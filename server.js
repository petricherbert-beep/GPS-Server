// server.js – Vollständig kompatibel mit der Android-App inkl. Sleep-Modus
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

  // Bestehende Daten behalten (isAwake, alarmActive), falls vorhanden
  const existing = devices.get(deviceId) || { alarmActive: false, isAwake: true };

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

// 2. ALLE GERÄTE AUFWECKEN (Wird beim App-Start oder "Zoom All" gerufen)
app.post("/devices/wakeup-all", (req, res) => {
  console.log("Wecke alle Geräte auf...");
  for (let [id, device] of devices) {
    device.isAwake = true;
    devices.set(id, device);
  }
  res.json({ status: "all awake" });
});

// 3. EINZELNES GERÄT SCHLAFEN LEGEN (Wird nach 10s Inaktivität gerufen)
app.post("/devices/:id/sleep", (req, res) => {
  const deviceId = req.params.id;
  const device = devices.get(deviceId);
  if (device) {
    device.isAwake = false;
    devices.set(deviceId, device);
    console.log(`Sleep Mode aktiviert für: ${deviceId}`);
    res.json({ status: "sleeping" });
  } else {
    res.status(404).json({ error: "Device not found" });
  }
});

// 4. ALARM AUSLÖSEN
app.post("/devices/:id/ring", (req, res) => {
  const deviceId = req.params.id;
  const device = devices.get(deviceId) || { deviceId, isAwake: true };
  device.alarmActive = true;
  devices.set(deviceId, device);
  console.log(`Alarm aktiviert für: ${deviceId}`);
  res.json({ status: "alarm activated" });
});

// 5. ALARM ZURÜCKSETZEN
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

// 6. EINZELNES GERÄT PRÜFEN (Abfrage vom Handy: "Soll ich aufwachen/schlafen/klingeln?")
app.get("/devices/:id", (req, res) => {
  const device = devices.get(req.params.id);
  if (!device) return res.status(404).json({ error: "Not found" });
  res.json(device);
});

// 7. LISTE ALLER GERÄTE (Für die Kartenanzeige)
app.get("/devices", (req, res) => {
  const now = Date.now();
  const list = Array.from(devices.values()).map(d => ({
    ...d,
    // Offline markieren, wenn länger als 60s kein Update kam
    status: (now - d.timestamp < 60000) ? "online" : "offline"
  }));
  res.json(list);
});

app.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));
