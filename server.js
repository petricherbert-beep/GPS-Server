// server.js (Firebase Teil)
import admin from "firebase-admin";
import { readFile } from 'fs/promises';

// Lade den Service Account Key (Stelle sicher, dass die Datei existiert!)
const serviceAccount = JSON.parse(
  await readFile(new URL('./serviceAccountKey.json', import.meta.url))
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

// ... (Rest der server.js wie zuvor)

async function sendPushToOthers(senderId, message) {
  // Alle Tokens holen, außer vom Absender selbst
  const rows = await db.all("SELECT fcmToken FROM devices WHERE deviceId != ? AND fcmToken IS NOT NULL", [senderId]);
  const tokens = rows.map(r => r.fcmToken);
  
  if (tokens.length > 0) {
    const payload = {
      notification: {
        title: "GPS Geofence Alarm",
        body: message
      }
    };

    // An alle Tokens senden
    tokens.forEach(token => {
      admin.messaging().send({
        token: token,
        notification: payload.notification
      }).catch(err => console.log("Push Error für Token:", token, err.message));
    });
    
    console.log(`Push an ${tokens.length} Geräte gesendet: ${message}`);
  }
}
