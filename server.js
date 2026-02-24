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

  // Tabelle erstellen falls nicht vorhanden
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
  console.log("SQLite Datenbank bereit.");
})();

// --- GLOBALE VARIABLEN ---
const watchers = new Map(); // Wer beobachtet wen? (RAM ist hier okay)
let lastAppActivity = 0;    // Wann wurde zuletzt die Karte bewegt?

// --- HILFSFUNKTIONEN ---
const isAppActive = () => (Date.now() - lastAppActivity) < 65000;

// --- ROUTEN ---

app.get("/", (req, res) => {
  res.json({ 
    status: "Server läuft!", 
    appActive: isAppActive(),
    lastActivity: new Date(lastAppActivity).toLocaleTimeString()
  });
});

// 1. STANDORT-UPDATE (Vom Handy gesendet)
app.post("/location/update", async (req, res) => {
  const { deviceId, lat, lon, speed, battery, accuracy, name } = req.body;
  if (!deviceId) return res.status(400).send("No Device ID");

  try {
    // Aktuellen Status (Sleep/Alarm) aus DB holen, um ihn nicht zu überschreiben
    const existing = await db.get("SELECT isAwake, alarmActive FROM devices WHERE deviceId = ?", [deviceId]);
    const currentAwake = existing ? existing.isAwake : 0;
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
    console.error(err);
    res.status(500).json({ error: "Database error" });
  }
});

// 2. ALLE AUFWECKEN (Wird beim App-Start gerufen)
app.post("/devices/wakeup-all", async (req, res) => {
  console.log("App aktiv: Wecke alle Geräte auf.");
  lastAppActivity = Date.now();
  await db.run("UPDATE devices SET isAwake = 1");
  res.json({ status: "all awake" });
});

// 3. EINZEL-GERÄT SCHLAFEN LEGEN
app.post("/devices/:id/sleep", async (req, res) => {
  await db.run("UPDATE devices SET isAwake = 0 WHERE deviceId = ?", [req.params.id]);
  console.log(`Gerät ${req.params.id} geht in den Schlafmodus.`);
  res.json({ status: "sleeping" });
});

// 4. BEOBACHTUNG (Ghost Mode Logic)
// Wenn ich ein Gerät auf der Karte anklicke
app.post("/devices/:id/watch", (req, res) => {
  const targetId = req.params.id;
  const watcherId = req.query.watcherId;
  
  if (!watchers.has(targetId)) watchers.set(targetId, new Set());
  watchers.get(targetId).add(watcherId);
  
  console.log(`${watcherId} beobachtet jetzt ${targetId}`);
  res.json({ status: "watching" });
});

app.post("/devices/:id/unwatch", (req, res) => {
  const targetId = req.params.id;
  const watcherId = req.query.watcherId;
  
  if (watchers.has(targetId)) {
    watchers.get(targetId).delete(watcherId);
  }
  res.json({ status: "unwatched" });
});

// 5. STATUS-CHECK (Wird alle 6s vom Handy-Service gerufen)
app.get("/devices/:id", async (req, res) => {
  const deviceId = req.params.id;
  const device = await db.get("SELECT * FROM devices WHERE deviceId = ?", [deviceId]);
  
  if (!device) return res.status(404).json({ error: "Not found" });

  // Prüfen ob jemand zuschaut
  const isWatched = watchers.has(deviceId) && watchers.get(deviceId).size > 0;
  
  // Smart-Logic: Nur senden wenn App aktiv ODER jemand zuschaut
  const effectiveAwake = (device.isAwake && isAppActive()) || isWatched;

  res.json({
    ...device,
    alarmActive: !!device.alarmActive,
    isAwake: !!effectiveAwake,
    isWatched: isWatched
  });
});

// 6. GERÄTE-LISTE (Für die Kartenanzeige)
app.get("/devices", async (req, res) => {
  lastAppActivity = Date.now(); // Jede Kartenabfrage hält Geräte wach
  const now = Date.now();
  
  try {
    const rows = await db.all("SELECT * FROM devices");
    res.json(rows.map(d => ({
      ...d,
      alarmActive: !!d.alarmActive,
      isWatched: watchers.has(d.deviceId) && watchers.get(d.deviceId).size > 0,
      status: (now - d.timestamp < 65000) ? "online" : "offline"
    })));
  } catch (err) {
    res.status(500).json({ error: "Database error" });
  }
});

// 7. ALARM FUNKTIONEN
app.post("/devices/:id/ring", async (req, res) => {
  await db.run("UPDATE devices SET alarmActive = 1 WHERE deviceId = ?", [req.params.id]);
  res.json({ status: "alarm activated" });
});

app.post("/devices/:id/reset-alarm", async (req, res) => {
  await db.run("UPDATE devices SET alarmActive = 0 WHERE deviceId = ?", [req.params.id]);
  res.json({ status: "alarm reset" });
});

app.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));
