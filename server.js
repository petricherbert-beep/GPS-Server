import express from "express";
import admin from "firebase-admin";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ----- Firebase Setup -----
// Ersetze den Pfad zu deinem Service Account JSON
// oder nutze Umgebungsvariable / Render Secrets
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://peopletracking-5aad1-default-rtdb.firebaseio.com"
});

const db = admin.database(); // Für Realtime Database
const devices = new Map();

// ----- Routes -----

// Root
app.get("/", (req, res) => {
  res.json({ status: "Server läuft!" });
});

// GPS-Update
app.post("/location/update", async (req, res) => {
  const { deviceId, lat, lon, battery, speed, timestamp } = req.body;

  if (!deviceId || lat == null || lon == null) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  const data = {
    lat,
    lon,
    battery,
    speed,
    timestamp: timestamp ?? Date.now()
  };

  devices.set(deviceId, data);

  // Firebase speichern
  try {
    await db.ref(`devices/${deviceId}`).set(data);
  } catch (err) {
    console.error("Firebase write error:", err);
  }

  res.json({ status: "ok" });
});

// Geräte abfragen
app.get("/devices", async (req, res) => {
  const now = Date.now();
  const result = Array.from(devices.entries()).map(([id, d]) => ({
    deviceId: id,
    lat: d.lat,
    lon: d.lon,
    battery: d.battery,
    speed: d.speed,
    timestamp: d.timestamp,
    offline: now - d.timestamp > 60000
  }));

  res.json(result);
});

// ----- Start Server -----
app.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));
