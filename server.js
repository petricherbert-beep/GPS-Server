import express from "express";
import bodyParser from "body-parser";

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

const devices = new Map();

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

app.listen(PORT, () => console.log("Server läuft"));

