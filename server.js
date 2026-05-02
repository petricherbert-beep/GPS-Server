import express from 'express';
import http from 'http';
import cors from 'cors';
import { Server } from 'socket.io';
import bodyParser from 'body-parser';
import fs from 'fs/promises';
import admin from 'firebase-admin';

// --- FIREBASE INITIALISIERUNG ---
async function initFirebase() {
    const keyPath = './gps-tracking-app-c4f56-firebase-adminsdk-fbsvc-9290f27516.json';
    try {
        const serviceAccount = JSON.parse(await fs.readFile(keyPath, 'utf8'));
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log("✅ Firebase Admin erfolgreich initialisiert");
    } catch (e) {
        console.error("❌ Firebase Fehler: Datei nicht gefunden oder ungültig!");
        console.error("Gesuchter Pfad:", keyPath);
        console.error("Fehlermeldung:", e.message);
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

async function init() {
    try { devices = JSON.parse(await fs.readFile(DATA_FILE, 'utf8')); } catch (e) { devices = {}; }
    try { geofences = JSON.parse(await fs.readFile(GEOFENCE_FILE, 'utf8')); } catch (e) { geofences = []; }
}
init();

async function saveDevices() { try { await fs.writeFile(DATA_FILE, JSON.stringify(devices, null, 2)); } catch (e) {} }
async function saveGeofences() { try { await fs.writeFile(GEOFENCE_FILE, JSON.stringify(geofences, null, 2)); } catch (e) {} }

// --- LOKATION & IDENTITÄT (JSON) ---
app.post('/location', async (req, res) => {
    const data = req.body;
    if (!data.deviceId) return res.sendStatus(400);
    
    const id = data.deviceId.toLowerCase();
    const event = data.geofenceEvent;
    
    // Daten zusammenführen
    devices[id] = { ...devices[id], ...data, deviceId: id, lastSeen: Date.now() };
    await saveDevices();

    // GEOFENCE PUSH BENACHRICHTIGUNG
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
                    android: { priority: 'high', ttl: 3600000 }
                };
                admin.messaging().send(message)
                    .then(() => console.log(`🚀 Geofence-Push an ${other.name || other.deviceId} erfolgreich`))
                    .catch(e => console.log(`❌ Geofence-Push fehlgeschlagen für ${other.name}:`, e.message));
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
            const message = {
                data: {
                    type: active ? 'alarm' : 'stop_alarm',
                    title: active ? '🚨 NOTFALL ALARM!' : 'Alarm beendet',
                    message: active ? `Hilfe benötigt von ${devices[id].name}!` : 'Der Alarm wurde gestoppt.',
                    deviceId: id
                },
                token: devices[id].fcmToken,
                android: { priority: 'high', ttl: 0 }
            };
            admin.messaging().send(message)
                .then(() => console.log(`🚀 Alarm-Push an ${devices[id].name} gesendet`))
                .catch(e => console.log(`❌ Alarm-Push fehlgeschlagen:`, e.message));
        }
        res.sendStatus(200);
    } else res.status(404).send('Not found');
});

// --- WATCH LOGIK (MIT WAKEUP-PUSH) ---
app.post('/devices/:id/watch', async (req, res) => {
    const id = req.params.id.toLowerCase();
    const watcherId = req.query.watcherId || "unknown";
    if (!devices[id]) devices[id] = { deviceId: id, watchers: {} };
    if (!devices[id].watchers) devices[id].watchers = {};
    
    devices[id].watchers[watcherId] = Date.now();
    devices[id].isWatched = true;
    await saveDevices();

    if (devices[id].fcmToken) {
        console.log(`📡 Sende Wakeup-Push an ${devices[id].name || id}`);
        admin.messaging().send({
            data: { type: 'wakeup', deviceId: id },
            token: devices[id].fcmToken,
            android: { priority: 'high', ttl: 0 }
        }).then(() => console.log("🚀 Wakeup-Push erfolgreich gesendet"))
          .catch(e => console.log("❌ Wakeup-Push fehlgeschlagen:", e.message));
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

app.get('/geofences', (req, res) => res.json(geofences));
app.get('/devices', (req, res) => res.json(Object.values(devices)));

io.on('connection', (socket) => {
    socket.on('join_device', (id) => socket.join(id.toLowerCase()));
    socket.on('leave_device', (id) => socket.leave(id.toLowerCase()));
});

server.listen(PORT, () => console.log(`🚀 GPS Server V4 online auf Port ${PORT}`));
