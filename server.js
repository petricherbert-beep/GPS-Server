import express from 'express';
import http from 'http';
import cors from 'cors';
import { Server } from 'socket.io';
import bodyParser from 'body-parser';
import fs from 'fs/promises';
import path from 'path';
import multer from 'multer';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors({ origin: "*" }));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;
const DATA_FILE = './devices.json';
const GEOFENCE_FILE = './geofences.json';

// Standard Middlewares
app.use(bodyParser.json());
app.use('/location/binary', bodyParser.raw({ type: 'application/octet-stream', limit: '50kb' }));
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

let devices = {};
let geofences = [];

// --- DATEN ASYNCHRON LADEN ---
async function init() {
    try {
        const devData = await fs.readFile(DATA_FILE, 'utf8');
        devices = JSON.parse(devData);
    } catch (e) { devices = {}; }
    
    try {
        const geoData = await fs.readFile(GEOFENCE_FILE, 'utf8');
        geofences = JSON.parse(geoData);
    } catch (e) { geofences = []; }
}
init();

async function saveDevices() {
    try { await fs.writeFile(DATA_FILE, JSON.stringify(devices, null, 2)); } catch (e) { console.error("Save Error", e); }
}

async function saveGeofences() {
    try { await fs.writeFile(GEOFENCE_FILE, JSON.stringify(geofences, null, 2)); } catch (e) { console.error("Save Error", e); }
}

// --- API ENDPUNKTE ---

app.get('/geofences', (req, res) => res.json(geofences));

app.post('/geofences', async (req, res) => {
    const gf = req.body;
    if (!gf.id) gf.id = Date.now().toString();
    const index = geofences.findIndex(g => g.id === gf.id);
    if (index !== -1) geofences[index] = gf; else geofences.push(gf);
    await saveGeofences();
    io.emit('geofences_updated', geofences);
    res.status(201).json(gf);
});

// --- BINARY LOCATION (FIXED-POINT OPTIMIERUNG) ---
app.post('/location/binary', async (req, res) => {
    const buffer = req.body;
    if (!Buffer.isBuffer(buffer) || buffer.length < 5) return res.sendStatus(400);

    try {
        let offset = 0;
        const idLen = buffer.readUInt8(offset++);
        const deviceId = buffer.toString('utf8', offset, offset + idLen).toLowerCase();
        offset += idLen;
        const count = buffer.readUInt8(offset++);

        let lastDev = null;
        for (let i = 0; i < count; i++) {
            const timestamp = Number(buffer.readBigInt64LE(offset)); offset += 8;
            const lat = buffer.readInt32LE(offset) / 10000000.0; offset += 4;
            const lon = buffer.readInt32LE(offset) / 10000000.0; offset += 4;
            const accuracy = buffer.readUInt16LE(offset) / 10.0; offset += 2;
            const battery = buffer.readUInt8(offset++);
            const flags = buffer.readUInt8(offset++);

            const isLocked = (flags & 1) !== 0;
            const isMoving = (flags & 2) !== 0;
            const isWifi = (flags & 4) !== 0;

            if (!devices[deviceId]) devices[deviceId] = { watchers: {} };
            const isWatched = devices[deviceId].watchers ? Object.keys(devices[deviceId].watchers).length > 0 : false;

            devices[deviceId] = {
                ...devices[deviceId],
                deviceId, lat, lon, timestamp, accuracy, battery, 
                isLocked, isMotion: isMoving, isWifi, isWatched,
                status: 'online'
            };
            lastDev = devices[deviceId];
        }

        await saveDevices();
        if (lastDev) {
            // 🔥 ROOM-OPTIMIERUNG: Sende nur an Leute, die dieses Gerät beobachten
            io.to(deviceId).emit('location_update', lastDev);
        }
        res.sendStatus(200);
    } catch (e) {
        console.error("Binary Parse Error:", e);
        res.sendStatus(500);
    }
});

// --- WATCH MANAGEMENT (MIT ROOMS) ---
app.post('/devices/:id/watch', async (req, res) => {
    const id = req.params.id.toLowerCase();
    const watcherId = req.query.watcherId || "unknown";

    if (!devices[id]) return res.status(404).send('Not found');
    if (!devices[id].watchers) devices[id].watchers = {};

    devices[id].watchers[watcherId] = Date.now();
    devices[id].isWatched = true;

    await saveDevices();
    io.to(id).emit('location_update', devices[id]);
    res.sendStatus(200);
});

// --- SOCKET.IO ROOM HANDLING ---
io.on('connection', (socket) => {
    // Wenn eine App ein Gerät beobachten will, tritt sie dem Raum bei
    socket.on('join_device', (deviceId) => {
        const id = deviceId.toLowerCase();
        socket.join(id);
        console.log(`Socket ${socket.id} joined room ${id}`);
    });

    socket.on('leave_device', (deviceId) => {
        socket.leave(deviceId.toLowerCase());
    });
});

server.listen(PORT, () => {
    console.log(`🚀 Ultra-Efficient Server auf Port ${PORT}`);
});
