import express from "express";
import cors from "cors";
import sqlite3 from "sqlite3";
import { open } from "sqlite";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

let db;
(async () => {
  db = await open({ filename: "./database.db", driver: sqlite3.Database });
  await db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      deviceId TEXT PRIMARY KEY,
      lat REAL, lon REAL, speed REAL, battery INTEGER, accuracy REAL,
      name TEXT, timestamp INTEGER, alarmActive INTEGER DEFAULT 0, isAwake INTEGER DEFAULT 0
    )
  `);
})();

const watchers = new Map();
let lastAppActivity = 0;

const isAppActive = () => (Date.now() - lastAppActivity) < 60000;

app.post("/location/update", async (req, res) => {
  const { deviceId, lat, lon } = req.body;
  if (!deviceId) return res.sendStatus(400);

  const existing = await db.get("SELECT isAwake, alarmActive FROM devices WHERE deviceId = ?", [deviceId]);
  const currentAwake = existing ? existing.isAwake : 0;
  const currentAlarm = existing ? existing.alarmActive : 0;

  await db.run(`
    INSERT INTO devices (deviceId, lat, lon, speed, battery, accuracy, name, timestamp, isAwake, alarmActive)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(deviceId) DO UPDATE SET
      lat=excluded.lat, lon=excluded.lon, speed=excluded.speed, 
      battery=excluded.battery, accuracy=excluded.accuracy, 
      name=excluded.name, timestamp=excluded.timestamp
  `, [deviceId, lat, lon, req.body.speed, req.body.battery, req.body.accuracy, req.body.name, Date.now(), currentAwake, currentAlarm]);

  res.json({ status: "ok" });
});

app.post("/devices/wakeup-all", async (req, res) => {
  lastAppActivity = Date.now();
  await db.run("UPDATE devices SET isAwake = 1");
  res.json({ status: "all awake" });
});

app.post("/devices/:id/sleep", async (req, res) => {
  await db.run("UPDATE devices SET isAwake = 0 WHERE deviceId = ?", [req.params.id]);
  res.json({ status: "sleeping" });
});

app.post("/devices/:id/watch", (req, res) => {
  const targetId = req.params.id;
  if (!watchers.has(targetId)) watchers.set(targetId, new Set());
  watchers.get(targetId).add(req.query.watcherId);
  res.json({ status: "watching" });
});

app.post("/devices/:id/unwatch", (req, res) => {
  if (watchers.has(req.params.id)) watchers.get(req.params.id).delete(req.query.watcherId);
  res.json({ status: "unwatched" });
});

app.get("/devices/:id", async (req, res) => {
  const device = await db.get("SELECT * FROM devices WHERE deviceId = ?", [req.params.id]);
  if (!device) return res.status(404).send("Not found");
  const isWatched = watchers.has(device.deviceId) && watchers.get(device.deviceId).size > 0;
  const effectiveAwake = (device.isAwake && isAppActive()) || isWatched;
  res.json({ ...device, alarmActive: !!device.alarmActive, isAwake: !!effectiveAwake, isWatched });
});

app.get("/devices", async (req, res) => {
  lastAppActivity = Date.now();
  const rows = await db.all("SELECT * FROM devices");
  const now = Date.now();
  res.json(rows.map(d => ({
    ...d, alarmActive: !!d.alarmActive,
    isWatched: watchers.has(d.deviceId) && watchers.get(d.deviceId).size > 0,
    status: (now - d.timestamp < 65000) ? "online" : "offline"
  })));
});

app.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));
