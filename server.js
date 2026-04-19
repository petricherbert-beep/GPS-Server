import express from 'express';
import http from 'http';
import cors from 'cors';
import { Server } from 'socket.io';
import bodyParser from 'body-parser';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors({ origin: "*" }));
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

const PORT = process.env.PORT || 3000;
const DATA_FILE = './devices.json';
const AUDIO_DIR = './uploads/audio';

if (!fs.existsSync(AUDIO_DIR)) {
    fs.mkdirSync(AUDIO_DIR, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => { cb(null, AUDIO_DIR); },
    filename: (req, file, cb) => {
        const deviceId = req.body.deviceId || 'unknown';
        cb(null, `audio_${deviceId}_${Date.now()}.mp3`);
    }
});
const upload = multer({ storage: storage });

app.use(bodyParser.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

let devices = {};

if (fs.existsSync(DATA_FILE)) {
    try {
        devices = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (e) {
        console.error("Fehler beim Laden der devices.json", e);
        devices = {};
    }
}

function saveDevices() {
    fs.writeFileSync(DATA_FILE, JSON.stringify(devices, null, 2));
}

// --- API ENDPUNKTE ---

app.post('/location/update', (req, res) => {
    const data = req.body;
    if (!data.deviceId) return res.status(400).send("Missing deviceId");
    const id = data.deviceId.toLowerCase();

    // Alle Felder der App (inkl. Temperatur, Snapped-Koordinaten etc.) übernehmen
    devices[id] = {
        ...devices[id], 
        ...data,        
        deviceId: id,
        status: 'online',
        timestamp: Date.now()
    };

    saveDevices();
    io.emit('location_update', devices[id]); // Sendet Update an alle Map-Clients via Socket.io
    res.sendStatus(200);
});

app.get('/devices', (req, res) => {
    res.json(Object.values(devices));
});

app.get('/devices/:id', (req, res) => {
    const id = req.params.id.toLowerCase();
    if (devices[id]) res.json(devices[id]);
    else res.status(404).send('Gerät nicht gefunden');
});

// Alarm Steuerung (Modern)
app.post('/devices/:id/alarm', (req, res) => {
    const id = req.params.id.toLowerCase();
    const active = req.query.active === 'true';
    if (devices[id]) {
        devices[id].alarmActive = active;
        saveDevices();
        io.emit('command', { deviceId: id, action: active ? 'START_ALARM' : 'STOP_ALARM' });
        res.sendStatus(200);
    } else res.status(404).send('Gerät nicht gefunden');
});

// Alarm Steuerung (Legacy/Fallback für alte App-Versionen)
app.post('/devices/:id/ring', (req, res) => {
    const id = req.params.id.toLowerCase();
    io.emit('command', { deviceId: id, action: 'START_ALARM' });
    res.sendStatus(200);
});

app.post('/devices/:id/reset-alarm', (req, res) => {
    const id = req.params.id.toLowerCase();
    io.emit('command', { deviceId: id, action: 'STOP_ALARM' });
    res.sendStatus(200);
});

// Audio Funktionen
app.post('/devices/:id/audio-request', (req, res) => {
    const id = req.params.id.toLowerCase();
    io.emit('command', { deviceId: id, action: 'START_RECORDING' });
    res.status(200).json({ message: "Recording command sent" });
});

app.post('/audio/upload', upload.single('audio'), (req, res) => {
    const deviceId = req.body.deviceId || 'unknown';
    if (!req.file) return res.status(400).send("No file uploaded");
    io.emit('new_audio', {
        deviceId: deviceId,
        filename: req.file.filename,
        url: `/uploads/audio/${req.file.filename}`,
        timestamp: Date.now()
    });
    res.sendStatus(200);
});

// Globale Befehle
app.post('/devices/wakeup-all', (req, res) => {
    io.emit('command', { action: 'WAKE_UP' });
    res.sendStatus(200);
});

app.post('/location/clear/:id', (req, res) => {
    const id = req.params.id.toLowerCase();
    if (devices[id]) {
        devices[id].history = [];
        saveDevices();
        io.emit('location_update', devices[id]);
    }
    res.sendStatus(200);
});

io.on('connection', (socket) => {
    console.log('Ein Client (Karte/App) ist via Socket.io verbunden:', socket.id);
    socket.on('disconnect', () => { console.log('Client getrennt'); });
});

server.listen(PORT, () => {
    console.log(`🚀 Socket.io Server läuft auf Port ${PORT}`);
});
