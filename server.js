import express from "express";
import cors from "cors";
import sqlite3 from "sqlite3";
import { open } from "sqlite";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// --- DATENBANK INITIALISIERUNG ---
let db;
(async () => {
  db = await open({
    filename: "./database.db",
    driver: sqlite3.Database
  });

  // Tabelle erstellen mit isAwake und alarmActive
  await db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      deviceId TEXT PRIMARY KEY,
      lat REAL,
      lon REAL,
      speed REAL,
      battery INTEGER,
      accuracy REAL,
      name TEXT,
      timestamp INTEGER,
      alarmActive INTEGER DEFAULT 0,
      isAwake INTEGER DEFAULT 1
    )
  `);
  console.log("SQLite Datenbank bereit.");
})();

// --- GHOST MODE & AUTO-SLEEP LOGIK ---
const watchers = new Map(); // Wer beobachtet wen? (deviceId -> Set von watcherIds)
let lastAppActivity = 0;    // Zeitstempel der letzten Map-Abfrage

// Hilfsfunktion: Ist gerade eine App geöffnet? (Timeout 60s)
const isAppActive = () => (Date.now() - lastAppActivity) < 60000;

app.get("/", (req, res) => {
  res.json({ 
    status: "Server läuft!", 
    activeApp: isAppActive(),
    devicesInDb: "Check /devices"
  });
});

// 1. STANDORT-UPDATE (Vom Handy gesendet)
app.post("/location/update", async (req, res) => {
  const { deviceId, lat, lon, speed, battery, accuracy, name } = req.body;
  if (!deviceId) return res.status(400).send("No Device ID");

  try {
    // WICHTIG: Bestehenden isAwake Status beibehalten, nicht mit Update überschreiben
    const existing = await db.get("SELECT isAwake, alarmActive FROM devices WHERE deviceId = ?", [deviceId]);
    const currentAwake = existing ? existing.isAwake : 1; // Neue Geräte starten wach
    const currentAlarm = existing ? existing.alarmActive : 0;

    await db.run(`
      INSERT INTO devices (deviceId, lat, lon, speed, battery, accuracy, name, timestamp, isAwake, alarmActive)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(deviceId) DO UPDATE SET
        lat=excluded.lat, 
        lon=excluded.lon, 
        speed=excluded.speed, 
        battery=excluded.battery, 
        accuracy=excluded.accuracy, 
        name=excluded.name, 
        timestamp=excluded.timestamp
    `, [deviceId, lat, lon, speed, battery, accuracy, name, Date.now(), currentAwake, currentAlarm]);

    res.json({ status: "ok" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. ALLE AUFWECKEN (App Start)
app.post("/devices/wakeup-all", async (req, res) => {
  console.log("Wakeup-all: Alle Geräte werden aktiviert.");
  lastAppActivity = Date.now();
  await db.run("UPDATE devices SET isAwake = 1");
  res.json({ status: "all awake" });
});

// 3. GERÄT IN SCHLAFMODUS (Sparen)
app.post("/devices/:id/sleep", async (req, res) => {
  await db.run("UPDATE devices SET isAwake = 0 WHERE deviceId = ?", [req.params.id]);
  res.json({ status: "sleeping" });
});

// 4. BEOBACHTUNG (Ghost Mode Unterstützung)
app.post("/devices/:id/watch", (req, res) => {
  const targetId = req.params.id;
  const watcherId = req.query.watcherId;
  if (!watchers.has(targetId)) watchers.set(targetId, new Set());
  watchers.get(targetId).add(watcherId);
  res.json({ status: "watching" });
});

app.post("/devices/:id/unwatch", (req, res) => {
  const targetId = req.params.id;
  if (watchers.has(targetId)) watchers.get(targetId).delete(req.query.watcherId);
  res.json({ status: "unwatched" });
});

// 5. STATUS-CHECK (Wird alle 6s vom Service gerufen)
app.get("/devices/:id", async (req, res) => {
  const device = await db.get("SELECT * FROM devices WHERE deviceId = ?", [req.params.id]);
  if (!device) return res.status(404).send("Not found");

  const isWatched = watchers.has(device.deviceId) && watchers.get(device.deviceId).size > 0;
  // Gerät ist wach wenn: (isAwake=1 UND App aktiv) ODER (jemand schaut zu)
  const effectiveAwake = (device.isAwake === 1 && isAppActive()) || isWatched;

  res.json({
    ...device,
    alarmActive: !!device.alarmActive,
    isAwake: !!effectiveAwake,
    isWatched: isWatched
  });
});

// 6. GERÄTE-LISTE (Für MapActivity)
app.get("/devices", async (req, res) => {
  lastAppActivity = Date.now(); // Jede Abfrage hält Geräte wach
  const now = Date.now();
  try {
    const rows = await db.all("SELECT * FROM devices");
    res.json(rows.map(d => ({
      ...d,
      alarmActive: !!d.alarmActive,
      isWatched: watchers.has(d.deviceId) && watchers.get(d.deviceId).size > 0,
      // Offline wenn länger als 65s kein Update kam
      status: (now - d.timestamp < 65000) ? "online" : "offline"
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. ALARM FUNKTIONEN
app.post("/devices/:id/ring", async (req, res) => {
  await db.run("UPDATE devices SET alarmActive = 1 WHERE deviceId = ?", [req.params.id]);
  res.sendStatus(200);
});

app.post("/devices/:id/reset-alarm", async (req, res) => {
  await db.run("UPDATE devices SET alarmActive = 0 WHERE deviceId = ?", [req.params.id]);
  res.sendStatus(200);
});

app.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));
