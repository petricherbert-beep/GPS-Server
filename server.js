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

/* ======================================================
   🔥 FIREBASE INITIALISIERUNG (Robust für Render/Heroku)
====================================================== */
try {
  const accountVar = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (accountVar && !admin.apps.length) {
    let serviceAccount;
    const trimmed = accountVar.trim();
    if (trimmed.startsWith('{')) {
        serviceAccount = JSON.parse(trimmed);
    } else {
        serviceAccount = JSON.parse(Buffer.from(trimmed, 'base64').toString('utf8'));
    }
    
    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n').replace(/^"/, '').replace(/"$/, '');
    }
    
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log("✅ Firebase Admin initialisiert.");
  }
} catch (error) {
  console.error("❌ Firebase Fehler:", error.message);
}

/* ======================================================
   🗄 SQLITE DATENBANK (Mit allen Tracking-Feldern)
====================================================== */
let db;
(async () => {
  db = await open({ filename: "./database.db", driver: sqlite3.Database });
  await db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      deviceId TEXT PRIMARY KEY COLLATE NOCASE, 
      lat REAL, lon REAL, speed REAL, battery INTEGER,
      accuracy REAL, name TEXT, timestamp INTEGER, 
      alarmActive INTEGER DEFAULT 0, isAwake INTEGER DEFAULT 1, 
      fcmToken TEXT
    )
  `);
  console.log("✅ SQLite Datenbank bereit.");
})();

/* ======================================================
   🔔 PUSH FUNKTION (Daten-optimiert)
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

  // Benachrichtigung nur für Geofence, nicht für stille Befehle (Alarm/Stop)
  if (!['alarm', 'stop_alarm', 'wakeup'].includes(data.type)) {
    message.notification = { title: data.title ?? "GPS Tracker", body: data.message ?? "" };
  }

  try {
    await admin.messaging().send(message);
    console.log(`🚀 Push an ${targetDeviceId} gesendet (${data.type})`);
  } catch (error) { console.error("❌ Push Fehler:", error.message); }
}

/* ======================================================
   🌍 API ROUTEN
====================================================== */

// WICHTIG: Speichert jetzt alle Koordinaten wieder!
app.post("/location/update", async (req, res) => {
  let { deviceId, lat, lon, speed, battery, accuracy, name, fcmToken, geofenceEvent } = req.body;
  if (!deviceId) return res.sendStatus(400);

  const timestamp = Date.now();
  try {
    const existing = await db.get("SELECT isAwake, alarmActive FROM devices WHERE deviceId = ? COLLATE NOCASE", [deviceId]);
    const currentAwake = existing ? existing.isAwake : 1;
    const currentAlarm = existing ? existing.alarmActive : 0;

    await db.run(`
      INSERT INTO devices (deviceId, lat, lon, speed, battery, accuracy, name, timestamp, isAwake, alarmActive, fcmToken)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(deviceId) DO UPDATE SET
        lat=excluded.lat, lon=excluded.lon, speed=excluded.speed, battery=excluded.battery,
        accuracy=excluded.accuracy, name=COALESCE(excluded.name, devices.name), 
        timestamp=excluded.timestamp, fcmToken=COALESCE(excluded.fcmToken, devices.fcmToken)
    `, [deviceId, lat, lon, speed, battery, accuracy, name, timestamp, currentAwake, currentAlarm, fcmToken]);

    // Sofortige Aktualisierung für die Karte via WebSocket
    broadcast({ deviceId, lat, lon, speed, battery, accuracy, name, timestamp, status: "online", isAwake: !!currentAwake, alarmActive: !!currentAlarm });

    if (geofenceEvent) {
      const otherDevices = await db.all("SELECT deviceId FROM devices WHERE deviceId != ? COLLATE NOCASE", [deviceId]);
      for (const d of otherDevices) {
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
    isAwake: d.isAwake === 1,
    status: now - d.timestamp < 65000 ? "online" : "offline"
  })));
});

app.post("/devices/:id/ring", async (req, res) => {
  const id = req.params.id;
  await db.run("UPDATE devices SET alarmActive = 1 WHERE deviceId = ? COLLATE NOCASE", [id]);
  await sendPush(id, { type: "alarm", title: "ALARM!", message: "Gerät wird gesucht!" });
  res.sendStatus(200);
});

app.post("/devices/:id/reset-alarm", async (req, res) => {
  const id = req.params.id;
  await db.run("UPDATE devices SET alarmActive = 0 WHERE deviceId = ? COLLATE NOCASE", [id]);
  await sendPush(id, { type: "stop_alarm" });
  res.sendStatus(200);
});

const server = app.listen(PORT, () => console.log(`🚀 Server läuft auf Port ${PORT}`));
const wss = new WebSocketServer({ server });

function broadcast(data) {
  const message = JSON.stringify(data);
  wss.clients.forEach(client => { if (client.readyState === WebSocket.OPEN) client.send(message); });
}
