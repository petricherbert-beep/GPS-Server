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
   🔥 FIREBASE INITIALISIERUNG (Mit Auto-Repair)
====================================================== */
try {
  const accountVar = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!accountVar) {
    console.error("❌ FIREBASE_SERVICE_ACCOUNT fehlt!");
  } else {
    let serviceAccount;
    // Prüfen ob Base64 oder JSON
    if (accountVar.trim().startsWith('{')) {
      serviceAccount = JSON.parse(accountVar);
    } else {
      const decoded = Buffer.from(accountVar, 'base64').toString('utf8');
      serviceAccount = JSON.parse(decoded);
    }
    
    // Private Key reparieren
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
      console.log("✅ Firebase Admin erfolgreich initialisiert.");
    }
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
      deviceId TEXT PRIMARY KEY COLLATE NOCASE, 
      name TEXT, 
      lat REAL, 
      lon REAL, 
      timestamp INTEGER, 
      alarmActive INTEGER DEFAULT 0, 
      fcmToken TEXT
    )
  `);
  console.log("✅ SQLite Datenbank bereit.");
})();

/* ======================================================
   🔔 PUSH FUNKTION (Robust & String-Only)
====================================================== */
async function sendPush(targetDeviceId, data) {
  if (!admin.apps.length || !db) return;

  const device = await db.get("SELECT fcmToken FROM devices WHERE deviceId = ? COLLATE NOCASE", [targetDeviceId]);

  if (!device?.fcmToken || device.fcmToken.length < 10) {
    console.log(`⚠️ Kein gültiger Token für ${targetDeviceId}.`);
    return;
  }

  // Alles zu String konvertieren für Firebase
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

  try {
    const response = await admin.messaging().send(message);
    console.log(`🚀 Push erfolgreich gesendet an ${targetDeviceId} | ID: ${response}`);
  } catch (error) {
    console.error(`❌ Push Fehler:`, error.message);
  }
}

/* ======================================================
   🌍 API ROUTEN
====================================================== */

// Standort-Update & Token Registrierung
app.post("/location/update", async (req, res) => {
  const { deviceId, name, fcmToken, lat, lon } = req.body;
  if (!deviceId) return res.sendStatus(400);

  try {
    const timestamp = Date.now();
    const token = (fcmToken && fcmToken.length > 20) ? fcmToken : null;

    await db.run(`
      INSERT INTO devices (deviceId, name, timestamp, fcmToken, lat, lon)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(deviceId) DO UPDATE SET
        name=COALESCE(excluded.name, devices.name),
        timestamp=excluded.timestamp,
        fcmToken=COALESCE(excluded.fcmToken, devices.fcmToken),
        lat=COALESCE(excluded.lat, devices.lat),
        lon=COALESCE(excluded.lon, devices.lon)
    `, [deviceId, name || "Oliver", timestamp, token, lat || 0, lon || 0]);

    broadcast({ deviceId, status: "online", timestamp });
    res.json({ status: "ok" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Liste aller Geräte
app.get("/devices", async (req, res) => {
  try {
    const rows = await db.all("SELECT * FROM devices");
    res.json(rows.map(d => ({
      ...d,
      alarmActive: d.alarmActive === 1,
      status: Date.now() - d.timestamp < 65000 ? "online" : "offline"
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Alarm auslösen (Mit Spam-Schutz)
app.post("/devices/:id/ring", async (req, res) => {
  const id = req.params.id;
  
  // Prüfen ob bereits aktiv
  const device = await db.get("SELECT alarmActive FROM devices WHERE deviceId = ? COLLATE NOCASE", [id]);
  
  if (device && device.alarmActive === 1) {
    console.log(`⚠️ Alarm für ${id} bereits aktiv. Überspringe Push.`);
    return res.status(200).send("Already ringing");
  }

  console.log(`🔔 Starte NEUEN Alarm für: ${id}`);
  await db.run("UPDATE devices SET alarmActive = 1 WHERE deviceId = ? COLLATE NOCASE", [id]);
  
  // Nur diesen einen Push senden
  await sendPush(id, { 
    type: "alarm", 
    alarmActive: "true", 
    title: "ALARM!", 
    message: "Das Gerät wird gesucht!" 
  });
  
  res.sendStatus(200);
});

// Alarm stoppen
app.post("/devices/:id/reset-alarm", async (req, res) => {
  const id = req.params.id;
  console.log(`🛑 Stoppe Alarm für: ${id}`);
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
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(message);
  });
}
