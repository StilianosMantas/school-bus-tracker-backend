const winston = require('winston');
const path = require('path');
const fs = require('fs');

// Create logs directory if it doesn't exist
const logsDir = path.join(__dirname, '../../../logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Safe JSON stringifier that handles circular references
const safeStringify = (obj) => {
  const seen = new Set();
  return JSON.stringify(obj, (key, value) => {
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) {
        return '[Circular]';
      }
      seen.add(value);
    }
    // Skip logging certain sensitive or problematic properties
    if (key === 'req' || key === 'res' || key === 'socket' || key === 'connection') {
      return '[Object]';
    }
    return value;
  }, 2);
};

// Define log format
const logFormat = winston.format.combine(
  winston.format.timestamp({
    format: 'YYYY-MM-DD HH:mm:ss'
  }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json(),
  winston.format.printf(({ timestamp, level, message, service, ...meta }) => {
    try {
      return safeStringify({
        timestamp,
        level,
        service: service || 'unknown',
        message,
        ...meta
      });
    } catch (error) {
      // Fallback if even safe stringify fails
      return JSON.stringify({
        timestamp,
        level,
        service: service || 'unknown',
        message,
        error: 'Failed to serialize log data'
      }, null, 2);
    }
  })
);

// Create logger instance
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: logFormat,
  defaultMeta: { service: 'bus-tracker' },
  transports: [
    // Write all logs to combined.log
    new winston.transports.File({ 
      filename: path.join(logsDir, 'combined.log'),
      maxsize: 5242880, // 5MB
      maxFiles: 5
    }),
    // Write errors to error.log
    new winston.transports.File({ 
      filename: path.join(logsDir, 'error.log'), 
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 5
    })
  ]
});

// If not in production, also log to console
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    )
  }));
}

// Create child loggers for each service
const createServiceLogger = (serviceName) => {
  return logger.child({ service: serviceName });
};

module.exports = {
  logger,
  createServiceLogger
};