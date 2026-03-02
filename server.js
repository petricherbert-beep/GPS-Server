import express from "express";
import cors from "cors";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import admin from "firebase-admin";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// 🔥 FIREBASE INITIALISIERUNG (Mit Key-Repair)
try {
  const accountVar = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (accountVar) {
    let serviceAccount = JSON.parse(accountVar.trim().startsWith('{') ? accountVar : Buffer.from(accountVar, 'base64').toString('utf8'));
    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n').replace(/^"/, '').replace(/"$/, '');
    }
    if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    console.log("✅ Firebase Admin bereit.");
  }
} catch (e) { console.error("❌ Firebase Fehler:", e.message); }

let db;
(async () => {
  db = await open({ filename: "./database.db", driver: sqlite3.Database });
  await db.exec(`CREATE TABLE IF NOT EXISTS devices (deviceId TEXT PRIMARY KEY COLLATE NOCASE, name TEXT, timestamp INTEGER, alarmActive INTEGER DEFAULT 0, fcmToken TEXT)`);
  console.log("✅ Datenbank bereit.");
})();

// 🔔 PUSH FUNKTION (Mit Log)
async function sendPush(targetDeviceId, data) {
  if (!admin.apps.length || !db) return;
  const device = await db.get("SELECT fcmToken FROM devices WHERE deviceId = ? COLLATE NOCASE", [targetDeviceId]);
  if (!device?.fcmToken) return;

  const stringData = {};
  Object.keys(data).forEach(k => stringData[k] = String(data[k]));

  try {
    await admin.messaging().send({
      token: device.fcmToken,
      data: stringData,
      android: { priority: 'high', ttl: 0 }
    });
    console.log(`🚀 Push tatsächlich gesendet an ${targetDeviceId}`);
  } catch (e) { console.error("❌ Push Fehler:", e.message); }
}

// 🌍 ROUTEN
app.post("/location/update", async (req, res) => {
  const { deviceId, name, fcmToken } = req.body;
  if (!deviceId) return res.sendStatus(400);
  const token = (fcmToken && fcmToken.length > 20) ? fcmToken : null;
  
  // WICHTIG: Hier KEIN sendPush aufrufen! Nur DB Update.
  await db.run(`INSERT INTO devices (deviceId, name, timestamp, fcmToken) VALUES (?, ?, ?, ?) ON CONFLICT(deviceId) DO UPDATE SET name=excluded.name, timestamp=excluded.timestamp, fcmToken=COALESCE(excluded.fcmToken, devices.fcmToken)`, [deviceId, name, Date.now(), token]);
  res.json({ status: "ok" });
});

app.get("/devices", async (req, res) => {
  const rows = await db.all("SELECT * FROM devices");
  res.json(rows.map(d => ({ ...d, alarmActive: d.alarmActive === 1 })));
});

app.post("/devices/:id/ring", async (req, res) => {
  const id = req.params.id;
  
  // PRÜFEN: Ist der Alarm schon aktiv?
  const device = await db.get("SELECT alarmActive FROM devices WHERE deviceId = ?", [id]);
  
  if (device && device.alarmActive === 1) {
    console.log(`⚠️ Alarm für ${id} läuft bereits. Kein neuer Push nötig.`);
    return res.status(200).send("Already ringing");
  }

  console.log(`🔔 Alarm wird NEU aktiviert für: ${id}`);
  await db.run("UPDATE devices SET alarmActive = 1 WHERE deviceId = ? COLLATE NOCASE", [id]);
  
  // Nur diesen EINEN Push senden!
  await sendPush(id, { type: "alarm", alarmActive: "true", title: "ALARM!", message: "Gerät wird gesucht!" });
  res.sendStatus(200);
});

app.post("/devices/:id/reset-alarm", async (req, res) => {
  const id = req.params.id;
  await db.run("UPDATE devices SET alarmActive = 0 WHERE deviceId = ? COLLATE NOCASE", [id]);
  await sendPush(id, { type: "stop_alarm", alarmActive: "false" });
  res.sendStatus(200);
});

app.listen(PORT, () => console.log(`🚀 Server läuft auf Port ${PORT}`));
