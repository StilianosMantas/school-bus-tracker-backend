const timezoneCache = require('../cache/timezoneCache');

/**
 * Utility functions for date/time operations with timezone caching
 */

/**
 * Get current timestamp in ISO format
 * This avoids any timezone queries by using local Date object
 */
function getCurrentTimestamp() {
  return new Date().toISOString();
}

/**
 * Get current date string (YYYY-MM-DD format)
 */
function getCurrentDate() {
  return new Date().toISOString().split('T')[0];
}

/**
 * Get current time string (HH:mm:ss format)
 */
function getCurrentTime() {
  return new Date().toISOString().split('T')[1].split('.')[0];
}

/**
 * Convert timestamp to local date string
 */
function toDateString(timestamp) {
  if (!timestamp) return getCurrentDate();
  return new Date(timestamp).toISOString().split('T')[0];
}

/**
 * Convert timestamp to local time string  
 */
function toTimeString(timestamp) {
  if (!timestamp) return getCurrentTime();
  return new Date(timestamp).toISOString().split('T')[1].split('.')[0];
}

/**
 * Get cached timezone list (avoids repeated DB queries)
 */
async function getTimezones() {
  return timezoneCache.getTimezones();
}

/**
 * Get common timezones only (no DB query needed)
 */
function getCommonTimezones() {
  return timezoneCache.getCommonTimezones();
}

/**
 * Get timezone cache status for monitoring
 */
function getTimezonesCacheStatus() {
  return timezoneCache.getCacheStatus();
}

/**
 * Calculate time difference in seconds
 */
function getTimeDiffSeconds(timestamp1, timestamp2) {
  const time1 = timestamp1 instanceof Date ? timestamp1 : new Date(timestamp1);
  const time2 = timestamp2 instanceof Date ? timestamp2 : new Date(timestamp2);
  return Math.abs(time2.getTime() - time1.getTime()) / 1000;
}

/**
 * Calculate time difference in minutes
 */
function getTimeDiffMinutes(timestamp1, timestamp2) {
  return getTimeDiffSeconds(timestamp1, timestamp2) / 60;
}

/**
 * Check if timestamp is within last N seconds
 */
function isWithinLastSeconds(timestamp, seconds) {
  const diff = getTimeDiffSeconds(timestamp, new Date());
  return diff <= seconds;
}

/**
 * Format duration in minutes to human readable format
 */
function formatDuration(minutes) {
  if (minutes < 60) {
    return `${Math.round(minutes)} minutes`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = Math.round(minutes % 60);
  return `${hours}h ${remainingMinutes}m`;
}

module.exports = {
  getCurrentTimestamp,
  getCurrentDate,
  getCurrentTime,
  toDateString,
  toTimeString,
  getTimezones,
  getCommonTimezones,
  getTimezonesCacheStatus,
  getTimeDiffSeconds,
  getTimeDiffMinutes,
  isWithinLastSeconds,
  formatDuration
};