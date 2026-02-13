import express from "express";

const app = express();
app.use(express.json()); // bodyParser nicht mehr nötig, Express hat built-in

const PORT = process.env.PORT || 3000;

const devices = new Map();

// GPS-Update Route
app.post("/location/update", (req, res) => {
  const { deviceId, lat, lon, battery, speed, timestamp } = req.body;

  if (!deviceId || lat == null || lon == null) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  devices.set(deviceId, {
    lat,
    lon,
    battery,
    speed,
    timestamp: timestamp ?? Date.now()
  });

  res.json({ status: "ok" });
});

// Liste aller Geräte
app.get("/devices", (req, res) => {
  const now = Date.now();
  const result = Array.from(devices.entries()).map(([id, d]) => ({
    deviceId: id,
    lat: d.lat,
    lon: d.lon,
    battery: d.battery,
    speed: d.speed,
    timestamp: d.timestamp,
    offline: now - d.timestamp > 60000 // offline, wenn > 1 min kein Update
  }));
  res.json(result);
});

// Test-Route
app.get("/", (req, res) => {
  res.send("Server läuft!");
});

// Server starten
app.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));
