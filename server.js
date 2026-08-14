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
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import compression from 'compression';
import { z } from 'zod';

process.on("uncaughtException", (err) => { console.error("💥 UNCAUGHT:", err); process.exit(1); });
process.on("unhandledRejection", (err) => { console.error("💥 UNHANDLED:", err); });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

if (!process.env.API_KEY) { console.error("❌ API_KEY missing"); process.exit(1); }
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
    if (!deviceQueues.has(id)) deviceQueues.set(id, Promise.resolve());
    const next = deviceQueues.get(id).catch(() => {}).then(() => fn()).catch(err => { throw err; });
    deviceQueues.set(id, next);
    next.finally(() => { if (deviceQueues.get(id) === next) setTimeout(() => { if (deviceQueues.get(id) === next) deviceQueues.delete(id); }, 10000); });
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
        if (!id) return cb(new Error("X-Device-ID missing"));
        cb(null, `telemetry_${id}.bin`);
    }
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

// --- PROTOBUF ---
const PROTO_PATH = path.join(__dirname, 'tracking.proto');
const packageDefinition = protoLoader.loadSync(PROTO_PATH, { keepCase: true, longs: Number, enums: String, defaults: false, oneofs: true });
const trackingProto = grpc.loadPackageDefinition(packageDefinition).tracking;
const protoSource = await fs.readFile(PROTO_PATH, 'utf8');
const root = protobuf.parse(protoSource).root;
const LocationUpdateProto = root.lookupType("LocationUpdateProto");
const DeviceLocationProto = root.lookupType("DeviceLocationProto");

const locationSchema = z.object({
    deviceId: z.string().min(1),
    lat: z.number().optional(), lon: z.number().optional(),
    timestamp: z.number().optional(),
    accuracy: z.number().optional(), speed: z.number().optional(), bearing: z.number().optional(),
    battery: z.number().optional(), alarmActive: z.boolean().optional(), accident: z.boolean().optional(),
    isAwake: z.boolean().optional(), isWatched: z.boolean().optional(), isLocked: z.boolean().optional(),
    isMotion: z.boolean().optional(), isWifi: z.boolean().optional(),
    motionState: z.string().optional(), geofenceEvent: z.string().optional(),
    name: z.string().optional(), watcherName: z.string().optional(),
    sats: z.number().optional(), snappedLat: z.number().optional(), snappedLon: z.number().optional(),
    visualLat: z.number().optional(), visualLon: z.number().optional(),
    color: z.number().optional(), status: z.string().optional(), pointId: z.string().optional(),
    intermediateCoords: z.array(z.number()).optional()
});

const fcmRegistrationSchema = z.object({ deviceId: z.string(), fcmToken: z.string().min(10) });

function sanitizeAndValidate(raw) {
    if (!raw) return { success: false, error: "Empty" };
    const canonical = {
        deviceId: normalizeDeviceId(raw.deviceId || raw.device_id),
        lat: raw.lat, lon: raw.lon, timestamp: raw.timestamp, accuracy: raw.accuracy,
        speed: raw.speed, bearing: raw.bearing,
        battery: raw.battery ?? raw.battery_pct ?? raw.batteryPct,
        alarmActive: raw.alarmActive ?? raw.alarm_active,
        accident: raw.accident, isAwake: raw.isAwake ?? raw.is_awake,
        isWatched: raw.isWatched ?? raw.is_watched, isLocked: raw.isLocked ?? raw.is_locked,
        isMotion: raw.isMotion ?? raw.is_motion, isWifi: raw.isWifi ?? raw.is_wifi,
        motionState: raw.motionState || raw.motion_state, geofenceEvent: raw.geofenceEvent || raw.geofence_event,
        name: raw.name, watcherName: raw.watcherName || raw.watcher_name,
        sats: raw.sats ?? raw.sats_count, snappedLat: raw.snappedLat ?? raw.snapped_lat,
        snappedLon: raw.snappedLon ?? raw.snapped_lon, visualLat: raw.visualLat ?? raw.visual_lat,
        visualLon: raw.visualLon ?? raw.visual_lon, color: raw.color, status: raw.status,
        pointId: raw.pointId || raw.point_id, intermediateCoords: raw.intermediateCoords || raw.intermediate_coords
    };
    Object.keys(canonical).forEach(k => canonical[k] === undefined && delete canonical[k]);
    const result = locationSchema.safeParse(canonical);
    return result.success ? { success: true, data: result.data } : { success: false, error: result.error };
}

async function validateAndProcessLocation(raw, metadata = {}) {
    const res = sanitizeAndValidate(raw);
    if (!res.success) return res;
    const id = res.data.deviceId;
    return enqueueUpdate(id, async () => {
        if (!(await verifyDeviceAuth(id, metadata.deviceSecret, { provisioningKey: metadata.provisioningKey }))) return { success: false, code: 401 };
        const update = await updateDevice(id, res.data);
        return { success: true, updated: update.updated, id, data: devices[id] };
    });
}

const HASH_CONFIG = { N: 16384, r: 8, p: 1, keyLen: 64, saltSize: 16 };
async function hashSecret(secret) {
    const salt = crypto.randomBytes(HASH_CONFIG.saltSize).toString('hex');
    return new Promise((res, rej) => { crypto.scrypt(secret, salt, HASH_CONFIG.keyLen, (err, key) => err ? rej(err) : res(`${salt}:${key.toString('hex')}`)); });
}
async function verifySecret(secret, stored) {
    const [salt, key] = stored.split(':');
    return new Promise((res, rej) => { crypto.scrypt(secret, salt, HASH_CONFIG.keyLen, (err, derived) => err ? rej(err) : res(crypto.timingSafeEqual(Buffer.from(key, 'hex'), derived))); });
}
async function verifyDeviceAuth(id, secret, meta = {}) {
    if (!id) return false;
    const dev = devices[id];
    if (meta.provisioningKey === PROVISIONING_KEY) return true;
    if (!dev || !dev.deviceSecretHash || !secret) return false;
    return await verifySecret(secret.trim(), dev.deviceSecretHash);
}

function decodeProtoSafe(type, buf) { try { return type.toObject(type.decode(buf), { defaults: false, longs: Number }); } catch (e) { return null; } }
const safe = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(err => { console.error("🔥:", err); if (!res.headersSent) res.sendStatus(500); });

let devices = {};
let geofences = [];
const grpcStreams = new Map();

function mapAppToProto(d) {
    if (!d) return d;
    return DeviceLocationProto.create({
        device_id: d.deviceId || "", name: d.name || "", lat: d.lat || 0, lon: d.lon || 0,
        battery: Math.round(d.battery || 0), speed: d.speed || 0, bearing: d.bearing || 0,
        timestamp: d.timestamp || Date.now(), accuracy: d.accuracy || 0, temperature: d.temperature || 0,
        alarm_active: !!d.alarmActive, is_watched: !!d.isWatched, fcm_token: d.fcmToken || "",
        is_locked: !!d.isLocked, is_motion: !!d.isMotion, is_wifi: !!d.isWifi,
        accident: !!d.accident, geofence_event: d.geofenceEvent || "", motion_state: d.motionState || "STILL",
        sats: Math.round(d.sats || 0), snapped_lat: d.snappedLat || 0, snapped_lon: d.snappedLon || 0,
        visual_lat: d.visualLat || 0, visual_lon: d.visualLon || 0, color: Math.round(d.color || 0),
        is_awake: !!(d.isAwake ?? true), status: d.status || "online", watcher_name: d.watcherName || "",
        point_id: d.pointId || "", offline: !!d.offline, intermediate_coords: d.intermediateCoords || []
    });
}

function mapToPublic(d) { if (!d) return d; const { fcmToken, deviceSecretHash, ...safe } = d; return safe; }

function pushUpdateToAll(device) {
    if (!device?.deviceId) return;
    const pub = mapToPublic(device);
    io.to(device.deviceId).emit('location_update', pub);
    const response = { device_id: device.deviceId, timestamp: Date.now(), server_response: { device: mapAppToProto(pub) } };
    for (const [sid, call] of grpcStreams) { try { if (call && !call.destroyed) call.write(response); else grpcStreams.delete(sid); } catch (e) { grpcStreams.delete(sid); } }
}

const app = express();
app.set('trust proxy', 1);
app.use(compression());
app.use(cors({ origin: "*" }));

const grpcServer = new grpc.Server();
grpcServer.addService(trackingProto.TrackingService.service, {
    GetDevices: (call, cb) => {
        if (call.metadata.get('x-api-key')?.[0] !== API_KEY) return cb({ code: grpc.status.UNAUTHENTICATED });
        cb(null, { devices: Object.values(devices).map(mapToPublic).map(mapAppToProto) });
    },
    TrackLocation: (call) => {
        if (call.metadata.get('x-api-key')?.[0] !== API_KEY) return call.end();
        const sid = crypto.randomUUID();
        call.lastActivity = Date.now();
        grpcStreams.set(sid, call);
        call.on('data', async (ev) => {
            const up = ev.location_update; if (!up || call.destroyed) return;
            call.lastActivity = Date.now();
            const id = normalizeDeviceId(up.device_id || up.deviceId);
            try {
                const res = await validateAndProcessLocation(up, { deviceSecret: call.metadata.get('x-device-token')?.[0], provisioningKey: call.metadata.get('x-provisioning-key')?.[0] });
                if (res.success && res.updated) { if (!call.deviceId) call.deviceId = res.id; pushUpdateToAll(res.data); }
            } catch (err) {}
        });
        call.on('end', () => grpcStreams.delete(sid));
        call.on('error', () => grpcStreams.delete(sid));
    }
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use((req, res, next) => {
    if (req.path === '/' || req.path.startsWith('/socket.io')) return next();
    if ((req.headers['x-api-key'] || "").trim() !== API_KEY.trim()) return res.sendStatus(401);
    next();
});

app.post(['/location', '/v1/location'], bodyParser.raw({ type: 'application/x-protobuf' }), bodyParser.json(), safe(async (req, res) => {
    let raw = req.body;
    if (Buffer.isBuffer(req.body)) raw = decodeProtoSafe(LocationUpdateProto, req.body);
    const resv = await validateAndProcessLocation(raw, { deviceSecret: req.headers['x-device-token'], provisioningKey: req.headers['x-provisioning-key'] });
    if (!resv.success) return res.status(400).json({ error: resv.error });
    if (resv.updated) pushUpdateToAll(resv.data);
    res.sendStatus(200);
}));

app.post('/v1/device/register-fcm', bodyParser.json(), safe(async (req, res) => {
    const { deviceId, fcmToken } = req.body;
    const id = normalizeDeviceId(deviceId);
    console.log(`📲 FCM: ${id}`);
    if (id) {
        if (!devices[id]) devices[id] = { deviceId: id, status: 'online' };
        devices[id].fcmToken = fcmToken;
        await saveDevicesSafe();
    }
    res.sendStatus(200);
}));

app.get(['/devices', '/v1/devices'], safe((req, res) => res.json(Object.values(devices).map(mapToPublic))));

async function controlAuthMiddleware(req, res, next) {
    const id = normalizeDeviceId(req.params.id);
    const deviceToken = req.headers['x-device-token'];
    if (id && deviceToken && (await verifyDeviceAuth(id, deviceToken))) return next();
    if (req.headers['x-api-key'] === API_KEY) return next();
    res.sendStatus(401);
}

app.post(['/devices/:id/alarm', '/v1/devices/:id/alarm'], controlAuthMiddleware, safe(async (req, res) => {
    const id = normalizeDeviceId(req.params.id);
    if (!id || !devices[id]) return res.sendStatus(404);
    const d = devices[id];
    const active = req.query.active === 'true';
    d.alarmActive = active;
    console.log(`🔊 ALARM: ${id} -> ${active}`);
    await saveDevicesSafe();
    pushUpdateToAll(d);
    const type = active ? 'alarm' : 'stop_alarm';
    const payload = { type, deviceId: id, message: active ? "Notfall!" : "Entwarnung", deviceName: d.name || id };
    if (d.fcmToken) admin.messaging().send({ data: payload, token: d.fcmToken, android: { priority: 'high' } }).catch(() => {});
    Object.values(devices).forEach(t => { if (t.fcmToken && t.deviceId !== id) admin.messaging().send({ data: payload, token: t.fcmToken }).catch(() => {}); });
    res.sendStatus(200);
}));

app.get(['/telemetry/download/:id', '/v1/telemetry/download/:id'], safe(async (req, res) => {
    const id = normalizeDeviceId(req.params.id);
    const file = path.join(TELEMETRY_DIR, `telemetry_${id}.bin`);
    try { await fs.access(file); res.download(file); } catch (e) { res.sendStatus(404); }
}));

async function saveDevicesSafe() { await fs.writeFile(DATA_FILE, JSON.stringify(devices, null, 2)); }

async function initFirebase() {
    try {
        const envKey = process.env.FIREBASE_SERVICE_ACCOUNT || process.env.firebase_service_account;
        const sa = envKey ? JSON.parse(envKey) : JSON.parse(await fs.readFile(path.join(__dirname, 'firebase-key.json'), 'utf8'));
        admin.initializeApp({ credential: admin.credential.cert(sa) });
    } catch (e) { console.error("Firebase fail:", e); }
}

async function init() {
    try { await fs.mkdir(TELEMETRY_DIR, { recursive: true }); devices = JSON.parse(await fs.readFile(DATA_FILE, 'utf8')); } catch (e) { devices = {}; }
}

async function updateDevice(id, data) {
    const old = devices[id] || {};
    devices[id] = { ...old, ...data, deviceId: id, lastSeen: Date.now() };
    return { updated: true };
}

async function startServer() {
    await init(); await initFirebase();
    server.listen(PORT, () => console.log(`🚀 Port ${PORT}`));
    grpcServer.bindAsync(`0.0.0.0:${GRPC_PORT}`, grpc.ServerCredentials.createInsecure(), () => grpcServer.start());
}
startServer();
