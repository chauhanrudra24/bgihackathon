const { initializeApp } = require('firebase/app');
const { getDatabase, ref, onValue } = require('firebase/database');
const mongoose = require('mongoose');
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
      console.log('📡 Firebase Update Received:', new Date().toLocaleTimeString());
      console.log('📊 Data Structure:', JSON.stringify(data).substring(0, 200) + '...');
      
      // Emit the parsed data to React clients IMMEDIATELY for real-time feel
      // We emit even if MongoDB is down, so the dashboard stays "Live"
      io.emit('sensor-update', {
        ...data,
        timestamp: new Date().toISOString()
      });

      // Throttle saving to MongoDB to avoid spamming (e.g. max once every 5 seconds)
      const now = Date.now();
      if (now - lastSavedTime > 5000) {
        try {
          if (mongoose.connection.readyState === 1) { // 1 = Connected
            const gov = data.gov_node || {};
            const newReading = new SensorData({
              tdsValue: gov.tdsValue || 0,
              turbidityVoltage: gov.turbidityVoltage || 0,
              waterStatus: gov.waterStatus || 'UNKNOWN',
              govSupplyLitres: gov.govSupplyLitres || 0,
              consumerTotalLitres: gov.consumerTotalLitres || 0,
              flowDifference: gov.flowDifference || 0,
              flowRate: gov.flowRate || 0
            });
            await newReading.save();
            lastSavedTime = now;
            console.log('💾 Detailed Data archived to MongoDB');
          }
        } catch (err) {
          console.error('❌ Error archiving to MongoDB:', err.message);
        }
      }
    }
  });
};
