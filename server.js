import express from 'express';
import http from 'http';
import cors from 'cors';
import { Server } from 'socket.io';
import bodyParser from 'body-parser';
import fs from 'fs/promises';
import admin from 'firebase-admin';
import protobuf from 'protobufjs';

// --- STRENGE KONFIGURATION ---
if (!process.env.API_KEY) {
    console.error("❌ KRITISCH: API_KEY fehlt! Server-Start abgebrochen.");
    process.exit(1);
}
const API_KEY = process.env.API_KEY;
const PORT = process.env.PORT || 3000;
const DATA_FILE = './devices.json';
const GEOFENCE_FILE = './geofences.json';

// --- PROTOBUF DEFINITION ---
const protoSource = `
syntax = "proto3";
message LocationUpdateProto {
  string point_id = 1;
  string device_id = 2;
  string name = 3;
  double lat = 4;
  double lon = 5;
  optional int32 battery = 6;
  optional float temperature = 7;
  optional float speed = 8;
  optional float bearing = 9;
  int64 timestamp = 10;
  optional float accuracy = 11;
  bool alarm_active = 12;
  bool is_awake = 13;
  bool is_watched = 14;
  string fcm_token = 15;
  string geofence_event = 16;
  bool is_locked = 17;
  bool is_motion = 18;
  bool is_wifi = 19;
  bool accident = 20;
  optional int32 proximity_distance = 21;
  optional bool proximity_enabled = 22;
  optional double snapped_lat = 23;
  optional double snapped_lon = 24;
  optional double visual_lat = 25;
  optional double visual_lon = 26;
  string motion_state = 27;
  bytes encrypted_data = 30;
}
message LocationBatchProto {
  repeated LocationUpdateProto updates = 1;
}
message DeviceLocationProto {
  string device_id = 1;
  double lat = 2;
  double lon = 3;
  optional int32 battery = 4;
  optional float temperature = 5;
  optional float speed = 6;
  optional float bearing = 7;
  int64 timestamp = 8;
  optional float accuracy = 9;
  bool offline = 10;
  string name = 11;
  string status = 12;
  bool alarm_active = 13;
  bool is_awake = 14;
  bool is_watched = 15;
  string watcher_name = 16;
  string fcm_token = 17;
  bool is_locked = 18;
  bool is_motion = 19;
  bool is_wifi = 20;
  bool accident = 21;
  optional double snapped_lat = 22;
  optional double snapped_lon = 23;
  optional double visual_lat = 26;
  optional double visual_lon = 27;
  string geofence_event = 24;
  string motion_state = 25;
  bytes encrypted_data = 30;
}
message DeviceListProto {
  repeated DeviceLocationProto devices = 1;
}
`;
const root = protobuf.parse(protoSource).root;
const LocationUpdateProto = root.lookupType("LocationUpdateProto");
const LocationBatchProto = root.lookupType("LocationBatchProto");
const DeviceLocationProto = root.lookupType("DeviceLocationProto");
const DeviceListProto = root.lookupType("DeviceListProto");

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
        const serviceAccount = envKey ? JSON.parse(envKey) : JSON.parse(await fs.readFile('./firebase-key.json', 'utf8'));
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
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// --- 🌐 SOCKET.IO LOGIK ---
io.on('connection', (socket) => {
    socket.on('join_device', (data) => {
        if (!data) return;
        const deviceId = (typeof data === 'string' ? data : data.deviceId)?.toLowerCase().trim();
        const apiKey = typeof data === 'object' ? data.apiKey : null;

        if (apiKey && apiKey !== API_KEY) {
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
    const providedKey = (req.headers['x-api-key'] || req.query.apiKey || "").trim();
    if (providedKey !== API_KEY.trim()) return res.sendStatus(401);
    next();
});

app.get('/', (req, res) => res.send('🚀 GPS Server is running.'));

app.use(bodyParser.json());
app.use(bodyParser.raw({
    type: () => true,
    limit: '200kb'
}));

let devices = {};
let geofences = [];
let lastPushTimes = {};

let savePromise = Promise.resolve();

async function atomicWrite(file, data) {
    const tmp = file + '.tmp';
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, file);
}

function saveDevicesSafe() {
    savePromise = savePromise
        .then(() => atomicWrite(DATA_FILE, JSON.stringify(devices, null, 2)))
        .catch(console.error);
    return savePromise;
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

    for (const key in lastPushTimes) {
        if (now - lastPushTimes[key] > 86400000) {
            delete lastPushTimes[key];
        }
    }

    if (changed) saveDevicesSafe();
}, 30000);

function updateDevice(id, data) {
    if (data.lat !== undefined && data.lon !== undefined) {
        if (typeof data.lat !== 'number' || typeof data.lon !== 'number' ||
            data.lat < -90 || data.lat > 90 || data.lon < -180 || data.lon > 180) {
            console.warn(`⚠️ Ungültige Koordinaten für ${id}: ${data.lat}, ${data.lon}`);
            return;
        }
    }

    const old = devices[id] || {};

    let alarmActive = data.alarmActive;
    if (old.alarmActive === true && data.alarmActive === false) {
        if (Date.now() - (old.lastSeen || 0) < 30000) alarmActive = true;
    }

    let accident = data.accident;
    if (old.accident === true && data.accident === false) {
        if (Date.now() - (old.lastSeen || 0) < 30000) accident = true;
    }

    devices[id] = {
        ...old,
        ...data,
        alarmActive: alarmActive ?? old.alarmActive ?? false,
        accident: accident ?? old.accident ?? false,
        isLocked: data.isLocked ?? old.isLocked ?? false,
        isMotion: data.isMotion ?? old.isMotion ?? false,
        isWifi: data.isWifi ?? old.isWifi ?? false,
        status: 'online',
        lastSeen: Date.now()
    };
    delete devices[id].geofenceEvent;
    handleEvents(id, { ...devices[id], geofenceEvent: data.geofenceEvent }, old);
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
            broadcast(id, { type: 'geofence_event', zoneName: data.geofenceEvent.split(':')[1] || 'Zone', deviceName: device.name || id, action: data.geofenceEvent.startsWith('enter') ? 'betreten' : 'verlassen' });
        }
    }

    if (data.accident === true && old.accident !== true) {
        const key = `acc:${id}`;
        if (!lastPushTimes[key] || (now - lastPushTimes[key] > 300000)) {
            lastPushTimes[key] = now;
            console.log(`🚨 ACCIDENT BROADCAST for ${id}`);
            broadcast(id, { type: 'accident_alert', deviceName: device.name || id, user: device.name || id });
        }
    }

    if (data.alarmActive === true && old.alarmActive !== true) {
        const key = `alarm:${id}`;
        if (!lastPushTimes[key] || (now - lastPushTimes[key] > 300000)) {
            lastPushTimes[key] = now;
            console.log(`🔊 ALARM BROADCAST for ${id}`);
            broadcast(id, { type: 'alarm', message: `${device.name || id} braucht Hilfe!`, deviceName: device.name || id });
        }
    }
}

function broadcast(senderId, payload) {
    Object.values(devices).forEach(d => {
        if (d.deviceId !== senderId && d.fcmToken) admin.messaging().send({ data: payload, token: d.fcmToken, android: { priority: 'high' } }).catch(() => {});
    });
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
    io.to(id).emit('location_update', devices[id]);
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
        io.to(firstId).emit('location_update', devices[firstId]);
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
    io.to(id).emit('location_update', devices[id]);
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
