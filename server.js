/* ======================================================
   🌐 SERVER.JS – KOMPLETTE VERSION (REINES JS)
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

/* ======================================================
   🔥 FIREBASE INITIALISIERUNG
====================================================== */
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

/* ======================================================
   🗄 SQLITE DATENBANK & STARTUP
====================================================== */
(async () => {
  db = await open({ filename: "./database.db", driver: sqlite3.Database });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      deviceId TEXT PRIMARY KEY COLLATE NOCASE,
      lat REAL, lon REAL, speed REAL, battery INTEGER,
      accuracy REAL, name TEXT, timestamp INTEGER,
      alarmActive INTEGER DEFAULT 0, fcmToken TEXT,
      isLocked INTEGER DEFAULT 0, isMotion INTEGER DEFAULT 0, isWifi INTEGER DEFAULT 0
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS device_tokens (
      deviceId TEXT PRIMARY KEY COLLATE NOCASE,
      fcmToken TEXT,
      updatedAt INTEGER
    )
  `);

  console.log("✅ Datenbank bereit.");

  await wakeupAllDevicesViaTopic();

  // Geräte nach 7 Tagen löschen
  setInterval(async () => {
    if (!db) return;
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    try {
      await db.run("DELETE FROM devices WHERE timestamp < ?", [sevenDaysAgo]);
    } catch (err) {
      console.error("❌ Cleanup Fehler:", err.message);
    }
  }, 60 * 60 * 1000);

  // Tokens nach 14 Tagen löschen
  setInterval(async () => {
    if (!db) return;
    const fourteenDaysAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
    try {
      await db.run("DELETE FROM device_tokens WHERE updatedAt < ?", [fourteenDaysAgo]);
    } catch (err) {
      console.error("❌ Token Cleanup Fehler:", err.message);
    }
  }, 24 * 60 * 60 * 1000);

  // Watcher Timeout
  setInterval(async () => {
    const now = Date.now();
    const timeout = 10 * 60 * 1000; // 10 Min
    for (const [targetId, lastActive] of lastWatchActivity.entries()) {
      if (now - lastActive > timeout) {
        activeWatchers.delete(targetId);
        lastWatchActivity.delete(targetId);
        await sendPush(targetId, { type: "watch_state", isWatched: "false" });
        broadcast({ deviceId: targetId, isWatched: false, status: "online" });
      }
    }
  }, 60 * 1000);
})();

/* ======================================================
   🌍 API ROUTEN
====================================================== */

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
    `, [deviceId, lat, lon, speed, battery, accuracy, name, timestamp, fcmToken, currentAlarm, isLocked ? 1 : 0, isMotion ? 1 : 0, isWifi ? 1 : 0]);

    // Token speichern / aktualisieren
    if (fcmToken) {
      await db.run(`
        INSERT INTO device_tokens (deviceId, fcmToken, updatedAt)
        VALUES (?, ?, ?)
        ON CONFLICT(deviceId) DO UPDATE SET fcmToken=excluded.fcmToken, updatedAt=excluded.updatedAt
      `, [deviceId, fcmToken, timestamp]);
    }

    broadcast({ deviceId, lat, lon, speed, battery, accuracy, name, timestamp, status: "online", alarmActive: !!currentAlarm, isLocked: !!isLocked, isMotion: !!isMotion, isWifi: !!isWifi, isWatched: activeWatchers.has(deviceId.toLowerCase()) });

    if (geofenceEvent) {
      const others = await db.all("SELECT deviceId FROM devices WHERE deviceId != ? COLLATE NOCASE", [deviceId]);
      for (const d of others) {
        await sendPush(d.deviceId, { type: "geofence_event", title: "Zonen-Info", message: `${name || deviceId} ${geofenceEvent}` });
      }
    }
    res.json({ status: "ok" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
    status: now - d.timestamp < 24 * 60 *60 * 1000 ? "online" : "offline"
  })));
});

/* ======================================================
   🔔 ALARM & WATCH
====================================================== */
app.post("/devices/:id/alarm", async (req, res) => {
  const deviceId = req.params.id.toLowerCase();
  const { active } = req.query;
  const alarmValue = active === "true" ? 1 : 0;

  try {
    await db.run("UPDATE devices SET alarmActive = ? WHERE deviceId = ? COLLATE NOCASE", [alarmValue, deviceId]);
    await sendPush(deviceId, { type: alarmValue ? "alarm" : "stop_alarm", title: "Alarm-System", message: alarmValue ? "ALARM AUSGELÖST!" : "Alarm beendet." });

    const device = await db.get("SELECT * FROM devices WHERE deviceId = ? COLLATE NOCASE", [deviceId]);
    if (device) broadcast({ ...device, alarmActive: !!alarmValue, status: "online" });

    res.sendStatus(200);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/devices/wakeup-all", async (req, res) => {
  try { await wakeupAllDevicesViaTopic(); res.sendStatus(200); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/devices/:id/watch", async (req, res) => {
  const targetId = req.params.id.toLowerCase();
  const watcherId = req.query.watcherId;
  if (!watcherId) return res.status(400).json({ error: "watcherId fehlt" });

  if (!activeWatchers.has(targetId)) activeWatchers.set(targetId, new Set());
  activeWatchers.get(targetId).add(watcherId);
  lastWatchActivity.set(targetId, Date.now());

  await sendPush(targetId, { type: "watch_state", isWatched: "true" });
  res.sendStatus(200);
});

app.post("/devices/:id/unwatch", async (req, res) => {
  const targetId = req.params.id.toLowerCase();
  const watcherId = req.query.watcherId;
  if (!watcherId) return res.status(400).json({ error: "watcherId fehlt" });

  if (activeWatchers.has(targetId)) {
    activeWatchers.get(targetId).delete(watcherId);
    if (activeWatchers.get(targetId).size === 0) {
      activeWatchers.delete(targetId);
      lastWatchActivity.delete(targetId);
      await sendPush(targetId, { type: "watch_state", isWatched: "false" });
    }
  }
  res.sendStatus(200);
});

/* ======================================================
   🔌 WEBSOCKET & PUSH HELPERS
====================================================== */
const server = app.listen(PORT, () => console.log(`🚀 Server läuft auf Port ${PORT}`));
const wss = new WebSocketServer({ server });

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

async function sendPush(targetDeviceId, data) {
  if (!admin.apps.length || !db) return;
  const device = await db.get("SELECT fcmToken FROM device_tokens WHERE deviceId = ? COLLATE NOCASE", [targetDeviceId]);
  if (!device?.fcmToken) return;

  const stringData = {};
  Object.keys(data).forEach(key => { stringData[key] = String(data[key]); });

  try {
    await admin.messaging().send({ token: device.fcmToken, data: stringData, android: { priority: "high" } });
  } catch (e) { console.error("❌ Push Error:", e.message); }
}

async function wakeupAllDevicesViaTopic() {
  if (!admin.apps.length) return;
  try {
    await admin.messaging().send({ topic: "all_devices", data: { type: "wakeup" }, android: { priority: "high" } });
  } catch (e) { console.error("❌ Wakeup Error"); }
}
