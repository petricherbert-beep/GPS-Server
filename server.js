import express from "express";
import cors from "cors";
import sqlite3 from "sqlite3";import { open } from "sqlite";
import admin from "firebase-admin";
import { WebSocketServer, WebSocket } from "ws";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

/* ======================================================
   🔥 FIREBASE INITIALISIERUNG
====================================================== */
try {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    console.warn("⚠️ FIREBASE_SERVICE_ACCOUNT ist nicht gesetzt!");
  } else if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
    });
    console.log("✅ Firebase Admin initialisiert.");
  }
} catch (error) {
  console.error("❌ Firebase Initialisierung fehlgeschlagen:", error.message);
}

/* ======================================================
   🗄 SQLITE DATENBANK
====================================================== */
let db;
(async () => {
  db = await open({ filename: "./database.db", driver: sqlite3.Database });
  await db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      deviceId TEXT PRIMARY KEY, lat REAL, lon REAL, speed REAL, battery INTEGER,
      accuracy REAL, name TEXT, timestamp INTEGER, alarmActive INTEGER DEFAULT 0,
      isAwake INTEGER DEFAULT 1, fcmToken TEXT
    )
  `);
  console.log("✅ SQLite Datenbank bereit.");
})();

/* ======================================================
   🧹 AUTOMATISCHER CLEANUP (Alle 30 Min)
====================================================== */
setInterval(async () => {
  if (!db) return;
  const cutoff = Date.now() - (24 * 60 * 60 * 1000); // 24 Stunden
  try {
    const result = await db.run("DELETE FROM devices WHERE timestamp < ?", [cutoff]);
    if (result.changes > 0) console.log(`🧹 Cleanup: ${result.changes} inaktive Geräte gelöscht.`);
  } catch (err) { console.error("❌ Cleanup Fehler:", err.message); }
}, 30 * 60 * 1000);

const watchers = new Map();
let lastAppActivity = 0;
const isAppActive = () => Date.now() - lastAppActivity < 60000;

/* ======================================================
   🔔 PUSH FUNKTION (Optimiert für Alarme & Hintergrund)
====================================================== */
async function sendPush(targetDeviceId, data) {
  if (!admin.apps.length || !db) return;

  const device = await db.get(
    "SELECT fcmToken FROM devices WHERE deviceId = ?",
    [targetDeviceId]
  );

  if (!device?.fcmToken) {
    console.error(`❌ Kein Token für Gerät ${targetDeviceId} gefunden.`);
    return;
  }

  // WICHTIG: Alle Werte im 'data' Payload MÜSSEN Strings sein!
  const stringData = {};
  Object.keys(data).forEach(key => {
    stringData[key] = String(data[key]); 
  });

  const message = {
    token: device.fcmToken,
    data: stringData, 
    android: {
      priority: 'high', // Erlaubt Zustellung im Hintergrund
      ttl: 0,
    }
  };

  if (stringData.type !== 'alarm' && stringData.type !== 'stop_alarm') {
    message.notification = {
      title: stringData.title || "GPS Tracker",
      body: stringData.message || "",
    };
  }

  try {
    const response = await admin.messaging().send(message);
    console.log(`✅ Push erfolgreich gesendet an ${targetDeviceId}. ID: ${response}`);
  } catch (error) {
    console.error(`❌ Firebase Fehler für ${targetDeviceId}:`, error.message);
  }
}

/* ======================================================
   🌍 ROUTEN
====================================================== */

app.post("/location/update", async (req, res) => {
  let { deviceId, lat, lon, speed, battery, accuracy, name, fcmToken, geofenceEvent } = req.body;
  if (!deviceId) return res.sendStatus(400);
  deviceId = deviceId.toLowerCase();

  try {
    const existing = await db.get("SELECT isAwake, alarmActive FROM devices WHERE deviceId = ?", [deviceId]);
    const currentAwake = existing ? existing.isAwake : 1;
    const currentAlarm = existing ? existing.alarmActive : 0;
    const timestamp = Date.now();

    await db.run(`
      INSERT INTO devices (deviceId, lat, lon, speed, battery, accuracy, name, timestamp, isAwake, alarmActive, fcmToken)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(deviceId) DO UPDATE SET
        lat=excluded.lat, lon=excluded.lon, speed=excluded.speed, battery=excluded.battery,
        accuracy=excluded.accuracy, name=excluded.name, timestamp=excluded.timestamp, fcmToken=excluded.fcmToken
    `, [deviceId, lat, lon, speed, battery, accuracy, name, timestamp, currentAwake, currentAlarm, fcmToken]);

    broadcast({ deviceId, lat, lon, speed, battery, accuracy, name, timestamp, status: "online", isAwake: !!currentAwake, alarmActive: !!currentAlarm });

    // Wenn ein Geofence-Event (betritt/verlässt) vorliegt -> Push an alle anderen
    if (geofenceEvent) {
      const otherDevices = await db.all("SELECT deviceId FROM devices WHERE deviceId != ?", [deviceId]);
      for (const d of otherDevices) {
        await sendPush(d.deviceId, {
          type: "geofence_alert",
          title: "Zonen-Info",
          message: `${name || deviceId} ${geofenceEvent}`
        });
      }
    }
    res.json({ status: "ok" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/devices", async (req, res) => {
  lastAppActivity = Date.now();
  const rows = await db.all("SELECT * FROM devices");
  const now = Date.now();
  res.json(rows.map(d => ({
    ...d,
    alarmActive: d.alarmActive === 1,
    isWatched: watchers.has(d.deviceId) && watchers.get(d.deviceId).size > 0,
    status: now - d.timestamp < 65000 ? "online" : "offline"
  })));
});

app.post("/devices/:id/ring", async (req, res) => {
  const id = req.params.id.toLowerCase();
  await db.run("UPDATE devices SET alarmActive = 1 WHERE deviceId = ?", [id]);
  await sendPush(id, { type: "alarm", title: "ALARM!", message: "Gerät wird gesucht!" });
  res.sendStatus(200);
});

app.post("/devices/:id/reset-alarm", async (req, res) => {
  const id = req.params.id.toLowerCase();
  await db.run("UPDATE devices SET alarmActive = 0 WHERE deviceId = ?", [id]);
  await sendPush(id, { type: "stop_alarm" });
  res.sendStatus(200);
});

app.post("/devices/wakeup-all", async (req, res) => {
  lastAppActivity = Date.now();
  await db.run("UPDATE devices SET isAwake = 1");
  res.json({ status: "all awake" });
});

// ... (Andere Routen wie sleep, watch/unwatch, status bleiben gleich)

const server = app.listen(PORT, () => console.log(`🚀 Server läuft auf Port ${PORT}`));
const wss = new WebSocketServer({ server });

function broadcast(data) {
  const message = JSON.stringify(data);
  wss.clients.forEach(client => { if (client.readyState === WebSocket.OPEN) client.send(message); });
}
