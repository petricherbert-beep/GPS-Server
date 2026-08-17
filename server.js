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

/**
 * 🔥 V374: Structural Stability & Contract Hardening
 * - Persistence Migration (camelCase to snake_case) on startup with immediate write.
 * - Smart Merging: Only update provided fields; protect name/fcm_token from null overwrite.
 * - Socket.IO camelCase Contract: Restored for client compatibility.
 * - Alarm Semantics: Siren for target, Notification for remote devices.
 * - Robust gRPC: Proper error status (UNAUTHENTICATED) and identity checks.
 */

process.on("uncaughtException", (err) => { console.error("💥 UNCAUGHT EXCEPTION:", err); });
process.on("unhandledRejection", (err) => { console.error("💥 UNHANDLED REJECTION:", err); });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const API_KEY = (process.env.API_KEY || "test").trim();
const PORT = process.env.PORT || 3000;
const GRPC_PORT = process.env.GRPC_PORT || 50051;
const DATA_FILE = path.join(__dirname, 'devices.json');
const GEOFENCE_FILE = path.join(__dirname, 'geofences.json');
const TELEMETRY_DIR = path.join(__dirname, 'telemetry');

await fs.mkdir(TELEMETRY_DIR, { recursive: true }).catch(() => {});

let devices = {};
let geofences = {};
let firebaseReady = false;
const grpcStreams = new Map();

// --- PROTOBUF ---
const PROTO_PATH = path.join(__dirname, 'tracking.proto');
const packageDefinition = protoLoader.loadSync(PROTO_PATH, { keepCase: true, longs: Number, enums: String, defaults: false, oneofs: true });
const trackingProto = grpc.loadPackageDefinition(packageDefinition).tracking;
const root = protobuf.parse(await fs.readFile(PROTO_PATH, 'utf8')).root;

const LocationUpdateProto = root.lookupType("tracking.LocationUpdateProto");
const DeviceLocationProto = root.lookupType("tracking.DeviceLocationProto");
const LocationBatchProto = root.lookupType("tracking.LocationBatchProto");
const TrackingEventProto = root.lookupType("tracking.TrackingEvent");

// --- HELPERS ---
function normalizeId(id) { return id ? id.trim().toLowerCase() : null; }
function hasValue(v) { return v !== undefined && v !== null && v !== ''; }

function robustBool(v) {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') return v.toLowerCase() === 'true';
    return Number(v) === 1;
}

async function saveDevices() {
    try { await fs.writeFile(DATA_FILE, JSON.stringify(devices, null, 2)); }
    catch(e) { console.error("Failed to save devices:", e.message); }
}

/**
 * Maps internal snake_case storage to camelCase for Socket.IO clients.
 */
function toClientDevice(d = {}) {
    return {
        deviceId: d.device_id || "",
        name: d.name || "",
        lat: Number(d.lat ?? 0),
        lon: Number(d.lon ?? 0),
        battery: d.battery,
        alarmActive: !!d.alarm_active,
        isLocked: !!d.is_locked,
        isWatched: !!d.is_watched,
        fcmToken: d.fcm_token || "",
        geofenceEvent: d.geofence_event || "",
        motionState: d.motion_state || "STILL",
        sats: d.sats,
        visualLat: d.visual_lat,
        visualLon: d.visual_lon,
        offline: !!d.offline,
        status: d.status || "online",
        watcherName: d.watcher_name || "",
        isAwake: !!d.is_awake,
        pointId: d.point_id || "",
        intermediateCoords: Array.isArray(d.intermediate_coords) ? d.intermediate_coords : [],
        color: d.color,
        timestamp: d.timestamp,
        lastSeen: d.lastSeen
    };
}

/**
 * Partial update logic: Only apply fields that are explicitly provided in the 'raw' object.
 * This preserves metadata (name, tokens) during location-only updates.
 */
function applySmartUpdate(old = {}, raw = {}, updateLastSeen = true) {
    const d = { ...old };
    const id = normalizeId(raw.device_id || raw.deviceId);
    if (!id) return null;

    d.device_id = id;
    if (raw.name !== undefined) d.name = raw.name;
    if (raw.lat !== undefined) d.lat = Number(raw.lat);
    if (raw.lon !== undefined) d.lon = Number(raw.lon);

    // Optional Booleans
    if (raw.alarm_active !== undefined) d.alarm_active = robustBool(raw.alarm_active);
    else if (raw.alarmActive !== undefined) d.alarm_active = robustBool(raw.alarmActive);

    if (raw.is_locked !== undefined) d.is_locked = robustBool(raw.is_locked);
    else if (raw.isLocked !== undefined) d.is_locked = robustBool(raw.isLocked);

    if (raw.is_watched !== undefined) d.is_watched = robustBool(raw.is_watched);
    else if (raw.isWatched !== undefined) d.is_watched = robustBool(raw.isWatched);

    if (raw.offline !== undefined) d.offline = robustBool(raw.offline);

    if (raw.is_awake !== undefined) d.is_awake = robustBool(raw.is_awake);
    else if (raw.isAwake !== undefined) d.is_awake = robustBool(raw.isAwake);

    // Strings
    const fcm = raw.fcm_token ?? raw.fcmToken;
    if (fcm !== undefined) d.fcm_token = fcm;

    const gf = raw.geofence_event ?? raw.geofenceEvent;
    if (gf !== undefined) d.geofence_event = gf;

    const motion = raw.motion_state ?? raw.motionState;
    if (motion !== undefined) d.motion_state = motion;

    if (raw.status !== undefined) d.status = raw.status;

    const watcher = raw.watcher_name ?? raw.watcherName;
    if (watcher !== undefined) d.watcher_name = watcher;

    const point = raw.point_id ?? raw.pointId;
    if (point !== undefined) d.point_id = point;

    // Numbers
    if (raw.battery !== undefined) d.battery = Math.round(Number(raw.battery));
    if (raw.speed !== undefined) d.speed = Number(raw.speed);
    if (raw.bearing !== undefined) d.bearing = Number(raw.bearing);
    if (raw.accuracy !== undefined) d.accuracy = Number(raw.accuracy);
    if (raw.sats !== undefined) d.sats = Math.round(Number(raw.sats));
    if (raw.temperature !== undefined) d.temperature = Number(raw.temperature);
    if (raw.color !== undefined) d.color = Math.round(Number(raw.color));
    if (raw.timestamp !== undefined) d.timestamp = Number(raw.timestamp);

    const vLat = raw.visual_lat ?? raw.visualLat;
    const vLon = raw.visual_lon ?? raw.visualLon;
    if (vLat !== undefined) d.visual_lat = Number(vLat);
    if (vLon !== undefined) d.visual_lon = Number(vLon);

    const coords = raw.intermediate_coords || raw.intermediatePoints;
    if (Array.isArray(coords)) d.intermediate_coords = coords.map(Number);

    if (updateLastSeen) d.lastSeen = Date.now();

    return d;
}

function pushUpdate(device, signal = null) {
    if (device) {
        io.to(device.device_id).emit('location_update', toClientDevice(device));
    }
    if (signal === 'reload_geofences') io.emit('reload_geofences', true);

    const eventPayload = {
        device_id: device ? device.device_id : "system",
        timestamp: Date.now()
    };

    if (signal === 'reload_geofences') {
        eventPayload.server_response = { reload_geofences: true };
    } else if (device) {
        eventPayload.server_response = { device: device };
    }

    const message = TrackingEventProto.create(eventPayload);
    for (const [sid, call] of grpcStreams) {
        try { if (!call.destroyed) call.write(message); else grpcStreams.delete(sid); }
        catch(e){ grpcStreams.delete(sid); }
    }
}

async function sendFcm(targetId, payload) {
    if (!firebaseReady) return;
    const dev = devices[targetId];
    if (!dev?.fcm_token) return;
    try {
        const stringData = Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, String(v ?? '')]));
        await admin.messaging().send({ token: dev.fcm_token, data: stringData, android: { priority: 'high' } });
    } catch (e) { console.error(`FCM Failed for ${targetId}:`, e.message); }
}

// --- APP & STORAGE ---
const storage = multer.diskStorage({
    destination: TELEMETRY_DIR,
    filename: (req, file, cb) => {
        const devId = normalizeId(req.headers['x-device-id']) || "unknown";
        cb(null, `telemetry_${devId}_${Date.now()}.bin`);
    }
});
const upload = multer({ storage });

const app = express();
app.use(cors());
app.use(compression());

app.use((req, res, next) => {
    if (req.path === '/' || req.path.startsWith('/socket.io')) return next();
    if ((req.headers['x-api-key'] || "").trim() !== API_KEY) return res.sendStatus(401);
    next();
});

app.get('/v1/devices', (req, res) => res.json(Object.values(devices).map(toClientDevice)));
app.get('/v1/devices/:id', (req, res) => {
    const id = normalizeId(req.params.id);
    if (id && devices[id]) res.json(toClientDevice(devices[id]));
    else res.sendStatus(404);
});

app.post('/v1/location', bodyParser.raw({ type: 'application/x-protobuf', limit: '1mb' }), bodyParser.json(), async (req, res) => {
    try {
        let raw = req.body;
        if (Buffer.isBuffer(raw)) raw = LocationUpdateProto.toObject(LocationUpdateProto.decode(raw), { defaults: false, longs: Number });
        const id = normalizeId(raw.device_id || raw.deviceId);
        if (id) {
            const updated = applySmartUpdate(devices[id] || {}, raw);
            if (updated) { devices[id] = updated; pushUpdate(updated); await saveDevices(); }
            res.sendStatus(200);
        } else res.sendStatus(400);
    } catch(e){ res.sendStatus(400); }
});

app.post('/v1/location/batch', bodyParser.raw({ type: 'application/x-protobuf', limit: '5mb' }), async (req, res) => {
    try {
        const decoded = LocationBatchProto.decode(req.body);
        const batch = LocationBatchProto.toObject(decoded, { defaults: false, longs: Number });
        let changed = false;
        if (batch.updates) {
            for (const up of batch.updates) {
                const id = normalizeId(up.device_id);
                if (id) {
                    const updated = applySmartUpdate(devices[id] || {}, up);
                    if (updated) { devices[id] = updated; pushUpdate(updated); changed = true; }
                }
            }
            if (changed) await saveDevices();
        }
        res.sendStatus(200);
    } catch(e){ res.sendStatus(400); }
});

app.post('/v1/devices/:id/alarm', async (req, res) => {
    const id = normalizeId(req.params.id);
    if (id && devices[id]) {
        const active = req.query.active === 'true';
        if (devices[id].alarm_active !== active) {
            devices[id].alarm_active = active; pushUpdate(devices[id]);
            await sendFcm(id, { type: active ? 'alarm' : 'stop_alarm', deviceId: id, message: active ? "Alarm!" : "Stop" });
            if (active) {
                const notify = { type: 'remote_alarm_start', deviceId: id, name: devices[id].name || "Gerät", title: "ALARM!", message: `${devices[id].name || id} hat einen Alarm!` };
                Object.values(devices).forEach(t => { if(t.fcm_token && t.device_id !== id) sendFcm(t.device_id, notify); });
            }
            await saveDevices();
        }
    }
    res.sendStatus(200);
});

app.post('/v1/devices/:id/wakeup', async (req, res) => {
    const id = normalizeId(req.params.id);
    if (id) sendFcm(id, { type: 'wakeup', deviceId: id });
    res.sendStatus(200);
});

app.post('/v1/devices/:id/break-lock', async (req, res) => {
    const id = normalizeId(req.params.id);
    if (id && devices[id]) {
        devices[id].is_locked = false;
        devices[id].alarm_active = false;
        pushUpdate(devices[id]);
        sendFcm(id, { type: 'break_lock', deviceId: id });
        await saveDevices();
    }
    res.sendStatus(200);
});

app.post('/v1/devices/:id/watch', async (req, res) => {
    const id = normalizeId(req.params.id);
    if (id && devices[id]) {
        devices[id].is_watched = true;
        devices[id].watcher_name = req.query.watcherName || "Oliver";
        pushUpdate(devices[id]);
        sendFcm(id, { type: 'wakeup', deviceId: id, reason: 'watched' });
        await saveDevices();
    }
    res.sendStatus(200);
});

app.post('/v1/devices/:id/unwatch', async (req, res) => {
    const id = normalizeId(req.params.id);
    if (id && devices[id]) { devices[id].is_watched = false; pushUpdate(devices[id]); await saveDevices(); }
    res.sendStatus(200);
});

app.post('/v1/telemetry/upload', upload.single('file'), (req, res) => res.sendStatus(200));
app.get('/v1/telemetry/download/:id', async (req, res) => {
    const id = normalizeId(req.params.id);
    const files = await fs.readdir(TELEMETRY_DIR);
    const target = files.filter(f => f.startsWith(`telemetry_${id}_`)).sort().reverse()[0];
    if (target) res.sendFile(path.join(TELEMETRY_DIR, target));
    else res.sendStatus(404);
});
app.post('/v1/devices/:id/request-telemetry', (req, res) => {
    sendFcm(normalizeId(req.params.id), { type: 'request_telemetry' });
    res.sendStatus(200);
});

app.get('/v1/geofences', (req, res) => res.json(Object.values(geofences)));
app.post('/v1/geofences', bodyParser.json(), async (req, res) => {
    const gf = req.body;
    if (gf && gf.id) { geofences[gf.id] = gf; await fs.writeFile(GEOFENCE_FILE, JSON.stringify(geofences, null, 2)); pushUpdate(null, 'reload_geofences'); res.sendStatus(200); }
    else res.sendStatus(400);
});
app.delete('/v1/geofences/:id', async (req, res) => {
    const id = req.params.id;
    if (id && geofences[id]) { delete geofences[id]; await fs.writeFile(GEOFENCE_FILE, JSON.stringify(geofences, null, 2)); pushUpdate(null, 'reload_geofences'); }
    res.sendStatus(200);
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const grpcServer = new grpc.Server();
grpcServer.addService(trackingProto.TrackingService.service, {
    GetDevices: (call, cb) => {
        const metaKey = call.metadata.get('x-api-key')?.[0];
        const reqKey = call.request?.api_key;
        if (metaKey !== API_KEY && reqKey !== API_KEY) return cb({ code: grpc.status.UNAUTHENTICATED });
        cb(null, { devices: Object.values(devices).map(d => DeviceLocationProto.create(d)) });
    },
    TrackLocation: (call) => {
        if (call.metadata.get('x-api-key')?.[0] !== API_KEY) {
            call.destroy({ code: grpc.status.UNAUTHENTICATED, details: 'Invalid API key' });
            return;
        }
        const sid = crypto.randomUUID(); grpcStreams.set(sid, call);
        call.on('data', async (ev) => {
            const up = ev.location_update; if (!up) return;
            const id = normalizeId(up.device_id);
            if (id) {
                const updated = applySmartUpdate(devices[id] || {}, up);
                if (updated) { devices[id] = updated; pushUpdate(updated); await saveDevices(); }
            }
        });
        call.on('end', () => grpcStreams.delete(sid));
        call.on('error', () => grpcStreams.delete(sid));
    }
});

async function initFirebase() {
    try {
        const envKey = process.env.FIREBASE_SERVICE_ACCOUNT || process.env.firebase_service_account;
        if (envKey) {
            admin.initializeApp({ credential: admin.credential.cert(JSON.parse(envKey)) });
            firebaseReady = true;
            console.log("🔥 Firebase initialized.");
        } else console.warn("⚠️ Firebase Service Account missing.");
    } catch(e){ console.error("❌ Firebase Failed:", e.message); }
}

async function start() {
    try {
        const stored = JSON.parse(await fs.readFile(DATA_FILE, 'utf8'));
        const migrated = {};
        for (const [key, raw] of Object.entries(stored)) {
            const id = normalizeId(raw.device_id || raw.deviceId || key);
            if (!id) continue;
            const normalized = applySmartUpdate({}, raw, false);
            if (normalized) migrated[id] = { ...normalized, lastSeen: raw.lastSeen || Date.now() };
        }
        devices = migrated;
        await saveDevices();
        console.log(`📦 Loaded and migrated ${Object.keys(devices).length} devices.`);
    } catch(e){ devices = {}; }
    try { geofences = JSON.parse(await fs.readFile(GEOFENCE_FILE, 'utf8')); } catch(e){ geofences = {}; }
    await initFirebase();
    server.listen(PORT, () => console.log(`🚀 Port ${PORT}`));
    grpcServer.bindAsync(`0.0.0.0:${GRPC_PORT}`, grpc.ServerCredentials.createInsecure(), (err, port) => {
        if (!err) grpcServer.start();
    });
}
start();
