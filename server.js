import express from "express";
import cors from "cors";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import admin from "firebase-admin";
import { WebSocketServer, WebSocket } from "ws"; // NEU: WebSocket Import

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
      credential: admin.credential.cert(
        JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
      ),
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
  db = await open({
    filename: "./database.db",
    driver: sqlite3.Database,
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      deviceId TEXT PRIMARY KEY,
      lat REAL,
      lon REAL,
      speed REAL,
      battery INTEGER,
      accuracy REAL,
      name TEXT,
      timestamp INTEGER,
      alarmActive INTEGER DEFAULT 0,
      isAwake INTEGER DEFAULT 1,
      fcmToken TEXT
    )
  `);

  console.log("✅ SQLite Datenbank bereit.");
})();

/* ======================================================
   🧹 AUTOMATISCHER CLEANUP (Alle 30 Min)
   Löscht Geräte, die älter als 24 Stunden sind.
====================================================== */

setInterval(async () => {
  if (!db) return;
  const cutoff = Date.now() - (24 * 60 * 60 * 1000);
  try {
    const result = await db.run("DELETE FROM devices WHERE timestamp < ?", [cutoff]);
    if (result.changes > 0) {
      console.log(`🧹 Cleanup: ${result.changes} inaktive Geräte gelöscht.`);
    }
  } catch (err) {
    console.error("❌ Cleanup Fehler:", err.message);
  }
}, 30 * 60 * 1000);

/* ======================================================
   👀 GHOST MODE & APP STATUS
====================================================== */

const watchers = new Map();
let lastAppActivity = 0;

const isAppActive = () => Date.now() - lastAppActivity < 60000;

/* ======================================================
   🔔 PUSH FUNKTION
====================================================== */

async function sendPush(targetDeviceId, data) {
  if (!admin.apps.length || !db) return;

  const device = await db.get(
    "SELECT fcmToken FROM devices WHERE deviceId = ?",
    [targetDeviceId]
  );

  if (!device?.fcmToken) return;

  try {
    await admin.messaging().send({
      token: device.fcmToken,
      data,
      notification: {
        title: data.title ?? "",
        body: data.message ?? "",
      },
    });
  } catch (error) {
    console.log("Push Fehler:", error.message);
  }
}

/* ======================================================
   🌍 ROUTEN
====================================================== */

app.get("/", (req, res) => {
  res.json({ status: "Server läuft!", appActive: isAppActive(), wsActive: true });
});

/* ------------------------------
   1️⃣ LOCATION UPDATE (Mit Broadcast)
------------------------------ */

app.post("/location/update", async (req, res) => {
  let {
    deviceId,
    lat,
    lon,
    speed,
    battery,
    accuracy,
    name,
    fcmToken,
    geofenceEvent,
  } = req.body;

  if (!deviceId) return res.sendStatus(400);
  deviceId = deviceId.toLowerCase();

  try {
    const existing = await db.get(
      "SELECT isAwake, alarmActive FROM devices WHERE deviceId = ?",
      [deviceId]
    );

    const currentAwake = existing ? existing.isAwake : 1;
    const currentAlarm = existing ? existing.alarmActive : 0;
    const timestamp = Date.now();

    await db.run(
      `
      INSERT INTO devices (
        deviceId, lat, lon, speed, battery, accuracy,
        name, timestamp, isAwake, alarmActive, fcmToken
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(deviceId) DO UPDATE SET
        lat=excluded.lat,
        lon=excluded.lon,
        speed=excluded.speed,
        battery=excluded.battery,
        accuracy=excluded.accuracy,
        name=excluded.name,
        timestamp=excluded.timestamp,
        fcmToken=excluded.fcmToken
    `,
      [
        deviceId,
        lat,
        lon,
        speed,
        battery,
        accuracy,
        name,
        timestamp,
        currentAwake,
        currentAlarm,
        fcmToken,
      ]
    );

    // ECHTZEIT BROADCAST AN ALLE APPS
    broadcast({
        deviceId, lat, lon, speed, battery, accuracy, name, timestamp,
        status: "online",
        isAwake: !!currentAwake,
        alarmActive: !!currentAlarm
    });

    if (geofenceEvent) {
      const rows = await db.all(
        "SELECT deviceId FROM devices WHERE deviceId != ?",
        [deviceId]
      );

      for (const r of rows) {
        await sendPush(r.deviceId, {
          type: "geofence",
          title: "Geofence Info",
          message: `${name || deviceId}: ${geofenceEvent}`,
        });
      }
    }

    res.json({ status: "ok" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ------------------------------
   2️⃣ WAKEUP ALL
------------------------------ */

app.post("/devices/wakeup-all", async (req, res) => {
  lastAppActivity = Date.now();
  await db.run("UPDATE devices SET isAwake = 1");
  res.json({ status: "all awake" });
});

/* ------------------------------
   3️⃣ SLEEP DEVICE
------------------------------ */

app.post("/devices/:id/sleep", async (req, res) => {
  await db.run("UPDATE devices SET isAwake = 0 WHERE deviceId = ?", [
    req.params.id.toLowerCase(),
  ]);
  res.json({ status: "sleeping" });
});

/* ------------------------------
   4️⃣ WATCH / UNWATCH
------------------------------ */

app.post("/devices/:id/watch", (req, res) => {
  const targetId = req.params.id.toLowerCase();
  const watcherId = req.query.watcherId?.toLowerCase();

  if (!watchers.has(targetId)) watchers.set(targetId, new Set());
  if (watcherId) watchers.get(targetId).add(watcherId);

  res.json({ status: "watching" });
});

app.post("/devices/:id/unwatch", (req, res) => {
  const targetId = req.params.id.toLowerCase();
  if (watchers.has(targetId)) {
    watchers.get(targetId).delete(req.query.watcherId?.toLowerCase());
  }
  res.json({ status: "unwatched" });
});

/* ------------------------------
   5️⃣ STATUS CHECK
------------------------------ */

app.get("/devices/:id", async (req, res) => {
  const deviceId = req.params.id.toLowerCase();
  const device = await db.get(
    "SELECT * FROM devices WHERE deviceId = ?",
    [deviceId]
  );

  if (!device) return res.status(404).send("Not found");

  const isWatched =
    watchers.has(deviceId) && watchers.get(deviceId).size > 0;

  const effectiveAwake =
    (device.isAwake === 1 && isAppActive()) || isWatched;

  res.json({
    ...device,
    alarmActive: device.alarmActive === 1,
    isAwake: !!effectiveAwake,
    isWatched: !!isWatched,
  });
});

/* ------------------------------
   6️⃣ DEVICE LIST
------------------------------ */

app.get("/devices", async (req, res) => {
  lastAppActivity = Date.now();
  const rows = await db.all("SELECT * FROM devices");
  const now = Date.now();

  res.json(
    rows.map((d) => ({
      ...d,
      alarmActive: d.alarmActive === 1,
      isWatched:
        watchers.has(d.deviceId) &&
        watchers.get(d.deviceId).size > 0,
      status: now - d.timestamp < 65000 ? "online" : "offline",
    }))
  );
});

/* ------------------------------
   7️⃣ ALARM
------------------------------ */

app.post("/devices/:id/ring", async (req, res) => {
  const deviceId = req.params.id.toLowerCase();

  await db.run(
    "UPDATE devices SET alarmActive = 1 WHERE deviceId = ?",
    [deviceId]
  );

  await sendPush(deviceId, {
    type: "alarm",
    title: "ALARM!",
    message: "Dein Gerät wird gesucht!",
  });

  res.sendStatus(200);
});

app.post("/devices/:id/reset-alarm", async (req, res) => {
  await db.run(
    "UPDATE devices SET alarmActive = 0 WHERE deviceId = ?",
    [req.params.id.toLowerCase()]
  );

  res.sendStatus(200);
});

/* ======================================================
   🚀 SERVER START & WEBSOCKET BROADCAST
====================================================== */

const server = app.listen(PORT, () =>
  console.log(`🚀 Server läuft auf Port ${PORT}`)
);

const wss = new WebSocketServer({ server });

function broadcast(data) {
  const message = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}
