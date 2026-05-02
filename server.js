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
        // Wir prüfen verschiedene mögliche Namen der Umgebungsvariable
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
        
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log("✅ Firebase Admin erfolgreich initialisiert!");
    } catch (e) {
        console.error("❌ Firebase Initialisierung fehlgeschlagen!");
        console.error("Grund:", e.message);
        console.log("TIPP: Falls 'invalid_grant' erscheint, erzeuge in der Firebase Console einen NEUEN Key.");
    }
}
initFirebase();

const app = express();
app.use(cors({ origin: "*" }));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;
const DATA_FILE = './devices.json';

app.use(bodyParser.json());
app.use('/location/binary', bodyParser.raw({ type: 'application/octet-stream', limit: '50kb' }));
app.use(express.static('public'));

let devices = {};
async function init() {
    try { devices = JSON.parse(await fs.readFile(DATA_FILE, 'utf8')); } catch (e) { devices = {}; }
}
init();

async function saveDevices() { 
    try { await fs.writeFile(DATA_FILE, JSON.stringify(devices, null, 2)); } catch (e) {} 
}

// --- LOKATION & IDENTITÄT (JSON) ---
app.post('/location', async (req, res) => {
    const data = req.body;
    if (!data.deviceId) return res.sendStatus(400);
    const id = data.deviceId.toLowerCase();
    const event = data.geofenceEvent;
    
    devices[id] = { ...devices[id], ...data, deviceId: id, lastSeen: Date.now() };
    await saveDevices();

    // PUSH LOGIK FÜR EVENTS
    if (event && !["heartbeat", "token_refresh", "wifi_lock", "forced_wakeup"].includes(event)) {
        console.log(`🔔 Event von ${devices[id].name || id}: ${event}`);
        
        const isEnter = event.startsWith('enter:');
        const zoneName = event.split(':')[1] || 'einer Zone';
        const deviceName = devices[id].name || 'Ein Gerät';
        const action = isEnter ? 'betreten' : 'verlassen';

        Object.values(devices).forEach(other => {
            if (other.deviceId !== id && other.fcmToken) {
                const message = {
                    data: {
                        type: 'geofence_event',
                        title: `Zone: ${zoneName}`,
                        message: `${deviceName} hat ${zoneName} ${action}.`,
                        zoneName: zoneName,
                        deviceName: deviceName,
                        action: action
                    },
                    token: other.fcmToken,
                    android: { priority: 'high' }
                };
                admin.messaging().send(message)
                    .then(() => console.log(`🚀 Push an ${other.name || other.deviceId} gesendet`))
                    .catch(e => console.log(`❌ Push fehlgeschlagen:`, e.message));
            }
        });
    }

    io.to(id).emit('location_update', devices[id]);
    res.sendStatus(200);
});

// --- ULTRA-BINARY DECODER V4 (Stabiles Typ-Flag Protokoll mit SPEED) ---
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
                speed = buffer.readInt8(offset++);
                flags = buffer.readUInt8(offset++);
            } else {
                const dt = buffer.readUInt16LE(offset); offset += 2;
                const dLat = buffer.readInt16LE(offset) / 100000.0; offset += 2;
                const dLon = buffer.readInt16LE(offset) / 100000.0; offset += 2;
                speed = buffer.readInt8(offset++);
                flags = buffer.readUInt8(offset++);
                ts = lastTs + dt; lat = lastLat + dLat; lon = lastLon + dLon;
                battery = devices[deviceId]?.battery || 0;
                accuracy = devices[deviceId]?.accuracy || 10.0;
            }
            lastLat = lat; lastLon = lon; lastTs = ts;

            // Alarm-Schutz: Bestehenden Status beibehalten, wenn das Paket kein Event meldet
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
    } catch (e) { res.sendStatus(500); }
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
            }).catch(e => console.log('❌ Alarm Push Error'));
        }
        res.sendStatus(200);
    } else res.status(404).send('Not found');
});

// --- WATCH LOGIK ---
app.post('/devices/:id/watch', async (req, res) => {
    const id = req.params.id.toLowerCase();
    const watcherId = req.query.watcherId || "unknown";
    if (!devices[id]) devices[id] = { deviceId: id, watchers: {} };
    if (!devices[id].watchers) devices[id].watchers = {};
    devices[id].watchers[watcherId] = Date.now();
    devices[id].isWatched = true;
    await saveDevices();
    if (devices[id].fcmToken) {
        admin.messaging().send({
            data: { type: 'wakeup', deviceId: id },
            token: devices[id].fcmToken,
            android: { priority: 'high', ttl: 0 }
        }).catch(e => console.log("❌ Wakeup failed"));
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
