import express from 'express';
import bodyParser from 'body-parser';
import admin from 'firebase-admin';
import http from 'http';
import { Server as socketIo } from 'socket.io';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import protobuf from 'protobufjs';

// --- ESM COMPATIBILITY ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- PROTOBUF SETUP ---
const root = await protobuf.load(path.join(__dirname, 'tracking.proto'));
const LocationUpdateProto = root.lookupType('tracking.LocationUpdateProto');
const LocationBatchProto = root.lookupType('tracking.LocationBatchProto');

// --- INITIALIZATION ---
const app = express();
const server = http.createServer(app);
const io = new socketIo(server);

// Firebase Initialization
const serviceAccountPath = path.join(__dirname, 'app/gps-tracking-app-c4f56-firebase-adminsdk-fbsvc-661bbccbc9.json');
if (fs.existsSync(serviceAccountPath)) {
    admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8')))
    });
    console.log('✅ Firebase initialized with service account');
} else {
    admin.initializeApp();
    console.log('ℹ️ Firebase initialized with default credentials');
}

// 🔥 PRODUCTION GRADE MIDDLEWARE (Hybrid)
// 1. Protobuf/Binary Layer
app.use(bodyParser.raw({
    type: (req) => {
        const ct = req.headers['content-type'] || '';
        return ct.includes('protobuf') || ct.includes('octet-stream');
    },
    limit: '5mb'
}));

// 2. JSON Layer (only if not already buffered by raw)
app.use((req, res, next) => {
    if (Buffer.isBuffer(req.body)) return next();
    bodyParser.json({ limit: '1mb' })(req, res, next);
});

app.use(bodyParser.urlencoded({ extended: true }));

const devices = {}; // In-memory device store
const lastPushTimes = {};
let geofences = [];

// Load Geofences from disk
const gfPath = path.join(__dirname, 'geofences.json');
if (fs.existsSync(gfPath)) {
    try {
        geofences = JSON.parse(fs.readFileSync(gfPath, 'utf8'));
        console.log(`✅ Loaded ${geofences.length} geofences from disk`);
    } catch (e) {
        console.error('❌ Failed to load geofences:', e.message);
    }
}

// --- LOGGING ---
function log(level, message) {
    const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
    console.log(`[${ts}] ${level.toUpperCase().padEnd(7)} | ${message}`);
}

// --- HELPERS ---
const safe = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(err => {
        log("error", `API Error: ${err.message}`);
        res.status(500).send(err.message);
    });
};

function mapAppToProto(data) {
    if (!data) return data;
    const p = { ...data };
    if (data.deviceId) p.device_id = data.deviceId;
    if (data.pointId) p.point_id = data.pointId;
    if (data.alarmActive !== undefined) p.alarm_active = data.alarmActive;
    if (data.isAwake !== undefined) p.is_awake = data.isAwake;
    if (data.isWatched !== undefined) p.is_watched = data.isWatched;
    if (data.isLocked !== undefined) p.is_locked = data.isLocked;
    if (data.isMotion !== undefined) p.is_motion = data.isMotion;
    if (data.isWifi !== undefined) p.is_wifi = data.isWifi;
    if (data.fcmToken) p.fcm_token = data.fcmToken;
    if (data.geofenceEvent) p.geofence_event = data.geofenceEvent;
    if (data.motionState) p.motion_state = data.motionState;
    if (data.battery !== undefined) p.battery = data.battery;
    if (data.speed !== undefined) p.speed = data.speed;
    if (data.bearing !== undefined) p.bearing = data.bearing;
    if (data.accuracy !== undefined) p.accuracy = data.accuracy;
    if (data.snappedLat) p.snapped_lat = data.snappedLat;
    if (data.snappedLon) p.snapped_lon = data.snappedLon;
    if (data.visualLat) p.visual_lat = data.visualLat;
    if (data.visualLon) p.visual_lon = data.visualLon;
    if (data.watcherName) p.watcher_name = data.watcherName;
    return p;
}

function mapProtoToApp(data) {
    if (!data) return data;
    const mapped = { ...data };
    mapped.deviceId = data.deviceId || data.device_id;
    mapped.pointId = data.pointId || data.point_id;
    mapped.alarmActive = data.alarmActive ?? data.alarm_active ?? false;
    mapped.isAwake = data.isAwake ?? data.is_awake ?? false;
    mapped.isWatched = data.isWatched ?? data.is_watched ?? false;
    mapped.isLocked = data.isLocked ?? data.is_locked ?? false;
    mapped.isMotion = data.isMotion ?? data.is_motion ?? false;
    mapped.isWifi = data.isWifi ?? data.is_wifi ?? false;
    mapped.accident = data.accident ?? false;
    mapped.fcmToken = data.fcmToken || data.fcm_token;
    mapped.geofenceEvent = data.geofenceEvent || data.geofence_event;
    mapped.motionState = data.motionState || data.motion_state;
    mapped.battery = data.battery ?? data.batteryPct ?? data.battery_pct;
    mapped.snappedLat = data.snappedLat || data.snapped_lat;
    mapped.snappedLon = data.snappedLon || data.snapped_lon;
    mapped.visualLat = data.visualLat || data.visual_lat;
    mapped.visualLon = data.visualLon || data.visual_lon;
    return mapped;
}

// --- BROADCAST LOGIC ---
function pushUpdateToAll(device) {
    if (!device?.deviceId) return;
    io.to(device.deviceId).emit('location_update', device);

    const protoDevice = mapAppToProto(device);
    const response = {
        device_id: device.deviceId,
        timestamp: Date.now(),
        server_response: { device: protoDevice }
    };
    io.emit('server_response', response);
}

// --- API ENDPOINTS ---
app.get('/', (req, res) => res.send('GPS Tracking Server V1.2.3 Active (Catch-All Raw)'));

app.get(['/devices', '/v1/devices'], safe((req, res) => {
    res.json(Object.values(devices));
}));

app.get(['/devices/:id', '/v1/devices/:id'], safe((req, res) => {
    const id = req.params.id.toLowerCase();
    const device = devices[id];
    if (!device) return res.status(404).send('Not found');
    res.json(device);
}));

app.post(['/location/update', '/v1/location'], safe(async (req, res) => {
    const contentType = req.headers['content-type'] || '';
    const isBinary = Buffer.isBuffer(req.body) && contentType.includes('protobuf');

    let data;
    try {
        if (isBinary) {
            data = mapProtoToApp(LocationUpdateProto.decode(req.body));
            log("debug", `✅ Single Decoded: ${data.deviceId} (Binary, size=${req.body.length})`);
        } else {
            // req.body is already a JSON object if processed by bodyParser.json
            data = mapProtoToApp(req.body);
            log("debug", `✅ Single Decoded: ${data.deviceId} (JSON)`);
        }
    } catch (e) {
        log("error", `❌ PROTO DECODE FAILED: ${e.message} | CT: ${contentType} | Size: ${req.body?.length}`);
        return res.status(400).send(`Decode error: ${e.message}`);
    }

    if (!data.deviceId) return res.status(400).send('Missing deviceId');

    updateDevice(data.deviceId, data);
    pushUpdateToAll(devices[data.deviceId.toLowerCase()]);
    res.sendStatus(200);
}));

app.post('/v1/location/batch', safe(async (req, res) => {
    const contentType = req.headers['content-type'] || '';
    if (!Buffer.isBuffer(req.body) || !contentType.includes('protobuf')) {
        log("error", `❌ Batch non-binary request. CT: ${contentType}`);
        return res.status(400).send('Expected binary protobuf');
    }

    try {
        const batch = LocationBatchProto.decode(req.body);
        log("info", `📦 Received batch with ${batch.updates.length} points (Size=${req.body.length})`);

        for (const update of batch.updates) {
            const data = mapProtoToApp(update);
            if (data.deviceId) {
                updateDevice(data.deviceId, data);
            }
        }

        if (batch.updates.length > 0) {
            const last = mapProtoToApp(batch.updates[batch.updates.length - 1]);
            pushUpdateToAll(devices[last.deviceId.toLowerCase()]);
        }
        res.sendStatus(200);
    } catch (e) {
        log("error", `❌ BATCH DECODE FAILED: ${e.message}`);
        res.status(400).send(e.message);
    }
}));

// --- REMOTE COMMANDS (FCM) ---

app.post(['/devices/:id/alarm', '/v1/devices/:id/alarm'], safe(async (req, res) => {
    const id = req.params.id.toLowerCase();
    const active = req.query.active === 'true';
    log("info", `🔔 Alarm ${active ? 'ON' : 'OFF'} requested for ${id}`);
    await broadcast(null, { type: 'alarm', active: active.toString(), deviceId: id });
    res.sendStatus(200);
}));

app.post(['/devices/:id/wakeup', '/v1/devices/:id/wakeup'], safe(async (req, res) => {
    const id = req.params.id.toLowerCase();
    log("info", `⚡ Wakeup requested for ${id}`);
    await broadcast(null, { type: 'wakeup', deviceId: id });
    res.sendStatus(200);
}));

app.post(['/devices/:id/watch', '/v1/devices/:id/watch'], safe(async (req, res) => {
    const id = req.params.id.toLowerCase();
    const watcherId = req.query.watcherId;
    log("info", `👀 Watch started for ${id} by ${watcherId}`);
    await broadcast(id, { type: 'watch_start', watcherId: watcherId });
    res.sendStatus(200);
}));

app.post(['/devices/:id/unwatch', '/v1/devices/:id/unwatch'], safe(async (req, res) => {
    const id = req.params.id.toLowerCase();
    const watcherId = req.query.watcherId;
    log("info", `🙈 Watch stopped for ${id} by ${watcherId}`);
    await broadcast(id, { type: 'watch_stop', watcherId: watcherId });
    res.sendStatus(200);
}));

app.post(['/devices/wakeup-all', '/v1/devices/wakeup-all'], safe(async (req, res) => {
    log("info", "📣 Global Wakeup requested");
    await broadcast(null, { type: 'wakeup' });
    res.sendStatus(200);
}));

app.post(['/test/proximity', '/v1/test/proximity'], safe(async (req, res) => {
    log("info", "🧪 Test Proximity requested");
    await broadcast(null, {
        type: 'proximity_alert',
        name: 'TEST-BOT',
        distance: '15',
        deviceId: 'test_bot_999',
        lat: '47.0971',
        lon: '15.4175'
    });
    res.sendStatus(200);
}));

app.post(['/location/clear/:id', '/v1/location/clear/:id'], safe(async (req, res) => {
    const id = req.params.id.toLowerCase();
    log("info", `Sweep: History cleared for ${id}`);
    res.sendStatus(200);
}));

app.post(['/devices/:id/break-lock', '/v1/devices/:id/break-lock'], safe(async (req, res) => {
    const id = req.params.id.toLowerCase();
    log("info", `🔓 Break Lock requested for ${id}`);
    await broadcast(id, { type: 'break_lock', deviceId: id });
    res.sendStatus(200);
}));

// --- GEOFENCE API ---
app.get(['/geofences', '/v1/geofences'], safe((req, res) => {
    res.json(geofences);
}));

app.post(['/geofences', '/v1/geofences'], safe((req, res) => {
    const gf = req.body;
    if (!gf.id) return res.status(400).send('Missing ID');

    const index = geofences.findIndex(g => g.id === gf.id);
    if (index >= 0) {
        geofences[index] = gf;
        log("info", `📍 Updated geofence: ${gf.name || gf.id}`);
    } else {
        geofences.push(gf);
        log("info", `📍 Created geofence: ${gf.name || gf.id}`);
    }

    fs.writeFileSync(gfPath, JSON.stringify(geofences, null, 2));
    res.sendStatus(200);
}));

app.delete('/v1/geofences/:id', safe((req, res) => {
    const id = req.params.id;
    const initialCount = geofences.length;
    geofences = geofences.filter(g => g.id !== id);

    if (geofences.length < initialCount) {
        log("info", `📍 Deleted geofence: ${id}`);
        fs.writeFileSync(gfPath, JSON.stringify(geofences, null, 2));
        res.sendStatus(200);
    } else {
        res.status(404).send('Not found');
    }
}));

// --- DEVICE STATE ENGINE ---
function updateDevice(id, data) {
    id = id.toLowerCase();
    const old = devices[id] || {};

    const fcmToken = data.fcmToken || old.fcmToken;
    const name = data.name || old.name;
    const alarmActive = data.alarmActive !== undefined ? data.alarmActive : old.alarmActive;

    const battery = (data.battery > 0) ? data.battery : (old.battery || 0);
    if (data.battery !== undefined && data.battery !== old.battery) log("debug", `🔋 ${id}: ${old.battery ?? 'new'} -> ${data.battery}%`);

    const isRealGeofence = typeof data.geofenceEvent === 'string' && (data.geofenceEvent.startsWith('enter:') || data.geofenceEvent.startsWith('exit:'));

    devices[id] = {
        ...old, ...data, deviceId: id,
        fcmToken: fcmToken,
        name: name,
        battery: battery,
        geofenceEvent: isRealGeofence ? data.geofenceEvent : undefined,
        alarmActive: alarmActive ?? old.alarmActive ?? false,
        status: 'online', lastSeen: Date.now()
    };
    handleEvents(id, { ...devices[id], geofenceEvent: data.geofenceEvent }, old);
}

async function handleEvents(id, data, old) {
    const device = devices[id]; if (!device) return;
    if (typeof data.geofenceEvent === 'string' && (data.geofenceEvent.startsWith('enter:') || data.geofenceEvent.startsWith('exit:'))) {
        const key = `gf:${id}:${data.geofenceEvent}`;

        if (Date.now() - (lastPushTimes[key] || 0) > 120000) {
            lastPushTimes[key] = Date.now();
            const [action, ...name] = data.geofenceEvent.split(':');
            const zoneName = name.join(':') || 'Zone';
            await broadcast(id, { type: 'geofence_event', deviceId: id, zoneName: zoneName, deviceName: device.name || id, action: action === 'enter' ? 'betreten' : 'verlassen' });
        }
    }
}

async function broadcast(senderId, payload) {
    const tokens = Object.values(devices)
        .filter(d => (senderId === null || d.deviceId !== senderId) && d.fcmToken && d.fcmToken.length > 5)
        .map(d => d.fcmToken);

    if (tokens.length === 0) {
        log("debug", `ℹ️ BCast: No target tokens for event ${payload.type}`);
        return;
    }

    log("info", `📣 Broadcasting ${payload.type} to ${tokens.length} devices...`);

    for (let i = 0; i < tokens.length; i += 500) {
        try {
            const batch = tokens.slice(i, i + 500);
            await admin.messaging().sendEachForMulticast({
                tokens: batch,
                data: payload,
                android: { priority: 'high' }
            });
        } catch (e) {
            log("error", `❌ FCM Broadcast failed: ${e.message}`);
        }
    }
}

// --- SERVER START ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => log("info", `🚀 Server running on port ${PORT} (V1.2.3)`));
