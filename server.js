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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- STRENGE KONFIGURATION ---
if (!process.env.API_KEY) {
    console.error("❌ KRITISCH: API_KEY fehlt! Server-Start abgebrochen.");
    process.exit(1);
}
const API_KEY = process.env.API_KEY;
const PORT = process.env.PORT || 3000;
// Render unterstützt standardmäßig nur einen öffentlichen Port.
// Wir lassen gRPC auf einem internen Port laufen oder nutzen den gleichen, falls ein Proxy davor sitzt.
const GRPC_PORT = process.env.GRPC_PORT || 50051;
const DATA_FILE = path.join(__dirname, 'devices.json');
const GEOFENCE_FILE = path.join(__dirname, 'geofences.json');

// --- PROTOBUF DEFINITION ---
const PROTO_PATH = path.join(__dirname, 'tracking.proto');
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: Number, // FIX: Konsistent Number für alle
    enums: String,
    defaults: false, // FIX: Konsistent keine Defaults (erleichtert Null-Handling)
    oneofs: true
});
const trackingProto = grpc.loadPackageDefinition(packageDefinition).tracking;

// Für Legacy REST/Socket (ProtobufJS)
const protoSource = await fs.readFile(PROTO_PATH, 'utf8');
const root = protobuf.parse(protoSource).root;
const LocationUpdateProto = root.lookupType("LocationUpdateProto");
const LocationBatchProto = root.lookupType("LocationBatchProto");
const DeviceLocationProto = root.lookupType("DeviceLocationProto");
const DeviceListProto = root.lookupType("DeviceListProto");

// --- gRPC STATE ---
const grpcStreams = new Set();

function pushUpdateToAll(device) {
    if (!device || !device.deviceId) return;

    // 1. Socket.IO
    io.to(device.deviceId).emit('location_update', device);

    // 2. gRPC Streams
    for (const call of grpcStreams) {
        try {
            // FIX: Reliable Backpressure & Memory Protection
            if (call.writable === false) {
                grpcStreams.delete(call);
                continue;
            }

            const ok = call.write(device);
            if (!ok) {
                call._pendingWrites = (call._pendingWrites || 0) + 1;
                if (call._pendingWrites > 100) {
                    console.warn(`⚠️ gRPC Backpressure: Force closing slow client`);
                    call.end();
                    grpcStreams.delete(call);
                }
            } else {
                call._pendingWrites = 0;
            }
        } catch (e) {
            console.error("gRPC Write Error:", e);
            grpcStreams.delete(call);
        }
    }
}

// Hilfsfunktion für Feld-Mapping (Proto snake_case -> App camelCase)
function mapProtoToApp(data) {
    if (!data) return data;
    const mapped = { ...data };

    // ProtoJS ordnet snake_case Felder automatisch camelCase zu (visual_lat -> visualLat)
    // Wir muessen hier sicherstellen, dass wir die Felder finden, falls defaults:false aktiv war.

    mapped.deviceId = data.deviceId || data.device_id;
    mapped.pointId = data.pointId || data.point_id;

    // Boolean Status Flags (Defaults erzwingen, falls undefined)
    mapped.alarmActive = (data.alarmActive !== undefined) ? data.alarmActive : (data.alarm_active !== undefined ? data.alarm_active : false);
    mapped.isAwake = (data.isAwake !== undefined) ? data.isAwake : (data.is_awake !== undefined ? data.is_awake : false);
    mapped.isWatched = (data.isWatched !== undefined) ? data.isWatched : (data.is_watched !== undefined ? data.is_watched : false);
    mapped.isLocked = (data.isLocked !== undefined) ? data.isLocked : (data.is_locked !== undefined ? data.is_locked : false);
    mapped.isMotion = (data.isMotion !== undefined) ? data.isMotion : (data.is_motion !== undefined ? data.is_motion : false);
    mapped.isWifi = (data.isWifi !== undefined) ? data.isWifi : (data.is_wifi !== undefined ? data.is_wifi : false);
    mapped.accident = (data.accident !== undefined) ? data.accident : (data.accident !== undefined ? data.accident : false);

    mapped.fcmToken = data.fcmToken || data.fcm_token;
    mapped.geofenceEvent = data.geofenceEvent || data.geofence_event;
    mapped.motionState = data.motionState || data.motion_state;

    // Optionale numerische Felder (Putz-Logik fuer 0, falls sie doch als 0 reinkommen)
    // Aber durch 'optional' im Schema kommen sie nun meist als undefined, wenn sie fehlen.
    mapped.snappedLat = data.snappedLat || data.snapped_lat;
    mapped.snappedLon = data.snappedLon || data.snapped_lon;
    mapped.visualLat = data.visualLat || data.visual_lat;
    mapped.visualLon = data.visualLon || data.visual_lon;

    if (mapped.snappedLat === 0 && mapped.snappedLon === 0) {
        delete mapped.snappedLat; delete mapped.snappedLon;
    }
    return mapped;
}

// --- FIREBASE INITIALISIERUNG ---
async function initFirebase() {
    try {
        const envKey = process.env.FIREBASE_SERVICE_ACCOUNT || process.env.firebase_service_account;
        const serviceAccount = envKey ? JSON.parse(envKey) : JSON.parse(await fs.readFile(path.join(__dirname, 'firebase-key.json'), 'utf8'));
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        console.log("✅ Firebase Admin aktiv.");
    } catch (e) {
        console.error("❌ Firebase Fehler:", e.message);
        process.exit(1);
    }
}
initFirebase();

const app = express();
app.use(cors({ origin: "*" }));

// --- 🛡️ RATE LIMITING ---
const telemetryLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 500, // Hoher Durchsatz für GPS Punkte
    message: "Zu viele Standort-Updates."
});

const adminLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60, // Strenger Schutz für Alarme/Zonen/Wakeups
    message: "Administrative Limits erreicht."
});

app.use('/location', telemetryLimiter);
app.use('/v1/location', telemetryLimiter);
app.use('/devices', adminLimiter);
app.use('/v1/devices', adminLimiter);
app.use('/geofences', adminLimiter);
app.use('/v1/geofences', adminLimiter);

// --- gRPC SERVER IMPLEMENTATION ---
const grpcServer = new grpc.Server();
grpcServer.addService(trackingProto.TrackingService.service, {
    GetDevices: (call, callback) => {
        if (call.request.api_key !== API_KEY) {
            return callback({ code: grpc.status.UNAUTHENTICATED, details: "Invalid API Key" });
        }
        callback(null, { devices: Object.values(devices) });
    },
    TrackLocation: (call) => {
        if (grpcStreams.size >= 1000) {
            console.warn("❌ gRPC Reject: Max connections reached");
            return call.end();
        }

        grpcStreams.add(call);

        function cleanup() {
            grpcStreams.delete(call);
        }

        call.on('data', (update) => {
            const data = mapProtoToApp(update);
            const id = data.deviceId?.toLowerCase();
            if (id) {
                const wasCritical = data.alarmActive || data.accident;
                updateDevice(id, data);
                saveDevicesSafe({ immediate: wasCritical });
                pushUpdateToAll(devices[id]);
            }
        });

        call.on('end', cleanup);
        call.on('error', cleanup);
        call.on('close', cleanup);
        call.on('cancelled', cleanup);
    }
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// --- 🌐 SOCKET.IO LOGIK ---
io.on('connection', (socket) => {
    socket.on('join_device', (data) => {
        if (!data) return;
        const deviceId = (typeof data === 'string' ? data : data.deviceId)?.toLowerCase().trim();
        const apiKey = typeof data === 'object' ? data.apiKey : null;

        // FIX: Mandatory Auth
        if (apiKey !== API_KEY) {
            console.warn(`⚠️ Socket Auth-Fehler für: ${deviceId}`);
            return;
        }

        if (deviceId) {
            socket.join(deviceId);
            if (devices[deviceId]) socket.emit('location_update', devices[deviceId]);
        }
    });

    socket.on('leave_device', (id) => {
        if (!id) return;
        const deviceId = id.toLowerCase().trim();
        socket.leave(deviceId);
    });
});

// --- 🛡️ MIDDLEWARE: API-KEY ---
app.use((req, res, next) => {
    if (req.path === '/' || req.path.startsWith('/socket.io')) return next();

    // FIX: Nur Header erlauben, Query-Params sind unsicher
    const providedKey = (req.headers['x-api-key'] || "").trim();
    if (providedKey !== API_KEY.trim()) return res.sendStatus(401);
    next();
});

app.get('/', (req, res) => res.send('🚀 GPS Server is running.'));

app.use(bodyParser.json({ limit: '200kb' }));
app.use(bodyParser.raw({
    type: 'application/x-protobuf',
    limit: '200kb'
}));

let devices = {};
let geofences = [];
let lastPushTimes = {};

// 1. Debounced Persistence
let saveTimer;

async function atomicWrite(file, data) {
    const tmp = file + '.tmp';
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, file);
}

function saveDevicesSafe(opts = { immediate: false }) {
    if (opts.immediate) {
        if (saveTimer) clearTimeout(saveTimer);
        return atomicWrite(DATA_FILE, JSON.stringify(devices, null, 2))
            .then(() => console.log(`🔥 Critical state flushed to disk.`))
            .catch(e => console.error("Critical Save Error:", e));
    }

    if (saveTimer) return; // Bereits ein Debounce aktiv

    saveTimer = setTimeout(async () => {
        saveTimer = null;
        try {
            await atomicWrite(DATA_FILE, JSON.stringify(devices, null, 2));
            console.log(`💾 Devices saved to disk.`);
        } catch (e) {
            console.error("Save Error:", e);
        }
    }, 2000); // 2 Sekunden Debounce
}

async function init() {
    try {
        devices = JSON.parse(await fs.readFile(DATA_FILE, 'utf8'));
        for (const id in devices) {
            const d = devices[id];
            if (typeof d.timestamp === 'object' || d.timestamp < 0) {
                d.timestamp = Date.now();
            }
        }
    } catch (e) { devices = {}; }
    try { geofences = JSON.parse(await fs.readFile(GEOFENCE_FILE, 'utf8')); } catch (e) { geofences = []; }
}
init();

setInterval(() => {
    const now = Date.now();
    let changed = false;

    for (const id in devices) {
        if (devices[id].status !== 'offline' && (now - devices[id].lastSeen > 120000)) {
            devices[id].status = 'offline';
            io.to(id).emit('location_update', devices[id]);
            changed = true;
        }
    }

    // Cleanup alte lastPushTimes
    for (const key in lastPushTimes) {
        if (now - lastPushTimes[key] > 86400000) {
            delete lastPushTimes[key];
        }
    }

    // 🔥 AUTOMATIC CLEANUP: Lösche Geräte, die länger als 30 Tage offline sind
    for (const id in devices) {
        if (now - (devices[id].lastSeen || 0) > 30 * 86400000) {
            console.log(`🧹 Permanent removing stale device: ${id}`);
            delete devices[id];
            changed = true;
        }
    }

    if (changed) saveDevicesSafe();
}, 30000);

function updateDevice(id, data) {
    // 4. Input Sanitization & Validation
    if (data.lat !== undefined && data.lon !== undefined) {
        if (typeof data.lat !== 'number' || typeof data.lon !== 'number' ||
            data.lat < -90 || data.lat > 90 || data.lon < -180 || data.lon > 180) {
            console.warn(`⚠️ Ungültige Koordinaten für ${id}: ${data.lat}, ${data.lon}`);
            return;
        }
    }

    const old = devices[id] || {};

    // 🔥 RACE CONDITION PROTECTION: Nur neuere Daten akzeptieren
    if (data.timestamp && old.timestamp && data.timestamp < old.timestamp) {
        console.log(`🛡️ Blocked stale update for ${id} (Incoming: ${data.timestamp} < Current: ${old.timestamp})`);
        return;
    }

    let alarmActive = data.alarmActive;
    if (old.alarmActive === true && data.alarmActive === false) {
        // 🔥 FIX: Nur wenn das letzte Update SEHR ALT war (> 30s),
        // koennte es ein "stale" Punkt sein, der einen neuen Alarm loescht.
        if (Date.now() - (old.lastSeen || 0) > 30000) alarmActive = true;
    }

    let accident = data.accident;
    if (old.accident === true && data.accident === false) {
        if (Date.now() - (old.lastSeen || 0) > 30000) accident = true;
    }

    // WHITELIST MERGE (Sicherheit gegen Pollution)
    const sanitized = {
        deviceId: id,
        name: data.name || old.name,
        lat: data.lat ?? old.lat,
        lon: data.lon ?? old.lon,
        battery: data.battery ?? old.battery,
        speed: data.speed ?? old.speed,
        bearing: data.bearing ?? old.bearing,
        timestamp: data.timestamp ?? Date.now(),
        accuracy: data.accuracy ?? old.accuracy,
        fcmToken: data.fcmToken || old.fcmToken,
        snappedLat: data.snappedLat ?? old.snappedLat,
        snappedLon: data.snappedLon ?? old.snappedLon,
        visualLat: data.visualLat ?? old.visualLat,
        visualLon: data.visualLon ?? old.visualLon,
        motionState: data.motionState || old.motionState,
        alarmActive: alarmActive ?? old.alarmActive ?? false,
        accident: accident ?? old.accident ?? false,
        isLocked: data.isLocked ?? old.isLocked ?? false,
        isMotion: data.isMotion ?? old.isMotion ?? false,
        isWifi: data.isWifi ?? old.isWifi ?? false,
        status: 'online',
        lastSeen: Date.now()
    };

    devices[id] = sanitized;
    delete devices[id].geofenceEvent;
    handleEvents(id, { ...sanitized, geofenceEvent: data.geofenceEvent }, old);
}

async function handleEvents(id, data, old) {
    const now = Date.now();
    const device = devices[id];
    if (!device) return;

    const IGNORE_EVENTS = ["heartbeat", "token_refresh", "audit_check", "token_init", "token_update", "app_visible", "self_watch_active"];
    if (data.geofenceEvent && !IGNORE_EVENTS.includes(data.geofenceEvent)) {
        const key = `gf:${id}:${data.geofenceEvent}`;
        if (!lastPushTimes[key] || (now - lastPushTimes[key] > 600000)) {
            lastPushTimes[key] = now;
            await broadcast(id, {
                type: 'geofence_event',
                deviceId: id, // 🔥 FIX: DeviceId für Filterung im Client
                zoneName: data.geofenceEvent.split(':')[1] || 'Zone',
                deviceName: device.name || id,
                action: data.geofenceEvent.startsWith('enter') ? 'betreten' : 'verlassen'
            });
        }
    }

    if (data.accident === true && old.accident !== true) {
        const key = `acc:${id}`;
        if (!lastPushTimes[key] || (now - lastPushTimes[key] > 300000)) {
            lastPushTimes[key] = now;
            console.log(`🚨 ACCIDENT BROADCAST for ${id}`);
            await broadcast(id, {
                type: 'accident_alert',
                deviceId: id,
                deviceName: device.name || id,
                user: device.name || id
            });
        }
    }

    if (data.alarmActive === true && old.alarmActive !== true) {
        const key = `alarm:${id}`;
        if (!lastPushTimes[key] || (now - lastPushTimes[key] > 300000)) {
            lastPushTimes[key] = now;
            console.log(`🔊 ALARM BROADCAST for ${id}`);
            await broadcast(id, {
                type: 'alarm',
                deviceId: id,
                message: `${device.name || id} braucht Hilfe!`,
                deviceName: device.name || id
            });
        }
    }
}

async function broadcast(senderId, payload) {
    const tokens = Object.values(devices)
        .filter(d => d.deviceId !== senderId && d.fcmToken)
        .map(d => d.fcmToken);

    if (tokens.length === 0) return;

    // FIX: Firebase Multicast Limit (500 tokens)
    const tokenChunks = [];
    for (let i = 0; i < tokens.length; i += 500) {
        tokenChunks.push(tokens.slice(i, i + 500));
    }

    for (const chunk of tokenChunks) {
        try {
            const response = await admin.messaging().sendEachForMulticast({
                data: payload,
                tokens: chunk,
                android: { priority: 'high' }
            });

            if (response.failureCount > 0) {
                const failedTokens = [];
                response.responses.forEach((resp, idx) => {
                    if (!resp.success) {
                        const error = resp.error;
                        if (error.code === 'messaging/registration-token-not-registered' ||
                            error.code === 'messaging/invalid-registration-token') {
                            failedTokens.push(chunk[idx]);
                        }
                    }
                });

                if (failedTokens.length > 0) {
                    console.log(`🧹 Cleaning up ${failedTokens.length} invalid FCM tokens...`);
                    Object.values(devices).forEach(d => {
                        if (failedTokens.includes(d.fcmToken)) {
                            delete d.fcmToken;
                        }
                    });
                    saveDevicesSafe();
                }
            }
        } catch (e) {
            console.error("Multicast Error:", e);
        }
    }
}

app.post(['/location', '/v1/location'], async (req, res) => {
    let data = req.body;
    if (Buffer.isBuffer(req.body) && req.body.length > 0) {
        try {
            data = mapProtoToApp(LocationUpdateProto.toObject(LocationUpdateProto.decode(req.body), { defaults: false, longs: Number }));
        } catch (e) {
            console.error("PROTO ERROR:", e);
            return res.status(400).send("Protobuf Error");
        }
    }
    const id = data.deviceId?.toLowerCase();
    if (!id) return res.sendStatus(400);
    updateDevice(id, data);
    saveDevicesSafe();
    pushUpdateToAll(devices[id]);
    res.sendStatus(200);
});

app.post(['/location/update-batch', '/v1/location/batch'], async (req, res) => {
    let batch = [];
    if (Buffer.isBuffer(req.body) && req.body.length > 0) {
        try {
            const decoded = LocationBatchProto.decode(req.body);
            batch = (decoded.updates || []).map(u => mapProtoToApp(LocationUpdateProto.toObject(u, { defaults: false, longs: Number })));
        } catch (e) {
            console.error("PROTO BATCH ERROR:", e);
            return res.status(400).send("Protobuf Batch Error");
        }
    } else {
        batch = req.body;
    }
    if (!Array.isArray(batch)) return res.sendStatus(400);
    batch.forEach(item => {
        const id = item.deviceId?.toLowerCase();
        if (id) updateDevice(id, item);
    });
    saveDevicesSafe();
    if (batch.length > 0 && batch[0].deviceId) {
        const firstId = batch[0].deviceId.toLowerCase();
        pushUpdateToAll(devices[firstId]);
    }
    res.sendStatus(200);
});

app.get(['/devices', '/v1/devices'], (req, res) => {
    const list = Object.values(devices);
    const accept = req.headers['accept'] || '';
    if (accept.includes('application/x-protobuf')) {
        const buffer = DeviceListProto.encode(DeviceListProto.create({ devices: list })).finish();
        res.setHeader('Content-Type', 'application/x-protobuf');
        return res.send(buffer);
    }
    res.json(list);
});

app.get(['/devices/:id', '/v1/devices/:id'], (req, res) => {
    const id = req.params.id.toLowerCase();
    if (!devices[id]) return res.sendStatus(404);
    const accept = req.headers['accept'] || '';
    if (accept.includes('application/x-protobuf')) {
        const buffer = DeviceLocationProto.encode(DeviceLocationProto.create(devices[id])).finish();
        res.setHeader('Content-Type', 'application/x-protobuf');
        return res.send(buffer);
    }
    res.json(devices[id]);
});

app.post(['/devices/:id/alarm', '/v1/devices/:id/alarm'], (req, res) => {
    const id = req.params.id.toLowerCase();
    const active = req.query.active === 'true';
    if (!devices[id]) return res.sendStatus(404);
    devices[id].alarmActive = active;
    saveDevicesSafe();
    pushUpdateToAll(devices[id]);
    io.to(id).emit('command', { deviceId: id, action: active ? 'START_ALARM' : 'STOP_ALARM' });
    res.sendStatus(200);
});

app.post(['/devices/:id/watch', '/v1/devices/:id/watch'], (req, res) => {
    const id = req.params.id.toLowerCase();
    const watcherId = req.query.watcherId;
    const watcherName = req.query.watcherName || "Jemand";

    if (!devices[id]) return res.sendStatus(404);

    devices[id].isWatched = true;
    devices[id].watcherName = watcherName;

    if (devices[id].fcmToken) {
        admin.messaging().send({
            data: {
                type: 'watch_state',
                state: 'true',
                watcherName: watcherName,
                targetId: id
            },
            token: devices[id].fcmToken,
            android: { priority: 'high' }
        }).catch(() => {});
    }

    res.sendStatus(200);
});

app.post(['/devices/:id/unwatch', '/v1/devices/:id/unwatch'], (req, res) => {
    const id = req.params.id.toLowerCase();
    if (!devices[id]) return res.sendStatus(404);

    devices[id].isWatched = false;
    delete devices[id].watcherName;

    if (devices[id].fcmToken) {
        admin.messaging().send({
            data: { type: 'watch_state', state: 'false' },
            token: devices[id].fcmToken
        }).catch(() => {});
    }
    res.sendStatus(200);
});

app.post(['/devices/:id/wakeup', '/v1/devices/:id/wakeup'], (req, res) => {
    const id = req.params.id.toLowerCase();
    const watcherName = req.query.watcherName || "Zentrale";
    if (!devices[id]) return res.sendStatus(404);

    if (devices[id].fcmToken) {
        admin.messaging().send({
            data: { type: 'wakeup', watcherName: watcherName },
            token: devices[id].fcmToken,
            android: { priority: 'high' }
        }).catch(() => {});
    }
    res.sendStatus(200);
});

app.get(['/geofences', '/v1/geofences'], (req, res) => res.json(geofences));

app.post(['/geofences', '/v1/geofences'], async (req, res) => {
    const gf = req.body;
    if (!gf.id) return res.sendStatus(400);
    geofences = geofences.filter(item => item.id !== gf.id);
    geofences.push(gf);
    await atomicWrite(GEOFENCE_FILE, JSON.stringify(geofences, null, 2));
    res.sendStatus(200);
});

app.put(['/geofences/:id', '/v1/geofences/:id'], async (req, res) => {
    const id = req.params.id;
    const gf = req.body;
    if (!gf.id) gf.id = id;
    geofences = geofences.filter(item => item.id !== id);
    geofences.push(gf);
    await atomicWrite(GEOFENCE_FILE, JSON.stringify(geofences, null, 2));
    res.sendStatus(200);
});

app.delete(['/geofences/:id', '/v1/geofences/:id'], async (req, res) => {
    const id = req.params.id;
    geofences = geofences.filter(item => item.id !== id);
    await atomicWrite(GEOFENCE_FILE, JSON.stringify(geofences, null, 2));
    res.sendStatus(200);
});

app.post(['/location/clear/:id', '/v1/location/clear/:id'], (req, res) => {
    const id = req.params.id.toLowerCase();
    delete devices[id];
    saveDevicesSafe();
    res.sendStatus(200);
});

app.post(['/devices/wakeup-all', '/v1/devices/wakeup-all'], (req, res) => {
    Object.values(devices).forEach(d => {
        if (d.fcmToken) {
            admin.messaging().send({
                data: { type: 'wakeup', watcherName: "Zentrale (Broadcast)" },
                token: d.fcmToken,
                android: { priority: 'high' }
            }).catch(() => {});
        }
    });
    res.sendStatus(200);
});

server.listen(PORT, () => console.log(`🚀 GPS Server online on Port ${PORT}`));

grpcServer.bindAsync(`0.0.0.0:${GRPC_PORT}`, grpc.ServerCredentials.createInsecure(), (err, port) => {
    if (err) {
        console.error("❌ gRPC Bind Error:", err);
        // Falls der gRPC Port belegt ist oder auf Render Probleme macht,
        // stürzen wir nicht ab, damit Express weiterläuft.
    } else {
        console.log(`📡 gRPC Server online on Port ${port}`);
    }
});
