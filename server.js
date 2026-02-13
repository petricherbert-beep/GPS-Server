import express from "express";
import admin from "firebase-admin";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ----- Firebase Setup optional -----
let db = null;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: "https://peopletracking-5aad1-default-rtdb.firebaseio.com"
    });

    db = admin.database();
    console.log("Firebase verbunden ✅");
  } catch (err) {
    console.error("Firebase Init Fehler:", err);
  }
} else {
  console.log("Firebase Secret nicht gesetzt. Server läuft ohne DB.");
}

// ----- Devices Map -----
const devices = new Map();

// ----- Routes -----
app.get("/", (req, res) => res.json({ status: "Server läuft!" }));

app.post("/location/update", async (req, res) => {
  const { deviceId, lat, lon, battery, speed, timestamp } = req.body;

  if (!deviceId || lat == null || lon == null) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  const data = { lat, lon, battery, speed, timestamp: timestamp ?? Date.now() };

  devices.set(deviceId, data);

  // Firebase nur, wenn db verfügbar
  if (db) {
    try {
      await db.ref(`devices/${deviceId}`).set(data);
    } catch (err) {
      console.error("Firebase write error:", err);
    }
  }

  res.json({ status: "ok" });
});

app.get("/devices", (req, res) => {
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
