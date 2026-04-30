import express from 'express';
import http from 'http';
import cors from 'cors';
import { Server } from 'socket.io';
import bodyParser from 'body-parser';
import fs from 'fs/promises';
import admin from 'firebase-admin';

// --- FIREBASE INITIALISIERUNG ---
async function initFirebase() {
    try {
        // Nutzt die vorhandene JSON-Datei in deinem Repository
        const keyPath = './gps-tracking-app-c4f56-firebase-adminsdk-fbsvc-9290f27516.json';
        const serviceAccount = JSON.parse(await fs.readFile(keyPath, 'utf8'));
        
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log("✅ Firebase Admin erfolgreich initialisiert");
    } catch (e) {
        console.error("⚠️ Firebase Fehler:", e.message);
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

// --- LOKATION & IDENTITÄT (JSON) ---
app.post('/location', async (req, res) => {
    const data = req.body;
    const id = data.deviceId.toLowerCase();
    const event = data.geofenceEvent;
    
    // Update Gerätedaten
    devices[id] = { ...devices[id], ...data, deviceId: id, lastSeen: Date.now() };
    await saveDevices();

    // 🔥 GEOFENCE PUSH BENACHRICHTIGUNG
    if (event && event !== "heartbeat" && event !== "token_refresh" && event !== "wifi_lock") {
        console.log(`🔔 Geofence Event von ${devices[id].name || id}: ${event}`);
        
        const isEnter = event.startsWith('enter:');
        const action = isEnter ? 'betreten' : 'verlassen';
        const zoneName = event.split(':')[1] || 'einer Zone';
        const deviceName = devices[id].name || 'Ein Gerät';

        // Nachricht an ALLE ANDEREN senden
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
                    android: { priority: 'normal' }
                };
                admin.messaging().send(message).catch(e => console.log("Push failed for", other.name));
            }
        });
    }

    io.to(id).emit('location_update', devices[id]);
    res.sendStatus(200);
});

// --- ULTRA-BINARY DECODER V3 ---
app.post('/location/binary', async (req, res) => {
    const buffer = req.body;
    if (!Buffer.isBuffer(buffer) || buffer.length < 5) return res.sendStatus(400);
    try {
        let offset = 0;
        const idLen = buffer.readUInt8(offset++);
        const deviceId = buffer.toString('utf8', offset, offset + idLen).toLowerCase();
        offset += idLen;
        const nameLen = buffer.readUInt8(offset++);
        const deviceName = buffer.toString('utf8', offset, offset + nameLen);
        offset += nameLen;
        const count = buffer.readUInt8(offset++);
        
        let lastLat = 0, lastLon = 0, lastTs = 0;
        for (let i = 0; i < count; i++) {
            let lat, lon, ts, accuracy, battery, flags;
            if (i === 0) {
                ts = Number(buffer.readBigInt64LE(offset)); offset += 8;
                lat = buffer.readInt32LE(offset) / 10000000.0; offset += 4;
                lon = buffer.readInt32LE(offset) / 10000000.0; offset += 4;
                accuracy = buffer.readUInt16LE(offset) / 10.0; offset += 2;
                battery = buffer.readUInt8(offset++);
                flags = buffer.readUInt8(offset++);
            } else {
                const checkFrame = buffer.readUInt16LE(offset);
                if (checkFrame === 0) { // Forced Base Frame
                    offset += 2;
                    ts = Number(buffer.readBigInt64LE(offset)); offset += 8;
                    lat = buffer.readInt32LE(offset) / 10000000.0; offset += 4;
                    lon = buffer.readInt32LE(offset) / 10000000.0; offset += 4;
                    accuracy = buffer.readUInt16LE(offset) / 10.0; offset += 2;
                    battery = buffer.readUInt8(offset++);
                    flags = buffer.readUInt8(offset++);
                } else {
                    const dt = checkFrame; offset += 2;
                    const dLat = buffer.readInt16LE(offset); offset += 2;
                    const dLon = buffer.readInt16LE(offset); offset += 2;
                    flags = buffer.readUInt8(offset++);
                    ts = lastTs + dt; lat = lastLat + (dLat / 100000.0); lon = lastLon + (dLon / 100000.0);
                    battery = devices[deviceId]?.battery || 0; accuracy = devices[deviceId]?.accuracy || 10.0;
                }
            }
            lastLat = lat; lastLon = lon; lastTs = ts;
            devices[deviceId] = {
                ...devices[deviceId], deviceId, name: deviceName, lat, lon, timestamp: ts, accuracy, battery,
                isLocked: (flags & 1) !== 0, isMotion: (flags & 2) !== 0, isWifi: (flags & 4) !== 0,
                accident: (flags & 64) !== 0, alarmActive: (flags & 128) !== 0, status: 'online', lastSeen: Date.now()
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
            admin.messaging().send(message).catch(e => console.log('Push Error:', e));
        }
        res.sendStatus(200);
    } else res.status(404).send('Not found');
});

// --- GERÄTEÜBERSICHT ---
app.get('/devices', (req, res) => res.json(Object.values(devices)));

// --- WATCH LOGIK ---
app.post('/devices/:id/watch', async (req, res) => {
    const id = req.params.id.toLowerCase();
    const watcherId = req.query.watcherId || "unknown";
    if (!devices[id]) devices[id] = { watchers: {} };
    if (!devices[id].watchers) devices[id].watchers = {};
    devices[id].watchers[watcherId] = Date.now();
    devices[id].isWatched = true;
    await saveDevices();
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

io.on('connection', (socket) => {
    socket.on('join_device', (deviceId) => socket.join(deviceId.toLowerCase()));
    socket.on('leave_device', (deviceId) => socket.leave(deviceId.toLowerCase()));
});

server.listen(PORT, () => console.log(`🚀 GPS Server online auf Port ${PORT}`));
