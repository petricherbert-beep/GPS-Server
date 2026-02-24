// server.js – SQLite Version mit Auto-Sleep & Ghost Mode
import express from "express";
import cors from "cors";
import sqlite3 from "sqlite3";
import { open } from "sqlite";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Datenbank initialisieren
let db;
(async () => {
  db = await open({
    filename: "./database.db",
    driver: sqlite3.Database
  });
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
      isAwake INTEGER DEFAULT 0
    )
  `);
})();

// Wer beobachtet wen? (Flüchtig im RAM okay)
const watchers = new Map();
let lastAppActivity = 0;

app.get("/", (req, res) => res.json({ status: "Server läuft!", appActive: (Date.now() - lastAppActivity) < 65000 }));

// 1. STANDORT-UPDATE
app.post("/location/update", async (req, res) => {
  const { deviceId, lat, lon, speed, battery, name, accuracy } = req.body;
  if (!deviceId) return res.status(400).send("No ID");

  await db.run(`
    INSERT INTO devices (deviceId, lat, lon, speed, battery, accuracy, name, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(deviceId) DO UPDATE SET
      lat=excluded.lat, lon=excluded.lon, speed=excluded.speed, 
      battery=excluded.battery, accuracy=excluded.accuracy, 
      name=excluded.name, timestamp=excluded.timestamp
  `, [deviceId, lat, lon, speed, battery, accuracy, name, Date.now()]);

  res.json({ status: "ok" });
});

// 2. ALLE AUFWECKEN
app.post("/devices/wakeup-all", async (req, res) => {
  lastAppActivity = Date.now();
  await db.run("UPDATE devices SET isAwake = 1");
  res.json({ status: "all awake" });
});

// 3. EINZEL-GERÄT SCHLAFEN
app.post("/devices/:id/sleep", async (req, res) => {
  await db.run("UPDATE devices SET isAwake = 0 WHERE deviceId = ?", [req.params.id]);
  res.json({ status: "sleeping" });
});

// 4. BEOBACHTUNG (Ghost Mode Logic)
app.post("/devices/:id/watch", (req, res) => {
  const targetId = req.params.id;
  const watcherId = req.query.watcherId;
  if (!watchers.has(targetId)) watchers.set(targetId, new Set());
  watchers.get(targetId).add(watcherId);
  res.json({ status: "watching" });
});

app.post("/devices/:id/unwatch", (req, res) => {
  if (watchers.has(req.params.id)) watchers.get(req.params.id).delete(req.query.watcherId);
  res.json({ status: "unwatched" });
});

// 5. STATUS-CHECK
app.get("/devices/:id", async (req, res) => {
  const device = await db.get("SELECT * FROM devices WHERE deviceId = ?", [req.params.id]);
  if (!device) return res.status(404).send("Not found");

  const appIsActive = (Date.now() - lastAppActivity) < 60000;
  const isWatched = watchers.has(device.deviceId) && watchers.get(device.deviceId).size > 0;
  const effectiveAwake = (device.isAwake && appIsActive) || isWatched;

  res.json({ ...device, alarmActive: !!device.alarmActive, isAwake: !!effectiveAwake, isWatched });
});

// 6. GERÄTE-LISTE
app.get("/devices", async (req, res) => {
  lastAppActivity = Date.now();
  const rows = await db.all("SELECT * FROM devices");
  const now = Date.now();
  res.json(rows.map(d => ({
    ...d,
    alarmActive: !!d.alarmActive,
    isWatched: watchers.has(d.deviceId) && watchers.get(d.deviceId).size > 0,
    status: (now - d.timestamp < 60000) ? "online" : "offline"
  })));
});

// 7. ALARM
app.post("/devices/:id/ring", async (req, res) => {
  await db.run("UPDATE devices SET alarmActive = 1 WHERE deviceId = ?", [req.params.id]);
  res.sendStatus(200);
});

app.post("/devices/:id/reset-alarm", async (req, res) => {
  await db.run("UPDATE devices SET alarmActive = 0 WHERE deviceId = ?", [req.params.id]);
  res.sendStatus(200);
});

app.listen(PORT, () => console.log(`Server auf Port ${PORT}`));
