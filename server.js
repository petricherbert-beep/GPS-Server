import express from "express";
import cors from "cors";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import admin from "firebase-admin";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ... (Firebase-Initialisierung bleibt gleich)
try {
  const accountVar = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (accountVar) {
    let serviceAccount = JSON.parse(accountVar.trim().startsWith('{') ? accountVar : Buffer.from(accountVar, 'base64').toString('utf8'));
    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n').replace(/^"/, '').replace(/"$/, '');
    }
    if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }
} catch (e) {}

let db;
(async () => {
  db = await open({ filename: "./database.db", driver: sqlite3.Database });
  // NEUES FELD: lastStateChange
  await db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      deviceId TEXT PRIMARY KEY COLLATE NOCASE, 
      name TEXT, 
      timestamp INTEGER, 
      alarmActive INTEGER DEFAULT 0, 
      fcmToken TEXT,
      lastStateChange INTEGER DEFAULT 0 
    )
  `);
})();

// ... (sendPush und andere Routen bleiben gleich)

// Route zum Alarm auslösen (mit Cooldown)
app.post("/devices/:id/ring", async (req, res) => {
  const id = req.params.id;
  const now = Date.now();
  const device = await db.get("SELECT alarmActive, lastStateChange FROM devices WHERE deviceId = ? COLLATE NOCASE", [id]);

  //
