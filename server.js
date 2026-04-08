/* ======================================================   🌐 SERVER.JS – VOLLSTÄNDIGE VERSION (Optimiert)
   - Geofences, Watcher, Auto-Wakeup & Heartbeat-Filter
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
const activeWatchers = new Map(); // targetId -> Set(watcherId)
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
   🗄 DATENBANK SETUP & TABELLEN
====================================================== */
(async () => {
  db = await open({ filename: "./database.db", driver: sqlite3.Database });

  // Geräte-Tabelle
  await db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      deviceId TEXT PRIMARY KEY COLLATE NOCASE,
      lat REAL, lon REAL, speed REAL, battery INTEGER,
      accuracy REAL, name TEXT, timestamp INTEGER,
      alarmActive INTEGER DEFAULT 0, fcmToken TEXT,
      isLocked INTEGER DEFAULT 0, isMotion INTEGER DEFAULT 0, isWifi INTEGER DEFAULT 0
    )
  `);

  // Token-Tabelle für Push
  await db.exec(`
    CREATE TABLE IF NOT EXISTS device_tokens (
      deviceId TEXT PRIMARY KEY COLLATE NOCASE,
      fcmToken TEXT,
      updatedAt INTEGER
    )
  `);

  // Geofence-Tabelle
  await db.exec(`
    CREATE TABLE IF NOT EXISTS geofences (
      id TEXT PRIMARY KEY,
      name TEXT,
      lat REAL,
      lon REAL,
      radius REAL,
      color INTEGER,
      createdBy TEXT,
      alarmSound TEXT,
      alarmVibration INTEGER DEFAULT 1,
      isHome INTEGER DEFAULT 0
    )
  `);

  console.log("✅ Datenbank bereit.");

  await wakeupAllDevicesViaTopic();

  /* ======================================================
     🕵️‍♂️ SERVER-WATCHDOG (Automatisches Aufwecken & Cleanup)
  ====================================================== */
  setInterval(async () => {
    const now = Date.now();
    const watcherTimeout = 10 * 60 * 1000; // 10 Min Inaktivität des Beobachters
    const targetInactivityTimeout = 20 * 60 * 1000; // 20 Min Funkstille (Handy-Heartbeat ist 14 Min)

    for (const [targetId, lastActive] of lastWatchActivity.entries()) {
      
      // 1. Inaktive Watcher entfernen
      if (now - lastActive > watcherTimeout) {
        activeWatchers.delete(targetId);
        lastWatchActivity.delete(targetId);
        await sendPush(targetId, { type: "watch_state", isWatched: "false" });
        broadcast({ deviceId: targetId, isWatched: false, status: "online" });
        continue;
      }

      // 2. Ziel-Gerät prüfen: Wenn beobachtet, aber länger als 20 Min stumm -> Rettungs-Push
      const device = await db.get("SELECT timestamp FROM devices WHERE deviceId = ? COLLATE NOCASE", [targetId]);
      if (device && (now - device.timestamp > targetInactivityTimeout)) {
        console.log(`⚠️ Gerät ${targetId} reagiert nicht (> 20 Min). Sende Rettungs-Push...`);
        await sendPush(targetId, { 
            type: "wakeup", 
            title: "Verbindung prüfen", 
            message: "Automatischer Wiederverbindungs-Versuch" 
        });
      }
    }
  }, 60 * 1000); // Jede Minute prüfen
})();

/* ======================================================
   🌍 API ROUTEN: STANDORT & GERÄTE
====================================================== */
app.post("/location/update", async (req, res) => {
  const { deviceId, lat, lon, speed, battery, accuracy, name, fcmToken, geofenceEvent, isLocked, isMotion, isWifi } = req.body;
  if (!deviceId) return res.sendStatus(400);

  const timestamp = Date.now();
  try {
    const existing = await db.get("SELECT alarmActive FROM devices WHERE deviceId = ? COLLATE NOCASE", [deviceId]);
    const currentAlarm = existing ? existing.alarmActive : 0;

    // Update Device Info
    await db.run(`
      INSERT INTO devices (deviceId, lat, lon, speed, battery, accuracy, name, timestamp, fcmToken, alarmActive, isLocked, isMotion, isWifi)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(deviceId) DO UPDATE SET
        lat=excluded.lat, lon=excluded.lon, speed=excluded.speed, battery=excluded.battery,
        accuracy=excluded.accuracy, name=COALESCE(excluded.name, devices.name),
        timestamp=excluded.timestamp, fcmToken=COALESCE(excluded.fcmToken, devices.fcmToken),
        isLocked=excluded.isLocked, isMotion=excluded.isMotion, isWifi=excluded.isWifi
    `, [deviceId, lat, lon, speed, battery, accuracy, name, timestamp, fcmToken, currentAlarm, isLocked ? 1 : 0, isMotion ? 1 : 0, isWifi ? 1 : 0]);

    if (fcmToken) {
      await db.run(`INSERT INTO device_tokens (deviceId, fcmToken, updatedAt) VALUES (?, ?, ?) ON CONFLICT(deviceId) DO UPDATE SET fcmToken=excluded.fcmToken, updatedAt=excluded.updatedAt`, [deviceId, fcmToken, timestamp]);
    }

    const watchers = activeWatchers.get(deviceId.toLowerCase());
    let watcherName = null;
    if (watchers && watchers.size > 0) {
      const firstId = watchers.values().next().value.toLowerCase();
      const wRow = await db.get("SELECT name FROM devices WHERE deviceId = ? COLLATE NOCASE", [firstId]);
      watcherName = wRow ? (wRow.name || firstId) : "Jemand";
    }

    // Live Broadcast via WebSocket
    broadcast({ 
      deviceId, lat, lon, speed, battery, accuracy, name, timestamp, 
      status: "online", alarmActive: !!currentAlarm, 
      isLocked: !!isLocked, isMotion: !!isMotion, isWifi: !!isWifi, 
      isWatched: !!watchers && watchers.size > 0,
      watcherName: watcherName 
    });

    // Geofence Event Push (FILTERT HEARTBEAT RAUS)
    if (geofenceEvent && geofenceEvent !== "heartbeat") {
      const others = await db.all("SELECT deviceId FROM devices WHERE deviceId != ? COLLATE NOCASE", [deviceId]);
      for (const d of others) {
        await sendPush(d.deviceId, { 
          type: "geofence_event", 
          title: "Zonen-Info", 
          message: `${name || deviceId} hat die Zone ${geofenceEvent}`,
          deviceName: name || deviceId,
          action: geofenceEvent
        });
      }
    }
    res.json({ status: "ok" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/devices", async (req, res) => {
  const rows = await db.all("SELECT * FROM devices");
  const now = Date.now();
  const nameMap = new Map(rows.map(r => [r.deviceId.toLowerCase(), r.name || r.deviceId]));

  res.json(rows.map(d => {
    const targetId = d.deviceId.toLowerCase();
    const watchers = activeWatchers.get(targetId);
    let watcherName = null;
    if (watchers && watchers.size > 0) {
      const firstWatcherId = watchers.values().next().value.toLowerCase();
      watcherName = nameMap.get(firstWatcherId) || "Jemand";
    }
    return {
      ...d,
      alarmActive: d.alarmActive === 1,
      isLocked: d.isLocked === 1 && now - d.timestamp < 150000,
      isMotion: d.isMotion === 1 && now - d.timestamp < 150000,
      isWifi: d.isWifi === 1,
      isWatched: !!watchers && watchers.size > 0,
      watcherName: watcherName,
      status: now - d.timestamp < 24 * 60 * 60 * 1000 ? "online" : "offline"
    };
  }));
});

/* ======================================================
   📍 API ROUTEN: GEOFENCES
====================================================== */
app.get("/geofences", async (req, res) => {
  try {
    const rows = await db.all("SELECT * FROM geofences");
    res.json(rows.map(g => ({
      ...g,
      alarmVibration: g.alarmVibration === 1,
      isHome: g.isHome === 1
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/geofences", async (req, res) => {
  const { id, name, lat, lon, radius, color, createdBy, alarmSound, alarmVibration, isHome } = req.body;
  try {
    await db.run(`
      INSERT INTO geofences (id, name, lat, lon, radius, color, createdBy, alarmSound, alarmVibration, isHome)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, radius=excluded.radius, alarmSound=excluded.alarmSound, alarmVibration=excluded.alarmVibration
    `, [id, name, lat, lon, radius, color, createdBy, alarmSound, alarmVibration ? 1 : 0, isHome ? 1 : 0]);
    res.sendStatus(201);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/geofences/:id", async (req, res) => {
  try {
    await db.run("DELETE FROM geofences WHERE id = ?", [req.params.id]);
    res.sendStatus(200);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ======================================================
   🔔 STEUERUNG: ALARM, WATCH, WAKEUP
====================================================== */

// Manueller Wakeup-Befehl
app.post("/devices/:id/wakeup", async (req, res) => {
    const deviceId = req.params.id.toLowerCase();
    try {
      await sendPush(deviceId, { 
          type: "wakeup", 
          title: "System-Check", 
          message: "Standort-Abfrage erzwungen" 
      });
      res.json({ status: "wakeup_sent" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/devices/:id/alarm", async (req, res) => {
  const deviceId = req.params.id.toLowerCase();
  const { active } = req.query;
  const alarmValue = active === "true" ? 1 : 0;
  try {
    await db.run("UPDATE devices SET alarmActive = ? WHERE deviceId = ? COLLATE NOCASE", [alarmValue, deviceId]);
    await sendPush(deviceId, { type: alarmValue ? "alarm" : "stop_alarm", title: "Alarm-System", message: alarmValue ? "ALARM AUSGELÖST!" : "Alarm beendet." });
    res.sendStatus(200);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/devices/:id/watch", async (req, res) => {
  const targetId = req.params.id.toLowerCase();
  const watcherId = req.query.watcherId;
  if (!watcherId) return res.status(400).json({ error: "watcherId fehlt" });

  if (!activeWatchers.has(targetId)) activeWatchers.set(targetId, new Set());
  activeWatchers.get(targetId).add(watcherId);
  lastWatchActivity.set(targetId, Date.now());

  const watcherRow = await db.get("SELECT name FROM devices WHERE deviceId = ? COLLATE NOCASE", [watcherId.toLowerCase()]);
  const wName = watcherRow ? (watcherRow.name || watcherId) : watcherId;

  await sendPush(targetId, { type: "watch_state", isWatched: "true", watcherName: wName });
  broadcast({ deviceId: targetId, isWatched: true, watcherName: wName });
  res.sendStatus(200);
});

app.post("/devices/:id/unwatch", async (req, res) => {
  const targetId = req.params.id.toLowerCase();
  const watcherId = req.query.watcherId;
  if (activeWatchers.has(targetId)) {
    activeWatchers.get(targetId).delete(watcherId);
    if (activeWatchers.get(targetId).size === 0) {
      activeWatchers.delete(targetId);
      lastWatchActivity.delete(targetId);
      await sendPush(targetId, { type: "watch_state", isWatched: "false" });
      broadcast({ deviceId: targetId, isWatched: false, watcherName: null });
    }
  }
  res.sendStatus(200);
});

/* ======================================================
   🔌 HELPERS (BROADCAST & PUSH)
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
    await admin.messaging().send({ 
        token: device.fcmToken, 
        data: stringData, 
        android: { priority: "high", ttl: 0 } 
    });
  } catch (e) { console.error("❌ Push Error:", e.message); }
}

async function wakeupAllDevicesViaTopic() {
  if (!admin.apps.length) return;
  try {
    await admin.messaging().send({ topic: "all_devices", data: { type: "wakeup" }, android: { priority: "high" } });
  } catch (e) { console.error("❌ Wakeup Error"); }
}/* ======================================================
   🌐 SERVER.JS – VOLLSTÄNDIGE VERSION (Inkl. Auto-Wakeup & Geofences)
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
const activeWatchers = new Map(); // targetId -> Set(watcherId)
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
   🗄 DATENBANK SETUP & TABELLEN
====================================================== */
(async () => {
  db = await open({ filename: "./database.db", driver: sqlite3.Database });

  // Geräte-Tabelle
  await db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      deviceId TEXT PRIMARY KEY COLLATE NOCASE,
      lat REAL, lon REAL, speed REAL, battery INTEGER,
      accuracy REAL, name TEXT, timestamp INTEGER,
      alarmActive INTEGER DEFAULT 0, fcmToken TEXT,
      isLocked INTEGER DEFAULT 0, isMotion INTEGER DEFAULT 0, isWifi INTEGER DEFAULT 0
    )
  `);

  // Token-Tabelle für Push
  await db.exec(`
    CREATE TABLE IF NOT EXISTS device_tokens (
      deviceId TEXT PRIMARY KEY COLLATE NOCASE,
      fcmToken TEXT,
      updatedAt INTEGER
    )
  `);

  // Geofence-Tabelle
  await db.exec(`
    CREATE TABLE IF NOT EXISTS geofences (
      id TEXT PRIMARY KEY,
      name TEXT,
      lat REAL,
      lon REAL,
      radius REAL,
      color INTEGER,
      createdBy TEXT,
      alarmSound TEXT,
      alarmVibration INTEGER DEFAULT 1,
      isHome INTEGER DEFAULT 0
    )
  `);

  console.log("✅ Datenbank bereit.");

  await wakeupAllDevicesViaTopic();

  /* ======================================================
     🕵️‍♂️ SERVER-WATCHDOG (Automatisches Aufwecken)
  ====================================================== */
  setInterval(async () => {
    const now = Date.now();
    const watcherTimeout = 10 * 60 * 1000; // Watcher-Status läuft nach 10 Min Inaktivität ab
    const targetInactivityTimeout = 5 * 60 * 1000; // 5 Minuten Funkstille sind zu viel

    for (const [targetId, lastActive] of lastWatchActivity.entries()) {
      
      // 1. Inaktive Watcher entfernen
      if (now - lastActive > watcherTimeout) {
        activeWatchers.delete(targetId);
        lastWatchActivity.delete(targetId);
        await sendPush(targetId, { type: "watch_state", isWatched: "false" });
        broadcast({ deviceId: targetId, isWatched: false, status: "online" });
        continue;
      }

      // 2. Ziel-Gerät prüfen: Wenn beobachtet, aber stumm -> Wakeup senden
      const device = await db.get("SELECT timestamp FROM devices WHERE deviceId = ? COLLATE NOCASE", [targetId]);
      if (device && (now - device.timestamp > targetInactivityTimeout)) {
        console.log(`⚠️ Gerät ${targetId} ist stumm (>5 Min). Sende Rettungs-Push...`);
        await sendPush(targetId, { 
            type: "wakeup", 
            title: "Verbindung prüfen", 
            message: "Automatischer Wiederverbindungs-Versuch" 
        });
      }
    }
  }, 60 * 1000); // Prüfung jede Minute
})();

/* ======================================================
   🌍 API ROUTEN: STANDORT & GERÄTE
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

    if (fcmToken) {
      await db.run(`INSERT INTO device_tokens (deviceId, fcmToken, updatedAt) VALUES (?, ?, ?) ON CONFLICT(deviceId) DO UPDATE SET fcmToken=excluded.fcmToken, updatedAt=excluded.updatedAt`, [deviceId, fcmToken, timestamp]);
    }

    const watchers = activeWatchers.get(deviceId.toLowerCase());
    let watcherName = null;
    if (watchers && watchers.size > 0) {
      const firstId = watchers.values().next().value.toLowerCase();
      const wRow = await db.get("SELECT name FROM devices WHERE deviceId = ? COLLATE NOCASE", [firstId]);
      watcherName = wRow ? (wRow.name || firstId) : "Jemand";
    }

    broadcast({ 
      deviceId, lat, lon, speed, battery, accuracy, name, timestamp, 
      status: "online", alarmActive: !!currentAlarm, 
      isLocked: !!isLocked, isMotion: !!isMotion, isWifi: !!isWifi, 
      isWatched: !!watchers && watchers.size > 0,
      watcherName: watcherName 
    });

    if (geofenceEvent) {
      const others = await db.all("SELECT deviceId FROM devices WHERE deviceId != ? COLLATE NOCASE", [deviceId]);
      for (const d of others) {
        await sendPush(d.deviceId, { 
          type: "geofence_event", 
          title: "Zonen-Info", 
          message: `${name || deviceId} hat die Zone ${geofenceEvent}`,
          deviceName: name || deviceId,
          action: geofenceEvent
        });
      }
    }
    res.json({ status: "ok" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/devices", async (req, res) => {
  const rows = await db.all("SELECT * FROM devices");
  const now = Date.now();
  const nameMap = new Map(rows.map(r => [r.deviceId.toLowerCase(), r.name || r.deviceId]));

  res.json(rows.map(d => {
    const targetId = d.deviceId.toLowerCase();
    const watchers = activeWatchers.get(targetId);
    let watcherName = null;
    if (watchers && watchers.size > 0) {
      const firstWatcherId = watchers.values().next().value.toLowerCase();
      watcherName = nameMap.get(firstWatcherId) || "Jemand";
    }
    return {
      ...d,
      alarmActive: d.alarmActive === 1,
      isLocked: d.isLocked === 1 && now - d.timestamp < 150000,
      isMotion: d.isMotion === 1 && now - d.timestamp < 150000,
      isWifi: d.isWifi === 1,
      isWatched: !!watchers && watchers.size > 0,
      watcherName: watcherName,
      status: now - d.timestamp < 24 * 60 * 60 * 1000 ? "online" : "offline"
    };
  }));
});

/* ======================================================
   📍 API ROUTEN: GEOFENCES
====================================================== */
app.get("/geofences", async (req, res) => {
  try {
    const rows = await db.all("SELECT * FROM geofences");
    res.json(rows.map(g => ({
      ...g,
      alarmVibration: g.alarmVibration === 1,
      isHome: g.isHome === 1
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/geofences", async (req, res) => {
  const { id, name, lat, lon, radius, color, createdBy, alarmSound, alarmVibration, isHome } = req.body;
  try {
    await db.run(`
      INSERT INTO geofences (id, name, lat, lon, radius, color, createdBy, alarmSound, alarmVibration, isHome)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, radius=excluded.radius, alarmSound=excluded.alarmSound, alarmVibration=excluded.alarmVibration
    `, [id, name, lat, lon, radius, color, createdBy, alarmSound, alarmVibration ? 1 : 0, isHome ? 1 : 0]);
    res.sendStatus(201);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/geofences/:id", async (req, res) => {
  try {
    await db.run("DELETE FROM geofences WHERE id = ?", [req.params.id]);
    res.sendStatus(200);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ======================================================
   🔔 ALARM & WATCH & WAKEUP STEUERUNG
====================================================== */

// Manuelles Aufwecken eines Geräts (für App-Button)
app.post("/devices/:id/wakeup", async (req, res) => {
    const deviceId = req.params.id.toLowerCase();
    try {
      await sendPush(deviceId, { 
          type: "wakeup", 
          title: "System-Check", 
          message: "Standort-Abfrage erzwungen" 
      });
      res.json({ status: "wakeup_sent" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/devices/:id/alarm", async (req, res) => {
  const deviceId = req.params.id.toLowerCase();
  const { active } = req.query;
  const alarmValue = active === "true" ? 1 : 0;
  try {
    await db.run("UPDATE devices SET alarmActive = ? WHERE deviceId = ? COLLATE NOCASE", [alarmValue, deviceId]);
    await sendPush(deviceId, { type: alarmValue ? "alarm" : "stop_alarm", title: "Alarm-System", message: alarmValue ? "ALARM AUSGELÖST!" : "Alarm beendet." });
    res.sendStatus(200);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/devices/:id/watch", async (req, res) => {
  const targetId = req.params.id.toLowerCase();
  const watcherId = req.query.watcherId;
  if (!watcherId) return res.status(400).json({ error: "watcherId fehlt" });

  if (!activeWatchers.has(targetId)) activeWatchers.set(targetId, new Set());
  activeWatchers.get(targetId).add(watcherId);
  lastWatchActivity.set(targetId, Date.now());

  const watcherRow = await db.get("SELECT name FROM devices WHERE deviceId = ? COLLATE NOCASE", [watcherId.toLowerCase()]);
  const wName = watcherRow ? (watcherRow.name || watcherId) : watcherId;

  await sendPush(targetId, { type: "watch_state", isWatched: "true", watcherName: wName });
  broadcast({ deviceId: targetId, isWatched: true, watcherName: wName });
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
      broadcast({ deviceId: targetId, isWatched: false, watcherName: null });
    }
  }
  res.sendStatus(200);
});

/* ======================================================
   🔌 HELPERS (BROADCAST & PUSH)
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
    // High-Priority Push mit TTL 0 (sofortige Zustellung)
    await admin.messaging().send({ 
        token: device.fcmToken, 
        data: stringData, 
        android: { priority: "high", ttl: 0 } 
    });
  } catch (e) { console.error("❌ Push Error:", e.message); }
}

async function wakeupAllDevicesViaTopic() {
  if (!admin.apps.length) return;
  try {
    await admin.messaging().send({ topic: "all_devices", data: { type: "wakeup" }, android: { priority: "high" } });
  } catch (e) { console.error("❌ Wakeup Error"); }
}
