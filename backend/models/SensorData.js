const mongoose = require('mongoose');

const sensorDataSchema = new mongoose.Schema({
  tdsValue: { type: Number, required: true },
  turbidityVoltage: { type: Number, required: true },
  waterStatus: { type: String, required: true },
  timestamp: { type: Date, default: Date.now }
});

module.exports = mongoose.model('SensorData', sensorDataSchema);
