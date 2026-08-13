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
// 🔥 V318/V319/V320/V321: Required for new device registration. Fallback to API_KEY if unset.
const PROVISIONING_KEY = (process.env.PROVISIONING_KEY || API_KEY).trim();
const PORT = process.env.PORT || 3000;
const GRPC_PORT = process.env.GRPC_PORT || 50051;
const DATA_FILE = path.join(__dirname, 'devices.json');
const GEOFENCE_FILE = path.join(__dirname, 'geofences.json');
const TELEMETRY_DIR = path.join(__dirname, 'telemetry');

// 🔥 V319: Per-device Request Queues to prevent state races
const deviceQueues = new Map();

function enqueueUpdate(deviceId, fn) {
    if (!deviceId) return fn();
    const id = normalizeDeviceId(deviceId);
    if (!id) return fn();

    if (!deviceQueues.has(id)) {
        deviceQueues.set(id, Promise.resolve());
    }

    // 🔥 V321: Resilience Fix - Ensure the queue always proceeds even if one task fails
    const next = deviceQueues.get(id)
        .catch(() => {}) // Swallow previous failure
        .then(() => fn())
        .catch(err => {
            console.error(`🚨 QUEUE TASK ERROR for ${id}:`, err);
            throw err; // Re-throw so the caller still sees the error
        });

    deviceQueues.set(id, next);

    // Cleanup idle queues to prevent memory leak
    next.finally(() => {
        if (deviceQueues.get(id) === next) {
            // 🔥 V321: Faster cleanup for Render's free tier
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

// --- MULTER SETUP (V308/V315) ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, TELEMETRY_DIR),
    filename: (req, file, cb) => {
        // 🔥 V315: Security - Force identification via Header to avoid multipart ordering issues
        const id = normalizeDeviceId(req.headers['x-device-id']);
        if (!id) return cb(new Error("X-Device-ID header is required for telemetry upload"));
        cb(null, `telemetry_${id}.bin`);
    }
});
const upload = multer({
    storage,
    limits: {
        fileSize: 50 * 1024 * 1024, // 50MB limit
        files: 1,
        fields: 10
    }
});

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

// --- SCHEMA VALIDATION (V317 Hardened) ---
const locationSchema = z.object({
    deviceId: z.string().min(1).max(128).regex(/^[a-z0-9_-]+$/i),
    lat: z.number().finite().min(-90).max(90).optional(),
    lon: z.number().finite().min(-180).max(180).optional(),
    // 🔥 V315/V320: Milliseconds (10^12 is approx year 2001) with 10 min future tolerance
    timestamp: z.number().finite().int().min(1000000000000).refine(ts => ts <= Date.now() + 600000, { message: "Timestamp too far in future" }).optional(),
    accuracy: z.number().finite().min(0).optional(),
    speed: z.number().finite().min(0).optional(),
    bearing: z.number().finite().min(0).max(360).optional(),
    battery: z.number().finite().min(0).max(100).optional(),
    // 🔥 V317: FCM Token registration decoupled from location update
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
    sats: z.number().finite().int().min(-1).max(100).optional(),
    isLive: z.boolean().optional(),
    snappedLat: z.number().finite().min(-90).max(90).optional(),
    snappedLon: z.number().finite().min(-180).max(180).optional(),
    visualLat: z.number().finite().min(-90).max(90).optional(),
    visualLon: z.number().finite().min(-180).max(180).optional(),
    color: z.number().finite().int().optional(), // 🔥 V332: Custom Marker Color
    status: z.string().max(64).optional(),
    intermediateCoords: z.array(z.number().finite()).max(2000).refine(coords => coords.length % 2 === 0, { message: "Must be lat/lon pairs" }).optional()
});

const batchSchema = z.array(locationSchema).max(500);

const fcmRegistrationSchema = z.object({
    deviceId: z.string().min(1).max(128).regex(/^[a-z0-9_-]+$/i),
    fcmToken: z.string().min(10).max(4096)
});

const geofenceSchema = z.object({
    id: z.string().min(1).max(128),
    name: z.string().max(128),
    lat: z.number().finite().min(-90).max(90),
    lon: z.number().finite().min(-180).max(180),
    radius: z.number().finite().positive().max(100000)
});

// --- 🛡️ HELPER: CANONICAL NORMALIZATION (V314/V317) ---
function sanitizeAndValidate(raw) {
    if (!raw) return { success: false, error: "Empty payload" };

    // 1. Map all possible variants to CamelCase
    const canonical = {
        deviceId: normalizeDeviceId(raw.deviceId || raw.device_id),
        lat: raw.lat,
        lon: raw.lon,
        timestamp: raw.timestamp,
        accuracy: raw.accuracy,
        speed: raw.speed,
        bearing: raw.bearing,
        battery: raw.battery ?? raw.battery_pct ?? raw.batteryPct,
        // 🔥 V317: fcmToken removed from here, only in registration
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
        sats: raw.sats ?? raw.sats_count ?? raw.satsInFix,
        isLive: raw.isLive ?? raw.is_live,
        snappedLat: raw.snappedLat ?? raw.snapped_lat,
        snappedLon: raw.snappedLon ?? raw.snapped_lon,
        visualLat: raw.visualLat ?? raw.visual_lat,
        visualLon: raw.visualLon ?? raw.visual_lon,
        color: raw.color, // 🔥 V332
        status: raw.status,
        intermediateCoords: raw.intermediateCoords || raw.intermediate_coords
    };

    // 2. Filter undefined to support Patch Semantics
    Object.keys(canonical).forEach(key => canonical[key] === undefined && delete canonical[key]);

    // 3. Zod Validation
    const result = locationSchema.safeParse(canonical);
    if (!result.success) {
        return { success: false, error: result.error.format() };
    }

    return { success: true, data: result.data };
}

async function validateAndProcessLocation(raw, metadata = {}) {
    const result = sanitizeAndValidate(raw);

    if (!result.success) {
        console.warn(`⚠️ Validation failed for device ${raw.deviceId || raw.device_id || 'unknown'}:`, result.error);
        return { success: false, error: result.error };
    }

    const data = result.data;
    const id = data.deviceId;

    // 🔥 V319: Wrap in queue to prevent async race conditions
    return enqueueUpdate(id, async () => {
        // 🔥 V318: Unified Authentication Guard (Async)
        const providedSecret = metadata.deviceSecret || null;
        const isAuth = await verifyDeviceAuth(id, providedSecret, { provisioningKey: metadata.provisioningKey });

        if (!isAuth) {
            console.warn(`🚨 AUTH REJECTED: ${id}`);
            return { success: false, code: 401, error: "Unauthorized: Invalid Device Token or Provisioning Key" };
        }

        // 🔥 V311/V315: Stream Binding Guard
        if (metadata.authenticatedId && metadata.authenticatedId !== id) {
            console.warn(`🚨 SPOOFING ATTEMPT: ${metadata.authenticatedId} tried to update ${id}`);
            return { success: false, code: 403, error: "Unauthorized device ID" };
        }

        const update = await updateDevice(id, data, metadata);
        if (!update.updated) {
            return { success: true, updated: false, reason: update.reason, id };
        }

        return { success: true, updated: true, id, data: devices[id] };
    });
}

// 🔥 V318: Hash helpers for Device Secrets
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

// 🔥 V317/V318/V321/V334: Device Authentication Helper with Re-Provisioning support
async function verifyDeviceAuth(id, secret, metadata = {}) {
    if (!id) return false;
    const device = devices[id];

    // 🔥 V334: If the correct Provisioning Key is provided, we ALWAYS allow the access.
    // This allows devices to re-register (e.g. after cache clear) without manual server intervention.
    const provKey = (metadata.provisioningKey || "").trim();
    if (provKey && provKey === PROVISIONING_KEY) {
        return true;
    }

    // Standard Auth via Secret
    if (!device || !device.deviceSecretHash) {
        return false; // Provisioning key was required but missing/wrong (handled above)
    }

    if (!secret) return false;
    return await verifySecret(secret.trim(), device.deviceSecretHash);
}

// 🔥 V317: Protobuf Safe Decoding
function decodeProtoSafe(type, buffer) {
    try {
        return type.toObject(type.decode(buffer), { defaults: false, longs: Number });
    } catch (err) {
        console.warn(`⚠️ Protobuf decode failed for ${type.name}:`, err.message);
        return null;
    }
}

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
const grpcStreams = new Map();

// --- gRPC HELPERS ---
// 🔥 V318/V322: Robust optional numeric mapping (prevent Null Island / 0 defaults)
function mapAppToProto(data) {
    if (!data) return data;

    // 1. Fixed required/string fields
    const p = {
        device_id: data.deviceId || "",
        timestamp: data.timestamp ? Number(data.timestamp) : Date.now(),
        name: data.name || "",
        status: data.status || "online",
        offline: !!data.offline,
        alarm_active: !!data.alarmActive,
        is_awake: !!(data.isAwake ?? true),
        is_watched: !!data.isWatched,
        watcher_name: data.watcherName || "",
        fcm_token: data.fcmToken || "",
        is_locked: !!data.isLocked,
        is_motion: !!data.isMotion,
        is_wifi: !!data.isWifi,
        accident: !!data.accident,
        geofence_event: data.geofenceEvent || "",
        motion_state: data.motionState || "STILL",
        intermediate_coords: data.intermediateCoords || [],
        color: data.color || 0 // 🔥 V332
    };

    // 2. Safe numeric assignment: OMIT if null, undefined, or NaN
    const safeNum = (val) => {
        const n = Number(val);
        return (val != null && !isNaN(n)) ? n : undefined;
    };

    if (data.lat != null) p.lat = safeNum(data.lat);
    if (data.lon != null) p.lon = safeNum(data.lon);
    if (data.battery != null) p.battery = Math.round(safeNum(data.battery) || 0);
    if (data.speed != null) p.speed = safeNum(data.speed);
    if (data.bearing != null) p.bearing = safeNum(data.bearing);
    if (data.accuracy != null) p.accuracy = safeNum(data.accuracy);
    if (data.sats != null) p.sats = Math.round(safeNum(data.sats) || 0);
    if (data.snappedLat != null) p.snapped_lat = safeNum(data.snappedLat);
    if (data.snappedLon != null) p.snapped_lon = safeNum(data.snappedLon);
    if (data.visualLat != null) p.visual_lat = safeNum(data.visualLat);
    if (data.visualLon != null) p.visual_lon = safeNum(data.visualLon);

    return DeviceLocationProto.create(p);
}

function mapProtoToApp(data) {
    if (!data) return data;
    const deviceId = data.deviceId || data.device_id || "";

    // 🔥 V315: Strict Patch Semantics - Missing fields remain undefined
    return {
        deviceId: deviceId,
        lat: data.lat !== undefined ? Number(data.lat) : undefined,
        lon: data.lon !== undefined ? Number(data.lon) : undefined,
        timestamp: data.timestamp ? Number(data.timestamp) : undefined,
        accuracy: data.accuracy !== undefined ? Number(data.accuracy) : undefined,
        speed: data.speed !== undefined ? Number(data.speed) : undefined,
        bearing: data.bearing !== undefined ? Number(data.bearing) : undefined,
        battery: data.battery ?? data.battery_pct ?? data.batteryPct,
        alarmActive: data.alarmActive ?? data.alarm_active,
        isAwake: data.isAwake ?? data.is_awake,
        isWatched: data.isWatched ?? data.is_watched,
        isLocked: data.isLocked ?? data.is_locked,
        isMotion: data.isMotion ?? data.is_motion,
        isWifi: data.isWifi ?? data.is_wifi,
        accident: data.accident,
        fcmToken: data.fcmToken || data.fcm_token,
        geofenceEvent: data.geofenceEvent || data.geofence_event,
        motionState: data.motionState || data.motion_state,
        snappedLat: data.snappedLat || data.snapped_lat,
        snappedLon: data.snappedLon || data.snapped_lon,
        visualLat: data.visualLat || data.visual_lat,
        visualLon: data.visualLon || data.visual_lon,
        color: data.color, // 🔥 V332
        sats: data.sats ?? data.sats_count ?? data.satsInFix,
        name: data.name,
        watcherName: data.watcherName || data.watcher_name,
        intermediateCoords: data.intermediateCoords || data.intermediate_coords,
        status: data.status
    };
}

// 🔥 V315/V317: Security - Mandatory Sanitization for all external communication
function mapToPublic(device) {
    if (!device) return device;
    // Strictly whitelist keys that are safe to expose
    const {
        fcmToken,
        fcm_token,
        deviceSecret,
        device_secret,
        ...safeDevice
    } = device;
    return safeDevice;
}

// 🔥 V318: FCM Data Normalizer
function normalizeFcmData(payload) {
    return Object.fromEntries(
        Object.entries(payload ?? {}).map(([k, v]) => [k, String(v)])
    );
}

// --- BROADCAST LOGIC ---
function pushUpdateToAll(device) {
    if (!device?.deviceId) return;

    // 🔥 V316/V318: Zero-Leak Enforcement - Broadcast COMPLETE merged state
    const publicDevice = mapToPublic(device);
    io.to(device.deviceId).emit('location_update', publicDevice);

    const protoDevice = mapAppToProto(publicDevice);
    const response = {
        device_id: device.deviceId,
        timestamp: Date.now(),
        server_response: { device: protoDevice }
    };

    if (device.geofenceEvent && (device.geofenceEvent.startsWith('enter:') || device.geofenceEvent.startsWith('exit:'))) {
        console.log(`🚩 GEOFENCE EVENT: ${device.deviceId} -> ${device.geofenceEvent}`);
    }
    if (device.alarmActive) console.log(`🔊 ALARM ACTIVE: ${device.deviceId}`);
    if (device.accident) console.log(`🚨 ACCIDENT ALERT: ${device.deviceId}`);

    const streamCount = grpcStreams.size;
    if (streamCount > 0) {
        console.log(`📡 BROADCAST: ${device.deviceId} to ${streamCount} streams`);
    }

    for (const [streamId, call] of grpcStreams) {
        try {
            if (!call || call.destroyed) { grpcStreams.delete(streamId); continue; }

            // 🔥 V319: Robust Backpressure Handling
            const ok = call.write(response);
            if (!ok) {
                // If buffer is full, wait for 'drain' or pause until next update
                // For gRPC streams, if write returns false, we should ideally queue or drop
                // but _pendingWrites was a bad internal hack.
                // We'll just log and let gRPC handle internal buffering,
                // and if it gets too lagged (detectable via ping/pong), watchdog will kill it.
                // console.log(`📡 gRPC BACKPRESSURE for ${device.deviceId}`);
            }
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
    } catch (e) {
        console.error("❌ KRITISCH: Firebase Initialisierung fehlgeschlagen:", e.message);
        process.exit(1); // FCM ist für Alarme zwingend erforderlich
    }
}

const app = express();
app.set('trust proxy', 1);
app.use(compression());
app.use(cors({ origin: "*" }));

// --- 🛡️ RATE LIMITING ---
app.use('/location', rateLimit({ windowMs: 60000, max: 2000 })); // 🔥 V311: Fixed bypass bug
app.use(['/devices', '/geofences'], rateLimit({ windowMs: 60000, max: 120 }));

// --- gRPC SERVER ---
const grpcServer = new grpc.Server();
grpcServer.addService(trackingProto.TrackingService.service, {
    GetDevices: (call, callback) => {
        const meta = call.metadata.get('x-api-key');
        if (meta?.[0] !== API_KEY) return callback({ code: grpc.status.UNAUTHENTICATED, details: "Invalid API Key" });

        const list = Object.values(devices || {});
        // 🔥 V317: Unified Sanitization for gRPC
        const publicList = list.map(mapToPublic);

        callback(null, { devices: publicList.map(mapAppToProto) });
    },
    TrackLocation: (call) => {
        const meta = call.metadata.get('x-api-key');
        if (meta?.[0] !== API_KEY) {
            console.warn("🔐 gRPC AUTH FAILED: Invalid API Key");
            call.emit('error', { code: grpc.status.UNAUTHENTICATED });
            return call.end();
        }
        if (grpcStreams.size >= 1000) return call.end();

        const streamId = crypto.randomUUID();
        call.lastActivity = Date.now();
        grpcStreams.set(streamId, call);
        console.log(`📡 gRPC CONNECTED: ${streamId.substring(0, 8)}... (Total: ${grpcStreams.size})`);

        const cleanup = () => {
            if (grpcStreams.has(streamId)) {
                console.log(`🔌 gRPC DISCONNECTED: ${streamId.substring(0, 8)}...`);
                grpcStreams.delete(streamId);
            }
        };

        call.on('data', async (event) => {
            if (!call || call.destroyed) return;
            call.lastActivity = Date.now();
            const update = event.location_update;
            if (!update) return;

            // 🔥 V318: Identity Pinning - Check if ID matches bound stream ID
            const id = normalizeDeviceId(update.deviceId || update.device_id);
            if (call.deviceId && call.deviceId !== id) {
                console.warn(`🚨 gRPC IDENTITY BREACH: Stream bound to ${call.deviceId} received data for ${id}`);
                return call.destroy({ code: grpc.status.INVALID_ARGUMENT, details: "Stream identity bound to different deviceId" });
            }

            // 🔥 V317: Extract device token from metadata for each packet or first packet binding
            const deviceToken = call.metadata.get('x-device-token')?.[0];
            const provisioningKey = call.metadata.get('x-provisioning-key')?.[0];

            // 🔥 V311/V315/V317/V318/V321: Unified Validation Pipeline
            try {
                const result = await validateAndProcessLocation(update, {
                    authenticatedId: call.deviceId,
                    deviceSecret: deviceToken,
                    provisioningKey: provisioningKey
                });

                if (result.success) {
                    // 🔥 V315: Bind stream to device on first packet
                    if (!call.deviceId) {
                        call.deviceId = result.id;
                    }

                    if (result.updated) {
                        for (const [sid, old] of grpcStreams) {
                            if (sid !== streamId && old.deviceId === result.id) {
                                try { old.end(); } catch {} grpcStreams.delete(sid);
                            }
                        }
                        await saveDevicesSafe({ immediate: result.data.alarmActive || result.data.accident });
                        pushUpdateToAll(result.data);
                    }
                } else {
                    // 🔥 V321: Explicit gRPC Error Response
                    console.warn(`⚠️ gRPC update rejected for ${id}: ${result.error}`);
                    if (result.code === 401 || result.code === 403) {
                        return call.destroy({ code: result.code === 401 ? grpc.status.UNAUTHENTICATED : grpc.status.PERMISSION_DENIED, details: result.error });
                    }
                }
            } catch (err) {
                console.error(`🔥 gRPC Internal Error for ${id}:`, err.message);
            }
        });
        call.on('end', cleanup); call.on('error', cleanup); call.on('close', cleanup);
    }
});

// Watchdog
setInterval(() => {
    const now = Date.now();
    for (const [sid, call] of grpcStreams) { if (now - (call.lastActivity || 0) > 300000) { try { call.end(); } catch {} grpcStreams.delete(sid); } }

    Object.values(devices).forEach(d => {
        const lastLocationAt = d.lastLocationAt || d.lastSeen || 0;
        if (d.isWatched && (now - lastLocationAt) > 300000) {
            console.log(`🧹 AUTO-UNWATCH: ${d.deviceId} (Inactivity)`);
            d.isWatched = false;
            delete d.watcherName;
            pushUpdateToAll(d);
        }
    });
}, 60000);

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

io.use((socket, next) => {
    // 🔥 V311/V315: Force secure handshake auth, disable query param fallback
    if (socket.handshake.auth?.apiKey !== API_KEY) {
        console.warn("🔐 Socket.IO Auth Failed");
        return next(new Error("Unauthorized"));
    }
    next();
});

io.on('connection', (socket) => {
    socket.on('join_device', async (data) => {
        const rawId = (typeof data === 'string' ? data : (data?.device_id || data?.deviceId));
        const deviceToken = data?.deviceToken || data?.device_token;
        const id = normalizeDeviceId(rawId);

        // 🔥 V317/V318: Require device token to join its own room
        if (id && (await verifyDeviceAuth(id, deviceToken))) {
            socket.join(id);
            // 🔥 V316: Sanitize join-echo
            if (devices[id]) socket.emit('location_update', mapToPublic(devices[id]));
        } else {
            console.warn(`🔐 Socket.IO join_device REJECTED for ${id}`);
        }
    });
});

// 🔥 V311/V315: Timing Safe API Key Check
app.use((req, res, next) => {
    if (req.path === '/' || req.path.startsWith('/socket.io')) return next();

    const providedKey = req.headers['x-api-key'];
    const expectedKey = API_KEY;

    if (typeof providedKey !== 'string' || providedKey.length !== expectedKey.length) {
        return res.sendStatus(401);
    }

    try {
        if (!crypto.timingSafeEqual(Buffer.from(providedKey), Buffer.from(expectedKey))) {
            return res.sendStatus(401);
        }
    } catch (e) {
        return res.sendStatus(401);
    }
    next();
});

app.get('/', (req, res) => res.send('🚀 GPS Server is running.'));

app.get('/v1/debug/devices', safe((req, res) => {
    // 🔥 V315: Production Guard
    if (process.env.NODE_ENV === 'production') return res.sendStatus(404);

    res.json({
        count: Object.keys(devices).length,
        devices: Object.values(devices).map(mapToPublic), // 🔥 V317: Sanitize even in debug
        lastPushTimesSize: Object.keys(lastPushTimes).length,
        grpcStreamsCount: grpcStreams.size
    });
}));

const jsonParser = bodyParser.json({ limit: '200kb' });
const protoParser = bodyParser.raw({ type: 'application/x-protobuf', limit: '200kb' });

app.post(['/location', '/v1/location'], protoParser, jsonParser, safe(async (req, res) => {
    let raw = req.body;
    if (Buffer.isBuffer(req.body) && req.body.length > 0) {
        raw = decodeProtoSafe(LocationUpdateProto, req.body);
        if (!raw) return res.status(400).json({ success: false, error: "Invalid Protobuf payload" });
    }

    // 🔥 V318: Extract Secrets
    const deviceSecret = req.headers['x-device-token'];
    const provisioningKey = req.headers['x-provisioning-key'];

    // 🔥 V311/V315/V320: Unified Pipeline
    const result = await validateAndProcessLocation(raw, { deviceSecret, provisioningKey });
    if (!result.success) return res.status(result.code || 400).json({ success: false, error: result.error });

    if (result.updated) {
        await saveDevicesSafe({ immediate: !!(result.data.alarmActive || result.data.accident) });
        pushUpdateToAll(result.data);
    }
    res.sendStatus(200);
}));

app.post('/v1/device/register-fcm', jsonParser, safe(async (req, res) => {
    const result = fcmRegistrationSchema.safeParse(req.body);
    if (!result.success) return res.status(400).json(result.error.format());

    const { deviceId, fcmToken } = result.data;
    const deviceSecret = req.headers['x-device-token'];
    const provisioningKey = req.headers['x-provisioning-key'];

    if (!(await verifyDeviceAuth(deviceId, deviceSecret, { provisioningKey }))) {
        return res.status(401).json({ error: "Invalid Device Token or Provisioning Key" });
    }

    if (!devices[deviceId]) {
        // TOFU registration with Provisioning Key
        devices[deviceId] = {
            deviceId,
            deviceSecretHash: await hashSecret(deviceSecret),
            fcmToken,
            status: 'online',
            lastSeen: Date.now()
        };
    } else {
        devices[deviceId].fcmToken = fcmToken;
        devices[deviceId].status = 'online';
        devices[deviceId].lastSeen = Date.now();
    }

    await saveDevicesSafe({ immediate: true });
    res.sendStatus(200);
}));

app.post('/v1/location/raw', protoParser, safe(async (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ success: false, error: "Empty payload" });
    const raw = decodeProtoSafe(LocationUpdateProto, req.body);
    if (!raw) return res.status(400).json({ success: false, error: "Invalid Protobuf payload" });

    const deviceSecret = req.headers['x-device-token'];
    const provisioningKey = req.headers['x-provisioning-key'];

    // 🔥 V311/V315/V320: Unified Pipeline (Async Fix)
    const result = await validateAndProcessLocation(raw, { deviceSecret, provisioningKey });
    if (!result.success) return res.status(result.code || 400).json({ success: false, error: result.error });

    if (result.updated) {
        await saveDevicesSafe({ immediate: !!(result.data.alarmActive || result.data.accident) });
        pushUpdateToAll(result.data);
    }
    res.sendStatus(200);
}));

app.post(['/location/update-batch', '/v1/location/batch'], protoParser, jsonParser, safe(async (req, res) => {
    let rawUpdates = req.body;
    if (Buffer.isBuffer(req.body)) {
        const decoded = decodeProtoSafe(LocationBatchProto, req.body);
        if (!decoded) return res.status(400).json({ success: false, error: "Invalid Protobuf payload" });
        rawUpdates = (decoded.updates || []).map(u => mapProtoToApp(u));
    }

    // 🔥 V317: Batch Validation using Schema
    const parsed = batchSchema.safeParse(rawUpdates);
    if (!parsed.success) return res.status(400).json({ success: false, error: "Batch validation failed", details: parsed.error.format() });

    // 🔥 V318: Enforce single-device batch to prevent credential leaks
    const deviceIds = [...new Set(parsed.data.map(u => u.deviceId))];
    if (deviceIds.length !== 1) {
        return res.status(400).json({ success: false, error: "Batch must contain exactly one deviceId" });
    }

    const deviceSecret = req.headers['x-device-token'];
    const provisioningKey = req.headers['x-provisioning-key'];
    const id = deviceIds[0];

    const updatedIds = new Set();
    let hasCritical = false;

    for (const raw of parsed.data) {
        const result = await validateAndProcessLocation(raw, { deviceSecret, provisioningKey });
        if (result.success && result.updated) {
            updatedIds.add(result.id);
            if (result.data.alarmActive || result.data.accident) hasCritical = true;
        }
    }

    if (updatedIds.size > 0) {
        await saveDevicesSafe({ immediate: hasCritical });
        for (const id of updatedIds) {
            if (devices[id]) pushUpdateToAll(devices[id]);
        }
    }
    res.sendStatus(200);
}));

app.get(['/devices', '/v1/devices'], safe((req, res) => {
    const list = Object.values(devices || {});
    // 🔥 V317: Unified Sanitization
    const publicList = list.map(mapToPublic);

    if (req.headers['accept']?.includes('application/x-protobuf')) {
        return res.setHeader('Content-Type', 'application/x-protobuf').send(DeviceListProto.encode(DeviceListProto.create({
            devices: publicList.map(mapAppToProto)
        })).finish());
    }
    res.json(publicList);
}));

app.get(['/devices/:id', '/v1/devices/:id'], safe(async (req, res) => {
    const id = normalizeDeviceId(req.params.id);
    const d = id ? devices[id] : null;
    if (!d) return res.sendStatus(404);

    // 🔥 V321: Differentiate Auth - allow watchers with API_KEY OR the device itself
    const deviceToken = req.headers['x-device-token'];
    const providedApiKey = (req.headers['x-api-key'] || "").trim();

    const isWatcher = providedApiKey === API_KEY.trim();
    const isSelf = deviceToken && (await verifyDeviceAuth(id, deviceToken));

    if (!isWatcher && !isSelf) {
        console.warn(`🔐 DEVICE GET REJECTED for ${id}`);
        return res.sendStatus(401);
    }

    const publicData = mapToPublic(d);

    if (req.headers['accept']?.includes('application/x-protobuf')) {
        return res.setHeader('Content-Type', 'application/x-protobuf').send(DeviceLocationProto.encode(mapAppToProto(publicData)).finish());
    }

    res.json(publicData);
}));

// 🔥 V318: Control Auth Middleware
async function controlAuthMiddleware(req, res, next) {
    const id = normalizeDeviceId(req.params.id);
    const deviceToken = req.headers['x-device-token'];

    // Allow if it's the device itself with a valid token
    if (id && deviceToken) {
        const isAuth = await verifyDeviceAuth(id, deviceToken);
        if (isAuth) return next();
    }

    // OR allow if it's an admin/watcher with the global API Key
    // (In V318 we treat API_KEY as the "Control" key)
    const providedKey = req.headers['x-api-key'];
    if (providedKey === API_KEY) return next();

    res.sendStatus(401);
}

app.post(['/devices/:id/alarm', '/v1/devices/:id/alarm'], controlAuthMiddleware, safe(async (req, res) => {
    const id = normalizeDeviceId(req.params.id);
    if (!id || !devices[id]) return res.sendStatus(404);

    const d = devices[id];
    d.alarmActive = req.query.active === 'true';
    await saveDevicesSafe({ immediate: true });
    pushUpdateToAll(d);

    const helpersPayload = { type: 'alarm', deviceId: id, message: `${d.name || id} braucht Hilfe!`, deviceName: d.name || id };

    // --- 🛡️ SAFE BROADCAST TO HELPERS ---
    const senderId = id;
    Object.values(devices).forEach(target => {
        const targetId = target.deviceId;
        if (target.fcmToken && targetId !== senderId && targetId !== normalizeDeviceId(req.query.triggererId)) {
            admin.messaging().send({ data: helpersPayload, token: target.fcmToken })
                .catch(e => console.warn(`⚠️ Helper FCM failed for ${targetId}:`, e.message));
        }
    });

    // --- 🛡️ SAFE DIRECT ALARM TO TARGET ---
    if (d.alarmActive && d.fcmToken) {
        admin.messaging().send({
            data: { ...helpersPayload, message: "Fernauslösung: Alarm aktiviert!" },
            token: d.fcmToken,
            android: { priority: 'high' }
        }).catch(e => console.warn(`⚠️ Direct Alarm FCM failed for ${id}:`, e.message));
    } else if (!d.alarmActive && d.fcmToken) {
        // 🔥 V126: Also send STOP command via FCM for backgrounded devices
        admin.messaging().send({
            data: { type: 'stop_alarm', deviceId: id },
            token: d.fcmToken,
            android: { priority: 'high' }
        }).catch(e => console.warn(`⚠️ Stop Alarm FCM failed for ${id}:`, e.message));
    }

    io.to(id).emit('command', { deviceId: id, action: d.alarmActive ? 'START_ALARM' : 'STOP_ALARM' });
    res.sendStatus(200);
}));

app.post(['/devices/:id/wakeup', '/v1/devices/:id/wakeup'], controlAuthMiddleware, safe(async (req, res) => {
    const id = normalizeDeviceId(req.params.id);
    if (!id || !devices[id]) return res.sendStatus(404);

    const d = devices[id];

    if (d.fcmToken) {
        admin.messaging().send({
            data: normalizeFcmData({ type: 'wakeup', deviceId: id }),
            token: d.fcmToken,
            android: { priority: 'high' }
        }).catch(e => console.warn(`⚠️ Wakeup FCM failed for ${id}:`, e.message));
    }
    res.sendStatus(200);
}));

app.post('/v1/devices/wakeup-all', safe(async (req, res) => {
    if (req.headers['x-api-key'] !== API_KEY) return res.sendStatus(401); // Admin only

    const allDevices = Object.values(devices);
    // 🔥 V318: Batch Wakeup to prevent request spam
    const batches = [];
    for (let i = 0; i < allDevices.length; i += 100) batches.push(allDevices.slice(i, i + 100));

    for (const batch of batches) {
        await Promise.all(batch.map(d => {
            if (d.fcmToken) {
                return admin.messaging().send({
                    data: normalizeFcmData({ type: 'wakeup', deviceId: d.deviceId }),
                    token: d.fcmToken
                }).catch(() => {});
            }
            return Promise.resolve();
        }));
    }
    res.sendStatus(200);
}));

app.post(['/devices/:id/watch', '/v1/devices/:id/watch'], controlAuthMiddleware, safe(async (req, res) => {
    const id = normalizeDeviceId(req.params.id);
    if (!id || !devices[id]) {
        console.warn(`🚨 WATCH FAILED: Device ${id} not found. Registered IDs: ${Object.keys(devices)}`);
        return res.sendStatus(404);
    }

    const d = devices[id];
    d.isWatched = true;
    d.watcherName = req.query.watcherName || req.query.watcher_name || "Jemand";
    console.log(`👁️ WATCHING: ${id} by ${d.watcherName}`);

    await saveDevicesSafe({ immediate: true });
    pushUpdateToAll(d);

    if (d.fcmToken) {
        admin.messaging().send({
            data: normalizeFcmData({ type: 'watch_state', state: 'true', watcherName: d.watcherName, targetId: d.deviceId }),
            token: d.fcmToken,
            android: { priority: 'high' }
        }).catch(e => console.warn(`⚠️ Watch Notification failed:`, e.message));
    }
    res.sendStatus(200);
}));

app.post(['/devices/:id/unwatch', '/v1/devices/:id/unwatch'], controlAuthMiddleware, safe(async (req, res) => {
    const id = normalizeDeviceId(req.params.id);
    if (!id || !devices[id]) return res.sendStatus(404);

    const d = devices[id];
    d.isWatched = false;
    delete d.watcherName;

    await saveDevicesSafe({ immediate: true });
    pushUpdateToAll(d);

    if (d.fcmToken) {
        admin.messaging().send({
            data: normalizeFcmData({ type: 'watch_state', state: 'false' }),
            token: d.fcmToken
        }).catch(e => console.warn(`⚠️ Unwatch Notification failed:`, e.message));
    }
    res.sendStatus(200);
}));

// 🔥 V308: Telemetry Control Routes
app.post(['/devices/:id/request-telemetry', '/v1/devices/:id/request-telemetry'], safe(async (req, res) => {
    const id = normalizeDeviceId(req.params.id);
    const d = id ? devices[id] : null;
    if (!d || !d.fcmToken) return res.sendStatus(404);

    admin.messaging().send({
        data: { type: 'request_telemetry', deviceId: id },
        token: d.fcmToken,
        android: { priority: 'high' }
    }).then(() => console.log(`📡 Telemetry request sent to ${id}`))
      .catch(e => console.warn(`⚠️ Telemetry Request FCM failed:`, e.message));

    res.sendStatus(200);
}));

app.post(['/devices/:id/delete-telemetry', '/v1/devices/:id/delete-telemetry'], controlAuthMiddleware, safe(async (req, res) => {
    const id = normalizeDeviceId(req.params.id);
    if (!id) return res.sendStatus(400);

    const file = path.join(TELEMETRY_DIR, `telemetry_${id}.bin`);
    try {
        await fs.unlink(file);
        console.log(`🗑️ TELEMETRY DELETED: ${id}`);
    } catch (e) {}

    const d = devices[id];
    if (d?.fcmToken) {
        admin.messaging().send({
            data: normalizeFcmData({ type: 'delete_telemetry', deviceId: id }),
            token: d.fcmToken,
            android: { priority: 'high' }
        }).catch(() => {});
    }
    await saveDevicesSafe({ immediate: true });
    res.sendStatus(200);
}));

app.post(['/devices/:id/break-lock', '/v1/devices/:id/break-lock'], controlAuthMiddleware, safe(async (req, res) => {
    const id = normalizeDeviceId(req.params.id);
    if (!id || !devices[id]) return res.sendStatus(404);

    const d = devices[id];

    if (d.fcmToken) {
        admin.messaging().send({
            data: normalizeFcmData({ type: 'break_lock', deviceId: id }),
            token: d.fcmToken,
            android: { priority: 'high' }
        }).then(() => console.log(`🔓 Break Lock sent to ${id}`))
          .catch(e => console.warn(`⚠️ Break Lock FCM failed for ${id}:`, e.message));
    }
    await saveDevicesSafe({ immediate: true });
    res.sendStatus(200);
}));

app.post('/v1/devices/:id/proximity', safe(async (req, res) => {
    const id = normalizeDeviceId(req.params.id);
    const otherId = normalizeDeviceId(req.query.otherId);
    const deviceSecret = req.headers['x-device-token'];

    // 🔥 V318: Secure Proximity reporting
    if (!(await verifyDeviceAuth(id, deviceSecret))) return res.sendStatus(401);

    const distanceVal = Number(req.query.distance);
    const distanceStr = (Number.isFinite(distanceVal) && distanceVal >= 0) ? distanceVal.toString() : "?";
    const name = req.query.name || "Unbekanntes Gerät";

    if (!id || !otherId) return res.sendStatus(400);

    console.log(`📏 PROXIMITY REPORT: ${id} near ${otherId} (${distanceStr}m)`);

    await broadcast(id, {
        type: 'proximity_alert',
        deviceId: id,
        otherId: otherId,
        name: name,
        distance: distanceStr
    });

    res.sendStatus(200);
}));

app.get(['/geofences', '/v1/geofences'], safe((req, res) => res.json(geofences || [])));
app.post(['/geofences', '/v1/geofences'], jsonParser, safe(async (req, res) => {
    const result = geofenceSchema.safeParse(req.body);
    if (!result.success) return res.status(400).json(result.error.format());

    const gf = result.data;
    geofences = (geofences || []).filter(item => item.id !== gf.id);
    geofences.push(gf);
    await queueWrite(GEOFENCE_FILE, JSON.stringify(geofences, null, 2));
    broadcastGeofenceReload(); res.sendStatus(200);
}));

app.delete(['/geofences/:id', '/v1/geofences/:id'], safe(async (req, res) => {
    const id = req.params.id;
    geofences = (geofences || []).filter(item => item.id !== id);
    await queueWrite(GEOFENCE_FILE, JSON.stringify(geofences, null, 2));
    broadcastGeofenceReload(); res.sendStatus(200);
}));

app.post('/v1/test/proximity', safe(async (req, res) => {
    if (process.env.NODE_ENV === 'production') return res.sendStatus(404);
    const testId = "test_device";
    await broadcast(testId, {
        type: 'proximity_alert',
        deviceId: testId,
        name: "Test-Dummy",
        distance: "150"
    });
    res.sendStatus(200);
}));

app.post(['/location/clear/:id', '/v1/location/clear/:id'], safe(async (req, res) => {
    const id = normalizeDeviceId(req.params.id);
    if (!id) return res.sendStatus(400);
    res.sendStatus(200);
}));

// 🔥 V318: Authentication Middleware for Telemetry
async function telemetryAuthMiddleware(req, res, next) {
    const id = normalizeDeviceId(req.headers['x-device-id']);
    const deviceSecret = req.headers['x-device-token'];

    if (!id || !deviceSecret) return res.sendStatus(401);

    const isAuth = await verifyDeviceAuth(id, deviceSecret);
    if (!isAuth) return res.sendStatus(401);

    next();
}

// 🔥 V308: Telemetry Sync Routes
app.post(['/telemetry/upload', '/v1/telemetry/upload'], rateLimit({ windowMs: 60000, max: 5 }), telemetryAuthMiddleware, upload.single('file'), safe(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "file is required" });
    const id = normalizeDeviceId(req.headers['x-device-id']);
    console.log(`📤 TELEMETRY UPLOAD SUCCESS: ${id}`);
    res.sendStatus(200);
}));

app.get(['/telemetry/download/:id', '/v1/telemetry/download/:id'], safe(async (req, res) => {
    const id = normalizeDeviceId(req.params.id);
    if (!id) return res.sendStatus(400);

    // 🔥 V319: Security - Telemetry download requires OWN device token or ADMIN api key
    const deviceToken = req.headers['x-device-token'];
    const apiKey = req.headers['x-api-key'];

    const isOwnDevice = deviceToken && (await verifyDeviceAuth(id, deviceToken));
    const isAdmin = apiKey === API_KEY;

    if (!isOwnDevice && !isAdmin) {
        console.warn(`🔐 TELEMETRY DOWNLOAD REJECTED for ${id}`);
        return res.sendStatus(401);
    }

    const file = path.join(TELEMETRY_DIR, `telemetry_${id}.bin`);
    try {
        await fs.access(file);
        res.download(file);
    } catch (e) {
        res.status(404).send("Telemetry not found");
    }
}));

// --- PERSISTENCE ---
let writeQueue = Promise.resolve();
function queueWrite(file, data) {
    writeQueue = writeQueue.then(async () => {
        const tmp = file + '.tmp';
        await fs.writeFile(tmp, data);
        await fs.rename(tmp, file);
    });
    // 🔥 V317: Propagate errors to caller
    return writeQueue.catch(err => {
        console.error(`💾 WRITE ERROR [${file}]:`, err.message);
        throw err;
    });
}

let saveTimer = null;
async function saveDevicesSafe(opts = { immediate: false }) {
    if (opts.immediate || opts.forceSave) {
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = null;
        const snapshot = structuredClone(devices);
        try {
            await queueWrite(DATA_FILE, JSON.stringify(snapshot, null, 2));
            console.log("🔥 Critical Flush: Data persisted immediately.");
        } catch (e) {
            console.error("🔥 Critical Flush FAILED:", e.message);
            throw e;
        }
        return;
    }

    if (saveTimer) return;

    saveTimer = setTimeout(async () => {
        saveTimer = null;
        const snapshot = structuredClone(devices);
        try {
            await queueWrite(DATA_FILE, JSON.stringify(snapshot, null, 2));
            console.log("💾 Periodic Save: Device state persisted.");
        } catch (e) {
            console.error("💾 Periodic Save FAILED:", e.message);
        }
    }, 10000);
}

async function init() {
    try {
        await fs.mkdir(TELEMETRY_DIR, { recursive: true });
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

const DEFAULT_NAMES = new Set(["User", "Jemand", "Unbekannt", "Oliver", "Nicole"]);
const isDefaultName = (name) => !name || DEFAULT_NAMES.has(name);

async function updateDevice(id, data, metadata = {}) {
    const old = devices[id] || {};
    const now = Date.now();

    // 🔥 V317/V318: Stale Packet Protection
    if (old.timestamp && data.timestamp && data.timestamp < old.timestamp) {
        const lagMs = old.timestamp - data.timestamp;
        const lastSeenAgo = now - (old.lastSeen || 0);

        if (lagMs < 86400000 && lastSeenAgo < 60000) {
            return { updated: false, reason: 'stale' };
        }
    }

    const merged = { ...old };

    // 🔥 V318/V323: Hash Device Secret if new (Provisioning)
    if (!merged.deviceSecretHash && metadata.deviceSecret) {
        merged.deviceSecretHash = await hashSecret(metadata.deviceSecret);
        console.log(`✅ DEVICE PROVISIONED: ${id}`);
    }

    for (const key in data) {
        if (data[key] !== undefined) {
            merged[key] = data[key];
        }
    }

    merged.deviceId = id;
    merged.lastSeen = now;
    if (data.lat !== undefined && data.lon !== undefined) {
        merged.lastLocationAt = now;
    }
    merged.status = 'online';
    merged.name = isDefaultName(old.name) ? (data.name || old.name) : (old.name || data.name);

    devices[id] = merged;
    handleEvents(id, devices[id], old).catch(err => console.error(`❌ Event error for ${id}:`, err));
    return { updated: true };
}

async function handleEvents(id, data, old) {
    const device = devices[id]; if (!device) return;

    if (data.accident && !old.accident) {
        console.log(`🚨 BROADCASTING ACCIDENT: ${id}`);
        await broadcast(id, normalizeFcmData({
            type: 'accident_alert',
            deviceId: id,
            name: device.name || id,
            message: `${device.name || id} hat einen Unfall!`
        }));
    }

    if (typeof data.geofenceEvent === 'string' && (data.geofenceEvent.startsWith('enter:') || data.geofenceEvent.startsWith('exit:'))) {
        const key = `gf:${id}:${data.geofenceEvent}`;

        if (Object.keys(lastPushTimes).length > 5000) {
            const cutoff = Date.now() - 5 * 60 * 1000;
            for (const [k, v] of Object.entries(lastPushTimes)) {
                if (v < cutoff) delete lastPushTimes[k];
            }
        }

        if (Date.now() - (lastPushTimes[key] || 0) > 120000) {
            lastPushTimes[key] = Date.now();
            const [action, ...name] = data.geofenceEvent.split(':');
            const zoneName = name.join(':') || 'Zone';
            await broadcast(id, normalizeFcmData({
                type: 'geofence_event',
                deviceId: id,
                zoneName: zoneName,
                deviceName: device.name || id,
                action: action === 'enter' ? 'betreten' : 'verlassen'
            }));
        }
    }
}

async function broadcast(senderId, payload) {
    const fcmPayload = normalizeFcmData(payload);
    const tokens = [...new Set(Object.values(devices)
        .filter(d => {
            const id = d.deviceId;
            return id !== senderId && d.fcmToken && d.fcmToken.length > 10;
        })
        .map(d => d.fcmToken)
    )];

    if (tokens.length === 0) return;

    const batches = [];
    for (let i = 0; i < tokens.length; i += 500) {
        batches.push(tokens.slice(i, i + 500));
    }

    for (const batch of batches) {
        try {
            const res = await admin.messaging().sendEachForMulticast({ data: fcmPayload, tokens: batch, android: { priority: 'high' } });
            if (res.failureCount > 0) {
                res.responses.forEach((r, idx) => {
                    if (!r.success && r.error) {
                        const code = r.error.code || "";
                        // 🔥 V318: Proper Firebase Error Code Handling
                        if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-argument') {
                            const token = batch[idx];
                            Object.values(devices).forEach(d => {
                                if (d.fcmToken === token) delete d.fcmToken;
                            });
                        }
                    }
                });
            }
        } catch (e) { console.error("🚨 BCast Multicast Error:", e.message); }
    }
}

// 🔥 V315: Global Error Handler for Multer and other Express errors
app.use((err, req, res, next) => {
    console.error("💥 REQUEST ERROR:", err.message);
    if (res.headersSent) return next(err);
    if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code });
    res.status(500).json({ error: "Internal server error" });
});

async function startServer() {
    try {
        await initFirebase(); await init();
        server.listen(PORT, () => console.log(`🚀 GPS Server Port ${PORT}`));
        grpcServer.bindAsync(`0.0.0.0:${GRPC_PORT}`, grpc.ServerCredentials.createInsecure(), (err, p) => {
            if (err) { console.error("📡 gRPC Bind Failed:", err); process.exit(1); }
            console.log(`📡 gRPC Port ${p}`);
        });
    } catch (e) { console.error("💥 FATAL:", e); process.exit(1); }
}
startServer();
