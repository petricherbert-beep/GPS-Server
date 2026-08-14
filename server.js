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
import multer from 'multer'; // 🔥 V308: For Telemetry Uploads
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
const PROVISIONING_KEY = (process.env.PROVISIONING_KEY || API_KEY).trim();
const PORT = process.env.PORT || 3000;
const GRPC_PORT = process.env.GRPC_PORT || 50051;
const DATA_FILE = path.join(__dirname, 'devices.json');
const GEOFENCE_FILE = path.join(__dirname, 'geofences.json');
const TELEMETRY_DIR = path.join(__dirname, 'telemetry');

const deviceQueues = new Map();

function enqueueUpdate(deviceId, fn) {
    if (!deviceId) return fn();
    const id = normalizeDeviceId(deviceId);
    if (!id) return fn();

    if (!deviceQueues.has(id)) {
        deviceQueues.set(id, Promise.resolve());
    }

    const next = deviceQueues.get(id)
        .catch(() => {})
        .then(() => fn())
        .catch(err => {
            console.error(`🚨 QUEUE TASK ERROR for ${id}:`, err);
            throw err;
        });

    deviceQueues.set(id, next);

    next.finally(() => {
        if (deviceQueues.get(id) === next) {
            setTimeout(() => {
                if (deviceQueues.get(id) === next) deviceQueues.delete(id);
            }, 10000);
        }
    });

    return next;
}

const DEVICE_ID_RE = /^[a-z0-9_-]{1,64}$/i;
function normalizeDeviceId(id) {
    if (typeof id !== 'string') return null;
    const clean = id.trim().toLowerCase();
    return DEVICE_ID_RE.test(clean) ? clean : null;
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, TELEMETRY_DIR),
    filename: (req, file, cb) => {
        const id = normalizeDeviceId(req.headers['x-device-id']);
        if (!id) return cb(new Error("X-Device-ID header is required for telemetry upload"));
        cb(null, `telemetry_${id}.bin`);
    }
});
const upload = multer({
    storage,
    limits: {
        fileSize: 50 * 1024 * 1024,
        files: 1,
        fields: 10
    }
});

// --- PROTOBUF DEFINITION (V342 Aligned) ---
const PROTO_PATH = path.join(__dirname, 'tracking.proto');
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true, // MUST remain true to match p.alarm_active names
    longs: Number,
    enums: String,
    defaults: false,
    oneofs: true
});
const trackingProto = grpc.loadPackageDefinition(packageDefinition).tracking;

const protoSource = await fs.readFile(PROTO_PATH, 'utf8');
const root = protobuf.parse(protoSource).root;
const LocationUpdateProto = root.lookupType("LocationUpdateProto");
const DeviceLocationProto = root.lookupType("DeviceLocationProto");

const locationSchema = z.object({
    deviceId: z.string().min(1).max(128).regex(/^[a-z0-9_-]+$/i),
    lat: z.number().finite().optional(),
    lon: z.number().finite().optional(),
    timestamp: z.number().finite().int().optional(),
    accuracy: z.number().finite().optional(),
    speed: z.number().finite().optional(),
    bearing: z.number().finite().optional(),
    battery: z.number().finite().optional(),
    alarmActive: z.boolean().optional(),
    accident: z.boolean().optional(),
    isAwake: z.boolean().optional(),
    isWatched: z.boolean().optional(),
    isLocked: z.boolean().optional(),
    isMotion: z.boolean().optional(),
    isWifi: z.boolean().optional(),
    motionState: z.string().max(64).optional(),
    geofenceEvent: z.string().max(256).optional(),
    name: z.string().max(128).optional(),
    watcherName: z.string().max(128).optional(),
    sats: z.number().finite().int().optional(),
    snappedLat: z.number().finite().optional(),
    snappedLon: z.number().finite().optional(),
    visualLat: z.number().finite().optional(),
    visualLon: z.number().finite().optional(),
    color: z.number().finite().int().optional(),
    status: z.string().max(64).optional(),
    pointId: z.string().max(128).optional(),
    intermediateCoords: z.array(z.number().finite()).optional()
});

const fcmRegistrationSchema = z.object({
    deviceId: z.string().min(1).max(128).regex(/^[a-z0-9_-]+$/i),
    fcmToken: z.string().min(10).max(4096)
});

const geofenceSchema = z.object({
    id: z.string().min(1).max(128),
    name: z.string().max(128),
    lat: z.number().finite(),
    lon: z.number().finite(),
    radius: z.number().finite().positive()
});

function sanitizeAndValidate(raw) {
    if (!raw) return { success: false, error: "Empty payload" };
    const canonical = {
        deviceId: normalizeDeviceId(raw.deviceId || raw.device_id),
        lat: raw.lat, lon: raw.lon,
        timestamp: raw.timestamp,
        accuracy: raw.accuracy,
        speed: raw.speed,
        bearing: raw.bearing,
        battery: raw.battery ?? raw.battery_pct ?? raw.batteryPct,
        alarmActive: raw.alarmActive ?? raw.alarm_active,
        accident: raw.accident,
        isAwake: raw.isAwake ?? raw.is_awake,
        isWatched: raw.isWatched ?? raw.is_watched,
        isLocked: raw.isLocked ?? raw.is_locked,
        isMotion: raw.isMotion ?? raw.is_motion,
        isWifi: raw.isWifi ?? raw.is_wifi,
        motionState: raw.motionState || raw.motion_state,
        geofenceEvent: raw.geofenceEvent || raw.geofence_event,
        name: raw.name,
        watcherName: raw.watcherName || raw.watcher_name,
        sats: raw.sats ?? raw.sats_count,
        snappedLat: raw.snappedLat ?? raw.snapped_lat,
        snappedLon: raw.snappedLon ?? raw.snapped_lon,
        visualLat: raw.visualLat ?? raw.visual_lat,
        visualLon: raw.visualLon ?? raw.visual_lon,
        color: raw.color,
        status: raw.status,
        pointId: raw.pointId || raw.point_id,
        intermediateCoords: raw.intermediateCoords || raw.intermediate_coords
    };
    Object.keys(canonical).forEach(key => canonical[key] === undefined && delete canonical[key]);
    const result = locationSchema.safeParse(canonical);
    if (!result.success) return { success: false, error: result.error.format() };
    return { success: true, data: result.data };
}

async function validateAndProcessLocation(raw, metadata = {}) {
    const result = sanitizeAndValidate(raw);
    if (!result.success) return { success: false, error: result.error };
    const data = result.data;
    const id = data.deviceId;
    return enqueueUpdate(id, async () => {
        const isAuth = await verifyDeviceAuth(id, metadata.deviceSecret, { provisioningKey: metadata.provisioningKey });
        if (!isAuth) return { success: false, code: 401, error: "Auth failed" };
        if (metadata.authenticatedId && metadata.authenticatedId !== id) return { success: false, code: 403, error: "Spoofing" };
        const update = await updateDevice(id, data, metadata);
        return { success: true, updated: update.updated, id, data: devices[id] };
    });
}

const HASH_CONFIG = { N: 16384, r: 8, p: 1, keyLen: 64, saltSize: 16 };
async function hashSecret(secret) {
    const salt = crypto.randomBytes(HASH_CONFIG.saltSize).toString('hex');
    return new Promise((resolve, reject) => {
        crypto.scrypt(secret, salt, HASH_CONFIG.keyLen, (err, derivedKey) => {
            if (err) reject(err);
            resolve(`${salt}:${derivedKey.toString('hex')}`);
        });
    });
}
async function verifySecret(secret, storedHash) {
    if (!storedHash || !storedHash.includes(':')) return false;
    const [salt, key] = storedHash.split(':');
    return new Promise((resolve, reject) => {
        crypto.scrypt(secret, salt, HASH_CONFIG.keyLen, (err, derivedKey) => {
            if (err) reject(err);
            resolve(crypto.timingSafeEqual(Buffer.from(key, 'hex'), derivedKey));
        });
    });
}
async function verifyDeviceAuth(id, secret, metadata = {}) {
    if (!id) return false;
    const device = devices[id];
    const provKey = (metadata.provisioningKey || "").trim();
    if (provKey && provKey === PROVISIONING_KEY) return true;
    if (!device || !device.deviceSecretHash) return false;
    if (!secret) return false;
    return await verifySecret(secret.trim(), device.deviceSecretHash);
}

function decodeProtoSafe(type, buffer) {
    try { return type.toObject(type.decode(buffer), { defaults: false, longs: Number }); }
    catch (err) { return null; }
}

const safe = fn => (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(err => {
        console.error("🔥 ROUTE ERROR:", err);
        if (!res.headersSent) res.sendStatus(500);
    });

let devices = {};
let geofences = [];
let lastPushTimes = {};
const grpcStreams = new Map();

// --- ALIGNED MAPPING V342 ---
function mapAppToProto(data) {
    if (!data) return data;
    const p = {
        device_id: data.deviceId || "",
        name: data.name || "",
        lat: Number(data.lat || 0),
        lon: Number(data.lon || 0),
        battery: Math.round(Number(data.battery || 0)),
        speed: Number(data.speed || 0),
        bearing: Number(data.bearing || 0),
        timestamp: Number(data.timestamp || Date.now()),
        accuracy: Number(data.accuracy || 0),
        temperature: Number(data.temperature || 0),
        alarm_active: !!data.alarmActive,
        is_watched: !!data.isWatched,
        fcm_token: data.fcmToken || "",
        is_locked: !!data.isLocked,
        is_motion: !!data.isMotion,
        is_wifi: !!data.isWifi,
        accident: !!data.accident,
        geofence_event: data.geofenceEvent || "",
        motion_state: data.motionState || "STILL",
        sats: Math.round(Number(data.sats || 0)),
        snapped_lat: Number(data.snappedLat || 0),
        snapped_lon: Number(data.snappedLon || 0),
        visual_lat: Number(data.visualLat || 0),
        visual_lon: Number(data.visualLon || 0),
        color: Math.round(Number(data.color || 0)),
        is_awake: !!(data.isAwake ?? true),
        status: data.status || "online",
        watcher_name: data.watcherName || "",
        point_id: data.pointId || "",
        offline: !!data.offline,
        intermediate_coords: data.intermediateCoords || []
    };
    return DeviceLocationProto.create(p);
}

function mapProtoToApp(data) {
    if (!data) return data;
    return {
        deviceId: data.device_id,
        name: data.name,
        lat: data.lat, lon: data.lon,
        battery: data.battery,
        speed: data.speed,
        bearing: data.bearing,
        timestamp: data.timestamp,
        accuracy: data.accuracy,
        alarmActive: !!data.alarm_active,
        isWatched: !!data.is_watched,
        fcmToken: data.fcm_token,
        isLocked: !!data.is_locked,
        isMotion: !!data.is_motion,
        isWifi: !!data.is_wifi,
        accident: !!data.accident,
        geofenceEvent: data.geofence_event,
        motionState: data.motion_state,
        sats: data.sats,
        snappedLat: data.snapped_lat,
        snappedLon: data.snapped_lon,
        visualLat: data.visual_lat,
        visualLon: data.visual_lon,
        color: data.color,
        isAwake: !!data.is_awake,
        status: data.status,
        watcherName: data.watcher_name,
        pointId: data.point_id,
        offline: !!data.offline,
        intermediateCoords: data.intermediate_coords
    };
}

function mapToPublic(device) {
    if (!device) return device;
    const { fcmToken, deviceSecretHash, ...safeDevice } = device;
    return safeDevice;
}

function pushUpdateToAll(device) {
    if (!device?.deviceId) return;
    const publicDevice = mapToPublic(device);
    io.to(device.deviceId).emit('location_update', publicDevice);

    const protoDevice = mapAppToProto(publicDevice);
    const response = {
        device_id: device.deviceId,
        timestamp: Date.now(),
        server_response: { device: protoDevice }
    };

    const streamCount = grpcStreams.size;
    if (streamCount > 0) {
        console.log(`📡 BCast: ${device.deviceId} (Alarm=${device.alarmActive}) to ${streamCount} streams`);
    }

    for (const [streamId, call] of grpcStreams) {
        try {
            if (call && !call.destroyed) call.write(response);
            else grpcStreams.delete(streamId);
        } catch (e) { grpcStreams.delete(streamId); }
    }
}

function broadcastGeofenceReload() {
    for (const [streamId, call] of grpcStreams) {
        try {
            if (!call.destroyed) {
                call.write({ device_id: "server", timestamp: Date.now(), server_response: { reload_geofences: true } });
            }
        } catch (e) { grpcStreams.delete(streamId); }
    }
}

async function initFirebase() {
    try {
        const envKey = process.env.FIREBASE_SERVICE_ACCOUNT || process.env.firebase_service_account;
        const serviceAccount = envKey ? JSON.parse(envKey) : JSON.parse(await fs.readFile(path.join(__dirname, 'firebase-key.json'), 'utf8'));
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    } catch (e) { process.exit(1); }
}

const app = express();
app.set('trust proxy', 1);
app.use(compression());
app.use(cors({ origin: "*" }));
app.use('/location', rateLimit({ windowMs: 60000, max: 2000 }));

const grpcServer = new grpc.Server();
grpcServer.addService(trackingProto.TrackingService.service, {
    GetDevices: (call, callback) => {
        const meta = call.metadata.get('x-api-key');
        if (meta?.[0] !== API_KEY) return callback({ code: grpc.status.UNAUTHENTICATED });
        const list = Object.values(devices || {}).map(mapToPublic).map(mapAppToProto);
        callback(null, { devices: list });
    },
    TrackLocation: (call) => {
        const meta = call.metadata.get('x-api-key');
        if (meta?.[0] !== API_KEY) return call.end();
        const streamId = crypto.randomUUID();
        call.lastActivity = Date.now();
        grpcStreams.set(streamId, call);

        call.on('data', async (event) => {
            if (!call || call.destroyed) return;
            call.lastActivity = Date.now();
            const update = event.location_update;
            if (!update) return;

            const id = normalizeDeviceId(update.device_id || update.deviceId);
            if (call.deviceId && call.deviceId !== id) return call.destroy({ code: grpc.status.INVALID_ARGUMENT });

            const deviceToken = call.metadata.get('x-device-token')?.[0];
            const provisioningKey = call.metadata.get('x-provisioning-key')?.[0];

            try {
                const result = await validateAndProcessLocation(update, { authenticatedId: call.deviceId, deviceSecret: deviceToken, provisioningKey });
                if (result.success) {
                    if (!call.deviceId) call.deviceId = result.id;
                    if (result.updated) {
                        await saveDevicesSafe({ immediate: result.data.alarmActive || result.data.accident });
                        pushUpdateToAll(result.data);
                    }
                }
            } catch (err) {}
        });
        call.on('end', () => grpcStreams.delete(streamId));
        call.on('error', () => grpcStreams.delete(streamId));
    }
});

setInterval(() => {
    const now = Date.now();
    for (const [sid, call] of grpcStreams) { if (now - (call.lastActivity || 0) > 300000) { try { call.end(); } catch {} grpcStreams.delete(sid); } }
}, 60000);

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use((req, res, next) => {
    if (req.path === '/' || req.path.startsWith('/socket.io')) return next();
    const providedKey = (req.headers['x-api-key'] || "").trim();
    if (providedKey !== API_KEY.trim()) return res.sendStatus(401);
    next();
});

app.post(['/location', '/v1/location'], bodyParser.raw({ type: 'application/x-protobuf' }), bodyParser.json(), safe(async (req, res) => {
    let raw = req.body;
    if (Buffer.isBuffer(req.body)) raw = decodeProtoSafe(LocationUpdateProto, req.body);
    const result = await validateAndProcessLocation(raw, { deviceSecret: req.headers['x-device-token'], provisioningKey: req.headers['x-provisioning-key'] });
    if (!result.success) return res.status(result.code || 400).json({ error: result.error });
    if (result.updated) { await saveDevicesSafe(); pushUpdateToAll(result.data); }
    res.sendStatus(200);
}));

app.post('/v1/device/register-fcm', bodyParser.json(), safe(async (req, res) => {
    const { deviceId, fcmToken } = req.body;
    const id = normalizeDeviceId(deviceId);
    console.log(`📲 FCM REG: ${id} -> ${fcmToken.substring(0,10)}...`);
    if (id && devices[id]) { devices[id].fcmToken = fcmToken; await saveDevicesSafe({ immediate: true }); }
    res.sendStatus(200);
}));

app.get(['/devices', '/v1/devices'], safe((req, res) => {
    const publicList = Object.values(devices).map(mapToPublic);
    res.json(publicList);
}));

app.post(['/devices/:id/alarm', '/v1/devices/:id/alarm'], controlAuthMiddleware, safe(async (req, res) => {
    const id = normalizeDeviceId(req.params.id);
    if (!id || !devices[id]) return res.sendStatus(404);
    const d = devices[id];
    d.alarmActive = req.query.active === 'true';
    console.log(`🔊 ALARM: ${id} -> ${d.alarmActive}`);
    await saveDevicesSafe({ immediate: true });
    pushUpdateToAll(d);

    const payload = { type: 'alarm', deviceId: id, message: "Notfall!", deviceName: d.name || id };
    if (d.alarmActive && d.fcmToken) admin.messaging().send({ data: payload, token: d.fcmToken, android: { priority: 'high' } }).catch(() => {});
    Object.values(devices).forEach(t => {
        if (t.fcmToken && t.deviceId !== id) admin.messaging().send({ data: payload, token: t.fcmToken }).catch(() => {});
    });
    res.sendStatus(200);
}));

app.get(['/telemetry/download/:id', '/v1/telemetry/download/:id'], safe(async (req, res) => {
    const id = normalizeDeviceId(req.params.id);
    const apiKey = (req.headers['x-api-key'] || "").trim();
    if (apiKey !== API_KEY.trim()) return res.sendStatus(401);
    const file = path.join(TELEMETRY_DIR, `telemetry_${id}.bin`);
    try { await fs.access(file); res.download(file); } catch (e) { res.sendStatus(404); }
}));

async function saveDevicesSafe() {
    await fs.writeFile(DATA_FILE, JSON.stringify(devices, null, 2));
}

async function init() {
    try { await fs.mkdir(TELEMETRY_DIR, { recursive: true }); devices = JSON.parse(await fs.readFile(DATA_FILE, 'utf8')); } catch (e) { devices = {}; }
    try { geofences = JSON.parse(await fs.readFile(GEOFENCE_FILE, 'utf8')); } catch (e) { geofences = []; }
}

async function updateDevice(id, data) {
    const old = devices[id] || {};
    const merged = { ...old, ...data, deviceId: id, lastSeen: Date.now() };
    devices[id] = merged;
    return { updated: true };
}

async function startServer() {
    await initFirebase(); await init();
    server.listen(PORT, () => console.log(`🚀 Port ${PORT}`));
    grpcServer.bindAsync(`0.0.0.0:${GRPC_PORT}`, grpc.ServerCredentials.createInsecure(), () => grpcServer.start());
}
startServer();
