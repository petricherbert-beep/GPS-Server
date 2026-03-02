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
   🔥 FIREBASE INITIALISIERUNG (Ultimative Lösung)
====================================================== */
try {
  const accountVar = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!accountVar) {
    console.error("❌ Fehler: FIREBASE_SERVICE_ACCOUNT Umgebungsvariable fehlt!");
  } else {
    let serviceAccount;
    
    // Prüfen, ob der Inhalt Base64-kodiert ist oder direktes JSON
    if (accountVar.trim().startsWith('{')) {
      serviceAccount = JSON.parse(accountVar);
      console.log("ℹ️ Firebase: JSON-Format erkannt.");
    } else {
      const decoded = Buffer.from(accountVar, 'base64').toString('utf8');
      serviceAccount = JSON.parse(decoded);
      console.log("ℹ️ Firebase: Base64-Format erkannt und dekodiert.");
    }
    
    // Den Private Key reparieren (Zeilenumbrüche fixen)
    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key
        .replace(/\\n/g, '\n')
        .replace(/^"/, '')
        .replace(/"$/, '');
    }

    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
      console.log("✅ Firebase Admin erfolgreich initialisiert!");
    }
  }
} catch (error) {
  console.error("❌ Kritischer Firebase Fehler:", error.message);
}

/* ======================================================
   🗄 SQLITE DATENBANK (Mit NOCASE Support)
====================================================== */
let db;
(async () => {
  db = await open({ filename: "./database.db", driver: sqlite3.Database });
  
  // Tabelle erstellen mit Case-Insensitive ID
  await db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      deviceId TEXT PRIMARY KEY COLLATE NOCASE, 
      lat REAL, lon REAL, speed REAL, battery INTEGER,
      accuracy REAL, name TEXT, timestamp INTEGER, 
      alarmActive INTEGER DEFAULT 0, fcmToken TEXT
    )
  `);

  // Duplikate bereinigen (nur den neuesten Eintrag pro ID behalten)
  try {
    await db.run("DELETE FROM devices WHERE rowid NOT IN (SELECT max(rowid) FROM devices GROUP BY deviceId COLLATE NOCASE)");
    console.log("✅ Datenbank bereit und bereinigt.");
  } catch (e) { console.log("DB-Info:", e.message); }
})();

/* ======================================================
   🔔 PUSH FUNKTION (Robust & String-Only)
====================================================== */
async function sendPush(targetDeviceId, data) {
  if (!admin.apps.length || !db) {
    console.log("⚠️ Push abgebrochen: Admin oder DB nicht bereit.");
    return;
  }

  // Suche Gerät (ignoriert Groß/Kleinschreibung)
  const device = await db.get("SELECT fcmToken FROM devices WHERE deviceId = ? COLLATE NOCASE", [targetDeviceId]);

  if (!device?.fcmToken || device.fcmToken.length < 10) {
    console.log(`⚠️ Push Fehler: Kein gültiger Token für ${targetDeviceId} gefunden.`);
    return;
  }

  // Firebase Daten-Payload vorbereiten (NUR STRINGS ERLAUBT!)
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

  // Notification-Banner nur bei Nicht-Alarmen (Alarme macht die App selbst)
  if (stringData.type !== 'alarm' && stringData.type !== 'stop_alarm') {
    message.notification = {
      title: stringData.title || "GPS Tracker",
      body: stringData.message || "",
    };
  }

  try {
    const response = await admin.messaging().send(message);
    console.log(`✅ Push gesendet an ${targetDeviceId} | ID: ${response}`);
  } catch (error) {
    console.error(`❌ Firebase Sende-Fehler:`, error.message);
  }
}

/* ======================================================
   🌍 API ROUTEN
====================================================== */

// Standort & Token Update
app.post("/location/update", async (req, res) => {
  let { deviceId, lat, lon, speed, battery, accuracy, name, fcmToken } = req.body;
  if (!deviceId) return res.sendStatus(400);

  const timestamp = Date.now();
  // Token nur speichern, wenn er gültig ist (kein "Warte auf..." Text)
  const validToken = (fcmToken && fcmToken.length > 20) ? fcmToken : null;

  try {
    await db.run(`
      INSERT INTO devices (deviceId, lat, lon, speed, battery, accuracy, name, timestamp, fcmToken)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(deviceId) DO UPDATE SET
        lat=COALESCE(excluded.lat, devices.lat),
        lon=COALESCE(excluded.lon, devices.lon),
        speed=COALESCE(excluded.speed, devices.speed),
        battery=COALESCE(excluded.battery, devices.battery),
        accuracy=COALESCE(excluded.accuracy, devices.accuracy),
        name=COALESCE(excluded.name, devices.name),
        timestamp=excluded.timestamp,
        fcmToken=COALESCE(excluded.fcmToken, devices.fcmToken)
    `, [deviceId, lat || 0, lon || 0, speed || 0, battery || 0, accuracy || 0, name || "Handy", timestamp, validToken]);

    broadcast({ deviceId, status: "online", timestamp });
    res.json({ status: "ok" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Geräteliste
app.get("/devices", async (req, res) => {
  const rows = await db.all("SELECT * FROM devices");
  res.json(rows.map(d => ({
    ...d,
    alarmActive: d.alarmActive === 1,
    status: Date.now() - d.timestamp < 65000 ? "online" : "offline"
  })));
});

// Alarm auslösen
app.post("/devices/:id/ring", async (req, res) => {
  const id = req.params.id;
  await db.run("UPDATE devices SET alarmActive = 1 WHERE deviceId = ? COLLATE NOCASE", [id]);
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
  const id = req.params.id;
  await db.run("UPDATE devices SET alarmActive = 0 WHERE deviceId = ? COLLATE NOCASE", [id]);
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
