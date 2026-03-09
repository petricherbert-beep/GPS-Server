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

// Speichert, welches Gerät gerade von wem beobachtet wird
// Map<targetDeviceId, Set<watcherDeviceId>>
const activeWatchers = new Map();
// NEU: Speichert den Zeitstempel der letzten Watch-Aktivität
const lastWatchActivity = new Map();

/* ======================================================
   🔥 FIREBASE INITIALISIERUNG
====================================================== */
try {
  const accountVar = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (accountVar && !admin.apps.length) {
    let serviceAccount = JSON.parse(accountVar.trim().startsWith('{') ? accountVar : Buffer.from(accountVar, 'base64').toString('utf8'));
    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n').replace(/^"/, '').replace(/"$/, '');
    }
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    console.log("✅ Firebase Admin initialisiert.");
  }
} catch (error) { console.error("❌ Firebase Fehler:", error.message); }

/* ======================================================
   🗄 SQLITE DATENBANK & STARTUP LOGIK
====================================================== */
let db;
(async () => {
  db = await open({ filename: "./database.db", driver: sqlite3.Database });
  await db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      deviceId TEXT PRIMARY KEY COLLATE NOCASE, 
      lat REAL, lon REAL, speed REAL, battery INTEGER,
      accuracy REAL, name TEXT, timestamp INTEGER, 
      alarmActive INTEGER DEFAULT 0, fcmToken TEXT
    )
  `);
  console.log("✅ Datenbank bereit.");

  // STARTUP PUSH
  await wakeupAllDevicesViaTopic();
  
  // Cleanup-Job für inaktive Geräte: Alle 60 Minuten (älter als 12h löschen)
  setInterval(async () => {
    if (!db) return;
    const oneDayAgo = Date.now() - (12 * 60 * 60 * 1000);
    try {
      const result = await db.run("DELETE FROM devices WHERE timestamp < ?", [oneDayAgo]);
      if (result.changes > 0) {
        console.log(`🧹 Cleanup: ${result.changes} inaktive Geräte gelöscht.`);
      }
    } catch (err) { console.error("❌ Cleanup Fehler:", err.message); }
  }, 60 * 60 * 1000);

  // NEU: Cleanup-Job für isWatched (Timeout nach 10 Minuten Inaktivität)
  setInterval(async () => {
    const now = Date.now();
    const timeout = 10 * 60 * 1000; // 10 Minuten

    for (const [targetId, lastActive] of lastWatchActivity.entries()) {
      if (now - lastActive > timeout) {
        console.log(`⏱️ Timeout: ${targetId} wird nicht mehr beobachtet (10 Min Inaktivität).`);
        
        activeWatchers.delete(targetId);
        lastWatchActivity.delete(targetId);

        // Handy informieren (Push)
        await sendPush(targetId, { type: "watch_state", isWatched: "false" });

        // Alle WebSockets informieren (Auge-Symbol auf Karten entfernen)
        broadcast({ 
          deviceId: targetId, 
          isWatched: false,
          status: "online" 
        });
      }
    }
  }, 60 * 1000); // Check jede Minute

})();

/* ======================================================
   🔔 PUSH FUNKTIONEN
====================================================== */

async function sendPush(targetDeviceId, data) {
  if (!admin.apps.length || !db) return;
  const device = await db.get("SELECT fcmToken FROM devices WHERE deviceId = ? COLLATE NOCASE", [targetDeviceId]);
  if (!device?.fcmToken || device.fcmToken.length < 10) return;

  const stringData = {};
  Object.keys(data).forEach(key => { stringData[key] = String(data[key]); });

  const message = {
    token: device.fcmToken,
    data: stringData,
    android: { priority: 'high', ttl: 0 }
  };

  if (data.type === 'geofence_alert') {
    message.notification = { title: data.title, body: data.message };
  }

  try {
    await admin.messaging().send(message);
    console.log(`🚀 Push an ${targetDeviceId} gesendet (${data.type})`);
  } catch (error) { console.error(`❌ Push Fehler (${targetDeviceId}):`, error.message); }
}

async function wakeupAllDevicesViaTopic() {
  if (!admin.apps.length) return;
  try {
    const message = {
      topic: "all_devices",
      data: { type: "wakeup" },
      android: { priority: 'high' }
    };
    await admin.messaging().send(message);
    console.log("📣 Globaler Wakeup-Push an Topic 'all_devices' gesendet.");
  } catch (error) { console.error("❌ Topic-Push Fehler:", error.message); }
}

/* ======================================================
   🌍 API ROUTEN
====================================================== */

app.post("/location/update", async (req, res) => {
  const { deviceId, lat, lon, speed, battery, accuracy, name, fcmToken, geofenceEvent } = req.body;
  if (!deviceId) return res.sendStatus(400);

  const timestamp = Date.now();
  try {
    const existing = await db.get("SELECT alarmActive FROM devices WHERE deviceId = ? COLLATE NOCASE", [deviceId]);
    const currentAlarm = existing ? existing.alarmActive : 0;

    await db.run(`
      INSERT INTO devices (deviceId, lat, lon, speed, battery, accuracy, name, timestamp, fcmToken, alarmActive)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(deviceId) DO UPDATE SET
        lat=excluded.lat, lon=excluded.lon, speed=excluded.speed, battery=excluded.battery,
        accuracy=excluded.accuracy, name=COALESCE(excluded.name, devices.name), 
        timestamp=excluded.timestamp, fcmToken=COALESCE(excluded.fcmToken, devices.fcmToken)
    `, [deviceId, lat, lon, speed, battery, accuracy, name, timestamp, fcmToken, currentAlarm]);

    broadcast({ 
      deviceId, lat, lon, speed, battery, accuracy, name, timestamp, 
      status: "online", 
      alarmActive: !!currentAlarm,
      isWatched: activeWatchers.has(deviceId.toLowerCase())
    });

    if (geofenceEvent) {
      const others = await db.all("SELECT deviceId FROM devices WHERE deviceId != ? COLLATE NOCASE", [deviceId]);
      for (const d of others) {
        await sendPush(d.deviceId, { type: "geofence_alert", title: "Zonen-Info", message: `${name || deviceId} ${geofenceEvent}` });
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
    isWatched: activeWatchers.has(d.deviceId.toLowerCase()),
    status: now - d.timestamp < 1500000 ? "online" : "offline"
  })));
});

app.post("/devices/:id/watch", async (req, res) => {
  const targetId = req.params.id.toLowerCase();
  const watcherId = req.query.watcherId;
  
  if (!activeWatchers.has(targetId)) activeWatchers.set(targetId, new Set());
  activeWatchers.get(targetId).add(watcherId);
  
  // Zeitstempel für dieses Gerät aktualisieren
  lastWatchActivity.set(targetId, Date.now());
  
  await sendPush(targetId, { type: "watch_state", isWatched: "true" });
  res.sendStatus(200);
});

app.post("/devices/:id/unwatch", async (req, res) => {
  const targetId = req.params.id.toLowerCase();
  const watcherId = req.query.watcherId;
  
  if (activeWatchers.has(targetId)) {
    activeWatchers.get(targetId).delete(watcherId);
    if (activeWatchers.get(targetId).size === 0) {
      activeWatchers.delete(targetId);
      lastWatchActivity.delete(targetId); // Auch Zeitstempel löschen
      await sendPush(targetId, { type: "watch_state", isWatched: "false" });
    }
  }
  res.sendStatus(200);
});

// ... (Restliche Routen wie /ring, /reset-alarm identisch)
app.post("/devices/:id/ring", async (req, res) => {
  const id = req.params.id;
  await db.run("UPDATE devices SET alarmActive = 1 WHERE deviceId = ? COLLATE NOCASE", [id]);
  await sendPush(id, { type: "alarm" });
  res.sendStatus(200);
});

app.post("/devices/:id/reset-alarm", async (req, res) => {
  const id = req.params.id;
  const device = await db.get("SELECT alarmActive FROM devices WHERE deviceId = ? COLLATE NOCASE", [id]);
  if (!device || device.alarmActive === 0) return res.status(200).send("Already stopped");
  await db.run("UPDATE devices SET alarmActive = 0 WHERE deviceId = ? COLLATE NOCASE", [id]);
  await sendPush(id, { type: "stop_alarm" });
  res.sendStatus(200);
});

/* ======================================================
   🔌 SERVER & WEBSOCKET
====================================================== */
const server = app.listen(PORT, () => console.log(`🚀 Server läuft auf Port ${PORT}`));
const wss = new WebSocketServer({ server });

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}
