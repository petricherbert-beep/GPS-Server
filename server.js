/* ======================================================
   🌐 SERVER.JS – VOLLSTÄNDIGE VERSION (Optimiert)
   ====================================================== */
import express from "express";
import cors from "cors";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import admin from "firebase-admin";
import { WebSocketServer, WebSocket } from "ws";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const activeWatchers = new Map(); 
const lastWatchActivity = new Map();

let db;

/* --- FIREBASE --- */
try {
  const accountVar = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (accountVar && !admin.apps.length) {
    let serviceAccount = JSON.parse(
      accountVar.trim().startsWith("{")
        ? accountVar
        : Buffer.from(accountVar, "base64").toString("utf8")
    );
    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key
        .replace(/\\n/g, "\n")
        .replace(/^"/, "")
        .replace(/"$/, "");
    }
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    console.log("✅ Firebase Admin initialisiert.");
  }
} catch (err) {
  console.error("❌ Firebase Fehler:", err.message);
}

/* --- DATENBANK --- */
(async () => {
  db = await open({ filename: "./database.db", driver: sqlite3.Database });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      deviceId TEXT PRIMARY KEY COLLATE NOCASE,
      lat REAL, lon REAL, speed REAL, battery INTEGER,
      accuracy REAL, name TEXT, timestamp INTEGER,
      alarmActive INTEGER DEFAULT 0, fcmToken TEXT,
      isLocked INTEGER DEFAULT 0, isMotion INTEGER DEFAULT 0, isWifi INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS device_tokens (
      deviceId TEXT PRIMARY KEY COLLATE NOCASE,
      fcmToken TEXT, updatedAt INTEGER
    );
    CREATE TABLE IF NOT EXISTS geofences (
      id TEXT PRIMARY KEY, name TEXT, lat REAL, lon REAL,
      radius REAL, color INTEGER, createdBy TEXT,
      alarmSound TEXT, alarmVibration INTEGER DEFAULT 1, isHome INTEGER DEFAULT 0
    );
  `);

  console.log("✅ Datenbank bereit.");

  // WATCHDOG: Alle 60 Sek prüfen
  setInterval(async () => {
    const now = Date.now();
    for (const [targetId, lastActive] of lastWatchActivity.entries()) {
      // Watcher Timeout (10 Min)
      if (now - lastActive > 10 * 60 * 1000) {
        activeWatchers.delete(targetId);
        lastWatchActivity.delete(targetId);
        await sendPush(targetId, { type: "watch_state", isWatched: "false" });
        broadcast({ deviceId: targetId, isWatched: false, status: "online" });
        continue;
      }
      // Target Inactivity Check (20 Min) -> Rettungs-Push
      const device = await db.get("SELECT timestamp FROM devices WHERE deviceId = ? COLLATE NOCASE", [targetId]);
      if (device && (now - device.timestamp > 20 * 60 * 1000)) {
        await sendPush(targetId, { type: "wakeup", title: "Verbindung prüfen", message: "Auto-Wakeup aktiv" });
      }
    }
  }, 60000);
})();

/* --- API ROUTEN --- */
app.post("/location/update", async (req, res) => {
  const { deviceId, lat, lon, speed, battery, accuracy, name, fcmToken, geofenceEvent, isLocked, isMotion, isWifi } = req.body;
  if (!deviceId) return res.sendStatus(400);
  const timestamp = Date.now();

  try {
    const existing = await db.get("SELECT alarmActive FROM devices WHERE deviceId = ? COLLATE NOCASE", [deviceId]);
    const currentAlarm = existing ? existing.alarmActive : 0;

    await db.run(`
      INSERT INTO devices (deviceId, lat, lon, speed, battery, accuracy, name, timestamp, fcmToken, alarmActive, isLocked, isMotion, isWifi)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(deviceId) DO UPDATE SET
        lat=excluded.lat, lon=excluded.lon, speed=excluded.speed, battery=excluded.battery,
        accuracy=excluded.accuracy, name=COALESCE(excluded.name, devices.name),
        timestamp=excluded.timestamp, fcmToken=COALESCE(excluded.fcmToken, devices.fcmToken),
        isLocked=excluded.isLocked, isMotion=excluded.isMotion, isWifi=excluded.isWifi
    `, [deviceId, lat, lon, speed, battery, accuracy, name, timestamp, fcmToken, currentAlarm, isLocked?1:0, isMotion?1:0, isWifi?1:0]);

    if (fcmToken) {
      await db.run(`INSERT INTO device_tokens (deviceId, fcmToken, updatedAt) VALUES (?, ?, ?) ON CONFLICT(deviceId) DO UPDATE SET fcmToken=excluded.fcmToken, updatedAt=excluded.updatedAt`, [deviceId, fcmToken, timestamp]);
    }

    const watchers = activeWatchers.get(deviceId.toLowerCase());
    broadcast({ 
      deviceId, lat, lon, speed, battery, accuracy, name, timestamp, 
      status: "online", alarmActive: !!currentAlarm, 
      isLocked: !!isLocked, isMotion: !!isMotion, isWifi: !!isWifi, 
      isWatched: !!watchers && watchers.size > 0 
    });

    if (geofenceEvent && geofenceEvent !== "heartbeat") {
      const others = await db.all("SELECT deviceId FROM devices WHERE deviceId != ? COLLATE NOCASE", [deviceId]);
      for (const d of others) {
        await sendPush(d.deviceId, { type: "geofence_event", title: "Zonen-Info", message: `${name || deviceId}: ${geofenceEvent}` });
      }
    }
    res.json({ status: "ok" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/devices", async (req, res) => {
  const rows = await db.all("SELECT * FROM devices");
  const now = Date.now();
  res.json(rows.map(d => ({
    ...d,
    alarmActive: d.alarmActive === 1,
    isLocked: d.isLocked === 1 && now - d.timestamp < 150000,
    isMotion: d.isMotion === 1 && now - d.timestamp < 150000,
    isWifi: d.isWifi === 1,
    isWatched: activeWatchers.has(d.deviceId.toLowerCase()),
    status: now - d.timestamp < 24 * 60 * 60 * 1000 ? "online" : "offline"
  })));
});

app.get("/geofences", async (req, res) => {
  const rows = await db.all("SELECT * FROM geofences");
  res.json(rows.map(g => ({ ...g, alarmVibration: g.alarmVibration === 1, isHome: g.isHome === 1 })));
});

app.post("/geofences", async (req, res) => {
  const { id, name, lat, lon, radius, color, createdBy, alarmSound, alarmVibration, isHome } = req.body;
  await db.run(`INSERT INTO geofences (id, name, lat, lon, radius, color, createdBy, alarmSound, alarmVibration, isHome) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, radius=excluded.radius`, [id, name, lat, lon, radius, color, createdBy, alarmSound, alarmVibration?1:0, isHome?1:0]);
  res.sendStatus(201);
});

app.delete("/geofences/:id", async (req, res) => {
  await db.run("DELETE FROM geofences WHERE id = ?", [req.params.id]);
  res.sendStatus(200);
});

app.post("/devices/:id/wakeup", async (req, res) => {
  await sendPush(req.params.id.toLowerCase(), { type: "wakeup", title: "System-Check", message: "Standort erzwungen" });
  res.json({ status: "sent" });
});

app.post("/devices/:id/alarm", async (req, res) => {
  const active = req.query.active === "true";
  await db.run("UPDATE devices SET alarmActive = ? WHERE deviceId = ? COLLATE NOCASE", [active?1:0, req.params.id.toLowerCase()]);
  await sendPush(req.params.id.toLowerCase(), { type: active ? "alarm" : "stop_alarm", title: "Alarm", message: active ? "AUSGELÖST" : "Beendet" });
  res.sendStatus(200);
});

app.post("/devices/:id/watch", async (req, res) => {
  const targetId = req.params.id.toLowerCase();
  const watcherId = req.query.watcherId;
  if (!activeWatchers.has(targetId)) activeWatchers.set(targetId, new Set());
  activeWatchers.get(targetId).add(watcherId);
  lastWatchActivity.set(targetId, Date.now());
  await sendPush(targetId, { type: "watch_state", isWatched: "true" });
  broadcast({ deviceId: targetId, isWatched: true });
  res.sendStatus(200);
});

app.post("/devices/:id/unwatch", async (req, res) => {
  const targetId = req.params.id.toLowerCase();
  if (activeWatchers.has(targetId)) {
    activeWatchers.delete(targetId);
    lastWatchActivity.delete(targetId);
    await sendPush(targetId, { type: "watch_state", isWatched: "false" });
    broadcast({ deviceId: targetId, isWatched: false });
  }
  res.sendStatus(200);
});

const server = app.listen(PORT, () => console.log(`🚀 Port ${PORT}`));
const wss = new WebSocketServer({ server });
function broadcast(data) { wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify(data)); }); }

async function sendPush(targetId, data) {
  const device = await db.get("SELECT fcmToken FROM device_tokens WHERE deviceId = ? COLLATE NOCASE", [targetId]);
  if (!device?.fcmToken) return;
  const sData = {}; Object.keys(data).forEach(k => sData[k] = String(data[k]));
  try { await admin.messaging().send({ token: device.fcmToken, data: sData, android: { priority: "high", ttl: 0 } }); } catch (e) {}
}

async function wakeupAllDevicesViaTopic() {
  if (!admin.apps.length) return;
  try { await admin.messaging().send({ topic: "all_devices", data: { type: "wakeup" }, android: { priority: "high" } }); } catch (e) {}
}
