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

app.use(bodyParser.json());
app.use('/location/binary', bodyParser.raw({ type: 'application/octet-stream', limit: '50kb' }));
app.use(express.static('public'));

let devices = {};
let geofences = [];

async function init() {
    try { devices = JSON.parse(await fs.readFile(DATA_FILE, 'utf8')); } catch (e) { devices = {}; }
    try { geofences = JSON.parse(await fs.readFile(GEOFENCE_FILE, 'utf8')); } catch (e) { geofences = []; }
}
init();

async function saveDevices() { await fs.writeFile(DATA_FILE, JSON.stringify(devices, null, 2)); }

// --- ULTRA-BINARY DECODER (PHASE 7) ---
app.post('/location/binary', async (req, res) => {
    const buffer = req.body;
    if (!Buffer.isBuffer(buffer) || buffer.length < 5) return res.sendStatus(400);

    try {
        let offset = 0;
        const idLen = buffer.readUInt8(offset++);
        const deviceId = buffer.toString('utf8', offset, offset + idLen).toLowerCase();
        offset += idLen;
        const count = buffer.readUInt8(offset++);

        let lastLat = 0, lastLon = 0, lastTs = 0;

        for (let i = 0; i < count; i++) {
            let lat, lon, ts, accuracy, battery, flags;

            if (i === 0) {
                // Punkt 0 ist IMMER der Base-Frame (Absolute Werte, 20 Bytes)
                ts = Number(buffer.readBigInt64LE(offset)); offset += 8;
                lat = buffer.readInt32LE(offset) / 10000000.0; offset += 4;
                lon = buffer.readInt32LE(offset) / 10000000.0; offset += 4;
                accuracy = buffer.readUInt16LE(offset) / 10.0; offset += 2;
                battery = buffer.readUInt8(offset++);
                flags = buffer.readUInt8(offset++);
            } else {
                // Punkte 1..N sind Delta-Frames (7 Bytes!)
                const dt = buffer.readUInt16LE(offset); offset += 2;
                const dLat = buffer.readInt16LE(offset); offset += 2;
                const dLon = buffer.readInt16LE(offset); offset += 2;
                flags = buffer.readUInt8(offset++);

                ts = lastTs + dt;
                lat = lastLat + (dLat / 100000.0);
                lon = lastLon + (dLon / 100000.0);
                // Batterie und Genauigkeit behalten wir vom Base-Frame oder Flags
                battery = devices[deviceId]?.battery || 0;
                accuracy = devices[deviceId]?.accuracy || 10.0;
            }

            lastLat = lat; lastLon = lon; lastTs = ts;

            devices[deviceId] = {
                ...devices[deviceId],
                deviceId, lat, lon, timestamp: ts, accuracy, battery,
                isLocked: (flags & 1) !== 0,
                isMotion: (flags & 2) !== 0,
                isWifi: (flags & 4) !== 0,
                accident: (flags & 64) !== 0,
                alarmActive: (flags & 128) !== 0,
                status: 'online'
            };
        }

        await saveDevices();
        io.to(deviceId).emit('location_update', devices[deviceId]);
        res.sendStatus(200);
    } catch (e) { res.sendStatus(500); }
});

// (Rest der Standard-Endpunkte wie /devices etc. bitte beibehalten)
app.get('/devices', (req, res) => res.json(Object.values(devices)));
app.post('/devices/:id/watch', async (req, res) => {
    const id = req.params.id.toLowerCase();
    socketJoin(id, req.query.watcherId);
    res.sendStatus(200);
});

server.listen(PORT, () => console.log(`🚀 Ultra-Stream Server auf Port ${PORT}`));
