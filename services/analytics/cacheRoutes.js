const express = require('express');
const router = express.Router();
const { authenticateToken, authorizeRoles } = require('../auth/middleware');
const { getTimezonesCacheStatus } = require('../../shared/utils/dateUtils');
const timezoneCache = require('../../shared/cache/timezoneCache');

// Cache status endpoint for monitoring
router.get('/cache/status', authenticateToken, authorizeRoles(['admin']), async (req, res) => {
  try {
    const status = getTimezonesCacheStatus();
    
    res.json({
      success: true,
      data: {
        timezone_cache: status,
        cache_hit_rate: status.hasCachedData ? 'cached' : 'miss',
        recommendations: generateCacheRecommendations(status)
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to get cache status',
      details: error.message
    });
  }
});

// Clear cache endpoint
router.post('/cache/clear', authenticateToken, authorizeRoles(['admin']), async (req, res) => {
  try {
    timezoneCache.clearCache();
    
    res.json({
      success: true,
      message: 'All caches cleared successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to clear cache',
      details: error.message
    });
  }
});

// Preload cache endpoint
router.post('/cache/preload', authenticateToken, authorizeRoles(['admin']), async (req, res) => {
  try {
    await timezoneCache.getTimezones();
    const status = getTimezonesCacheStatus();
    
    res.json({
      success: true,
      message: 'Cache preloaded successfully',
      data: status
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to preload cache',
      details: error.message
    });
  }
});

function generateCacheRecommendations(status) {
  const recommendations = [];
  
  if (!status.hasCachedData) {
    recommendations.push('Cache is empty - consider preloading');
  }
  
  if (status.isExpired && status.hasCachedData) {
    recommendations.push('Cache is expired but still serving stale data');
  }
  
  if (status.cacheAge && status.cacheAge > 6 * 60 * 60 * 1000) { // 6 hours
    recommendations.push('Cache is getting old - will refresh automatically');
  }
  
  if (status.timezoneCount === 0) {
    recommendations.push('No timezone data cached - check database connection');
  }
  
  if (recommendations.length === 0) {
    recommendations.push('Cache is healthy and working optimally');
  }
  
  return recommendations;
}

module.exports = router;