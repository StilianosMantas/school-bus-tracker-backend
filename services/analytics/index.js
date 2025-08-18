const express = require('express');
const cors = require('cors');
const winston = require('winston');

const app = express();
const PORT = process.env.ANALYTICS_PORT || 5005;

// Configure winston logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});

// Middleware
 

app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? ['https://your-driver-app.vercel.app', 'https://your-admin-app.vercel.app', 'https://admin-bhca.onrender.com']
    : ['http://localhost:3001', 'http://localhost:3002', 'http://localhost:3003','https://admin-bhca.onrender.com'],
  credentials: true
}));

app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'analytics' });
});

// Routes
app.use('/', require('./routes'));
app.use('/admin', require('./cacheRoutes'));

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error('Error:', err);
  res.status(err.status || 500).json({
    error: {
      message: err.message || 'Internal server error'
    }
  });
});

app.listen(PORT, () => {
  logger.info(`Analytics service running on port ${PORT}`);
});

module.exports = app;