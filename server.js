// server.js – Fertig für Render

import express from "express";
import cors from "cors";  // <-- für CORS

const app = express();

// ----- Middleware -----
app.use(cors());        // erlaubt Fetch von localhost / anderer Domains
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ----- Geräte-Map -----
const devices = new Map();

// ----- Test-Route -----
app.get("/", (req, res) => {
  res.json({ status: "Server läuft!" });
});

// ----- POST: Standort aktualisieren -----
app.post("/location/update", (req, res) => {
  const { deviceId, lat, lon, speed, battery } = req.body;

  if (!deviceId || lat == null || lon == null) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  const timestamp = Date.now();
  devices.set(deviceId, { lat, lon, speed, battery, timestamp, status: "online" });

  console.log(`Update: ${deviceId} => lat:${lat} lon:${lon} speed:${speed}`);

  res.json({ status: "ok" });
});

// ----- GET: Alle Geräte abrufen -----
app.get("/devices", (req, res) => {
  const now = Date.now();
  const list = Array.from(devices.entries()).map(([id, d]) => ({
    deviceId: id,
    lat: d.lat,
    lon: d.lon,
    speed: d.speed,
    battery: d.battery,
    status: now - d.timestamp < 60000 ? "online" : "offline",
    timestamp: d.timestamp
  }));
  res.json(list);
});

// ----- Server starten -----
app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});
