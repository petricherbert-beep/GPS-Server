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
  int32 battery = 6;
  float temperature = 7;
  float speed = 8;
  float bearing = 9;
  int64 timestamp = 10;
  float accuracy = 11;
  bool alarm_active = 12;
  bool is_awake = 13;
  bool is_watched = 14;
  string fcm_token = 15;
  string geofence_event = 16;
  bool is_locked = 17;
  bool is_motion = 18;
  bool is_wifi = 19;
  bool accident = 20;
  int32 proximity_distance = 21;
  bool proximity_enabled = 22;
  double snapped_lat = 23;
  double snapped_lon = 24;
}
message LocationBatchProto {
  repeated LocationUpdateProto updates = 1;
}
message DeviceLocationProto {
  string device_id = 1;
  double lat = 2;
  double lon = 3;
  int32 battery = 4;
  float temperature = 5;
  float speed = 6;
  float bearing = 7;
  int64 timestamp = 8;
  float accuracy = 9;
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
  double snapped_lat = 22;
  double snapped_lon = 23;
  string geofence_event = 24;
  string motion_state = 25;
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
    // 🔥 FIX: Unterstütze sowohl camelCase (ProtoJS default) als auch snake_case (Schema)
    mapped.deviceId = data.deviceId || data.device_id;
    mapped.pointId = data.pointId || data.point_id;
    mapped.alarmActive = (data.alarmActive !== undefined) ? data.alarmActive : data.alarm_active;
    mapped.isAwake = (data.isAwake !== undefined) ? data.isAwake : data.is_awake;
    mapped.isWatched = (data.isWatched !== undefined) ? data.isWatched : data.is_watched;
    mapped.fcmToken = data.fcmToken || data.fcm_token;
    mapped.geofenceEvent = data.geofenceEvent || data.geofence_event;
    mapped.isLocked = (data.isLocked !== undefined) ? data.isLocked : data.is_locked;
    mapped.isMotion = (data.isMotion !== undefined) ? data.isMotion : data.is_motion;
    mapped.isWifi = (data.isWifi !== undefined) ? data.isWifi : data.is_wifi;
    mapped.proximityDistance = data.proximityDistance || data.proximity_distance;
    mapped.proximityEnabled = (data.proximityEnabled !== undefined) ? data.proximityEnabled : data.proximity_enabled;
    mapped.snappedLat = data.snappedLat || data.snapped_lat;
    mapped.snappedLon = data.snappedLon || data.snapped_lon;
    mapped.accident = (data.accident !== undefined) ? data.accident : data.accident;

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
    socket.on('join_device', (id) => {
        if (!id) return;
        const deviceId = id.toLowerCase().trim();
        socket.join(deviceId);
        if (devices[deviceId]) socket.emit('location_update', devices[deviceId]);
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
    type: (req) => {
        const ct = req.headers['content-type'] || '';
        return ct.includes('protobuf') || ct.includes('octet-stream');
    },
    limit: '200kb'
}));

let devices = {};
let geofences = [];
let lastPushTimes = {};

async function atomicWrite(file, data) {
    const tmp = file + '.tmp';
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, file);
}

function saveDevicesSafe() {
    atomicWrite(DATA_FILE, JSON.stringify(devices, null, 2)).catch(e => console.error(e));
}

async function init() {
    try {
        devices = JSON.parse(await fs.readFile(DATA_FILE, 'utf8'));
        // 🔥 SANITÄRUNG: Verhindere negative oder Objekt-Zeitstempel aus Altlasten
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

function updateDevice(id, data) {
    const old = devices[id] || {};
    // 🔥 FORCE OVERWRITE für kritische Flags (kein Erben aus Altlasten)
    devices[id] = {
        ...old,
        ...data,
        isLocked: data.isLocked ?? false,
        isMotion: data.isMotion ?? false,
        isWifi: data.isWifi ?? false,
        accident: data.accident ?? false,
        status: 'online',
        lastSeen: Date.now()
    };
    delete devices[id].geofenceEvent;
    handleEvents(id, { ...devices[id], geofenceEvent: data.geofenceEvent });
}

async function handleEvents(id, data) {
    const now = Date.now();
    const device = devices[id];
    if (!device) return;
    if (data.geofenceEvent && !["heartbeat", "token_refresh", "audit_check"].includes(data.geofenceEvent)) {
        const key = `gf:${id}:${data.geofenceEvent}`;
        if (!lastPushTimes[key] || (now - lastPushTimes[key] > 600000)) {
            lastPushTimes[key] = now;
            broadcast(id, { type: 'geofence_event', zoneName: data.geofenceEvent.split(':')[1] || 'Zone', deviceName: device.name || id, action: data.geofenceEvent.startsWith('enter') ? 'betreten' : 'verlassen' });
        }
    }
}

function broadcast(senderId, payload) {
    Object.values(devices).forEach(d => {
        if (d.deviceId !== senderId && d.fcmToken) admin.messaging().send({ data: payload, token: d.fcmToken, android: { priority: 'high' } }).catch(() => {});
    });
}

app.post('/location', async (req, res) => {
    let data = req.body;
    const contentType = req.headers['content-type'] || '';
    if (contentType.includes('application/x-protobuf') && Buffer.isBuffer(req.body)) {
        try {
            // 🔥 FIX: defaults: false verhindert das Überschreiben mit leeren Werten
            data = mapProtoToApp(LocationUpdateProto.toObject(LocationUpdateProto.decode(req.body), { defaults: false, longs: Number }));
        } catch (e) { return res.status(400).send("Protobuf Error"); }
    }
    const id = data.deviceId?.toLowerCase();
    if (!id) return res.sendStatus(400);
    updateDevice(id, data);
    saveDevicesSafe();
    io.to(id).emit('location_update', devices[id]);
    res.sendStatus(200);
});

app.post('/location/update-batch', async (req, res) => {
    let batch = [];
    const contentType = req.headers['content-type'] || '';
    if (contentType.includes('application/x-protobuf') && Buffer.isBuffer(req.body)) {
        try {
            const decoded = LocationBatchProto.decode(req.body);
            batch = (decoded.updates || []).map(u => mapProtoToApp(LocationUpdateProto.toObject(u, { defaults: true, longs: Number })));
        } catch (e) { return res.status(400).send("Protobuf Batch Error"); }
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

app.get('/devices', (req, res) => {
    const list = Object.values(devices);
    const accept = req.headers['accept'] || '';
    if (accept.includes('application/x-protobuf')) {
        const buffer = DeviceListProto.encode(DeviceListProto.create({ devices: list })).finish();
        res.setHeader('Content-Type', 'application/x-protobuf');
        return res.send(buffer);
    }
    res.json(list);
});

app.get('/devices/:id', (req, res) => {
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

app.post('/devices/:id/alarm', (req, res) => {
    const id = req.params.id.toLowerCase();
    const active = req.query.active === 'true';
    if (!devices[id]) return res.sendStatus(404);
    devices[id].alarmActive = active;
    saveDevicesSafe();
    io.to(id).emit('location_update', devices[id]);
    io.to(id).emit('command', { deviceId: id, action: active ? 'START_ALARM' : 'STOP_ALARM' });
    res.sendStatus(200);
});

app.get('/geofences', (req, res) => res.json(geofences));

server.listen(PORT, () => console.log(`🚀 GPS Server online on Port ${PORT}`));
