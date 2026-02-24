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
  db = await open({ filename: "./database.db", driver: sqlite3.Database });
  await db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      deviceId TEXT PRIMARY KEY,
      lat REAL, lon REAL, speed REAL, battery INTEGER, accuracy REAL,
      name TEXT, timestamp INTEGER, alarmActive INTEGER DEFAULT 0, isAwake INTEGER DEFAULT 1
    )
  `);
  console.log("SQLite Datenbank bereit.");
})();

const watchers = new Map();
let lastAppActivity = 0;
const isAppActive = () => (Date.now() - lastAppActivity) < 60000;

// 1. STANDORT-UPDATE
app.post("/location/update", async (req, res) => {
  let { deviceId, lat, lon, speed, battery, accuracy, name } = req.body;
  if (!deviceId) return res.sendStatus(400);
  deviceId = deviceId.toLowerCase(); // Konsistenz erzwingen

  try {
    const existing = await db.get("SELECT isAwake, alarmActive FROM devices WHERE deviceId = ?", [deviceId]);
    const currentAwake = existing ? existing.isAwake : 1;
    const currentAlarm = existing ? existing.alarmActive : 0;

    await db.run(`
      INSERT INTO devices (deviceId, lat, lon, speed, battery, accuracy, name, timestamp, isAwake, alarmActive)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(deviceId) DO UPDATE SET
        lat=excluded.lat, lon=excluded.lon, speed=excluded.speed, 
        battery=excluded.battery, accuracy=excluded.accuracy, 
        name=excluded.name, timestamp=excluded.timestamp
    `, [deviceId, lat, lon, speed, battery, accuracy, name, Date.now(), currentAwake, currentAlarm]);
    res.json({ status: "ok" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 2. ALLE AUFWECKEN
app.post("/devices/wakeup-all", async (req, res) => {
  lastAppActivity = Date.now();
  await db.run("UPDATE devices SET isAwake = 1");
  res.json({ status: "all awake" });
});

// 3. EINZEL-STATUS PRÜFEN (Wichtig: Boolean-Konvertierung für Android)
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

// 4. GERÄTE-LISTE (Für die Karte)
app.get("/devices", async (req, res) => {
  lastAppActivity = Date.now();
  const rows = await db.all("SELECT * FROM devices");
  const now = Date.now();
  res.json(rows.map(d => {
    const isWatched = watchers.has(d.deviceId) && watchers.get(d.deviceId).size > 0;
    const effectiveAwake = (d.isAwake === 1 && isAppActive()) || isWatched;
    return { 
      ...d, 
      alarmActive: d.alarmActive === 1, 
      isAwake: !!effectiveAwake, 
      isWatched: !!isWatched, 
      status: (now - d.timestamp < 65000) ? "online" : "offline" 
    };
  }));
});

// 5. WATCH/UNWATCH & ALARM (deviceId immer lowercase)
app.post("/devices/:id/watch", (req, res) => {
  const targetId = req.params.id.toLowerCase();
  if (!watchers.has(targetId)) watchers.set(targetId, new Set());
  watchers.get(targetId).add(req.query.watcherId?.toLowerCase());
  res.json({ status: "watching" });
});

app.post("/devices/:id/unwatch", (req, res) => {
  const targetId = req.params.id.toLowerCase();
  if (watchers.has(targetId)) watchers.get(targetId).delete(req.query.watcherId?.toLowerCase());
  res.json({ status: "unwatched" });
});

app.post("/devices/:id/ring", async (req, res) => {
  await db.run("UPDATE devices SET alarmActive = 1 WHERE deviceId = ?", [req.params.id.toLowerCase()]);
  res.sendStatus(200);
});

app.post("/devices/:id/reset-alarm", async (req, res) => {
  await db.run("UPDATE devices SET alarmActive = 0 WHERE deviceId = ?", [req.params.id.toLowerCase()]);
  res.sendStatus(200);
});

app.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));
