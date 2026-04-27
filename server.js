import express from 'express';
import http from 'http';
import cors from 'cors';
import { Server } from 'socket.io';
import bodyParser from 'body-parser';
import fs from 'fs/promises';
import path from 'path';

const app = express();
app.use(cors({ origin: "*" }));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;
const DATA_FILE = './devices.json';

app.use(bodyParser.json());
app.use('/location/binary', bodyParser.raw({ type: 'application/octet-stream', limit: '50kb' }));
app.use(express.static('public'));

let devices = {};

async function init() {
    try { devices = JSON.parse(await fs.readFile(DATA_FILE, 'utf8')); } catch (e) { devices = {}; }
}
init();

async function saveDevices() { await fs.writeFile(DATA_FILE, JSON.stringify(devices, null, 2)); }

app.get('/devices', (req, res) => res.json(Object.values(devices)));

// --- ULTRA-BINARY DECODER V3 (IDENTITÄT IM HEADER) ---
app.post('/location/binary', async (req, res) => {
    const buffer = req.body;
    if (!Buffer.isBuffer(buffer) || buffer.length < 5) return res.sendStatus(400);

    try {
        let offset = 0;
        // 1. Geräte-ID extrahieren
        const idLen = buffer.readUInt8(offset++);
        const deviceId = buffer.toString('utf8', offset, offset + idLen).toLowerCase();
        offset += idLen;
        
        // 2. Name extrahieren (NEU & SICHER!)
        const nameLen = buffer.readUInt8(offset++);
        const deviceName = buffer.toString('utf8', offset, offset + nameLen);
        offset += nameLen;
        
        const count = buffer.readUInt8(offset++);

        let lastLat = 0, lastLon = 0, lastTs = 0;

        for (let i = 0; i < count; i++) {
            let lat, lon, ts, accuracy, battery, flags;
            if (i === 0) {
                ts = Number(buffer.readBigInt64LE(offset)); offset += 8;
                lat = buffer.readInt32LE(offset) / 10000000.0; offset += 4;
                lon = buffer.readInt32LE(offset) / 10000000.0; offset += 4;
                accuracy = buffer.readUInt16LE(offset) / 10.0; offset += 2;
                battery = buffer.readUInt8(offset++);
                flags = buffer.readUInt8(offset++);
            } else {
                const dt = buffer.readUInt16LE(offset); offset += 2;
                const dLat = buffer.readInt16LE(offset); offset += 2;
                const dLon = buffer.readInt16LE(offset); offset += 2;
                flags = buffer.readUInt8(offset++);
                ts = lastTs + dt;
                lat = lastLat + (dLat / 100000.0);
                lon = lastLon + (dLon / 100000.0);
                battery = devices[deviceId]?.battery || 0;
                accuracy = devices[deviceId]?.accuracy || 10.0;
            }
            lastLat = lat; lastLon = lon; lastTs = ts;

            devices[deviceId] = {
                ...devices[deviceId],
                deviceId, name: deviceName, lat, lon, timestamp: ts, accuracy, battery,
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
    } catch (e) { console.error("Parse Error", e); res.sendStatus(500); }
});

app.post('/devices/:id/watch', async (req, res) => {
    const id = req.params.id.toLowerCase();
    if (!devices[id]) devices[id] = { watchers: {} };
    if (!devices[id].watchers) devices[id].watchers = {};
    devices[id].watchers[req.query.watcherId || "unknown"] = Date.now();
    devices[id].isWatched = true;
    await saveDevices();
    res.sendStatus(200);
});

server.listen(PORT, () => console.log(`🚀 Ultra-Binary Server (V3) online`));
