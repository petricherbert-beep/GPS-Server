const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*" }
});

const PORT = process.env.PORT || 3000;
const DATA_FILE = './devices.json';
const AUDIO_DIR = './uploads/audio';

// Sicherstellen, dass Verzeichnisse existieren
if (!fs.existsSync(AUDIO_DIR)) {
    fs.mkdirSync(AUDIO_DIR, { recursive: true });
}

// Multer Konfiguration für Audio-Uploads (MP3 vom Handy)
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, AUDIO_DIR);
    },
    filename: (req, file, cb) => {
        const deviceId = req.body.deviceId || 'unknown';
        const timestamp = Date.now();
        cb(null, `audio_${deviceId}_${timestamp}.mp3`);
    }
});
const upload = multer({ storage: storage });

app.use(bodyParser.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

let devices = {};

// Daten beim Start laden
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

// 1. Standort-Update von der App
app.post('/location/update', (req, res) => {
    const data = req.body;
    if (!data.deviceId) return res.status(400).send("Missing deviceId");
    
    const id = data.deviceId.toLowerCase();
    devices[id] = {
        ...devices[id],
        ...data,
        timestamp: Date.now(),
        status: 'online'
    };

    saveDevices();
    io.emit('location_update', devices[id]);
    res.sendStatus(200);
});

// 2. Alle Geräte abrufen
app.get('/devices', (req, res) => {
    res.json(Object.values(devices));
});

// 3. Einzelnes Gerät abrufen
app.get('/devices/:id', (req, res) => {
    const id = req.params.id.toLowerCase();
    if (devices[id]) {
        res.json(devices[id]);
    } else {
        res.status(404).send('Gerät nicht gefunden');
    }
});

// 4. Alarm-Status setzen (Wecken oder Alarmton)
app.post('/devices/:id/alarm', (req, res) => {
    const id = req.params.id.toLowerCase();
    const active = req.query.active === 'true';

    if (devices[id]) {
        devices[id].alarmActive = active;
        saveDevices();
        
        io.emit('command', {
            deviceId: id,
            action: active ? 'START_ALARM' : 'STOP_ALARM'
        });
        res.sendStatus(200);
    } else {
        res.status(404).send('Gerät nicht gefunden');
    }
});

/**
 * 5. Audio-Mitschnitt anfordern
 * Wird aufgerufen, wenn man in der App lange auf einen Marker drückt.
 */
app.post('/devices/:id/audio-request', (req, res) => {
    const id = req.params.id.toLowerCase();
    console.log(`🎤 Audio-Request für Gerät: ${id}`);
    
    // Sendet den Befehl "START_RECORDING" per WebSocket an das Ziel-Handy
    io.emit('command', {
        deviceId: id,
        action: 'START_RECORDING'
    });

    res.status(200).json({ message: "Recording command sent" });
});

/**
 * 6. Audio-Datei Empfang
 * Das Handy lädt hier die 10-Sekunden-Schnipsel hoch.
 */
app.post('/audio/upload', upload.single('audio'), (req, res) => {
    const deviceId = req.body.deviceId || 'unknown';
    if (!req.file) return res.status(400).send("No file uploaded");

    console.log(`✅ Audio empfangen von ${deviceId}: ${req.file.filename}`);
    
    // Alle Web-Clients informieren, damit sie die neue Datei anzeigen können
    io.emit('new_audio', {
        deviceId: deviceId,
        filename: req.file.filename,
        url: `/uploads/audio/${req.file.filename}`,
        timestamp: Date.now()
    });

    res.sendStatus(200);
});

// 7. Weckruf an alle (Universal-Push)
app.post('/devices/wakeup-all', (req, res) => {
    io.emit('command', { action: 'WAKE_UP' });
    res.sendStatus(200);
});

// 8. Historie löschen
app.post('/location/clear/:id', (req, res) => {
    const id = req.params.id.toLowerCase();
    if (devices[id]) {
        devices[id].history = [];
        saveDevices();
        io.emit('location_update', devices[id]);
    }
    res.sendStatus(200);
});

// --- WebSockets für Echtzeit-Kommunikation ---
io.on('connection', (socket) => {
    console.log('Ein Client (App oder Web) hat sich verbunden');

    socket.on('disconnect', () => {
        console.log('Client getrennt');
    });
});

server.listen(PORT, () => {
    console.log(`🚀 Server läuft auf Port ${PORT}`);
    console.log(`📁 Audio-Uploads werden in ${path.resolve(AUDIO_DIR)} gespeichert`);
});
