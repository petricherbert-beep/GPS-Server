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
import rateLimit from 'express-rate-limit';

import compression from 'compression';
import { z } from 'zod';

// --- 🪵 LOGGING ---
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const log = (level, ...args) => {
    if (level === 'error') return console.error(`[ERROR]`, ...args);
    if (LOG_LEVEL === 'debug' || (LOG_LEVEL === 'info' && level === 'info')) {
        console.log(`[${level.toUpperCase()}]`, ...args);
    }
};

// --- 🧱 TOP-LEVEL CRASH PROTECTION ---
process.on("uncaughtException", (err) => {
    log("error", "💥 UNCAUGHT EXCEPTION:", err);
});

process.on("unhandledRejection", (err) => {
    log("error", "💥 UNHANDLED PROMISE REJECTION:", err);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- STRENGE KONFIGURATION ---
if (!process.env.API_KEY) {
    console.error("❌ KRITISCH: API_KEY fehlt! Server-Start abgebrochen.");
    process.exit(1);
}
const API_KEY = process.env.API_KEY;
const PORT = process.env.PORT || 3000;
const GRPC_PORT = process.env.GRPC_PORT || 50051;
const DATA_FILE = path.join(__dirname, 'devices.json');
const GEOFENCE_FILE = path.join(__dirname, 'geofences.json');

// --- PROTOBUF DEFINITION ---
const PROTO_PATH = path.join(__dirname, 'tracking.proto');
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: Number,
    enums: String,
    defaults: false,
    oneofs: true
});
const trackingProto = grpc.loadPackageDefinition(packageDefinition).tracking;

const protoSource = await fs.readFile(PROTO_PATH, 'utf8');
const root = protobuf.parse(protoSource).root;
const LocationUpdateProto = root.lookupType("LocationUpdateProto");
const LocationBatchProto = root.lookupType("LocationBatchProto");
const DeviceLocationProto = root.lookupType("DeviceLocationProto");
const DeviceListProto = root.lookupType("DeviceListProto");

// --- SCHEMA VALIDATION ---
const locationSchema = z.object({
    deviceId: z.string(),
    lat: z.number().min(-90).max(90).optional(),
    lon: z.number().min(-180).max(180).optional(),
    timestamp: z.number().optional(),
    accuracy: z.number().optional(),
    speed: z.number().optional(),
    bearing: z.number().optional(),
    battery: z.number().optional(),
    fcmToken: z.string().optional(),
    alarmActive: z.boolean().optional(),
    accident: z.boolean().optional(),
    isLocked: z.boolean().optional(),
    isMotion: z.boolean().optional(),
    isWifi: z.boolean().optional(),
    motionState: z.string().optional(),
    geofenceEvent: z.string().optional(),
    name: z.string().optional()
});

const batchSchema = z.array(locationSchema);

// --- 🛡️ HELPER: SAFE REQUEST WRAPPER ---
const safe = fn => (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(err => {
        console.error("🔥 ROUTE ERROR:", err);
        if (!res.headersSent) res.sendStatus(500);
    });

// --- STATE ---
let devices = {};
let geofences = [];
let lastPushTimes = {};
const grpcStreams = new Set();
let devicesDirty = false;

// --- 🛡️ UTILS ---
async function withTimeout(promise, ms = 10000) {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("Timeout")), ms);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

// --- gRPC HELPERS ---
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

    if (device.geofenceEvent && (device.geofenceEvent.startsWith('enter:') || device.geofenceEvent.startsWith('exit:'))) {
        log("info", `🚩 GEOFENCE EVENT: ${device.deviceId} -> ${device.geofenceEvent}`);
    }
    if (device.alarmActive) log("info", `🔊 ALARM ACTIVE: ${device.deviceId}`);
    if (device.accident) log("info", `🚨 ACCIDENT ALERT: ${device.deviceId}`);

    for (const call of grpcStreams) {
        try {
            if (!call || call.destroyed || call.writableEnded) { grpcStreams.delete(call); continue; }
            const ok = call.write(response);
            if (!ok) {
                call._pendingWrites = (call._pendingWrites || 0) + 1;
                if (call._pendingWrites > 100) { call.end(); grpcStreams.delete(call); }
            } else { call._pendingWrites = 0; }
        } catch (e) { grpcStreams.delete(call); }
    }
}

function broadcastGeofenceReload() {
    for (const call of grpcStreams) {
        try { if (!call.destroyed) call.write({ reload_geofences: true }); }
        catch (e) { grpcStreams.delete(call); }
    }
}

// --- FIREBASE ---
async function initFirebase() {
    try {
        const envKey = process.env.FIREBASE_SERVICE_ACCOUNT || process.env.firebase_service_account;
        const serviceAccount = envKey ? JSON.parse(envKey) : JSON.parse(await fs.readFile(path.join(__dirname, 'firebase-key.json'), 'utf8'));
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        log("info", "✅ Firebase Admin aktiv.");
    } catch (e) { log("error", "❌ Firebase Fehler:", e.message); throw e; }
}

const app = express();
app.set('trust proxy', 1);
app.use(compression());
app.use(cors({ origin: "*" }));

// --- 🛡️ RATE LIMITING ---
app.use('/location', rateLimit({ windowMs: 60000, max: 2000, skipSuccessfulRequests: true }));
app.use(['/devices', '/geofences'], rateLimit({ windowMs: 60000, max: 120 }));

// --- gRPC SERVER ---
const grpcServer = new grpc.Server();
grpcServer.addService(trackingProto.TrackingService.service, {
    GetDevices: (call, callback) => {
        const meta = call.metadata.get('x-api-key');
        if (meta?.[0] !== API_KEY) return callback({ code: grpc.status.UNAUTHENTICATED, details: "Invalid API Key" });
        callback(null, { devices: Object.values(devices || {}) });
    },
    TrackLocation: (call) => {
        const meta = call.metadata.get('x-api-key');
        if (meta?.[0] !== API_KEY) { call.emit('error', { code: grpc.status.UNAUTHENTICATED }); return call.end(); }
        if (grpcStreams.size >= 1000) return call.end();

        call.lastActivity = Date.now();
        call.msgCount = 0;
        grpcStreams.add(call);

        const rateLimitInterval = setInterval(() => { call.msgCount = 0; }, 1000);
        const cleanup = () => {
            clearInterval(rateLimitInterval);
            grpcStreams.delete(call);
        };

        call.on('data', (event) => {
            if (!call || call.destroyed) return;
            call.lastActivity = Date.now();

            // 🔥 gRPC FLOOD PROTECTION
            call.msgCount++;
            if (call.msgCount > 100) {
                log("error", `⚠️ gRPC Flood from ${call.deviceId}, ending stream.`);
                call.end();
                return;
            }

            const update = event.location_update;
            if (!update) return;
            const data = mapProtoToApp(update);
            const id = data.deviceId?.toLowerCase();
            if (id) {
                for (const old of grpcStreams) { if (old !== call && old.deviceId === id) { try { old.end(); } catch {} grpcStreams.delete(old); } }
                call.deviceId = id;
                updateDevice(id, data);
                saveDevicesSafe({ immediate: data.alarmActive || data.accident });
                const updated = devices[id];
                if (updated) pushUpdateToAll(updated);
            }
        });
        call.on('end', cleanup); call.on('error', cleanup); call.on('close', cleanup);
    }
});

// Watchdogs & Cleanups
setInterval(() => {
    const now = Date.now();
    for (const call of grpcStreams) {
        if (call.destroyed || call.writableEnded || now - (call.lastActivity || 0) > 300000) {
            try { call.end(); } catch {} grpcStreams.delete(call);
        }
    }
}, 60000);

// 🔥 lastPushTimes TTL Cleanup
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of Object.entries(lastPushTimes)) {
        if (now - v > 3600000) delete lastPushTimes[k]; // 1h TTL
    }
}, 600000);

// 🔥 Device Expiration (7 days)
setInterval(() => {
    const now = Date.now();
    let expiredCount = 0;
    for (const [id, d] of Object.entries(devices)) {
        if (now - (d.lastSeen || 0) > 7 * 24 * 3600000) {
            delete devices[id]; expiredCount++;
        }
    }
    if (expiredCount > 0) { devicesDirty = true; log("info", `🧹 Expired ${expiredCount} inactive devices.`); }
}, 3600000);

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

io.use((socket, next) => {
    if ((socket.handshake.auth?.apiKey || socket.handshake.query?.apiKey) !== API_KEY) return next(new Error("Unauthorized"));
    next();
});

io.on('connection', (socket) => {
    socket.on('join_device', (data) => {
        const id = (typeof data === 'string' ? data : data?.deviceId)?.toLowerCase().trim();
        if (id) { socket.join(id); if (devices[id]) socket.emit('location_update', devices[id]); }
    });
    // 🔥 Socket Cleanup
    socket.on('disconnect', () => { socket.removeAllListeners(); });
});

// --- REST ROUTES ---
app.use((req, res, next) => {
    if (req.path === '/' || req.path.startsWith('/socket.io')) return next();
    if (req.headers['x-api-key'] !== API_KEY) return res.sendStatus(401);
    next();
});

app.use(bodyParser.json({ limit: '200kb' }));
app.use(bodyParser.raw({ type: 'application/x-protobuf', limit: '200kb' }));

app.get('/', (req, res) => res.send('🚀 GPS Server is running.'));

app.post(['/location', '/v1/location'], safe(async (req, res) => {
    let data = req.body;
    if (Buffer.isBuffer(req.body) && req.body.length > 0) {
        data = mapProtoToApp(LocationUpdateProto.toObject(LocationUpdateProto.decode(req.body), { defaults: false, longs: Number }));
    }
    const val = locationSchema.safeParse(data);
    if (!val.success) return res.status(400).json(val.error.format());
    data = val.data;
    const id = data.deviceId.toLowerCase();
    updateDevice(id, data);
    saveDevicesSafe();
    if (devices[id]) pushUpdateToAll(devices[id]);
    res.sendStatus(200);
}));

app.post(['/location/update-batch', '/v1/location/batch'], safe(async (req, res) => {
    let batch = Buffer.isBuffer(req.body) ? (LocationBatchProto.decode(req.body).updates || []).map(u => mapProtoToApp(LocationUpdateProto.toObject(u, { defaults: false, longs: Number }))) : req.body;
    const val = batchSchema.safeParse(batch);
    if (!val.success) return res.status(400).json(val.error.format());
    batch = val.data;
    batch.forEach(item => { const id = item.deviceId?.toLowerCase(); if (id) updateDevice(id, item); });
    saveDevicesSafe();
    if (batch.length > 0 && batch[0].deviceId) { const up = devices[batch[0].deviceId.toLowerCase()]; if (up) pushUpdateToAll(up); }
    res.sendStatus(200);
}));

app.get(['/devices', '/v1/devices'], safe((req, res) => {
    const list = Object.values(devices || {});
    if (req.headers['accept']?.includes('application/x-protobuf')) {
        return res.setHeader('Content-Type', 'application/x-protobuf').send(DeviceListProto.encode(DeviceListProto.create({ devices: list.map(d => mapAppToProto(d)) })).finish());
    }
    res.json(list);
}));

app.get(['/devices/:id', '/v1/devices/:id'], safe((req, res) => {
    const d = devices?.[req.params.id.toLowerCase()];
    if (!d) return res.sendStatus(404);
    if (req.headers['accept']?.includes('application/x-protobuf')) {
        return res.setHeader('Content-Type', 'application/x-protobuf').send(DeviceLocationProto.encode(DeviceLocationProto.create(mapAppToProto(d))).finish());
    }
    res.json(d);
}));

app.post(['/devices/:id/alarm', '/v1/devices/:id/alarm'], safe(async (req, res) => {
    const id = req.params.id.toLowerCase();
    const d = devices?.[id];
    if (!d) return res.sendStatus(404);
    d.alarmActive = req.query.active === 'true';
    saveDevicesSafe({ immediate: true });
    pushUpdateToAll(d);

    const helpersPayload = { type: 'alarm', deviceId: id, message: `${d.name || id} braucht Hilfe!`, deviceName: d.name || id };

    // --- 🛡️ SAFE BROADCAST TO HELPERS ---
    Object.values(devices).forEach(target => {
        if (target.fcmToken && target.deviceId !== id && target.deviceId !== req.query.triggererId?.toLowerCase()) {
            admin.messaging().send({ data: helpersPayload, token: target.fcmToken })
                .catch(e => console.warn(`⚠️ Helper FCM failed for ${target.deviceId}:`, e.message));
        }
    });

    // --- 🛡️ SAFE DIRECT ALARM TO TARGET ---
    if (d.alarmActive && d.fcmToken) {
        admin.messaging().send({
            data: { ...helpersPayload, message: "Fernauslösung: Alarm aktiviert!" },
            token: d.fcmToken,
            android: { priority: 'high' }
        }).catch(e => console.warn(`⚠️ Direct Alarm FCM failed for ${id}:`, e.message));
    }

    io.to(id).emit('command', { deviceId: id, action: d.alarmActive ? 'START_ALARM' : 'STOP_ALARM' });
    res.sendStatus(200);
}));

app.post(['/devices/:id/watch', '/v1/devices/:id/watch'], safe(async (req, res) => {
    const d = devices?.[req.params.id.toLowerCase()];
    if (!d) return res.sendStatus(404);
    d.isWatched = true; d.watcherName = req.query.watcherName || "Jemand";

    if (d.fcmToken) {
        admin.messaging().send({
            data: { type: 'watch_state', state: 'true', watcherName: d.watcherName, targetId: d.deviceId },
            token: d.fcmToken,
            android: { priority: 'high' }
        }).catch(e => console.warn(`⚠️ Watch Notification failed:`, e.message));
    }
    res.sendStatus(200);
}));

app.post(['/devices/:id/unwatch', '/v1/devices/:id/unwatch'], safe(async (req, res) => {
    const d = devices?.[req.params.id.toLowerCase()];
    if (!d) return res.sendStatus(404);
    d.isWatched = false; delete d.watcherName;

    if (d.fcmToken) {
        admin.messaging().send({
            data: { type: 'watch_state', state: 'false' },
            token: d.fcmToken
        }).catch(e => console.warn(`⚠️ Unwatch Notification failed:`, e.message));
    }
    res.sendStatus(200);
}));

app.post(['/devices/:id/break-lock', '/v1/devices/:id/break-lock'], safe(async (req, res) => {
    const id = req.params.id.toLowerCase();
    const d = devices?.[id];
    if (!d) return res.sendStatus(404);

    if (d.fcmToken) {
        admin.messaging().send({
            data: { type: 'break_lock', deviceId: id },
            token: d.fcmToken,
            android: { priority: 'high' }
        }).then(() => log("info", `🔓 Break Lock sent to ${id}`))
          .catch(e => log("error", `⚠️ Break Lock FCM failed for ${id}:`, e.message));
    }
    res.sendStatus(200);
}));

app.get(['/geofences', '/v1/geofences'], safe((req, res) => res.json(geofences || [])));
app.post(['/geofences', '/v1/geofences'], safe(async (req, res) => {
    if (!req.body?.id) return res.sendStatus(400);
    geofences = (geofences || []).filter(item => item.id !== req.body.id);
    geofences.push(req.body);
    await queueWrite(GEOFENCE_FILE, JSON.stringify(geofences, null, 2));
    broadcastGeofenceReload(); res.sendStatus(200);
}));

app.delete(['/geofences/:id', '/v1/geofences/:id'], safe(async (req, res) => {
    geofences = (geofences || []).filter(item => item.id !== req.params.id);
    await queueWrite(GEOFENCE_FILE, JSON.stringify(geofences, null, 2));
    broadcastGeofenceReload(); res.sendStatus(200);
}));

// --- PERSISTENCE ---
let writeQueue = Promise.resolve();
function queueWrite(file, data) {
    writeQueue = writeQueue.then(async () => {
        try {
            const tmp = file + '.tmp';
            await fs.writeFile(tmp, data); await fs.rename(tmp, file);
        } catch (e) {
            console.error(`💾 WRITE ERROR [${file}]:`, e.message);
        }
    });
    return writeQueue;
}

let saveTimer = null; let savePending = false;
function saveDevicesSafe(opts = { immediate: false }) {
    if (!devicesDirty && !opts.forceSave && !opts.immediate) return;
    savePending = true;

    // 1. SOFORT-MODUS: Bei Alarmen oder kritischen Statusänderungen
    if (opts.immediate || opts.forceSave) {
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = null;
        savePending = false;
        devicesDirty = false;
        return queueWrite(DATA_FILE, JSON.stringify(devices, null, 2))
            .then(() => log("debug", "🔥 Critical Flush: Data persisted immediately."));
    }

    // 2. DEBOUNCED-MODUS: Normales Sammeln von Updates
    if (saveTimer) return; // Timer läuft bereits

    saveTimer = setTimeout(async () => {
        saveTimer = null;
        if (!savePending) return;
        savePending = false;
        devicesDirty = false;
        await queueWrite(DATA_FILE, JSON.stringify(devices, null, 2));
        log("debug", "💾 Periodic Save: Device state persisted.");
    }, 10000); // 10s Puffer
}

async function init() {
    try {
        const raw = await fs.readFile(DATA_FILE, 'utf8');
        devices = JSON.parse(raw);
    } catch (e) {
        console.warn("⚠️ devices.json load failed, using empty state:", e.message);
        devices = {};
    }
    try {
        const rawGf = await fs.readFile(GEOFENCE_FILE, 'utf8');
        geofences = JSON.parse(rawGf);
    } catch (e) {
        console.warn("⚠️ geofences.json load failed, using empty state:", e.message);
        geofences = [];
    }
}

function updateDevice(id, data) {
    const old = devices[id] || {};

    // 🔥 CLOCK DRIFT PROTECTION: Allow small backward drift, but reject major jumps
    if (old.timestamp && data.timestamp && data.timestamp < old.timestamp - 60000) return;

    // 🔥 TOKEN PROTECTION: Don't overwrite with empty values
    const fcmToken = (data.fcmToken || data.fcm_token) || old.fcmToken;
    const name = data.name || old.name;

    const alarmActive = (old.alarmActive && !data.alarmActive && Date.now() - (old.lastSeen || 0) < 30000) ? true : data.alarmActive;

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
    const tokens = Object.values(devices)
        .filter(d => d.deviceId !== senderId && d.fcmToken && d.fcmToken.length > 5)
        .map(d => d.fcmToken);

    if (tokens.length === 0) {
        log("debug", `ℹ️ BCast: No target tokens for event ${payload.type}`);
        return;
    }

    log("info", `📣 Broadcasting ${payload.type} to ${tokens.length} devices...`);

    for (let i = 0; i < tokens.length; i += 500) {
        try {
            // 🔥 FCM TIMEOUT GUARD
            await withTimeout(admin.messaging().sendEachForMulticast({
                data: payload,
                tokens: tokens.slice(i, i + 500),
                android: { priority: 'high' }
            }), 15000);

            // Note: Response processing omitted for brevity as requested by user's cleanup logic
        } catch (e) { log("error", "🚨 BCast FCM Error:", e.message); }
    }
}

async function startServer() {
    try {
        await initFirebase(); await init();
        app.disable('x-powered-by');
        const webServer = server.listen(PORT, () => log("info", `🚀 GPS Server Port ${PORT}`));

        // 🔥 Server Timeouts (DoS Protection)
        webServer.headersTimeout = 5000;
        webServer.requestTimeout = 10000;

        grpcServer.bindAsync(`0.0.0.0:${GRPC_PORT}`, grpc.ServerCredentials.createInsecure(), (err, p) => {
            if (!err) log("info", `📡 gRPC Port ${p}`);
        });
    } catch (e) { log("error", "💥 FATAL:", e); process.exit(1); }
}
startServer();
