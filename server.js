import express from 'express';
import http from 'http';
import cors from 'cors';
import { Server } from 'socket.io';
import bodyParser from 'body-parser';
import fs from 'fs/promises';
import admin from 'firebase-admin';

// --- FIREBASE INITIALISIERUNG (Inlined Key) ---
const serviceAccount = {
  "type": "service_account",
  "project_id": "gps-tracking-app-c4f56",
  "private_key_id": "a8a532b50dce2b4bc258ceb7ee8580e74e90c3a9",
  "private_key": "-----BEGIN PRIVATE KEY-----\nMIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQD4dEOKkPmS6EJT\n66w6OUPmB23x8MTlsMMhxanFr0GeNJXXqSCrOh2uWVrb5zcwR+pKvWO2QqfvVOQ9\nno0KFC+F5E5+oBDo6Pl8ewC7XYAb5bKXfnj3rjwufQggBBHUi8JG8A1fvZGpA96qo\nvvvnLcPvSnh9PVTcQOz8qQDMa+0PrNngqXAkzyDUCp9T4MWQw/zZWZhYFCqTszJ0t\n47oMthrFMpzgPsCvkcPUAGzrDoRqOqaSTIsWBk1CiTpeVRRd9SGQT4Zar38myF\nyT+fWWqRk71f++ovIFgIvVqs10iiGlwOyENXI9C3C5iiMHbMi6w5B2e8aLnONY+8\ni0pw3BsZAgMBAAECggEAGtc0lLukuqIsyDqlnwSguTEER6bjHo1CB1v7Q0fzpsu3\nhFzZEqZsnnE4x5jq9WRPg1OCeiYpTkm1fpMslL8EMB19wi94ZzrWb8ZUFsnZbq/\nELFfrxr8/m97veBlZyjmFZGm5k3KzMn0vdYj1j6WdeJvL3rdP/umj0HwQ3HxnG9H\nfktxpwLlwLbUxl64hEina/kNWpthvR9BgEfT61qyRZLqjIRo2SKKhlFZ8aGbSxX\nsI+DVewBNqam4mpfCHe2PkGze/PMKxLgBfypRaINjV+5XyukvVmkrjkb57UZkIL0\nBkeRMKXJN0M7sqmBZTlIFuWdsE4TjKKST11d3BcFgAQKBgQD8XpUQjclrfrfHFHWN\nwN+vTLMCkAq1ZjI+dhmMrfcb39qlgNf1tM2yTUuGJZUTL8VCWzYfxo+ecARsBk2S\nDk1MjbNPmKvxRswXFYhcJYYCM/L+Dkh8ef8p8gmIZfKh/y9qUU365UbfsIwTM35u\nlHbkwaIZ0YJz+NoV5/KgtmRugQKBgQD8B0MsEOvnxxp96MRMnoyzVo21NEDp+tCb\nqa7LR7kfJ9efShmyFnd3l18KahRTAZu+V7DetjkI/gM1O6QKeH426GGwg1RmOLS\nqMe2johfa1Jm2AcsljyWOqa6PQWUYc4kmzbnPmkq/DaE7hLKEqtLXXHdwfoXvf6j\n/nTabO4QmQKBgHDZ8pp2bM1u2sthMLf0uZHwIFRTCRbY3jrkIMSxvkBut50uomOz\nOBA1VEJmZ+UuhW0I0IkhB3P372JG50UatCI5cydw+fpoiDcCX/mkpeoyRMSqqmtP\nOnUNUIn33KnoLNHEdbTV9f1tOxYS/sSACzJ8C/qznzww2YTWNb78EKkBAoGAGJyn\nJk4cOt7aQn4S7GUQ/RXjZxUoKy2KxKXBKCMtfbAHHOn4Ai2T/zwfBlZCBuaD8qfs\nHT2WcPj6HG83gF9swRUWl41XFUVxUbd8DeCFDmd7CnctR9XYN0eiT3xJOBFBEwEnk\nS+iRx4azpN+d1KZcalotnYKvIAkCksvEG3N4zwECgYAH5FdMaD5+j5xFaZxcDc+\n60/FsT9WkPwUyB2dVnhVfxvKGwcZgLUAGxgQXCZuoaavxkqO1Ew8MFBq20Y/ZT/j\nP82Jovi96Bdw4RifVKVCqgWFB2vn1YLAG7wYZ1uVhWYTBurUIl9qkkkpkNVPSQC\nAX4J4FBk6QPqF5V+rUzkAA==\n-----END PRIVATE KEY-----\n",
  "client_email": "firebase-adminsdk-fbsvc@gps-tracking-app-c4f56.iam.gserviceaccount.com"
};

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});
console.log("✅ Firebase Admin initialisiert");

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

// Identitäts-Update (Name, FCM Token)
app.post('/location', async (req, res) => {
    const data = req.body;
    const id = data.deviceId.toLowerCase();
    devices[id] = { ...devices[id], ...data, deviceId: id, lastSeen: Date.now() };
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
                accident: (flags & 64) !== 0, alarmActive: (flags & 128) !== 0, status: 'online'
            };
        }
        await saveDevices();
        io.to(deviceId).emit('location_update', devices[deviceId]);
        res.sendStatus(200);
    } catch (e) { res.sendStatus(500); }
});

// --- ALARM STEUERUNG (SOCKET + FCM PUSH) ---
app.post('/devices/:id/alarm', async (req, res) => {
    const id = req.params.id.toLowerCase();
    const active = req.query.active === 'true';
    if (devices[id]) {
        devices[id].alarmActive = active;
        await saveDevices();
        
        console.log(`🚨 Alarm ${active ? 'START' : 'STOP'} für ${devices[id].name || id}`);

        // 1. Socket.IO (Sofort-Trigger für offene App)
        io.to(id).emit('command', { deviceId: id, action: active ? 'START_ALARM' : 'STOP_ALARM' });

        // 2. FCM PUSH (Weckt das Handy im Hintergrund auf)
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

// --- WATCH & CONTROL ---
app.post('/devices/:id/watch', async (req, res) => {
    const id = req.params.id.toLowerCase();
    if (!devices[id]) devices[id] = { watchers: {} };
    if (!devices[id].watchers) devices[id].watchers = {};
    devices[id].watchers[req.query.watcherId || "unknown"] = Date.now();
    devices[id].isWatched = true;
    await saveDevices();
    io.to(id).emit('location_update', devices[id]);
    res.sendStatus(200);
});

app.post('/devices/:id/unwatch', async (req, res) => {
    const id = req.params.id.toLowerCase();
    if (devices[id] && devices[id].watchers) {
        delete devices[id].watchers[req.query.watcherId || "unknown"];
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

server.listen(PORT, () => console.log(`🚀 Ultra-Binary Server (V3) mit FCM online auf Port ${PORT}`));
