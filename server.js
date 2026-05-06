import express from 'express';
import http from 'http';
import cors from 'cors';
import { Server } from 'socket.io';
import bodyParser from 'body-parser';
import fs from 'fs/promises';
import admin from 'firebase-admin';

// --- STRENGE KONFIGURATION ---
if (!process.env.API_KEY) {
    console.error("❌ KRITISCH: API_KEY fehlt! Server-Start abgebrochen.");
    process.exit(1);
}
const API_KEY = process.env.API_KEY;
const PORT = process.env.PORT || 3000;
const DATA_FILE = './devices.json';
const GEOFENCE_FILE = './geofences.json';

// --- FIREBASE INITIALISIERUNG ---
async function initFirebase() {
    try {
        const envKey = process.env.FIREBASE_SERVICE_ACCOUNT || process.env.firebase_service_account;
        const serviceAccount = envKey ? JSON.parse(envKey) : JSON.parse(await fs.readFile('./firebase-key.json', 'utf8'));
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        console.log("✅ Firebase Admin aktiv.");
    } catch (e) {
        console.error("❌ Firebase Fehler:", e.message);
        process.exit(1);
    }
}
initFirebase();

const app = express();
app.use(cors({ origin: "*" }));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// --- 🛡️ MIDDLEWARE: RATE LIMITING (Memory-Safe) ---
const rateMap = {};
app.use((req, res, next) => {
    const ip = req.ip;
    const now = Date.now();
    if (!rateMap[ip]) rateMap[ip] = [];
    rateMap[ip] = rateMap[ip].filter(t => now - t < 10000);
    if (rateMap[ip].length > 100) return res.status(429).send("Too many requests");
    rateMap[ip].push(now);
    next();
});

// --- 🛡️ MIDDLEWARE: API-KEY AUTHENTIFIZIERUNG ---
app.use((req, res, next) => {
    // 🔥 Erlaube Root-Pfad (Health-Checks) und öffentliche Dateien ohne Key
    if (req.path === '/' || req.path.startsWith('/public')) return next();

    const providedKey = (
        req.headers['x-api-key'] ||
        req.headers['X-API-KEY'] ||
        req.query.apiKey ||
        ""
    ).trim();

    const serverKey = API_KEY.trim();

    if (providedKey !== serverKey) {
        const clientIp = req.headers['x-forwarded-for'] || req.ip;
        console.warn(`⚠️ AUTH-FEHLER [${clientIp}]: ${req.method} ${req.path}`);
        console.warn(`   Header erhalten:`, JSON.stringify(req.headers)); // 🔥 LOGGT HEADER
        return res.sendStatus(401);
    }
    next();
});

// Root-Endpunkt für Health-Checks
app.get('/', (req, res) => res.send('🚀 GPS Server is running.'));

app.use(bodyParser.json());
app.use('/location/binary', bodyParser.raw({ type: 'application/octet-stream', limit: '50kb' }));

let devices = {};
let geofences = [];
let lastPushTimes = {};

// --- ATOMARER SPEICHER ---
let deviceQueue = Promise.resolve();
let geofenceQueue = Promise.resolve();

async function atomicWrite(file, data) {
    const tmp = file + '.tmp';
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, file);
}

function saveDevicesSafe() {
    deviceQueue = deviceQueue.then(() => atomicWrite(DATA_FILE, JSON.stringify(devices, null, 2)))
        .catch(e => console.error("Disk Error (Devices):", e));
}

function saveGeofencesSafe() {
    geofenceQueue = geofenceQueue.then(() => atomicWrite(GEOFENCE_FILE, JSON.stringify(geofences, null, 2)))
        .catch(e => console.error("Disk Error (Geofences):", e));
}

async function init() {
    try { devices = JSON.parse(await fs.readFile(DATA_FILE, 'utf8')); } catch (e) { devices = {}; }
    try { geofences = JSON.parse(await fs.readFile(GEOFENCE_FILE, 'utf8')); } catch (e) { geofences = []; }
}
init();

// --- ZENTRALE WARTUNG (Alle 60s) ---
setInterval(() => {
    const now = Date.now();
    let changed = false;

    for (const id in devices) {
        const d = devices[id];
        // 🔥 13 Minuten (12 Min Intervall + 1 Min Puffer)
        if (d.status !== 'offline' && (now - d.lastSeen > 780000)) {
            d.status = 'offline';
            io.to(id).emit('location_update', d);
            changed = true;
        }
        if (d.watchers) {
            for (const w in d.watchers) {
                if (now - d.watchers[w] > 5 * 60 * 1000) { delete d.watchers[w]; changed = true; }
            }
            d.isWatched = Object.keys(d.watchers || {}).length > 0;
        }
    }
    for (const ip in rateMap) { if (rateMap[ip].length === 0) delete rateMap[ip]; }
    for (const key in lastPushTimes) { if (now - lastPushTimes[key] > 10 * 60 * 1000) delete lastPushTimes[key]; }

    if (changed) saveDevicesSafe();
}, 60000);

function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon/2) * Math.sin(dLon/2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// --- EVENT LOGIK (MODULAR) ---
async function handleEvents(id, data) {
    const now = Date.now();
    const device = devices[id];
    if (!device) return;

    // Geofence
    if (data.geofenceEvent && !["heartbeat", "token_refresh", "audit_check"].includes(data.geofenceEvent)) {
        const key = `gf:${id}:${data.geofenceEvent}`;
        if (!lastPushTimes[key] || (now - lastPushTimes[key] > 120000)) {
            lastPushTimes[key] = now;
            broadcast(id, {
                type: 'geofence_event',
                zoneName: data.geofenceEvent.split(':')[1] || 'Zone',
                deviceName: device.name || id,
                action: data.geofenceEvent.startsWith('enter') ? 'betreten' : 'verlassen'
            });
        }
    }

    // Accident
    if (data.accident === true) {
        const key = `acc:${id}`;
        if (!lastPushTimes[key] || (now - lastPushTimes[key] > 30000)) {
            lastPushTimes[key] = now;
            broadcast(id, { type: 'accident_alert', deviceName: device.name || id });
        }
    }

    // Proximity
    if (data.proximityEnabled && data.lat && data.lon) {
        Object.values(devices).forEach(other => {
            if (id.localeCompare(other.deviceId) < 0 && other.lat && other.lon) {
                const dist = calculateDistance(data.lat, data.lon, other.lat, other.lon);
                if (dist <= (data.proximityDistance || 500)) sendDoublePush(id, other.deviceId, 'proximity_alert', { distance: Math.round(dist).toString() });
            }
        });
    }
}

function broadcast(senderId, payload) {
    Object.values(devices).forEach(d => {
        if (d.deviceId !== senderId && d.fcmToken) admin.messaging().send({ data: payload, token: d.fcmToken, android: { priority: 'high' } }).catch(() => {});
    });
}

function sendDoublePush(id1, id2, type, extra) {
    const key = `${type}:${id1}:${id2}`;
    if (lastPushTimes[key] && (Date.now() - lastPushTimes[key] < 300000)) return;
    lastPushTimes[key] = Date.now();
    [id1, id2].forEach(tid => {
        const oid = tid === id1 ? id2 : id1;
        if (devices[tid]?.fcmToken) admin.messaging().send({ data: { ...extra, type, name: devices[oid].name || 'Gerät' }, token: devices[tid].fcmToken }).catch(() => {});
    });
}

function updateDevice(id, data) {
    const flags = data.flags || 0;
    const old = devices[id] || {};

    devices[id] = {
        ...old,
        ...data,
        status: 'online',
        lastSeen: Date.now(),
        isLocked: (flags & 1) !== 0 || (data.isLocked ?? old.isLocked ?? false),
        isMotion: (flags & 2) !== 0 || (data.isMotion ?? old.isMotion ?? false),
        isWifi: (flags & 4) !== 0 || (data.isWifi ?? old.isWifi ?? false),
        accident: (flags & 64) !== 0 || (data.accident ?? old.accident ?? false),
        alarmActive: (flags & 128) !== 0 || (data.alarmActive ?? old.alarmActive ?? false)
    };
    handleEvents(id, devices[id]);
}

// --- ENDPUNKTE ---
app.get('/geofences', (req, res) => res.json(geofences));

app.post('/devices/:id/alarm', (req, res) => {
    const id = req.params.id.toLowerCase();
    const active = req.query.active === 'true';
    if (!devices[id]) return res.sendStatus(404);
    devices[id].alarmActive = active;
    saveDevicesSafe();
    io.to(id).emit('location_update', devices[id]);

    if (devices[id].fcmToken) {
        admin.messaging().send({
            data: {
                type: active ? 'alarm' : 'stop_alarm', // 🔥 Kleinschreibung für Handy-App
                title: active ? '🚨 NOTFALL ALARM!' : 'Alarm gestoppt'
            },
            token: devices[id].fcmToken,
            android: { priority: 'high' }
        }).catch(e => console.error("Push Error:", e.message));
    }
    res.sendStatus(200);
});

app.post('/devices/wakeup-all', (req, res) => {
    Object.values(devices).forEach(d => {
        if (d.fcmToken) {
            admin.messaging().send({
                data: { type: 'WAKEUP' },
                token: d.fcmToken,
                android: { priority: 'high' }
            }).catch(() => {});
        }
    });
    res.sendStatus(200);
});

app.post('/devices/:id/watch', (req, res) => {
    const id = req.params.id.toLowerCase();
    const { watcherId, watcherName } = req.query;
    if (!devices[id]) return res.sendStatus(404);

    if (!devices[id].watchers) devices[id].watchers = {};
    devices[id].watchers[watcherId] = Date.now();
    devices[id].isWatched = true;
    devices[id].watcherName = watcherName || watcherId;

    saveDevicesSafe();
    io.to(id).emit('location_update', devices[id]);

    if (devices[id].fcmToken) {
        admin.messaging().send({
            data: { type: 'WAKEUP', watcherName: watcherName || watcherId },
            token: devices[id].fcmToken,
            android: { priority: 'high' }
        }).catch(() => {});
    }
    res.sendStatus(200);
});

app.post('/devices/:id/unwatch', (req, res) => {
    const id = req.params.id.toLowerCase();
    const { watcherId } = req.query;
    if (devices[id] && devices[id].watchers) {
        delete devices[id].watchers[watcherId];
        devices[id].isWatched = Object.keys(devices[id].watchers || {}).length > 0;
        saveDevicesSafe();
        io.to(id).emit('location_update', devices[id]);
    }
    res.sendStatus(200);
});

app.post('/geofences', async (req, res) => {
    const gf = req.body;
    if (!gf.id) gf.id = Date.now().toString();
    const idx = geofences.findIndex(g => g.id === gf.id);
    if (idx !== -1) geofences[idx] = gf; else geofences.push(gf);
    saveGeofencesSafe();
    io.emit('geofences_updated', geofences);
    res.status(201).json(gf);
});

app.post('/location', async (req, res) => {
    const id = req.body.deviceId?.toLowerCase();
    if (!id) return res.sendStatus(400);
    updateDevice(id, req.body);
    saveDevicesSafe();
    io.to(id).emit('location_update', devices[id]);
    res.sendStatus(200);
});

app.post('/location/binary', async (req, res) => {
    const buffer = req.body;
    if (!Buffer.isBuffer(buffer) || buffer.length < 10) return res.sendStatus(400);

    try {
        let offset = 0;
        const safeRead = (size) => { if (offset + size > buffer.length) throw new Error(`EOF (Need ${size}, have ${buffer.length - offset})`); };

        safeRead(1); const version = buffer.readUInt8(offset++);
        if (version !== 1) return res.sendStatus(400);

        safeRead(1); const idLen = buffer.readUInt8(offset++);
        safeRead(idLen); const deviceId = buffer.toString('utf8', offset, offset + idLen).toLowerCase();
        offset += idLen;

        safeRead(1); const nameLen = buffer.readUInt8(offset++);
        safeRead(nameLen); const deviceName = buffer.toString('utf8', offset, offset + nameLen);
        offset += nameLen;

        safeRead(1); const count = buffer.readUInt8(offset++);
        let lastLat = devices[deviceId]?.lat || 0, lastLon = devices[deviceId]?.lon || 0, lastTs = devices[deviceId]?.timestamp || 0;

        for (let i = 0; i < count; i++) {
            safeRead(1); const isBase = buffer.readUInt8(offset++) === 1;
            let lat, lon, ts, flg;
            if (isBase) {
                safeRead(21);
                ts = Number(buffer.readBigInt64LE(offset)); offset += 8;
                lat = buffer.readInt32LE(offset) / 10000000.0; offset += 4;
                lon = buffer.readInt32LE(offset) / 10000000.0; offset += 4;
                const acc = buffer.readUInt16LE(offset) / 10.0; offset += 2;
                const bat = buffer.readInt8(offset++);
                const spd = buffer.readInt8(offset++) / 10.0;
                flg = buffer.readUInt8(offset++);
                updateDevice(deviceId, { deviceId, name: deviceName, lat, lon, timestamp: ts, battery: bat, speed: spd, flags: flg, accuracy: acc });
            } else {
                safeRead(8);
                const dt = buffer.readUInt16LE(offset); offset += 2;
                const dLat = buffer.readInt16LE(offset) / 10000000.0; offset += 2;
                const dLon = buffer.readInt16LE(offset) / 10000000.0; offset += 2;
                const spd = buffer.readInt8(offset++) / 10.0;
                flg = buffer.readUInt8(offset++);

                ts = lastTs + dt; lat = lastLat + dLat; lon = lastLon + dLon;
                updateDevice(deviceId, { deviceId, name: deviceName, lat, lon, timestamp: ts, speed: spd, flags: flg });
            }
            lastLat = lat; lastLon = lon; lastTs = ts;
        }
        saveDevicesSafe();
        io.to(deviceId).emit('location_update', devices[deviceId]);
        res.sendStatus(200);
    } catch (e) { console.error("Binary Crash prevented:", e.message); res.sendStatus(400); }
});

app.get('/devices', (req, res) => res.json(Object.values(devices)));
server.listen(PORT, () => console.log(`🚀 Final Production GPS Server online auf Port ${PORT}`));
