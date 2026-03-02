import express from "express";
import cors from "cors";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import admin from "firebase-admin";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

/* ======================================================
   🔥 FIREBASE INITIALISIERUNG
====================================================== */
try {
  const accountVar = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (accountVar) {
    let serviceAccount = JSON.parse(accountVar.trim().startsWith('{') ? accountVar : Buffer.from(accountVar, 'base64').toString('utf8'));
    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n').replace(/^"/, '').replace(/"$/, '');
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
      timestamp INTEGER, 
      alarmActive INTEGER DEFAULT 0, 
      fcmToken TEXT
    )
  `);
  console.log("✅ SQLite Datenbank bereit.");
})();

/* ======================================================
   🔔 PUSH FUNKTION
====================================================== */
async function sendPush(targetDeviceId, data) {
  if (!admin.apps.length || !db) return;
  
  const device = await db.get("SELECT fcmToken FROM devices WHERE deviceId = ? COLLATE NOCASE", [targetDeviceId]);
  if (!device?.fcmToken || device.fcmToken.length < 10) return;

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

app.post("/location/update", async (req, res) => {
  const { deviceId, name, fcmToken } = req.body;
  if (!deviceId) return res.sendStatus(400);

  const timestamp = Date.now();
  const token = (fcmToken && fcmToken.length > 20) ? fcmToken : null;

  try {
    await db.run(`
      INSERT INTO devices (deviceId, name, timestamp, fcmToken)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(deviceId) DO UPDATE SET
        name=COALESCE(excluded.name, devices.name),
        timestamp=excluded.timestamp,
        fcmToken=COALESCE(excluded.fcmToken, devices.fcmToken)
    `, [deviceId, name || "Oliver", timestamp, token]);

    res.json({ status: "ok" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

app.post("/devices/:id/ring", async (req, res) => {
  const id = req.params.id;
  const device = await db.get("SELECT alarmActive FROM devices WHERE deviceId = ? COLLATE NOCASE", [id]);
  
  if (device && device.alarmActive === 1) {
    console.log(`⚠️ Alarm für ${id} bereits aktiv.`);
    return res.status(200).send("Already ringing");
  }

  console.log(`🔔 Starte Alarm für: ${id}`);
  await db.run("UPDATE devices SET alarmActive = 1 WHERE deviceId = ? COLLATE NOCASE", [id]);
  await sendPush(id, { type: "alarm", alarmActive: "true", title: "ALARM!", message: "Gerät wird gesucht!" });
  res.sendStatus(200);
});

app.post("/devices/:id/reset-alarm", async (req, res) => {
  const id = req.params.id;
  const device = await db.get("SELECT alarmActive FROM devices WHERE deviceId = ? COLLATE NOCASE", [id]);

  if (!device || device.alarmActive === 0) {
    // Wenn der Alarm schon aus ist, machen wir nichts (verhindert Endlosschleife)
    return res.status(200).send("Already stopped");
  }

  console.log(`🛑 Stoppe Alarm für: ${id}`);
  await db.run("UPDATE devices SET alarmActive = 0 WHERE deviceId = ? COLLATE NOCASE", [id]);
  await sendPush(id, { type: "stop_alarm", alarmActive: "false" });
  res.sendStatus(200);
});

app.listen(PORT, () => console.log(`🚀 Server läuft auf Port ${PORT}`));
