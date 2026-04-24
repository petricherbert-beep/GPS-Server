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
const GEOFENCE_FILE = './geofences.json';
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
let geofences = [];

// --- DATEN LADEN ---
if (fs.existsSync(DATA_FILE)) {
    try {
        devices = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (e) { console.error("Fehler beim Laden der devices.json", e); devices = {}; }
}

if (fs.existsSync(GEOFENCE_FILE)) {
    try {
        geofences = JSON.parse(fs.readFileSync(GEOFENCE_FILE, 'utf8'));
    } catch (e) { console.error("Fehler beim Laden der geofences.json", e); geofences = []; }
}

function saveDevices() {
    fs.writeFileSync(DATA_FILE, JSON.stringify(devices, null, 2));
}

function saveGeofences() {
    fs.writeFileSync(GEOFENCE_FILE, JSON.stringify(geofences, null, 2));
}

// --- API ENDPUNKTE ---

// Geofences
app.get('/geofences', (req, res) => {
    res.json(geofences);
});

app.post('/geofences', (req, res) => {
    const gf = req.body;
    if (!gf.id) gf.id = Date.now().toString();
    const index = geofences.findIndex(g => g.id === gf.id);
    if (index !== -1) {
        geofences[index] = gf;
    } else {
        geofences.push(gf);
    }
    saveGeofences();
    io.emit('geofences_updated', geofences);
    res.status(201).json(gf);
});

app.delete('/geofences/:id', (req, res) => {
    const id = req.params.id;
    geofences = geofences.filter(g => g.id !== id);
    saveGeofences();
    io.emit('geofences_updated', geofences);
    res.sendStatus(200);
});

// --- LOCATION UPDATE (FIX 3) ---
app.post('/location/update', (req, res) => {
    const data = req.body;
    if (!data.deviceId) return res.status(400).send("Missing deviceId");
    const id = data.deviceId.toLowerCase();

    // Sicherstellen, dass Objekt und Watchers existieren
    if (!devices[id]) devices[id] = { watchers: {} };
    if (!devices[id].watchers) devices[id].watchers = {};

    // Server berechnet isWatched selbst basierend auf der Watcher-Liste
    const isWatched = Object.keys(devices[id].watchers).length > 0;

    devices[id] = {
        ...devices[id],
        ...data,
        deviceId: id,
        isWatched: isWatched,   // 🔥 Server-Wahrheit überschreibt App-Flag
        status: 'online',
        timestamp: data.timestamp || Date.now()
    };

    saveDevices();
    io.emit('location_update', devices[id]);
    res.sendStatus(200);
});

// --- WATCH MANAGEMENT (FIX 1 & 2) ---
app.post('/devices/:id/watch', (req, res) => {
    const id = req.params.id.toLowerCase();
    const watcherId = req.query.watcherId || "unknown";

    if (!devices[id]) return res.status(404).send('Gerät nicht gefunden');
    if (!devices[id].watchers) devices[id].watchers = {};

    devices[id].watchers[watcherId] = Date.now();
    
    // isWatched ist nur true, wenn die Liste nicht leer ist
    devices[id].isWatched = Object.keys(devices[id].watchers).length > 0;

    saveDevices();
    io.emit('location_update', devices[id]);
    console.log(`[WATCH] ${watcherId} beobachtet ${id}`);
    res.sendStatus(200);
});

app.post('/devices/:id/unwatch', (req, res) => {
    const id = req.params.id.toLowerCase();
    const watcherId = req.query.watcherId || "unknown";

    if (!devices[id]) return res.sendStatus(200);
    if (!devices[id].watchers) devices[id].watchers = {};

    delete devices[id].watchers[watcherId];

    // Konsistente Neuberechnung
    devices[id].isWatched = Object.keys(devices[id].watchers).length > 0;

    saveDevices();
    io.emit('location_update', devices[id]);
    console.log(`[UNWATCH] ${watcherId} -> ${id}`);
    res.sendStatus(200);
});

// --- SONSTIGE GERÄTE-STEUERUNG ---
app.post('/devices/wakeup-all', (req, res) => {
    io.emit('command', { action: 'WAKEUP_ALL' });
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

app.post('/devices/:id/alarm', (req, res) => {
    const id = req.params.id.toLowerCase();
    const active = req.query.active === 'true' || req.body.active === true;
    if (devices[id]) {
        devices[id].alarmActive = active;
        saveDevices();
        io.emit('command', { deviceId: id, action: active ? 'START_ALARM' : 'STOP_ALARM' });
        res.sendStatus(200);
    } else res.status(404).send('Gerät nicht gefunden');
});

// --- AUDIO & CLEANUP ---
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

app.post('/location/clear/:id', (req, res) => {
    const id = req.params.id.toLowerCase();
    if (devices[id]) {
        devices[id].history = [];
        saveDevices();
        io.emit('location_update', devices[id]);
    }
    res.sendStatus(200);
});

// --- STALE WATCHER CLEANUP (AUTOMATISCH) ---
setInterval(() => {
    const now = Date.now();
    const STALE_TIMEOUT = 10 * 60 * 1000; // 10 Minuten Inaktivität
    let changed = false;

    Object.keys(devices).forEach(deviceId => {
        const dev = devices[deviceId];
        if (dev.watchers) {
            const watcherIds = Object.keys(dev.watchers);
            watcherIds.forEach(wId => {
                if (now - dev.watchers[wId] > STALE_TIMEOUT) {
                    console.log(`[CLEANUP] Entferne inaktiven Watcher ${wId} von ${deviceId}`);
                    delete dev.watchers[wId];
                    changed = true;
                }
            });

            const newIsWatched = Object.keys(dev.watchers).length > 0;
            if (dev.isWatched !== newIsWatched) {
                dev.isWatched = newIsWatched;
                changed = true;
                io.emit('location_update', dev);
            }
        }
    });

    if (changed) saveDevices();
}, 60000); // Prüfung jede Minute

// --- SOCKET.IO ---
io.on('connection', (socket) => {
    console.log('Client verbunden:', socket.id);
    socket.emit('geofences_updated', geofences);
    socket.on('disconnect', () => { console.log('Client getrennt'); });
});

server.listen(PORT, () => {
    console.log(`🚀 Socket.io Server läuft auf Port ${PORT}`);
});
