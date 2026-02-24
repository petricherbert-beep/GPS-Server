// server.js – Vollständig kompatibel mit der Android-App (inkl. Sleep & Ghost Mode)
import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Hier werden die Gerätedaten gespeichert
const devices = new Map();

// Verfolgt, wer gerade wen ansieht (Ghost Mode Logik)
// Key: deviceId (Ziel), Value: Set von deviceIds (Beobachter)
const watchers = new Map();

app.get("/", (req, res) => res.json({ status: "Server läuft!", activeDevices: devices.size }));

// 1. STANDORT-UPDATE
app.post("/location/update", (req, res) => {
  const { deviceId, lat, lon, speed, battery, name, accuracy } = req.body;

  if (!deviceId || lat == null || lon == null) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  // Bestehende Zustände (Sleep/Alarm) beibehalten
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

// 2. ALLE GERÄTE AUFWECKEN (Bei App-Start)
app.post("/devices/wakeup-all", (req, res) => {
  console.log("Wecke alle Geräte auf...");
  for (let [id, device] of devices) {
    device.isAwake = true;
    devices.set(id, device);
  }
  res.json({ status: "all awake" });
});

// 3. GERÄT SCHLAFEN LEGEN
app.post("/devices/:id/sleep", (req, res) => {
  const deviceId = req.params.id;
  const device = devices.get(deviceId);
  if (device) {
    device.isAwake = false;
    devices.set(deviceId, device);
    console.log(`Sleep Mode: ${deviceId}`);
    res.json({ status: "sleeping" });
  } else {
    res.status(404).json({ error: "Device not found" });
  }
});

// 4. BEOBACHTUNG STARTEN (Wenn ich einen Marker anklicke)
app.post("/devices/:id/watch", (req, res) => {
  const targetId = req.params.id;
  const watcherId = req.query.watcherId;
  
  if (!watchers.has(targetId)) {
    watchers.set(targetId, new Set());
  }
  watchers.get(targetId).add(watcherId);
  
  console.log(`Gerät ${watcherId} beobachtet jetzt ${targetId}`);
  res.json({ status: "watching" });
});

// 5. BEOBACHTUNG STOPPEN
app.post("/devices/:id/unwatch", (req, res) => {
  const targetId = req.params.id;
  const watcherId = req.query.watcherId;
  
  if (watchers.has(targetId)) {
    watchers.get(targetId).delete(watcherId);
  }
  
  res.json({ status: "unwatched" });
});

// 6. EINZEL-STATUS PRÜFEN (Wird alle 6s vom Handy gerufen)
app.get("/devices/:id", (req, res) => {
  const deviceId = req.params.id;
  const device = devices.get(deviceId);
  
  if (!device) return res.status(404).json({ error: "Not found" });

  // Prüfen, ob gerade jemand dieses Gerät ansieht
  const isWatched = watchers.has(deviceId) && watchers.get(deviceId).size > 0;

  res.json({
    ...device,
    isWatched: isWatched
  });
});

// 7. LISTE ALLER GERÄTE (Für die Karte)
app.get("/devices", (req, res) => {
  const now = Date.now();
  const list = Array.from(devices.values()).map(d => ({
    ...d,
    status: (now - d.timestamp < 60000) ? "online" : "offline",
    isWatched: watchers.has(d.deviceId) && watchers.get(d.deviceId).size > 0
  }));
  res.json(list);
});

// 8. ALARM ENDPUNKTE
app.post("/devices/:id/ring", (req, res) => {
  const device = devices.get(req.params.id) || { deviceId: req.params.id, isAwake: true };
  device.alarmActive = true;
  devices.set(req.params.id, device);
  res.json({ status: "alarm activated" });
});

app.post("/devices/:id/reset-alarm", (req, res) => {
  const device = devices.get(req.params.id);
  if (device) {
    device.alarmActive = false;
    devices.set(req.params.id, device);
  }
  res.json({ status: "alarm reset" });
});

app.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));
