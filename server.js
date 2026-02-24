import express from "express";
import cors from "cors";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import admin from "firebase-admin";

// --- FIREBASE INITIALISIERUNG ---
// Lade hier deine serviceAccountKey.json Datei herunter (aus der Firebase Console)
// admin.initializeApp({
//   credential: admin.credential.cert("./serviceAccountKey.json")
// });

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
      name TEXT, timestamp INTEGER, alarmActive INTEGER DEFAULT 0, 
      isAwake INTEGER DEFAULT 1, fcmToken TEXT
    )
  `);
})();

const watchers = new Map();
let lastAppActivity = 0;
const isAppActive = () => (Date.now() - lastAppActivity) < 60000;

// 1. STANDORT-UPDATE & GEOFENCE PUSH
app.post("/location/update", async (req, res) => {
  const { deviceId, lat, lon, speed, battery, accuracy, name, fcmToken, geofenceEvent } = req.body;
  if (!deviceId) return res.sendStatus(400);

  const existing = await db.get("SELECT isAwake, alarmActive FROM devices WHERE deviceId = ?", [deviceId]);
  const currentAwake = existing ? existing.isAwake : 1;
  const currentAlarm = existing ? existing.alarmActive : 0;

  await db.run(`
    INSERT INTO devices (deviceId, lat, lon, speed, battery, accuracy, name, timestamp, isAwake, alarmActive, fcmToken)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(deviceId) DO UPDATE SET
      lat=excluded.lat, lon=excluded.lon, speed=excluded.speed, 
      battery=excluded.battery, accuracy=excluded.accuracy, 
      name=excluded.name, timestamp=excluded.timestamp, fcmToken=excluded.fcmToken
  `, [deviceId, lat, lon, speed, battery, accuracy, name, Date.now(), currentAwake, currentAlarm, fcmToken]);

  // Falls ein Geofence-Event mitgeschickt wurde -> Push an andere
  if (geofenceEvent) {
    sendPushToOthers(deviceId, `${name || deviceId}: ${geofenceEvent}`);
  }

  res.json({ status: "ok" });
});

async function sendPushToOthers(senderId, message) {
  const rows = await db.all("SELECT fcmToken FROM devices WHERE deviceId != ? AND fcmToken IS NOT NULL", [senderId]);
  const tokens = rows.map(r => r.fcmToken);
  
  if (tokens.length > 0) {
    const payload = {
      notification: { title: "Geofence Info", body: message },
      tokens: tokens
    };
    // admin.messaging().sendEachForMulticast(payload).catch(e => console.log("Push Error", e));
    console.log(`Push gesendet an ${tokens.length} Geräte: ${message}`);
  }
}

// ... (Restliche Routen wie zuvor)

app.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));
