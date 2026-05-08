require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcrypt');
const User = require('./models/User');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(cors());
app.use(express.json());

// Socket.io connection
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  socket.on('disconnect', () => console.log('Client disconnected:', socket.id));
});

// Database Connection
mongoose.connect(process.env.MONGO_URI)
  .then(() => {
    console.log('MongoDB Connected');
    seedAdmin();
    // Start listening to Firebase after MongoDB connects
    require('./firebaseListener')(io);
  })
  .catch(err => console.log(err));

// Seed default admin if none exists
async function seedAdmin() {
  const adminExists = await User.findOne({ role: 'admin' });
  if (!adminExists) {
    const hashedPassword = await bcrypt.hash('admin123', 10);
    await User.create({ email: 'admin@gov.in', password: hashedPassword, role: 'admin' });
    console.log('Default admin created: admin@gov.in / admin123');
  }
}

// Routes
const authRoutes = require('./routes/auth');
const sensorRoutes = require('./routes/sensor')(io); // Pass io to emit events

app.use('/api/auth', authRoutes);
app.use('/api/sensor', sensorRoutes);

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
