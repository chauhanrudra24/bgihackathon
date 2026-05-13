const mongoose = require('mongoose');

const sensorDataSchema = new mongoose.Schema({
  tdsValue: { type: Number, required: true },
  turbidityVoltage: { type: Number, required: true },
  waterStatus: { type: String, required: true },
  govSupplyLitres: { type: Number, default: 0 },
  consumerTotalLitres: { type: Number, default: 0 },
  flowDifference: { type: Number, default: 0 },
  flowRate: { type: Number, default: 0 },
  timestamp: { type: Date, default: Date.now }
});

module.exports = mongoose.model('SensorData', sensorDataSchema);
