import express from 'express';
import http from 'http';
import cors from 'cors';
import { Server } from 'socket.io';
import bodyParser from 'body-parser';
import fs from 'fs/promises';
import admin from 'firebase-admin';

// --- FIREBASE INITIALISIERUNG (ROBUST) ---
async function initFirebase() {
    try {
        const envKey = process.env.FIREBASE_SERVICE_ACCOUNT || process.env.firebase_service_account;
        let serviceAccount;
        if (envKey) {
            console.log("📡 Nutze Firebase-Key aus Umgebungsvariable...");
            serviceAccount = JSON.parse(envKey);
        } else {
            console.log("📂 Suche lokale Key-Datei...");
            const localPath = './firebase-key.json';
            serviceAccount = JSON.parse(await fs.readFile(localPath, 'utf8'));
        }
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        console.log("✅ Firebase Admin erfolgreich initialisiert!");
    } catch (e) {
        console.error("❌ Firebase Initialisierung fehlgeschlagen!", e.message);
    }
}
initFirebase();

const app = express();
app.use(cors({ origin: "*" }));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;
const DATA_FILE = './devices.json';
const GEOFENCE_FILE = './geofences.json';

app.use(bodyParser.json());
app.use('/location/binary', bodyParser.raw({ type: 'application/octet-stream', limit: '50kb' }));
app.use(express.static('public'));

let devices = {};
let geofences = [];
let lastPushTimes = {}; // Spam-Schutz Speicher

async function init() {
    try { devices = JSON.parse(await fs.readFile(DATA_FILE, 'utf8')); } catch (e) { devices = {}; }
    try { geofences = JSON.parse(await fs.readFile(GEOFENCE_FILE, 'utf8')); } catch (e) { geofences = []; }
}
init();

async function saveDevices() {
    try { await fs.writeFile(DATA_FILE, JSON.stringify(devices, null, 2)); } catch (e) {}
}

async function saveGeofences() {
    try { await fs.writeFile(GEOFENCE_FILE, JSON.stringify(geofences, null, 2)); } catch (e) {}
}

function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon/2) * Math.sin(dLon/2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// --- GEOFENCES ---
app.get('/geofences', (req, res) => res.json(geofences));

app.post('/geofences', async (req, res) => {
    const gf = req.body;
    if (!gf.id) gf.id = Date.now().toString();
    const index = geofences.findIndex(g => g.id === gf.id);
    if (index !== -1) geofences[index] = gf; else geofences.push(gf);
    await saveGeofences();
    io.emit('geofences_updated', geofences);
    res.status(201).json(gf);
});

app.delete('/geofences/:id', async (req, res) => {
    const id = req.params.id;
    geofences = geofences.filter(g => g.id !== id);
    await saveGeofences();
    io.emit('geofences_updated', geofences);
    res.sendStatus(200);
});

// --- LOKATION & IDENTITÄT (JSON) ---
app.post('/location', async (req, res) => {
    const data = req.body;
    if (!data.deviceId) return res.sendStatus(400);
    const id = data.deviceId.toLowerCase();
    const event = data.geofenceEvent;

    // Daten zusammenführen (Alarm- & Unfallschutz)
    devices[id] = {
        ...devices[id], ...data,
        accident: data.accident !== undefined ? data.accident : (devices[id]?.accident || false),
        alarmActive: data.alarmActive !== undefined ? data.alarmActive : (devices[id]?.alarmActive || false),
        deviceId: id, lastSeen: Date.now()
    };
    await saveDevices();

    const now = Date.now();

    // 1. GEOFENCE PUSH (mit Spam-Schutz 2 Min)
    if (event && !["heartbeat", "token_refresh", "wifi_lock", "forced_wakeup", "audit_check"].includes(event)) {
        const pushKey = `${id}:${event}`;
        if (!lastPushTimes[pushKey] || (now - lastPushTimes[pushKey] > 2 * 60 * 1000)) {
            lastPushTimes[pushKey] = now;
            console.log(`🔔 Event von ${devices[id].name || id}: ${event}`);

            const isEnter = event.startsWith('enter:');
            const zoneName = event.split(':')[1] || 'Zone';
            const deviceName = devices[id].name || 'Ein Gerät';

            Object.values(devices).forEach(other => {
                if (other.deviceId !== id && other.fcmToken) {
                    admin.messaging().send({
                        data: {
                            type: 'geofence_event',
                            zoneName: zoneName,
                            deviceName: deviceName,
                            action: isEnter ? 'betreten' : 'verlassen',
                            message: `${deviceName} hat ${zoneName} ${isEnter ? 'betreten' : 'verlassen'}.`
                        },
                        token: other.fcmToken,
                        android: { priority: 'high' }
                    }).catch(e => console.log("Geofence push failed", e.message));
                }
            });
        }
    }

    // 2. UNFALL ALARM (Accident Alert)
    if (data.accident === true) {
        const accKey = `accident:${id}`;
        if (!lastPushTimes[accKey] || (now - lastPushTimes[accKey] > 30000)) {
            lastPushTimes[accKey] = now;
            console.log(`⚠️ UNFALL GEMELDET von ${devices[id].name || id}`);
            Object.values(devices).forEach(other => {
                if (other.deviceId !== id && other.fcmToken) {
                    admin.messaging().send({
                        data: {
                            type: 'accident_alert',
                            deviceName: devices[id].name || 'Jemand',
                            title: '🚨 UNFALL ALARM!',
                            message: `${devices[id].name || 'Ein Gerät'} hat einen schweren Unfall gemeldet!`
                        },
                        token: other.fcmToken,
                        android: { priority: 'high' }
                    }).catch(e => console.log("Accident push failed", e.message));
                }
            });
        }
    }

    // 3. ANNÄHERUNGS-CHECK (Proximity)
    const myThreshold = data.proximityDistance || 500;
    const isProxEnabled = data.proximityEnabled === true;

    if (isProxEnabled && data.lat && data.lon) {
        Object.values(devices).forEach(other => {
            if (other.deviceId !== id && other.lat && other.lon) {
                const dist = calculateDistance(data.lat, data.lon, other.lat, other.lon);
                if (dist <= myThreshold) {
                    const proxKey = `prox:${id}:${other.deviceId}`;
                    if (!lastPushTimes[proxKey] || (now - lastPushTimes[proxKey] > 5 * 60 * 1000)) {
                        lastPushTimes[proxKey] = now;
                        if (devices[id].fcmToken) {
                            admin.messaging().send({
                                data: {
                                    type: 'proximity_alert',
                                    name: other.name || 'Gerät',
                                    distance: Math.round(dist).toString()
                                },
                                token: devices[id].fcmToken,
                                android: { priority: 'high' }
                            }).catch(e => console.log("Prox-Push failed", e.message));
                        }
                    }
                }
            }
        });
    }

    io.to(id).emit('location_update', devices[id]);
    res.sendStatus(200);
});

// --- BINARY DECODER V4 (Speed Precision Fix) ---
app.post('/location/binary', async (req, res) => {
    const buffer = req.body;
    if (!Buffer.isBuffer(buffer) || buffer.length < 6) return res.sendStatus(400);
    try {
        let offset = 0;
        const version = buffer.readUInt8(offset++);
        if (version !== 1) return res.sendStatus(400);
        const idLen = buffer.readUInt8(offset++);
        const deviceId = buffer.toString('utf8', offset, offset + idLen).toLowerCase();
        offset += idLen;
        const nameLen = buffer.readUInt8(offset++);
        const deviceName = buffer.toString('utf8', offset, offset + nameLen);
        offset += nameLen;
        const count = buffer.readUInt8(offset++);
        let lastLat = 0, lastLon = 0, lastTs = 0;

        for (let i = 0; i < count; i++) {
            let lat, lon, ts, accuracy, battery, speed, flags;
            const isBaseFrame = buffer.readUInt8(offset++) === 1;

            if (isBaseFrame) {
                ts = Number(buffer.readBigInt64LE(offset)); offset += 8;
                lat = buffer.readInt32LE(offset) / 10000000.0; offset += 4;
                lon = buffer.readInt32LE(offset) / 10000000.0; offset += 4;
                accuracy = buffer.readInt16LE(offset) / 10.0; offset += 2;
                battery = buffer.readInt8(offset++);
                speed = buffer.readInt8(offset++) / 10.0;
                flags = buffer.readUInt8(offset++);
            } else {
                const dt = buffer.readUInt16LE(offset); offset += 2;
                const dLat = buffer.readInt32LE(offset) / 10000000.0; offset += 4; // 🔥 FIX: readInt32LE statt readInt16LE für 10 Mio Präzision
                const dLon = buffer.readInt32LE(offset) / 10000000.0; offset += 4;
                speed = buffer.readInt8(offset++) / 10.0;
                flags = buffer.readUInt8(offset++);
                ts = lastTs + dt; lat = lastLat + dLat; lon = lastLon + dLon;
                battery = devices[deviceId]?.battery || 0; accuracy = devices[deviceId]?.accuracy || 10.0;
            }
            lastLat = lat; lastLon = lon; lastTs = ts;

            // Alarm- & Unfallschutz
            const incomingAccident = (flags & 64) !== 0;
            const incomingAlarm = (flags & 128) !== 0;
            const finalAccident = incomingAccident || (devices[deviceId]?.accident && !incomingAccident ? devices[deviceId].accident : incomingAccident);
            const finalAlarm = incomingAlarm || (devices[deviceId]?.alarmActive && !incomingAlarm ? devices[deviceId].alarmActive : incomingAlarm);

            devices[deviceId] = {
                ...devices[deviceId], deviceId, name: deviceName, lat, lon, timestamp: ts, accuracy, battery, speed,
                isLocked: (flags & 1) !== 0, isMotion: (flags & 2) !== 0, isWifi: (flags & 4) !== 0,
                accident: finalAccident, alarmActive: finalAlarm, status: 'online', lastSeen: Date.now()
            };
        }
        await saveDevices();
        io.to(deviceId).emit('location_update', devices[deviceId]);
        res.sendStatus(200);
    } catch (e) { console.error("Binary Error:", e); res.sendStatus(500); }
});

// --- ALARM STEUERUNG ---
app.post('/devices/:id/alarm', async (req, res) => {
    const id = req.params.id.toLowerCase();
    const active = req.query.active === 'true';
    if (devices[id]) {
        devices[id].alarmActive = active;
        await saveDevices();
        io.to(id).emit('command', { deviceId: id, action: active ? 'START_ALARM' : 'STOP_ALARM' });
        if (devices[id].fcmToken) {
            admin.messaging().send({
                data: { type: active ? 'alarm' : 'stop_alarm', deviceId: id },
                token: devices[id].fcmToken,
                android: { priority: 'high', ttl: 0 }
            }).catch(e => console.log('❌ Alarm Push Error', e.message));
        }
        res.sendStatus(200);
    } else res.status(404).send('Not found');
});

// --- WATCH LOGIK ---
app.post('/devices/:id/watch', async (req, res) => {
    const id = req.params.id.toLowerCase();
    const watcherId = req.query.watcherId || "unknown";
    const watcherName = req.query.watcherName || "Unbekannt";

    if (!devices[id]) devices[id] = { deviceId: id, watchers: {} };
    if (!devices[id].watchers) devices[id].watchers = {};

    devices[id].watchers[watcherId] = Date.now();
    devices[id].isWatched = true;
    devices[id].watcherName = watcherName; // 🔥 Speichern für UI Anzeige

    await saveDevices();
    if (devices[id].fcmToken) {
        admin.messaging().send({
            data: { type: 'wakeup', deviceId: id },
            token: devices[id].fcmToken,
            android: { priority: 'high', ttl: 0 }
        }).catch(e => console.log("❌ Wakeup failed", e.message));
    }
    io.to(id).emit('location_update', devices[id]);
    res.sendStatus(200);
});

app.post('/devices/:id/unwatch', async (req, res) => {
    const id = req.params.id.toLowerCase();
    const watcherId = req.query.watcherId || "unknown";
    if (devices[id] && devices[id].watchers) {
        delete devices[id].watchers[watcherId];
        devices[id].isWatched = Object.keys(devices[id].watchers).length > 0;
        await saveDevices();
        io.to(id).emit('location_update', devices[id]);
    }
    res.sendStatus(200);
});

app.get('/devices', (req, res) => res.json(Object.values(devices)));

io.on('connection', (socket) => {
    socket.on('join_device', (id) => socket.join(id.toLowerCase()));
});

server.listen(PORT, () => console.log(`🚀 GPS Server V4 online auf Port ${PORT}`));
