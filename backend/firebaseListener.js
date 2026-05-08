const { initializeApp } = require('firebase/app');
const { getDatabase, ref, onValue } = require('firebase/database');
const SensorData = require('./models/SensorData');

module.exports = function(io) {
  const firebaseConfig = {
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    databaseURL: process.env.FIREBASE_DATABASE_URL,
    projectId: process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.FIREBASE_APP_ID,
    measurementId: process.env.FIREBASE_MEASUREMENT_ID
  };

  const app = initializeApp(firebaseConfig);
  const db = getDatabase(app);
  const sensorRef = ref(db, 'sensorData');

  let lastSavedTime = 0;

  onValue(sensorRef, async (snapshot) => {
    const data = snapshot.val();
    if (data) {
      // Throttle saving to MongoDB to avoid spamming (e.g. max once every 5 seconds)
      const now = Date.now();
      if (now - lastSavedTime > 4000) {
        try {
          const newReading = new SensorData({
            tdsValue: data.tdsValue,
            turbidityVoltage: data.turbidityVoltage,
            waterStatus: data.waterStatus
          });
          await newReading.save();
          lastSavedTime = now;
          
          // Emit the parsed data to React clients
          io.emit('sensor-update', {
            tdsValue: data.tdsValue,
            turbidityVoltage: data.turbidityVoltage,
            waterStatus: data.waterStatus,
            timestamp: newReading.timestamp
          });
        } catch (err) {
          console.error('Error saving firebase data to MongoDB:', err.message);
        }
      }
    }
  });
};
