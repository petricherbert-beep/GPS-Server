import express from "express";
import cors from "cors";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import admin from "firebase-admin";
import { readFile } from 'fs/promises';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// --- FIREBASE INITIALISIERUNG ---
// Stelle sicher, dass die serviceAccountKey.json in diesem Ordner liegt!
try {
  const serviceAccount = JSON.parse(
    await readFile(new URL('./serviceAccountKey.json', import.meta.url))
  );
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log("Firebase Admin initialisiert.");
} catch (e) {
  console.error("Firebase Fehler: serviceAccountKey.json nicht gefunden oder ungültig.");
}

// --- DATENBANK INITIALISIERUNG ---
let db;
(async () => {
  db = await open({
    filename: "./database.db",
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      deviceId TEXT PRIMARY KEY,
      lat REAL, lon REAL, speed REAL, battery INTEGER, accuracy REAL,
      name TEXT, timestamp INTEGER, alarmActive INTEGER DEFAULT 0, 
      isAwake INTEGER DEFAULT 1, fcmToken TEXT
    )
  `);
  console.log("SQLite Datenbank bereit.");
})();

// --- GHOST MODE & AUTO-SLEEP LOGIK ---
const watchers = new Map(); // Wer beobachtet wen?
let lastAppActivity = 0;    // Wann wurde zuletzt die Map abgefragt?

const isAppActive = () => (Date.now() - lastAppActivity) < 60000;

// Hilfsfunktion für Push-Benachrichtigungen
async function sendPush(targetDeviceId, data) {
  const device = await db.get("SELECT fcmToken FROM devices WHERE deviceId = ?", [targetDeviceId]);
  if (device && device.fcmToken) {
    admin.messaging().send({
      token: device.fcmToken,
      data: data, // Enthält type, title, message
      notification: { title: data.title, body: data.message } // Fallback für System-Tray
    }).catch(e => console.log("Push Error:", e.message));
  }
}

// --- ROUTEN ---

app.get("/", (req, res) => {
  res.json({ status: "Server läuft!", appActive: isAppActive() });
});

// 1. STANDORT-UPDATE (Vom Handy gesendet)
app.post("/location/update", async (req, res) => {
  let { deviceId, lat, lon, speed, battery, accuracy, name, fcmToken, geofenceEvent } = req.body;
  if (!deviceId) return res.sendStatus(400);
  deviceId = deviceId.toLowerCase();

  try {
    const existing = await db.get("SELECT isAwake, alarmActive FROM devices WHERE deviceId = ?", [deviceId]);
    const currentAwake = existing ? existing.isAwake : 1;
    const currentAlarm = existing ? existing.alarmActive : 0;

    await db.run(`
      INSERT INTO devices (deviceId, lat, lon, speed, battery, accuracy, name, timestamp, isAwake, alarmActive, fcmToken)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(deviceId) DO UPDATE SET
        lat=excluded.lat, lon=excluded.lon, speed=excluded.speed, 
        battery=excluded.battery, accuracy=excluded.accuracy, 
        name=excluded.name, timestamp=excluded.timestamp, fcmToken=excluded.fcmToken
    `, [deviceId, lat, lon, speed, battery, accuracy, name, Date.now(), currentAwake, currentAlarm, fcmToken]);

    // Wenn ein Geofence-Ereignis gemeldet wird -> Push an ALLE ANDEREN
    if (geofenceEvent) {
      const rows = await db.all("SELECT deviceId FROM devices WHERE deviceId != ?", [deviceId]);
      rows.forEach(r => {
        sendPush(r.deviceId, { 
          type: "geofence", 
          title: "Geofence Info", 
          message: `${name || deviceId}: ${geofenceEvent}` 
        });
      });
    }

    res.json({ status: "ok" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. ALLE AUFWECKEN
app.post("/devices/wakeup-all", async (req, res) => {
  lastAppActivity = Date.now();
  await db.run("UPDATE devices SET isAwake = 1");
  res.json({ status: "all awake" });
});

// 3. EINZEL-GERÄT SCHLAFEN
app.post("/devices/:id/sleep", async (req, res) => {
  await db.run("UPDATE devices SET isAwake = 0 WHERE deviceId = ?", [req.params.id.toLowerCase()]);
  res.json({ status: "sleeping" });
});

// 4. BEOBACHTUNG (Ghost Mode)
app.post("/devices/:id/watch", (req, res) => {
  const targetId = req.params.id.toLowerCase();
  const watcherId = req.query.watcherId?.toLowerCase();
  if (!watchers.has(targetId)) watchers.set(targetId, new Set());
  if (watcherId) watchers.get(targetId).add(watcherId);
  res.json({ status: "watching" });
});

app.post("/devices/:id/unwatch", (req, res) => {
  const targetId = req.params.id.toLowerCase();
  if (watchers.has(targetId)) watchers.get(targetId).delete(req.query.watcherId?.toLowerCase());
  res.json({ status: "unwatched" });
});

// 5. STATUS-CHECK (Wird alle 6s vom Service gerufen)
app.get("/devices/:id", async (req, res) => {
  const deviceId = req.params.id.toLowerCase();
  const device = await db.get("SELECT * FROM devices WHERE deviceId = ?", [deviceId]);
  if (!device) return res.status(404).send("Not found");

  const isWatched = watchers.has(deviceId) && watchers.get(deviceId).size > 0;
  const effectiveAwake = (device.isAwake === 1 && isAppActive()) || isWatched;

  res.json({ 
    ...device, 
    alarmActive: device.alarmActive === 1, 
    isAwake: !!effectiveAwake, 
    isWatched: !!isWatched 
  });
});

// 6. GERÄTE-LISTE (Für MapActivity)
app.get("/devices", async (req, res) => {
  lastAppActivity = Date.now();
  const rows = await db.all("SELECT * FROM devices");
  const now = Date.now();
  res.json(rows.map(d => ({
    ...d,
    alarmActive: d.alarmActive === 1,
    isWatched: watchers.has(d.deviceId) && watchers.get(d.deviceId).size > 0,
    status: (now - d.timestamp < 65000) ? "online" : "offline"
  })));
});

// 7. ALARM AUSLÖSEN (Mit Push!)
app.post("/devices/:id/ring", async (req, res) => {
  const deviceId = req.params.id.toLowerCase();
  await db.run("UPDATE devices SET alarmActive = 1 WHERE deviceId = ?", [deviceId]);
  
  // Sofort Push an das Zielgerät
  await sendPush(deviceId, { 
    type: "alarm", 
    title: "ALARM!", 
    message: "Dein Gerät wird gesucht!" 
  });

  res.sendStatus(200);
});

app.post("/devices/:id/reset-alarm", async (req, res) => {
  await db.run("UPDATE devices SET alarmActive = 0 WHERE deviceId = ?", [req.params.id.toLowerCase()]);
  res.sendStatus(200);
});

app.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));
