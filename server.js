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

process.on("uncaughtException", (err) => { console.error("💥 CRASH:", err); process.exit(1); });
process.on("unhandledRejection", (err) => { console.error("💥 REJECTION:", err); });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const API_KEY = (process.env.API_KEY || "test_key").trim();
const PROVISIONING_KEY = (process.env.PROVISIONING_KEY || API_KEY).trim();
const PORT = process.env.PORT || 3000;
const GRPC_PORT = process.env.GRPC_PORT || 50051;
const DATA_FILE = path.join(__dirname, 'devices.json');
const TELEMETRY_DIR = path.join(__dirname, 'telemetry');

let devices = {};
const grpcStreams = new Map();

// --- HELPERS ---
function normalizeDeviceId(id) {
    if (typeof id !== 'string') return null;
    const clean = id.trim().toLowerCase();
    return /^[a-z0-9_-]{1,64}$/i.test(clean) ? clean : null;
}

const HASH_CONFIG = { N: 16384, r: 8, p: 1, keyLen: 64, saltSize: 16 };
async function hashSecret(secret) {
    const salt = crypto.randomBytes(HASH_CONFIG.saltSize).toString('hex');
    return new Promise((res, rej) => { crypto.scrypt(secret, salt, HASH_CONFIG.keyLen, (err, key) => err ? rej(err) : res(`${salt}:${key.toString('hex')}`)); });
}
async function verifySecret(secret, stored) {
    if (!stored || !stored.includes(':')) return false;
    const [salt, key] = stored.split(':');
    return new Promise((res, rej) => { crypto.scrypt(secret, salt, HASH_CONFIG.keyLen, (err, derived) => err ? rej(err) : res(crypto.timingSafeEqual(Buffer.from(key, 'hex'), derived))); });
}

async function verifyDeviceAuth(id, secret, meta = {}) {
    if (!id) return false;
    if (meta.provisioningKey === PROVISIONING_KEY) return true;
    const dev = devices[id];
    if (!dev || !dev.deviceSecretHash || !secret) return false;
    return await verifySecret(secret.trim(), dev.deviceSecretHash);
}

// --- SCHEMA & PROTO ---
const locationSchema = z.object({
    deviceId: z.string().min(1),
    lat: z.number().optional(), lon: z.number().optional(), timestamp: z.number().optional(),
    accuracy: z.number().optional(), speed: z.number().optional(), battery: z.number().optional(),
    alarmActive: z.boolean().optional(), accident: z.boolean().optional(),
    isLocked: z.boolean().optional(), isWifi: z.boolean().optional(), name: z.string().optional()
}).passthrough();

const PROTO_PATH = path.join(__dirname, 'tracking.proto');
const packageDefinition = protoLoader.loadSync(PROTO_PATH, { keepCase: true, longs: Number, enums: String, defaults: false, oneofs: true });
const trackingProto = grpc.loadPackageDefinition(packageDefinition).tracking;
const protoSource = await fs.readFile(PROTO_PATH, 'utf8');
const root = protobuf.parse(protoSource).root;
const LocationUpdateProto = root.lookupType("LocationUpdateProto");
const DeviceLocationProto = root.lookupType("DeviceLocationProto");

function mapAppToProto(d) {
    if (!d) return d;
    return DeviceLocationProto.create({
        device_id: d.deviceId || "", name: d.name || "", lat: d.lat || 0, lon: d.lon || 0,
        battery: Math.round(d.battery || 0), speed: d.speed || 0, bearing: d.bearing || 0,
        timestamp: d.timestamp || Date.now(), accuracy: d.accuracy || 0,
        alarm_active: !!d.alarmActive, is_watched: !!d.isWatched, is_locked: !!d.isLocked,
        accident: !!d.accident, motion_state: d.motionState || "STILL", sats: d.sats || 0,
        color: d.color || 0, fcm_token: d.fcmToken || ""
    });
}

function mapToPublic(d) { if (!d) return d; const { fcmToken, deviceSecretHash, ...safe } = d; return safe; }

function pushUpdateToAll(device) {
    if (!device?.deviceId) return;
    const pub = mapToPublic(device);
    io.to(device.deviceId).emit('location_update', pub);
    const response = { device_id: device.deviceId, timestamp: Date.now(), server_response: { device: mapAppToProto(device) } };
    for (const [sid, call] of grpcStreams) {
        try { if (call && !call.destroyed) call.write(response); else grpcStreams.delete(sid); }
        catch (e) { grpcStreams.delete(sid); }
    }
}

async function updateDevice(id, data, metadata = {}) {
    const old = devices[id] || {};
    if (!old.deviceSecretHash && metadata.deviceSecret) {
        data.deviceSecretHash = await hashSecret(metadata.deviceSecret);
    }
    devices[id] = { ...old, ...data, deviceId: id, lastSeen: Date.now() };
    return { updated: true, data: devices[id] };
}

// --- INIT ---
async function initFirebase() {
    try {
        const envKey = process.env.FIREBASE_SERVICE_ACCOUNT || process.env.firebase_service_account;
        const sa = envKey ? JSON.parse(envKey) : JSON.parse(await fs.readFile(path.join(__dirname, 'firebase-key.json'), 'utf8'));
        admin.initializeApp({ credential: admin.credential.cert(sa) });
        console.log("✅ Firebase Active");
    } catch (e) { console.error("❌ Firebase fail:", e.message); }
}

async function loadData() {
    try { await fs.mkdir(TELEMETRY_DIR, { recursive: true }); devices = JSON.parse(await fs.readFile(DATA_FILE, 'utf8')); } catch (e) { devices = {}; }
}

async function saveDevicesSafe() { try { await fs.writeFile(DATA_FILE, JSON.stringify(devices, null, 2)); } catch(e){} }

// --- SERVER ---
const app = express();
app.set('trust proxy', 1);
app.use(compression());
app.use(cors({ origin: "*" }));

const safe = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(err => { console.error("🔥 Error:", err); if (!res.headersSent) res.sendStatus(500); });

app.use((req, res, next) => {
    if (req.path === '/' || req.path.startsWith('/socket.io')) return next();
    if ((req.headers['x-api-key'] || "").trim() !== API_KEY) return res.sendStatus(401);
    next();
});

app.post(['/location', '/v1/location'], bodyParser.raw({ type: 'application/x-protobuf' }), bodyParser.json(), safe(async (req, res) => {
    let raw = req.body;
    if (Buffer.isBuffer(req.body)) {
        try { raw = LocationUpdateProto.toObject(LocationUpdateProto.decode(req.body), { defaults: false, longs: Number }); } catch(e){ return res.sendStatus(400); }
    }
    const id = normalizeDeviceId(raw.deviceId || raw.device_id);
    if (!id) return res.sendStatus(400);

    const isAuth = await verifyDeviceAuth(id, req.headers['x-device-token'], { provisioningKey: req.headers['x-provisioning-key'] });
    if (!isAuth) return res.sendStatus(401);

    const update = await updateDevice(id, raw, { deviceSecret: req.headers['x-device-token'] });
    if (update.updated) { pushUpdateToAll(update.data); await saveDevicesSafe(); }
    res.sendStatus(200);
}));

app.post('/v1/device/register-fcm', bodyParser.json(), safe(async (req, res) => {
    const { deviceId, fcmToken } = req.body;
    const id = normalizeDeviceId(deviceId);
    if (id && devices[id]) { devices[id].fcmToken = fcmToken; await saveDevicesSafe(); console.log(`📲 FCM Registered: ${id}`); }
    res.sendStatus(200);
}));

app.get(['/devices', '/v1/devices'], (req, res) => res.json(Object.values(devices).map(mapToPublic)));

app.post(['/devices/:id/alarm', '/v1/devices/:id/alarm'], safe(async (req, res) => {
    const id = normalizeDeviceId(req.params.id);
    const dev = devices[id];
    if (!dev) return res.sendStatus(404);

    const active = req.query.active === 'true';
    if (dev.alarmActive === active) return res.sendStatus(200);

    dev.alarmActive = active;
    console.log(`🔊 ALARM: ${id} -> ${active}`);
    await saveDevicesSafe();
    pushUpdateToAll(dev);

    const payload = { type: active ? 'alarm' : 'stop_alarm', deviceId: id, message: active ? "Alarm!" : "Stop", name: dev.name || id };
    if (dev.fcmToken) admin.messaging().send({ data: payload, token: dev.fcmToken, android: { priority: 'high' } }).catch(()=>{});
    Object.values(devices).forEach(t => { if (t.fcmToken && t.deviceId !== id) admin.messaging().send({ data: payload, token: t.fcmToken }).catch(()=>{}); });

    res.sendStatus(200);
}));

app.get(['/telemetry/download/:id', '/v1/telemetry/download/:id'], safe(async (req, res) => {
    const id = normalizeDeviceId(req.params.id);
    const file = path.join(TELEMETRY_DIR, `telemetry_${id}.bin`);
    try { await fs.access(file); res.download(file); } catch (e) { res.sendStatus(404); }
}));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const grpcServer = new grpc.Server();
grpcServer.addService(trackingProto.TrackingService.service, {
    GetDevices: (call, cb) => {
        if (call.metadata.get('x-api-key')?.[0] !== API_KEY) return cb({ code: grpc.status.UNAUTHENTICATED });
        cb(null, { devices: Object.values(devices).map(mapToPublic).map(mapAppToProto) });
    },
    TrackLocation: (call) => {
        if (call.metadata.get('x-api-key')?.[0] !== API_KEY) return call.end();
        const sid = crypto.randomUUID();
        grpcStreams.set(sid, call);
        call.on('data', async (ev) => {
            const up = ev.location_update; if (!up) return;
            const id = normalizeDeviceId(up.device_id || up.deviceId);
            const isAuth = await verifyDeviceAuth(id, call.metadata.get('x-device-token')?.[0], { provisioningKey: call.metadata.get('x-provisioning-key')?.[0] });
            if (isAuth) {
                const res = await updateDevice(id, up, { deviceSecret: call.metadata.get('x-device-token')?.[0] });
                if (res.updated) pushUpdateToAll(res.data);
            }
        });
        call.on('end', () => grpcStreams.delete(sid));
        call.on('error', () => grpcStreams.delete(sid));
    }
});

async function start() {
    await loadData();
    await initFirebase();
    server.listen(PORT, () => console.log(`🚀 API on ${PORT}`));
    grpcServer.bindAsync(`0.0.0.0:${GRPC_PORT}`, grpc.ServerCredentials.createInsecure(), (err, port) => {
        if (err) return console.error(err);
        grpcServer.start();
        console.log(`📡 gRPC on ${port}`);
    });
}
start();
