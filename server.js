// server.js – Vollständig optimierte Version mit Auto-Sleep & Ghost Mode
import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Datenspeicher im RAM
const devices = new Map();
const watchers = new Map(); // Wer beobachtet wen?

// Zeitstempel der letzten Map-Aktivität
let lastAppActivity = 0;

app.get("/", (req, res) => {
  res.json({ 
    status: "Server läuft!", 
    activeDevices: devices.size,
    appActive: (Date.now() - lastAppActivity) < 65000 
  });
});

// 1. STANDORT-UPDATE (Vom Handy gesendet)
app.post("/location/update", (req, res) => {
  const { deviceId, lat, lon } = req.body;

  if (!deviceId || lat == null || lon == null) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  // Bestehende Zustände (Alarm/Basis-Status) behalten
  const existing = devices.get(deviceId) || { 
    alarmActive: false, 
    isAwake: false // Neue Geräte starten standardmäßig im Sleep Mode
  };

  devices.set(deviceId, {
    ...existing,
    ...req.body,
    timestamp: Date.now(),
    status: "online"
  });

  res.json({ status: "ok" });
});

// 2. ALLE AUFWECKEN (Wird beim App-Start gerufen)
app.post("/devices/wakeup-all", (req, res) => {
  console.log("App wurde geöffnet: Wecke alle Geräte auf.");
  lastAppActivity = Date.now();
  
  for (let [id, device] of devices) {
    device.isAwake = true;
    devices.set(id, device);
  }
  res.json({ status: "all awake" });
});

// 3. EINZEL-GERÄT SCHLAFEN LEGEN
app.post("/devices/:id/sleep", (req, res) => {
  const deviceId = req.params.id;
  const device = devices.get(deviceId);
  if (device) {
    device.isAwake = false;
    devices.set(deviceId, device);
    res.json({ status: "sleeping" });
  } else {
    res.status(404).json({ error: "Device not found" });
  }
});

// 4. BEOBACHTUNG STARTEN (Marker ausgewählt)
app.post("/devices/:id/watch", (req, res) => {
  const targetId = req.params.id;
  const watcherId = req.query.watcherId;
  
  if (!watchers.has(targetId)) {
    watchers.set(targetId, new Set());
  }
  watchers.get(targetId).add(watcherId);
  
  console.log(`${watcherId} beobachtet jetzt ${targetId}`);
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

// 6. STATUS-CHECK (Wird alle 6s vom Handy-Service gerufen)
app.get("/devices/:id", (req, res) => {
  const deviceId = req.params.id;
  const device = devices.get(deviceId);
  
  if (!device) return res.status(404).json({ error: "Not found" });

  // --- SMART AUTO-SLEEP LOGIK ---
  // Ein Gerät ist "aktiv wach", wenn:
  // 1. Die App generell aktiv ist (lastAppActivity < 60s) UND das Gerät auf isAwake steht
  // 2. ODER wenn das Gerät gerade explizit von jemandem beobachtet wird (Marker selektiert)
  
  const appIsActive = (Date.now() - lastAppActivity) < 60000;
  const isWatched = watchers.has(deviceId) && watchers.get(deviceId).size > 0;
  
  const effectiveAwakeState = (device.isAwake && appIsActive) || isWatched;

  res.json({
    ...device,
    isAwake: effectiveAwakeState,
    isWatched: isWatched
  });
});

// 7. LISTE ALLER GERÄTE (Abfrage alle 1.5 - 5s durch die App)
app.get("/devices", (req, res) => {
  // Jede Abfrage der Liste registriert App-Aktivität
  lastAppActivity = Date.now();
  
  const now = Date.now();
  const list = Array.from(devices.values()).map(d => {
    const isWatched = watchers.has(d.deviceId) && watchers.get(d.deviceId).size > 0;
    return {
      ...d,
      status: (now - d.timestamp < 60000) ? "online" : "offline",
      isWatched: isWatched
    };
  });
  res.json(list);
});

// 8. ALARM FUNKTIONEN
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
