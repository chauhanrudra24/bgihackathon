const express = require('express');
const router = express.Router();
const SensorData = require('../models/SensorData');

module.exports = function(io) {
  // ESP32 posts data here
  router.post('/data', async (req, res) => {
    try {
      const { tdsValue, turbidityVoltage, waterStatus } = req.body;
      
      const newReading = new SensorData({
        tdsValue,
        turbidityVoltage,
        waterStatus
      });
      
      await newReading.save();
      
      // Emit to all connected React clients
      io.emit('sensor-update', newReading);
      
      res.status(201).json({ message: 'Data received successfully' });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // React fetches latest data on load
  router.get('/latest', async (req, res) => {
    try {
      const latest = await SensorData.findOne().sort({ timestamp: -1 });
      res.json(latest);
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  return router;
};
