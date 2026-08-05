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
import crypto from 'crypto'; // 🔥 V302: For UUID and TimingSafeEqual

import compression from 'compression';
import { z } from 'zod';

// --- 🧱 TOP-LEVEL CRASH PROTECTION ---
process.on("uncaughtException", (err) => {
    console.error("💥 UNCAUGHT EXCEPTION:", err);
    process.exit(1);
});

process.on("unhandledRejection", (err) => {
    console.error("💥 UNHANDLED PROMISE REJECTION:", err);
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
    device_id: z.string().optional(),
    deviceId: z.string().optional(),
    lat: z.number().min(-90).max(90).optional(),
    lon: z.number().min(-180).max(180).optional(),
    timestamp: z.number().optional(),
    accuracy: z.number().optional(),
    speed: z.number().optional(),
    bearing: z.number().optional(),
    battery: z.number().optional(),
    fcm_token: z.string().optional(),
    fcmToken: z.string().optional(),
    alarm_active: z.boolean().optional(),
    alarmActive: z.boolean().optional(),
    accident: z.boolean().optional(),
    is_locked: z.boolean().optional(),
    isLocked: z.boolean().optional(),
    is_motion: z.boolean().optional(),
    isMotion: z.boolean().optional(),
    is_wifi: z.boolean().optional(),
    isWifi: z.boolean().optional(),
    motion_state: z.string().optional(),
    motionState: z.string().optional(),
    geofence_event: z.string().optional(),
    geofenceEvent: z.string().optional(),
    name: z.string().optional(),
    sats: z.number().optional(),
    is_live: z.boolean().optional(),
    visual_lat: z.number().optional(),
    visual_lon: z.number().optional(),
    intermediate_coords: z.array(z.number()).optional()
}).refine(data => data.device_id || data.deviceId, { message: "device_id is required" });

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
const grpcStreams = new Map(); // 🔥 V301: Changed to Map for efficient lookup

// --- gRPC HELPERS ---
function mapAppToProto(data) {
    if (!data) return data;

    // 🔥 V305: Ensure strict mapping to DeviceLocationProto field names
    // protobufjs uses the exact names from the .proto file if configured,
    // but sometimes it defaults to camelCase. We provide BOTH.
    const id = data.device_id || data.deviceId || "";

    return {
        device_id: id,
        deviceId: id, // Fallback
        lat: Number(data.lat) || 0,
        lon: Number(data.lon) || 0,
        battery: data.battery ?? 0,
        speed: data.speed ?? 0,
        bearing: data.bearing ?? 0,
        timestamp: Number(data.timestamp) || Date.now(),
        accuracy: data.accuracy ?? 0,
        offline: !!data.offline,
        name: data.name || "",
        status: data.status || "online",
        alarm_active: !!(data.alarm_active || data.alarmActive),
        alarmActive: !!(data.alarm_active || data.alarmActive),
        is_awake: !!(data.is_awake ?? data.isAwake ?? true),
        isAwake: !!(data.is_awake ?? data.isAwake ?? true),
        is_watched: !!(data.is_watched || data.isWatched),
        isWatched: !!(data.is_watched || data.isWatched),
        watcher_name: data.watcher_name || data.watcherName || "",
        watcherName: data.watcher_name || data.watcherName || "",
        fcm_token: data.fcm_token || data.fcmToken || "",
        fcmToken: data.fcm_token || data.fcmToken || "",
        is_locked: !!(data.is_locked || data.isLocked),
        isLocked: !!(data.is_locked || data.isLocked),
        is_motion: !!(data.is_motion || data.isMotion),
        isMotion: !!(data.is_motion || data.isMotion),
        is_wifi: !!(data.is_wifi || data.isWifi),
        isWifi: !!(data.is_wifi || data.isWifi),
        accident: !!data.accident,
        snapped_lat: data.snapped_lat || data.snappedLat || 0,
        snapped_lon: data.snapped_lon || data.snappedLon || 0,
        visual_lat: data.visual_lat || data.visualLat || 0,
        visual_lon: data.visual_lon || data.visualLon || 0,
        geofence_event: data.geofence_event || data.geofenceEvent || "",
        geofenceEvent: data.geofence_event || data.geofenceEvent || "",
        motion_state: data.motion_state || data.motionState || "STILL",
        motionState: data.motion_state || data.motionState || "STILL",
        sats: data.sats ?? 0,
        intermediate_coords: data.intermediate_coords || data.intermediateCoords || []
    };
}

function mapProtoToApp(data) {
    if (!data) return data;
    // Normalisierung für Eingang (App -> Server)
    // Wir speichern INTERN alles in snake_case für den neuen Standard
    const mapped = {
        device_id: data.device_id || data.deviceId,
        lat: data.lat,
        lon: data.lon,
        timestamp: data.timestamp || Date.now(),
        accuracy: data.accuracy,
        speed: data.speed,
        bearing: data.bearing,
        battery: data.battery ?? data.battery_pct ?? data.batteryPct,
        alarm_active: data.alarm_active ?? data.alarmActive ?? false,
        is_awake: data.is_awake ?? data.isAwake ?? true,
        is_watched: data.is_watched ?? data.isWatched ?? false,
        is_locked: data.is_locked ?? data.isLocked ?? false,
        is_motion: data.is_motion ?? data.isMotion ?? false,
        is_wifi: data.is_wifi ?? data.isWifi ?? false,
        accident: data.accident ?? false,
        fcm_token: data.fcm_token || data.fcmToken,
        geofence_event: data.geofence_event || data.geofenceEvent,
        motion_state: data.motion_state || data.motionState || "STILL",
        snapped_lat: data.snapped_lat || data.snappedLat,
        snapped_lon: data.snapped_lon || data.snappedLon,
        visual_lat: data.visual_lat || data.visualLat,
        visual_lon: data.visual_lon || data.visualLon,
        sats: data.sats ?? data.sats_count ?? data.satsInFix ?? 0,
        name: data.name,
        watcher_name: data.watcher_name || data.watcherName,
        intermediate_coords: data.intermediate_coords || data.intermediateCoords || []
    };
    return mapped;
}

// --- BROADCAST LOGIC ---
function pushUpdateToAll(device) {
    if (!device?.device_id) return;
    io.to(device.device_id).emit('location_update', device);

    const protoDevice = mapAppToProto(device);
    const response = {
        device_id: device.device_id,
        timestamp: Date.now(),
        server_response: { device: protoDevice }
    };

    if (device.geofence_event && (device.geofence_event.startsWith('enter:') || device.geofence_event.startsWith('exit:'))) {
        console.log(`🚩 GEOFENCE EVENT: ${device.device_id} -> ${device.geofence_event}`);
    }
    if (device.alarm_active) console.log(`🔊 ALARM ACTIVE: ${device.device_id}`);
    if (device.accident) console.log(`🚨 ACCIDENT ALERT: ${device.device_id}`);

    for (const [streamId, call] of grpcStreams) {
        try {
            if (!call || call.destroyed) { grpcStreams.delete(streamId); continue; }

            // 🔥 V301: Filtering - only send if call is interested in this device
            if (call.device_id && call.device_id !== device.device_id) continue;

            const ok = call.write(response);
            if (!ok) {
                call._pendingWrites = (call._pendingWrites || 0) + 1;
                if (call._pendingWrites > 100) { call.end(); grpcStreams.delete(streamId); }
            } else { call._pendingWrites = 0; }
        } catch (e) { grpcStreams.delete(streamId); }
    }
}

function broadcastGeofenceReload() {
    for (const [streamId, call] of grpcStreams) {
        try { if (!call.destroyed) call.write({ reload_geofences: true }); }
        catch (e) { grpcStreams.delete(streamId); }
    }
}

// --- FIREBASE ---
async function initFirebase() {
    try {
        const envKey = process.env.FIREBASE_SERVICE_ACCOUNT || process.env.firebase_service_account;
        const serviceAccount = envKey ? JSON.parse(envKey) : JSON.parse(await fs.readFile(path.join(__dirname, 'firebase-key.json'), 'utf8'));
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        console.log("✅ Firebase Admin aktiv.");
    } catch (e) { console.error("❌ Firebase Fehler:", e.message); throw e; }
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
        const list = Object.values(devices || {});
        callback(null, { devices: list.map(d => mapAppToProto(d)) });
    },
    TrackLocation: (call) => {
        const meta = call.metadata.get('x-api-key');
        if (meta?.[0] !== API_KEY) { call.emit('error', { code: grpc.status.UNAUTHENTICATED }); return call.end(); }
        if (grpcStreams.size >= 1000) return call.end();

        const streamId = crypto.randomUUID(); // 🔥 V302: Safe UUID
        call.lastActivity = Date.now();
        grpcStreams.set(streamId, call);
        const cleanup = () => grpcStreams.delete(streamId);
        call.on('data', (event) => {
            if (!call || call.destroyed) return;
            call.lastActivity = Date.now();
            const update = event.location_update;
            if (!update) return;
            const data = mapProtoToApp(update);
            const id = data.device_id?.toLowerCase();
            if (id) {
                // Terminate other streams for the same device if needed?
                // Usually one device has one active write stream.
                for (const [sid, old] of grpcStreams) {
                    if (sid !== streamId && old.device_id === id) {
                        try { old.end(); } catch {} grpcStreams.delete(sid);
                    }
                }
                call.device_id = id;
                updateDevice(id, data);
                saveDevicesSafe({ immediate: data.alarm_active || data.accident });
                const updated = devices[id];
                if (updated) pushUpdateToAll(updated);
            }
        });
        call.on('end', cleanup); call.on('error', cleanup); call.on('close', cleanup);
    }
});

// Watchdog
setInterval(() => {
    const now = Date.now();
    // 1. gRPC Stream Cleanup
    for (const [sid, call] of grpcStreams) { if (now - (call.lastActivity || 0) > 300000) { try { call.end(); } catch {} grpcStreams.delete(sid); } }

    // 2. 🔥 Watch-State Cleanup (V297)
    // If a device hasn't been updated for 5 minutes, assume nobody is watching it anymore.
    Object.values(devices).forEach(d => {
        const lastSeen = d.last_seen || d.lastSeen || 0;
        if (d.is_watched && (now - lastSeen) > 300000) {
            console.log(`🧹 AUTO-UNWATCH: ${d.device_id} (Inactivity)`);
            d.is_watched = false;
            delete d.watcher_name;
            pushUpdateToAll(d);
        }
    });
}, 60000);

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

io.use((socket, next) => {
    if ((socket.handshake.auth?.apiKey || socket.handshake.query?.apiKey) !== API_KEY) return next(new Error("Unauthorized"));
    next();
});

io.on('connection', (socket) => {
    socket.on('join_device', (data) => {
        const id = (typeof data === 'string' ? data : (data?.device_id || data?.deviceId))?.toLowerCase().trim();
        if (id) { socket.join(id); if (devices[id]) socket.emit('location_update', devices[id]); }
    });
});

// --- REST ROUTES ---
app.use((req, res, next) => {
    if (req.path === '/' || req.path.startsWith('/socket.io')) return next();

    // 🔥 V302: Timing Safe API Key Check
    const providedKey = req.headers['x-api-key'];
    if (!providedKey || providedKey.length !== API_KEY.length ||
        !crypto.timingSafeEqual(Buffer.from(providedKey), Buffer.from(API_KEY))) {
        return res.sendStatus(401);
    }
    next();
});

// app.use(bodyParser.json({ limit: '200kb' })); // Removed global to avoid processing all routes
// app.use(bodyParser.raw({ type: 'application/x-protobuf', limit: '200kb' }));

app.get('/', (req, res) => res.send('🚀 GPS Server is running.'));

// 🔥 V305: Debug route to verify server state
app.get('/v1/debug/devices', safe((req, res) => {
    res.json({
        count: Object.keys(devices).length,
        devices: devices,
        lastPushTimesSize: Object.keys(lastPushTimes).length,
        grpcStreamsCount: grpcStreams.size
    });
}));

const jsonParser = bodyParser.json({ limit: '200kb' });
const protoParser = bodyParser.raw({ type: 'application/x-protobuf', limit: '200kb' });

app.post(['/location', '/v1/location'], protoParser, jsonParser, safe(async (req, res) => {
    let data = req.body;
    if (Buffer.isBuffer(req.body) && req.body.length > 0) {
        data = mapProtoToApp(LocationUpdateProto.toObject(LocationUpdateProto.decode(req.body), { defaults: false, longs: Number }));
    }
    const val = locationSchema.safeParse(data);
    if (!val.success) return res.status(400).json(val.error.format());
    data = val.data;
    const id = (data.device_id || data.deviceId).toLowerCase();
    updateDevice(id, data);
    saveDevicesSafe();
    if (devices[id]) pushUpdateToAll(devices[id]);
    res.sendStatus(200);
}));

app.post('/v1/location/raw', protoParser, safe(async (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.sendStatus(400);
    const data = mapProtoToApp(LocationUpdateProto.toObject(LocationUpdateProto.decode(req.body), { defaults: false, longs: Number }));
    const id = data.device_id?.toLowerCase();
    if (!id) return res.sendStatus(400);
    updateDevice(id, data);
    saveDevicesSafe();
    if (devices[id]) pushUpdateToAll(devices[id]);
    res.sendStatus(200);
}));

app.post(['/location/update-batch', '/v1/location/batch'], protoParser, jsonParser, safe(async (req, res) => {
    let batch = Buffer.isBuffer(req.body) ? (LocationBatchProto.decode(req.body).updates || []).map(u => mapProtoToApp(LocationUpdateProto.toObject(u, { defaults: false, longs: Number }))) : req.body;
    const val = batchSchema.safeParse(batch);
    if (!val.success) return res.status(400).json(val.error.format());
    batch = val.data;
    batch.forEach(item => {
        const id = (item.device_id || item.deviceId)?.toLowerCase();
        if (id) updateDevice(id, item);
    });
    saveDevicesSafe();
    if (batch.length > 0) {
        const firstId = (batch[0].device_id || batch[0].deviceId)?.toLowerCase();
        if (firstId && devices[firstId]) pushUpdateToAll(devices[firstId]);
    }
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
    d.alarm_active = req.query.active === 'true';
    saveDevicesSafe({ immediate: true });
    pushUpdateToAll(d);

    const helpersPayload = { type: 'alarm', deviceId: id, message: `${d.name || id} braucht Hilfe!`, deviceName: d.name || id };

    // --- 🛡️ SAFE BROADCAST TO HELPERS ---
    Object.values(devices).forEach(target => {
        if (target.fcm_token && target.device_id !== id && target.device_id !== req.query.triggererId?.toLowerCase()) {
            admin.messaging().send({ data: helpersPayload, token: target.fcm_token })
                .catch(e => console.warn(`⚠️ Helper FCM failed for ${target.device_id}:`, e.message));
        }
    });

    // --- 🛡️ SAFE DIRECT ALARM TO TARGET ---
    if (d.alarm_active && d.fcm_token) {
        admin.messaging().send({
            data: { ...helpersPayload, message: "Fernauslösung: Alarm aktiviert!" },
            token: d.fcm_token,
            android: { priority: 'high' }
        }).catch(e => console.warn(`⚠️ Direct Alarm FCM failed for ${id}:`, e.message));
    } else if (!d.alarm_active && d.fcm_token) {
        // 🔥 V126: Also send STOP command via FCM for backgrounded devices
        admin.messaging().send({
            data: { type: 'stop_alarm', deviceId: id },
            token: d.fcm_token,
            android: { priority: 'high' }
        }).catch(e => console.warn(`⚠️ Stop Alarm FCM failed for ${id}:`, e.message));
    }

    io.to(id).emit('command', { deviceId: id, action: d.alarm_active ? 'START_ALARM' : 'STOP_ALARM' });
    res.sendStatus(200);
}));

app.post(['/devices/:id/wakeup', '/v1/devices/:id/wakeup'], safe(async (req, res) => {
    const id = req.params.id.toLowerCase();
    const d = devices?.[id];
    if (!d) return res.sendStatus(404);

    if (d.fcm_token) {
        admin.messaging().send({
            data: { type: 'wakeup', deviceId: id },
            token: d.fcm_token,
            android: { priority: 'high' }
        }).catch(e => console.warn(`⚠️ Wakeup FCM failed for ${id}:`, e.message));
    }
    res.sendStatus(200);
}));

app.post('/v1/devices/wakeup-all', safe(async (req, res) => {
    Object.values(devices).forEach(d => {
        if (d.fcm_token) {
            admin.messaging().send({
                data: { type: 'wakeup', deviceId: d.device_id },
                token: d.fcm_token
            }).catch(() => {});
        }
    });
    res.sendStatus(200);
}));

app.post(['/devices/:id/watch', '/v1/devices/:id/watch'], safe(async (req, res) => {
    const d = devices?.[req.params.id.toLowerCase()];
    if (!d) return res.sendStatus(404);
    d.is_watched = true;
    d.watcher_name = req.query.watcherName || req.query.watcher_name || "Jemand";

    if (d.fcm_token) {
        admin.messaging().send({
            data: { type: 'watch_state', state: 'true', watcherName: d.watcher_name, targetId: d.device_id },
            token: d.fcm_token,
            android: { priority: 'high' }
        }).catch(e => console.warn(`⚠️ Watch Notification failed:`, e.message));
    }
    res.sendStatus(200);
}));

app.post(['/devices/:id/unwatch', '/v1/devices/:id/unwatch'], safe(async (req, res) => {
    const d = devices?.[req.params.id.toLowerCase()];
    if (!d) return res.sendStatus(404);
    d.is_watched = false; delete d.watcher_name;

    if (d.fcm_token) {
        admin.messaging().send({
            data: { type: 'watch_state', state: 'false' },
            token: d.fcm_token
        }).catch(e => console.warn(`⚠️ Unwatch Notification failed:`, e.message));
    }
    res.sendStatus(200);
}));

app.post(['/devices/:id/break-lock', '/v1/devices/:id/break-lock'], safe(async (req, res) => {
    const id = req.params.id.toLowerCase();
    const d = devices?.[id];
    if (!d) return res.sendStatus(404);

    if (d.fcm_token) {
        admin.messaging().send({
            data: { type: 'break_lock', deviceId: id },
            token: d.fcm_token,
            android: { priority: 'high' }
        }).then(() => console.log(`🔓 Break Lock sent to ${id}`))
          .catch(e => console.warn(`⚠️ Break Lock FCM failed for ${id}:`, e.message));
    }
    res.sendStatus(200);
}));

app.post('/v1/devices/:id/proximity', safe(async (req, res) => {
    const id = req.params.id.toLowerCase();
    const otherId = req.query.otherId?.toLowerCase();
    const distance = req.query.distance;
    const name = req.query.name || "Unbekanntes Gerät";

    if (!id || !otherId) return res.sendStatus(400);

    console.log(`📏 PROXIMITY REPORT: ${id} near ${otherId} (${distance}m)`);

    await broadcast(id, {
        type: 'proximity_alert',
        deviceId: id,
        otherId: otherId,
        name: name,
        distance: distance.toString()
    });

    res.sendStatus(200);
}));

app.get(['/geofences', '/v1/geofences'], safe((req, res) => res.json(geofences || [])));
app.post(['/geofences', '/v1/geofences'], jsonParser, safe(async (req, res) => {
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

app.post('/v1/test/proximity', safe(async (req, res) => {
    // 🔥 V75: Realistic Proximity Test
    const testId = "test_device";
    await broadcast(testId, {
        type: 'proximity_alert',
        deviceId: testId,
        name: "Test-Dummy",
        distance: "150"
    });
    res.sendStatus(200);
}));

// =====================================================
// HISTORY / MAINTENANCE
// =====================================================

app.post(['/location/clear/:id', '/v1/location/clear/:id'], safe(async (req, res) => {
    const id = req.params.id.toLowerCase();
    // In this file-based implementation, we don't have a history list separate from 'devices'
    // but we could clear specific metadata if needed.
    res.sendStatus(200);
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
    savePending = true;

    // 1. SOFORT-MODUS: Bei Alarmen oder kritischen Statusänderungen
    if (opts.immediate || opts.forceSave) {
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = null;
        savePending = false;
        const snapshot = structuredClone(devices); // 🔥 V301: Prevent race conditions
        return queueWrite(DATA_FILE, JSON.stringify(snapshot, null, 2))
            .then(() => console.log("🔥 Critical Flush: Data persisted immediately."));
    }

    // 2. DEBOUNCED-MODUS: Normales Sammeln von Updates
    if (saveTimer) return; // Timer läuft bereits, wird nach Ablauf prüfen

    saveTimer = setTimeout(async () => {
        saveTimer = null;
        if (!savePending) return;
        savePending = false;
        const snapshot = structuredClone(devices); // 🔥 V301: Prevent race conditions
        await queueWrite(DATA_FILE, JSON.stringify(snapshot, null, 2));
        console.log("💾 Periodic Save: Device state persisted.");
    }, 10000); // 10s Puffer für normale Updates
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

function updateDevice(id, incomingData) {
    const old = devices[id] || {};
    const data = mapProtoToApp(incomingData);

    if (data.timestamp <= old.timestamp) return; // 🔥 V301: Strict timestamp check

    // 🔥 IDENTITY PROTECTION: Don't overwrite meaningful names with defaults
    const isDefaultName = (name) => !name || name === "User" || name === "Jemand" || name === "Unbekannt";
    const finalName = (isDefaultName(old.name) || !isDefaultName(data.name)) ? (data.name || old.name) : old.name;

    // 🔥 TOKEN PROTECTION: Don't overwrite with empty values
    const finalFcmToken = data.fcm_token || old.fcm_token;

    // 🔥 ALARM SYNC: Maintain state for a short period to prevent jitter
    const lastSeen = old.last_seen || old.lastSeen || 0;
    const alarmActive = (old.alarm_active && !data.alarm_active && (Date.now() - lastSeen < 30000)) ? true : data.alarm_active;

    // 🔥 BATTERY PROTECTION: Don't overwrite with 0 if we have an old value
    const battery = (data.battery > 0) ? data.battery : (old.battery || 0);

    const isRealGeofence = typeof data.geofence_event === 'string' && (data.geofence_event.startsWith('enter:') || data.geofence_event.startsWith('exit:'));

    devices[id] = {
        ...old,
        ...data,
        device_id: id,
        name: finalName,
        fcm_token: finalFcmToken,
        battery: battery,
        geofence_event: isRealGeofence ? data.geofence_event : undefined,
        alarm_active: alarmActive,
        status: 'online',
        last_seen: Date.now()
    };
    handleEvents(id, devices[id], old);
}

async function handleEvents(id, data, old) {
    const device = devices[id]; if (!device) return;

    // 🔥 V75: Accident Alert Broadcast
    if (data.accident && !old.accident) {
        console.log(`🚨 BROADCASTING ACCIDENT: ${id}`);
        await broadcast(id, {
            type: 'accident_alert',
            deviceId: id,
            name: device.name || id,
            message: `${device.name || id} hat einen Unfall!`
        });
    }

    if (typeof data.geofence_event === 'string' && (data.geofence_event.startsWith('enter:') || data.geofence_event.startsWith('exit:'))) {
        const key = `gf:${id}:${data.geofence_event}`;

        // --- 🛡️ MEMORY PROTECTION: Clear old lastPushTimes (Smart Cleanup V301) ---
        if (Object.keys(lastPushTimes).length > 5000) {
            console.log("🧹 Pruning lastPushTimes (Memory Protection)");
            const cutoff = Date.now() - 5 * 60 * 1000;
            for (const [k, v] of Object.entries(lastPushTimes)) {
                if (v < cutoff) delete lastPushTimes[k];
            }
        }

        if (Date.now() - (lastPushTimes[key] || 0) > 120000) {
            lastPushTimes[key] = Date.now();
            const [action, ...name] = data.geofence_event.split(':');
            const zoneName = name.join(':') || 'Zone';
            await broadcast(id, { type: 'geofence_event', deviceId: id, zoneName: zoneName, deviceName: device.name || id, action: action === 'enter' ? 'betreten' : 'verlassen' });
        }
    }
}

async function broadcast(senderId, payload) {
    const tokens = Object.values(devices)
        .filter(d => (d.device_id || d.deviceId) !== senderId && (d.fcm_token || d.fcmToken) && (d.fcm_token || d.fcmToken).length > 5)
        .map(d => d.fcm_token || d.fcmToken);

    if (tokens.length === 0) {
        console.log(`ℹ️ BCast: No target tokens for event ${payload.type} (Active devices: ${Object.keys(devices).length})`);
        return;
    }

    console.log(`📣 Broadcasting ${payload.type} to ${tokens.length} devices...`);

    const batches = [];
    for (let i = 0; i < tokens.length; i += 500) {
        batches.push(tokens.slice(i, i + 500));
    }

    // 🔥 V301: Faster parallel broadcast
    await Promise.all(batches.map(async (batch) => {
        try {
            const res = await admin.messaging().sendEachForMulticast({ data: payload, tokens: batch, android: { priority: 'high' } });
            if (res.failureCount > 0) {
                res.responses.forEach((r, idx) => {
                    if (!r.success && r.error) {
                        const code = r.error.code || "";
                        if (code.includes('not-registered') || code.includes('invalid')) {
                            const token = batch[idx];
                            Object.values(devices).forEach(d => {
                                if (d.fcm_token === token || d.fcmToken === token) {
                                    delete d.fcm_token;
                                    delete d.fcmToken;
                                }
                            });
                        }
                    }
                });
            }
        } catch (e) { console.error("🚨 BCast Multicast Error:", e.message); }
    }));
}

async function startServer() {
    try {
        await initFirebase(); await init();
        server.listen(PORT, () => console.log(`🚀 GPS Server Port ${PORT}`));
        grpcServer.bindAsync(`0.0.0.0:${GRPC_PORT}`, grpc.ServerCredentials.createInsecure(), (err, p) => {
            if (!err) console.log(`📡 gRPC Port ${p}`);
        });
    } catch (e) { console.error("💥 FATAL:", e); process.exit(1); }
}
startServer();
