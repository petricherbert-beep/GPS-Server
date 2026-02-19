// server.js – Vollständig kompatibel mit der Android-App
import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Hier werden die Daten gespeichert (im Arbeitsspeicher)
const devices = new Map();

app.get("/", (req, res) => res.json({ status: "Server läuft!" }));

// 1. STANDORT-UPDATE (Empfängt alle Daten vom Handy)
app.post("/location/update", (req, res) => {
  const { deviceId, lat, lon, speed, battery, name, accuracy } = req.body;

  if (!deviceId || lat == null || lon == null) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  // Bestehende Daten behalten (besonders alarmActive), falls vorhanden
  const existing = devices.get(deviceId) || { alarmActive: false };

  devices.set(deviceId, {
    ...existing,
    deviceId,
    lat,
    lon,
    speed,
    battery,
    name,
    accuracy,
    timestamp: Date.now(),
    status: "online"
  });

  res.json({ status: "ok" });
});

// 2. ALARM AUSLÖSEN (Wird von MapActivity aufgerufen)
app.post("/devices/:id/ring", (req, res) => {
  const deviceId = req.params.id;
  const device = devices.get(deviceId) || { deviceId };
  device.alarmActive = true;
  devices.set(deviceId, device);
  console.log(`Alarm aktiviert für: ${deviceId}`);
  res.json({ status: "alarm activated" });
});

// 3. ALARM ZURÜCKSETZEN (Wird vom Handy gerufen, wenn Alarm gestoppt wird)
app.post("/devices/:id/reset-alarm", (req, res) => {
  const deviceId = req.params.id;
  const device = devices.get(deviceId);
  if (device) {
    device.alarmActive = false;
    devices.set(deviceId, device);
  }
  console.log(`Alarm deaktiviert für: ${deviceId}`);
  res.json({ status: "alarm reset" });
});

// 4. EINZELNES GERÄT PRÜFEN (Wird vom LocationService alle 5 Sek. gerufen)
app.get("/devices/:id", (req, res) => {
  const device = devices.get(req.params.id);
  if (!device) return res.status(404).json({ error: "Not found" });
  res.json(device);
});

// 5. LISTE ALLER GERÄTE (Für die Karte)
app.get("/devices", (req, res) => {
  const now = Date.now();
  const list = Array.from(devices.values()).map(d => ({
    ...d,
    status: now - d.timestamp < 60000 ? "online" : "offline"
  }));
  res.json(list);
});

app.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));
