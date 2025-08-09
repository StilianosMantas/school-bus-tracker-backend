const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const dotenv = require('dotenv');
const path = require('path');

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../../.env') });

const app = express();
const PORT = process.env.GATEWAY_PORT || 3000;

// Middleware
app.use(helmet());
app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? ['https://your-driver-app.vercel.app', 'https://your-admin-app.vercel.app']
    : ['http://localhost:3001', 'http://localhost:3002', 'http://localhost:3003'],
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan('combined'));

// Service routes
app.use('/api/auth', require('../services/auth/routes'));
app.use('/api/tracking', require('../services/tracking/routes'));
app.use('/api/routes', require('../services/routes/routes'));
app.use('/api/buses', require('../services/buses/routes'));
app.use('/api/notifications', require('../services/notifications/routes'));
app.use('/api/analytics', require('../services/analytics/routes'));
app.use('/api/students', require('../services/student-data/routes'));
app.use('/api/student-data', require('../services/student-data/routes'));

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'gateway',
    timestamp: new Date().toISOString() 
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({
    error: {
      message: err.message || 'Internal server error',
      status: err.status || 500
    }
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: {
      message: 'Route not found',
      status: 404
    }
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Gateway service running on port ${PORT}`);
  console.log(`📍 Environment: ${process.env.NODE_ENV}`);
});