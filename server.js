import express from 'express';
import bodyParser from 'body-parser';
import admin from 'firebase-admin';
import http from 'http';
import { Server as socketIo } from 'socket.io';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// --- ESM COMPATIBILITY ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
    admin.initializeApp(); // Fallback for environments with GOOGLE_APPLICATION_CREDENTIALS
    console.log('ℹ️ Firebase initialized with default credentials');
}

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const devices = {}; // In-memory device store
const lastPushTimes = {};
let devicesDirty = false;

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
app.get('/', (req, res) => res.send('GPS Tracking Server V1.1.0 Active (ESM)'));

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
    const data = mapProtoToApp(req.body);
    if (!data.deviceId) return res.status(400).send('Missing deviceId');

    updateDevice(data.deviceId, data);
    pushUpdateToAll(devices[data.deviceId.toLowerCase()]);
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
    log("info", `🧹 History cleared for ${id}`);
    res.sendStatus(200);
}));

app.get(['/geofences', '/v1/geofences'], safe((req, res) => res.json([]))); // Fallback for geofences

// --- DEVICE STATE ENGINE ---
function updateDevice(id, data) {
    id = id.toLowerCase();
    const old = devices[id] || {};

    const fcmToken = data.fcmToken || old.fcmToken;
    const name = data.name || old.name;
    const alarmActive = data.alarmActive !== undefined ? data.alarmActive : old.alarmActive;

    // 🔥 BATTERY PROTECTION: Don't overwrite with 0 or null if we have an old value
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
    devicesDirty = true;
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
    // Collect target tokens (excluding sender if provided)
    // For manual test buttons, senderId is null, so it goes to everyone.
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
server.listen(PORT, () => log("info", `🚀 Server running on port ${PORT} (ESM)`));
