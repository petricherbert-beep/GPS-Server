import express from 'express';
import http from 'http';
import cors from 'cors';
import { Server } from 'socket.io';
import bodyParser from 'body-parser';
import fs from 'fs/promises';
import admin from 'firebase-admin';
import protobuf from 'protobufjs';
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import compression from 'compression';
import multer from 'multer';

process.on("uncaughtException", (err) => { console.error("💥 CRASH:", err); process.exit(1); });
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const API_KEY = (process.env.API_KEY || "test").trim();
const PORT = process.env.PORT || 3000;
const GRPC_PORT = process.env.GRPC_PORT || 50051;
const DATA_FILE = path.join(__dirname, 'devices.json');
const GEOFENCE_FILE = path.join(__dirname, 'geofences.json');
const TELEMETRY_DIR = path.join(__dirname, 'telemetry');

// Ensure directories
await fs.mkdir(TELEMETRY_DIR, { recursive: true }).catch(() => {});

let devices = {};
let geofences = {};
const grpcStreams = new Map();

// --- PROTOBUF (V362 Master Schema) ---
const PROTO_PATH = path.join(__dirname, 'tracking.proto');
const packageDefinition = protoLoader.loadSync(PROTO_PATH, { keepCase: true, longs: Number, enums: String, defaults: false, oneofs: true });
const trackingProto = grpc.loadPackageDefinition(packageDefinition).tracking;
const root = protobuf.parse(await fs.readFile(PROTO_PATH, 'utf8')).root;

const LocationUpdateProto = root.lookupType("tracking.LocationUpdateProto");
const DeviceLocationProto = root.lookupType("tracking.DeviceLocationProto");
const LocationBatchProto = root.lookupType("tracking.LocationBatchProto");

// --- HELPERS ---
function normalizeId(id) { return id ? id.trim().toLowerCase() : null; }
function hasValue(v) { return v !== undefined && v !== null && v !== ''; }
function bool(v) { return !!v; }

function mapToProto(d = {}) {
    const msg = {
        device_id: d.device_id || d.deviceId || "",
        name: d.name || "",
        lat: Number(d.lat ?? 0),
        lon: Number(d.lon ?? 0),
        alarm_active: bool(d.alarm_active || d.alarmActive),
        is_locked: bool(d.is_locked || d.isLocked),
        is_watched: bool(d.is_watched || d.isWatched),
        fcm_token: d.fcm_token || d.fcmToken || "",
        geofence_event: d.geofence_event || d.geofenceEvent || "",
        motion_state: d.motion_state || d.motionState || "STILL",
        offline: bool(d.offline),
        status: d.status || "online",
        watcher_name: d.watcher_name || d.watcherName || "",
        is_awake: bool(d.is_awake || d.isAwake),
        point_id: d.point_id || d.pointId || "",
        intermediate_coords: Array.isArray(d.intermediate_coords) ? d.intermediate_coords.map(Number) : []
    };
    if (hasValue(d.battery)) msg.battery = Math.round(Number(d.battery));
    if (hasValue(d.speed)) msg.speed = Number(d.speed);
    if (hasValue(d.bearing)) msg.bearing = Number(d.bearing);
    if (hasValue(d.accuracy)) msg.accuracy = Number(d.accuracy);
    if (hasValue(d.sats)) msg.sats = Math.round(Number(d.sats));
    if (hasValue(d.temperature)) msg.temperature = Number(d.temperature);
    if (hasValue(d.visual_lat || d.visualLat)) msg.visual_lat = Number(d.visual_lat || d.visualLat);
    if (hasValue(d.visual_lon || d.visualLon)) msg.visual_lon = Number(d.visual_lon || d.visualLon);
    if (hasValue(d.color)) msg.color = Math.round(Number(d.color));
    if (hasValue(d.timestamp)) msg.timestamp = Number(d.timestamp);
    return DeviceLocationProto.create(msg);
}

function pushUpdate(device, signal = null) {
    if (device) {
        const pub = { ...device }; delete pub.deviceSecretHash;
        io.to(device.deviceId).emit('location_update', pub);
    }
    if (signal === 'reload_geofences') io.emit('reload_geofences', true);

    const response = {
        device_id: device ? device.deviceId : "system",
        timestamp: Date.now(),
        server_response: signal === 'reload_geofences' ? { reload_geofences: true } : (device ? { device: mapToProto(device) } : null)
    };
    if (!response.server_response) return;

    for (const [sid, call] of grpcStreams) {
        try { if (!call.destroyed) call.write(response); else grpcStreams.delete(sid); }
        catch(e){ grpcStreams.delete(sid); }
    }
}

async function updateDevice(id, data) {
    const old = devices[id] || {};
    devices[id] = { ...old, ...data, deviceId: id, lastSeen: Date.now() };
    return devices[id];
}

async function sendFcm(targetId, payload) {
    const dev = devices[targetId];
    if (dev?.fcmToken) {
        try { await admin.messaging().send({ data: payload, token: dev.fcmToken, android: { priority: 'high' } }); }
        catch(e) { console.error(`FCM Failed for ${targetId}`); }
    }
}

// --- STORAGE & MULTIPART ---
const storage = multer.diskStorage({
    destination: TELEMETRY_DIR,
    filename: (req, file, cb) => {
        const devId = normalizeId(req.headers['x-device-id']) || "unknown";
        cb(null, `telemetry_${devId}_${Date.now()}.bin`);
    }
});
const upload = multer({ storage });

// --- SERVER ---
const app = express();
app.use(cors());
app.use(compression());

app.use((req, res, next) => {
    if (req.path === '/' || req.path.startsWith('/socket.io') || req.path.startsWith('/v1/telemetry/download')) return next();
    if ((req.headers['x-api-key'] || "").trim() !== API_KEY) return res.sendStatus(401);
    next();
});

// Devices
app.get('/v1/devices', (req, res) => res.json(Object.values(devices)));
app.get('/v1/devices/:id', (req, res) => {
    const id = normalizeId(req.params.id);
    if (id && devices[id]) res.json(devices[id]);
    else res.sendStatus(404);
});

// Location Updates
app.post('/v1/location', bodyParser.raw({ type: 'application/x-protobuf', limit: '1mb' }), bodyParser.json(), async (req, res) => {
    try {
        let raw = req.body;
        if (Buffer.isBuffer(req.body)) raw = LocationUpdateProto.toObject(LocationUpdateProto.decode(req.body), { defaults: false, longs: Number });
        const id = normalizeId(raw.device_id || raw.deviceId);
        if (id) { const dev = await updateDevice(id, raw); pushUpdate(dev); await fs.writeFile(DATA_FILE, JSON.stringify(devices, null, 2)); }
        res.sendStatus(200);
    } catch(e){ res.sendStatus(400); }
});

app.post('/v1/location/batch', bodyParser.raw({ type: 'application/x-protobuf', limit: '5mb' }), async (req, res) => {
    try {
        const decoded = LocationBatchProto.decode(req.body);
        const batch = LocationBatchProto.toObject(decoded, { defaults: false, longs: Number });
        if (batch.updates) {
            for (const up of batch.updates) {
                const id = normalizeId(up.device_id || up.deviceId);
                if (id) await updateDevice(id, up);
            }
            await fs.writeFile(DATA_FILE, JSON.stringify(devices, null, 2));
            // Trigger UI update for the last point in batch
            const last = batch.updates[batch.updates.length - 1];
            pushUpdate(devices[normalizeId(last.device_id || last.deviceId)]);
        }
        res.sendStatus(200);
    } catch(e){ res.sendStatus(400); }
});

app.post('/v1/location/clear/:id', (req, res) => res.sendStatus(200)); // Stub

// Control
app.post('/v1/devices/:id/alarm', async (req, res) => {
    const id = normalizeId(req.params.id);
    if (id && devices[id]) {
        const active = req.query.active === 'true';
        if (devices[id].alarmActive !== active) {
            devices[id].alarmActive = active; pushUpdate(devices[id]);
            const p = { type: active ? 'alarm' : 'stop_alarm', deviceId: id, message: active ? "Alarm!" : "Stop" };
            sendFcm(id, p);
            Object.values(devices).forEach(t => { if(t.fcmToken && t.deviceId !== id) sendFcm(t.deviceId, p); });
        }
    }
    res.sendStatus(200);
});

app.post('/v1/devices/:id/wakeup', async (req, res) => {
    const id = normalizeId(req.params.id);
    if (id) sendFcm(id, { type: 'wakeup', deviceId: id });
    res.sendStatus(200);
});

app.post('/v1/devices/wakeup-all', async (req, res) => {
    Object.keys(devices).forEach(id => sendFcm(id, { type: 'wakeup', deviceId: id }));
    res.sendStatus(200);
});

app.post('/v1/devices/:id/break-lock', async (req, res) => {
    const id = normalizeId(req.params.id);
    if (id && devices[id]) {
        await updateDevice(id, { forceUnlock: true, isLocked: false, alarmActive: false });
        sendFcm(id, { type: 'break_lock', deviceId: id });
        pushUpdate(devices[id]); // Immediate broadcast of new state
    }
    res.sendStatus(200);
});

app.post('/v1/devices/:id/watch', async (req, res) => {
    const id = normalizeId(req.params.id);
    const watcherId = req.query.watcherId;
    if (id && devices[id]) {
        devices[id].isWatched = true;
        devices[id].watcherName = req.query.watcherName || "Oliver";
        pushUpdate(devices[id]);
        sendFcm(id, { type: 'wakeup', deviceId: id, reason: 'watched' });
    }
    res.sendStatus(200);
});

app.post('/v1/devices/:id/unwatch', async (req, res) => {
    const id = normalizeId(req.params.id);
    if (id && devices[id]) { devices[id].isWatched = false; pushUpdate(devices[id]); }
    res.sendStatus(200);
});

// Telemetry
app.post('/v1/telemetry/upload', upload.single('file'), (req, res) => res.sendStatus(200));
app.get('/v1/telemetry/download/:id', async (req, res) => {
    const files = await fs.readdir(TELEMETRY_DIR);
    const target = files.sort().reverse().find(f => f.includes(`telemetry_${normalizeId(req.params.id)}`));
    if (target) res.sendFile(path.join(TELEMETRY_DIR, target));
    else res.sendStatus(404);
});
app.post('/v1/devices/:id/request-telemetry', (req, res) => {
    sendFcm(normalizeId(req.params.id), { type: 'request_telemetry' });
    res.sendStatus(200);
});

// Geofences
app.get('/v1/geofences', (req, res) => res.json(Object.values(geofences)));
app.post('/v1/geofences', bodyParser.json(), async (req, res) => {
    const gf = req.body;
    if (gf && gf.id) {
        geofences[gf.id] = gf;
        await fs.writeFile(GEOFENCE_FILE, JSON.stringify(geofences, null, 2));
        pushUpdate(null, 'reload_geofences');
        res.sendStatus(200);
    } else res.sendStatus(400);
});
app.delete('/v1/geofences/:id', async (req, res) => {
    const id = req.params.id;
    if (id && geofences[id]) {
        delete geofences[id];
        await fs.writeFile(GEOFENCE_FILE, JSON.stringify(geofences, null, 2));
        pushUpdate(null, 'reload_geofences');
    }
    res.sendStatus(200);
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const grpcServer = new grpc.Server();
grpcServer.addService(trackingProto.TrackingService.service, {
    GetDevices: (call, cb) => {
        if (call.metadata.get('x-api-key')?.[0] !== API_KEY) return cb({ code: grpc.status.UNAUTHENTICATED });
        cb(null, { devices: Object.values(devices).map(mapToProto) });
    },
    TrackLocation: (call) => {
        if (call.metadata.get('x-api-key')?.[0] !== API_KEY) return call.end();
        const sid = crypto.randomUUID(); grpcStreams.set(sid, call);
        call.on('data', async (ev) => {
            const up = ev.location_update; if (!up) return;
            const id = normalizeId(up.device_id || up.deviceId);
            if (id) { const dev = await updateDevice(id, up); pushUpdate(dev); }
        });
        call.on('end', () => grpcStreams.delete(sid));
        call.on('error', () => grpcStreams.delete(sid));
    }
});

async function initFirebase() {
    try {
        const envKey = process.env.FIREBASE_SERVICE_ACCOUNT || process.env.firebase_service_account;
        if (envKey) admin.initializeApp({ credential: admin.credential.cert(JSON.parse(envKey)) });
    } catch(e){ console.error("❌ Firebase Failed"); }
}

async function start() {
    try { devices = JSON.parse(await fs.readFile(DATA_FILE, 'utf8')); } catch(e){ devices = {}; }
    try { geofences = JSON.parse(await fs.readFile(GEOFENCE_FILE, 'utf8')); } catch(e){ geofences = {}; }
    await initFirebase();
    server.listen(PORT, () => console.log(`🚀 Port ${PORT}`));
    grpcServer.bindAsync(`0.0.0.0:${GRPC_PORT}`, grpc.ServerCredentials.createInsecure(), (err, port) => {
        if (!err) grpcServer.start();
    });
}
start();
