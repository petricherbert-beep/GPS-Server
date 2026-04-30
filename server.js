import express from 'express';
import http from 'http';
import cors from 'cors';
import { Server } from 'socket.io';
import bodyParser from 'body-parser';
import fs from 'fs/promises';
import path from 'path';
import admin from 'firebase-admin';

// --- FIREBASE INITIALISIERUNG ---
// Stelle sicher, dass die Datei 'serviceAccountKey.json' im gleichen Ordner liegt!
try {
    const serviceAccount = JSON.parse(await fs.readFile('./serviceAccountKey.json', 'utf8'));
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log("✅ Firebase Admin initialisiert");
} catch (e) {
    console.error("⚠️ Firebase konnte nicht geladen werden. Alarme funktionieren nur bei offener App via Sockets.");
}

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

// --- API ENDPUNKTE ---

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

app.get('/devices', (req, res) => res.json(Object.values(devices)));

// Standard JSON Update (für Identity & FCM Token)
app.post('/location', async (req, res) => {
    const data = req.body;
    const id = data.deviceId.toLowerCase();
    
    devices[id] = {
        ...devices[id],
        ...data,
        deviceId: id,
        status: 'online',
        lastSeen: Date.now()
    };
    
    await saveDevices();
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
                // Delta Decoding
                const checkFrame = buffer.readUInt16LE(offset);
                if (checkFrame === 0) { // Forced Base Frame (Wald-Schutz)
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
                    ts = lastTs + dt; 
                    lat = lastLat + (dLat / 100000.0); 
                    lon = lastLon + (dLon / 100000.0);
                    battery = devices[deviceId]?.battery || 0; 
                    accuracy = devices[deviceId]?.accuracy || 10.0;
                }
            }
            lastLat = lat; lastLon = lon; lastTs = ts;
            
            devices[deviceId] = {
                ...devices[deviceId],
                deviceId,
                name: deviceName,
                lat, lon, timestamp: ts, accuracy, battery,
                isLocked: (flags & 1) !== 0,
                isMotion: (flags & 2) !== 0,
                isWifi: (flags & 4) !== 0,
                accident: (flags & 64) !== 0,
                alarmActive: (flags & 128) !== 0,
                status: 'online',
                lastSeen: Date.now()
            };
        }
        await saveDevices();
        io.to(deviceId).emit('location_update', devices[deviceId]);
        res.sendStatus(200);
    } catch (e) { console.error(e); res.sendStatus(500); }
});

// --- ALARM STEUERUNG (SOCKET + FCM PUSH) ---
app.post('/devices/:id/alarm', async (req, res) => {
    const id = req.params.id.toLowerCase();
    const active = req.query.active === 'true';
    
    if (devices[id]) {
        devices[id].alarmActive = active;
        await saveDevices();
        
        console.log(`🚨 Alarm ${active ? 'START' : 'STOP'} für ${devices[id].name || id}`);

        // 1. Echtzeit-Update an alle Karten (Socket.io)
        io.to(id).emit('command', { deviceId: id, action: active ? 'START_ALARM' : 'STOP_ALARM' });
        io.emit('location_update', devices[id]);

        // 2. 🔥 FCM PUSH (für den Hintergrund-Dienst - weckt das Handy sofort)
        if (devices[id].fcmToken) {
            const message = {
                data: {
                    type: active ? 'alarm' : 'stop_alarm',
                    title: active ? '🚨 NOTFALL ALARM!' : 'Alarm beendet',
                    message: active ? `Hilfe benötigt von ${devices[id].name || 'Nicole'}!` : 'Der Alarm wurde gestoppt.',
                    deviceId: id
                },
                token: devices[id].fcmToken,
                android: {
                    priority: 'high', // 🔥 UNVERZICHTBAR für sofortige Zustellung
                    ttl: 0 // Nicht zwischenspeichern, sofort senden
                }
            };

            admin.messaging().send(message)
                .then((response) => console.log('Successfully sent FCM message:', response))
                .catch((error) => console.log('Error sending FCM message:', error));
        } else {
            console.log("⚠️ Kein FCM Token für dieses Gerät vorhanden. Alarm im Hintergrund verzögert.");
        }
        
        res.sendStatus(200);
    } else res.status(404).send('Gerät nicht gefunden');
});

// --- WATCHDOG & ROOMS ---
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
    socket.on('join_device', (deviceId) => {
        const id = deviceId.toLowerCase();
        socket.join(id);
        console.log(`📱 Client joined room: ${id}`);
    });
    socket.on('leave_device', (deviceId) => socket.leave(deviceId.toLowerCase()));
});

server.listen(PORT, () => console.log(`🚀 Ultra-Binary Server (V3) mit Firebase online auf Port ${PORT}`));
