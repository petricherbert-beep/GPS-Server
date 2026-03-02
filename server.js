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
   🔥 FIREBASE INITIALISIERUNG (Fix für JWT Signature)
====================================================== */
try {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    console.warn("⚠️ FIREBASE_SERVICE_ACCOUNT Umgebungsvariable fehlt!");
  } else {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    
    // WICHTIG: Ersetzt falsch interpretierte Zeilenumbrüche im Private Key
    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }

    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
      console.log("✅ Firebase Admin erfolgreich initialisiert.");
    }
  }
} catch (error) {
  console.error("❌ Firebase Initialisierung Fehler:", error.message);
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
   🔔 PUSH FUNKTION (Daten-Typen auf String fixiert)
====================================================== */
async function sendPush(targetDeviceId, data) {
  if (!admin.apps.length || !db) return;

  const device = await db.get(
    "SELECT fcmToken FROM devices WHERE deviceId = ?",
    [targetDeviceId]
  );

  if (!device?.fcmToken) {
    console.log(`⚠️ Kein Token für ${targetDeviceId} in DB.`);
    return;
  }

  // WICHTIG: Firebase 'data' Payload darf NUR Strings enthalten
  const stringData = {};
  Object.keys(data).forEach(key => {
    stringData[key] = String(data[key]);
  });

  const message = {
    token: device.fcmToken,
    data: stringData,
    android: {
      priority: 'high',
      ttl: 0,
    }
  };

  // Nur normale Nachrichten bekommen ein Notification-Banner
  // Alarme werden rein über 'data' im Hintergrund der App verarbeitet
  if (stringData.type !== 'alarm' && stringData.type !== 'stop_alarm') {
    message.notification = {
      title: stringData.title || "GPS Tracker",
      body: stringData.message || "",
    };
  }

  try {
    const response = await admin.messaging().send(message);
    console.log(`✅ Push gesendet an ${targetDeviceId} (Typ: ${stringData.type}) | ID: ${response}`);
  } catch (error) {
    console.error(`❌ Push Fehler für ${targetDeviceId}:`, error.message);
  }
}

/* ======================================================
   🌍 ROUTEN
====================================================== */

// Update für Standort und FCM-Token
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
    `, [deviceId, lat || 0, lon || 0, speed || 0, battery || 0, accuracy || 0, name || "Unbekannt", timestamp, currentAwake, currentAlarm, fcmToken]);

    broadcast({ deviceId, lat, lon, speed, battery, accuracy, name, timestamp, status: "online", isAwake: !!currentAwake, alarmActive: !!currentAlarm });

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

// Liste aller Geräte
app.get("/devices", async (req, res) => {
  const rows = await db.all("SELECT * FROM devices");
  const now = Date.now();
  res.json(rows.map(d => ({
    ...d,
    alarmActive: d.alarmActive === 1,
    status: now - d.timestamp < 65000 ? "online" : "offline"
  })));
});

// Alarm auslösen (Klingeln)
app.post("/devices/:id/ring", async (req, res) => {
  const id = req.params.id.toLowerCase();
  await db.run("UPDATE devices SET alarmActive = 1 WHERE deviceId = ?", [id]);
  await sendPush(id, { 
    type: "alarm", 
    alarmActive: "true", 
    title: "ALARM!", 
    message: "Gerät wird gesucht!" 
  });
  res.sendStatus(200);
});

// Alarm stoppen
app.post("/devices/:id/reset-alarm", async (req, res) => {
  const id = req.params.id.toLowerCase();
  await db.run("UPDATE devices SET alarmActive = 0 WHERE deviceId = ?", [id]);
  await sendPush(id, { 
    type: "stop_alarm", 
    alarmActive: "false" 
  });
  res.sendStatus(200);
});

/* ======================================================
   🔌 SERVER & WEBSOCKET
====================================================== */
const server = app.listen(PORT, () => console.log(`🚀 Server läuft auf Port ${PORT}`));
const wss = new WebSocketServer({ server });

function broadcast(data) {
  const message = JSON.stringify(data);
  wss.clients.forEach(client => { if (client.readyState === WebSocket.OPEN) client.send(message); });
}
