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

process.on("uncaughtException", (err) => { console.error("💥 CRASH:", err); process.exit(1); });
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const API_KEY = (process.env.API_KEY || "test").trim();
const PORT = process.env.PORT || 3000;
const GRPC_PORT = process.env.GRPC_PORT || 50051;
const DATA_FILE = path.join(__dirname, 'devices.json');

let devices = {};
const grpcStreams = new Map();

const PROTO_PATH = path.join(__dirname, 'tracking.proto');
const packageDefinition = protoLoader.loadSync(PROTO_PATH, { keepCase: true, longs: Number, enums: String, defaults: false, oneofs: true });
const trackingProto = grpc.loadPackageDefinition(packageDefinition).tracking;
const root = protobuf.parse(await fs.readFile(PROTO_PATH, 'utf8')).root;
const LocationUpdateProto = root.lookupType("LocationUpdateProto");
const DeviceLocationProto = root.lookupType("DeviceLocationProto");

function normalizeId(id) { return id ? id.trim().toLowerCase() : null; }

// 🔥 V346: Robust Multi-Format Mapping (Fixes wrong position)
function mapToProto(d) {
    // Check both underscore and camelCase variants to be safe
    return DeviceLocationProto.create({
        device_id: d.device_id || d.deviceId || "",
        name: d.name || "",
        lat: Number(d.lat || 0),
        lon: Number(d.lon || 0),
        battery: Math.round(d.battery || d.battery_level || 0),
        speed: Number(d.speed || 0),
        bearing: Number(d.bearing || 0),
        timestamp: Number(d.timestamp || Date.now()),
        accuracy: Number(d.accuracy || 0),
        alarm_active: !!(d.alarm_active || d.alarmActive),
        is_watched: !!(d.is_watched || d.isWatched),
        is_locked: !!(d.is_locked || d.isLocked),
        fcm_token: d.fcm_token || d.fcmToken || "",
        geofence_event: d.geofence_event || d.geofenceEvent || "",
        motion_state: d.motion_state || d.motionState || "STILL",
        sats: Math.round(d.sats || 0),
        visual_lat: Number(d.visual_lat || d.visualLat || 0),
        visual_lon: Number(d.visual_lon || d.visualLon || 0),
        color: Math.round(d.color || 0),
        offline: !!d.offline,
        status: d.status || "online",
        watcher_name: d.watcher_name || d.watcherName || ""
    });
}

function pushUpdate(device) {
    if (!device?.deviceId) return;
    const pub = { ...device }; delete pub.deviceSecretHash;
    io.to(device.deviceId).emit('location_update', pub);
    const response = { device_id: device.deviceId, timestamp: Date.now(), server_response: { device: mapToProto(device) } };
    for (const [sid, call] of grpcStreams) {
        try {
            if (!call.destroyed) call.write(response);
            else grpcStreams.delete(sid);
        } catch(e){ grpcStreams.delete(sid); }
    }
}

async function updateDevice(id, data) {
    const old = devices[id] || {};
    // 🔥 Canonicalize data to always use both versions for mapping
    const merged = { ...old, ...data, deviceId: id, lastSeen: Date.now() };
    devices[id] = merged;
    return devices[id];
}

const app = express();
app.use(cors());

app.use((req, res, next) => {
    if (req.path === '/' || req.path.startsWith('/socket.io')) return next();
    if ((req.headers['x-api-key'] || "").trim() !== API_KEY) return res.sendStatus(401);
    next();
});

app.post('/v1/location', bodyParser.raw({ type: 'application/x-protobuf' }), bodyParser.json(), async (req, res) => {
    try {
        let raw = req.body;
        if (Buffer.isBuffer(req.body)) {
            raw = LocationUpdateProto.toObject(LocationUpdateProto.decode(req.body), { defaults: false, longs: Number });
        }
        const id = normalizeId(raw.device_id || raw.deviceId);
        if (id) {
            const dev = await updateDevice(id, raw);
            pushUpdate(dev);
            await fs.writeFile(DATA_FILE, JSON.stringify(devices, null, 2));
        }
        res.sendStatus(200);
    } catch(e){ res.sendStatus(400); }
});

app.post('/v1/device/register-fcm', bodyParser.json(), async (req, res) => {
    const id = normalizeId(req.body.deviceId);
    if (id) {
        if(!devices[id]) devices[id] = { deviceId: id, status: 'online' };
        devices[id].fcmToken = req.body.fcmToken;
        await fs.writeFile(DATA_FILE, JSON.stringify(devices, null, 2));
    }
    res.sendStatus(200);
});

app.get('/v1/devices', (req, res) => res.json(Object.values(devices)));

app.post('/v1/devices/:id/alarm', async (req, res) => {
    const id = normalizeId(req.params.id);
    if (id && devices[id]) {
        const active = req.query.active === 'true';
        if (devices[id].alarmActive !== active) {
            devices[id].alarmActive = active;
            pushUpdate(devices[id]);
            const p = { type: active ? 'alarm' : 'stop_alarm', deviceId: id, message: active ? "Alarm!" : "Stop" };
            if (devices[id].fcmToken) admin.messaging().send({ data: p, token: devices[id].fcmToken, android: { priority: 'high' } }).catch(()=>{});
            Object.values(devices).forEach(t => { if(t.fcmToken && t.deviceId !== id) admin.messaging().send({ data: p, token: t.fcmToken }).catch(()=>{}); });
        }
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
        const sid = crypto.randomUUID(); grpcStreams.set(sid, call);
        call.on('data', async (ev) => {
            const up = ev.location_update; if (!up) return;
            const id = normalizeId(up.device_id || up.deviceId);
            if (id) {
                const dev = await updateDevice(id, up);
                pushUpdate(dev);
            }
        });
        call.on('end', () => grpcStreams.delete(sid));
    }
});

async function initFirebase() {
    try {
        const envKey = process.env.FIREBASE_SERVICE_ACCOUNT || process.env.firebase_service_account;
        if (envKey) admin.initializeApp({ credential: admin.credential.cert(JSON.parse(envKey)) });
        console.log("✅ Firebase Active");
    } catch(e){ console.error("❌ Firebase Failed"); }
}

async function start() {
    try { devices = JSON.parse(await fs.readFile(DATA_FILE, 'utf8')); } catch(e){ devices = {}; }
    await initFirebase();
    server.listen(PORT, () => console.log(`🚀 API on ${PORT}`));
    grpcServer.bindAsync(`0.0.0.0:${GRPC_PORT}`, grpc.ServerCredentials.createInsecure(), (err, port) => {
        if (err) return console.error(err);
        grpcServer.start();
        console.log(`📡 gRPC on ${port}`);
    });
}
start();
