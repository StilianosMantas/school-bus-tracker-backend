const express = require('express');
const router = express.Router();
const geocodingService = require('./geocoding-service');
const { authenticateToken, authorizeRoles } = require('../../middleware/auth');
const logger = require('../../utils/logger');

// Test geocoding endpoint (Admin only)
router.post('/test', authenticateToken, authorizeRoles(['admin']), async (req, res) => {
  try {
    const { address } = req.body;
    
    if (!address) {
      return res.status(400).json({ error: 'Address is required' });
    }

    const result = await geocodingService.testGeocoding(address);
    
    logger.info('Geocoding test completed', { 
      address, 
      success: result.success, 
      userId: req.user.id 
    });

    res.json(result);
  } catch (error) {
    logger.error('Geocoding test error', { error: error.message, userId: req.user?.id });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Geocode single address (Admin only)
router.post('/geocode', authenticateToken, authorizeRoles(['admin']), async (req, res) => {
  try {
    const { address, country = 'GR' } = req.body;
    
    if (!address) {
      return res.status(400).json({ error: 'Address is required' });
    }

    const result = await geocodingService.geocodeAddress(address, country);
    
    if (result) {
      logger.info('Address geocoded successfully', { 
        address, 
        country, 
        cached: result.cached,
        userId: req.user.id 
      });
      
      res.json({
        success: true,
        address,
        country,
        coordinates: result
      });
    } else {
      logger.warn('Failed to geocode address', { address, country, userId: req.user.id });
      res.status(404).json({ 
        success: false, 
        error: 'Could not geocode address',
        address,
        country
      });
    }
  } catch (error) {
    logger.error('Geocoding error', { error: error.message, userId: req.user?.id });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Batch geocode addresses (Admin only)
router.post('/geocode/batch', authenticateToken, authorizeRoles(['admin']), async (req, res) => {
  try {
    const { addresses } = req.body;
    
    if (!addresses || !Array.isArray(addresses) || addresses.length === 0) {
      return res.status(400).json({ error: 'Addresses array is required' });
    }

    if (addresses.length > 50) {
      return res.status(400).json({ error: 'Maximum 50 addresses per batch request' });
    }

    const results = await geocodingService.geocodeBatch(addresses);
    
    const successCount = results.filter(r => r.coordinates).length;
    
    logger.info('Batch geocoding completed', { 
      total: results.length, 
      successful: successCount, 
      userId: req.user.id 
    });

    res.json({
      success: true,
      total: results.length,
      successful: successCount,
      results
    });
  } catch (error) {
    logger.error('Batch geocoding error', { error: error.message, userId: req.user?.id });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get cached coordinates statistics (Admin only)
router.get('/cache/stats', authenticateToken, authorizeRoles(['admin']), async (req, res) => {
  try {
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    
    const { data: stats, error } = await supabase
      .from('address_coordinates')
      .select('country, geocoding_service, created_at')
      .order('created_at', { ascending: false });

    if (error) {
      logger.error('Error fetching cache stats', { error });
      return res.status(500).json({ error: 'Failed to fetch cache statistics' });
    }

    // Process statistics
    const totalCached = stats.length;
    const byCountry = {};
    const byService = {};
    const recentlyAdded = stats.filter(s => 
      new Date(s.created_at) > new Date(Date.now() - 24 * 60 * 60 * 1000)
    ).length;

    stats.forEach(stat => {
      byCountry[stat.country] = (byCountry[stat.country] || 0) + 1;
      byService[stat.geocoding_service] = (byService[stat.geocoding_service] || 0) + 1;
    });

    res.json({
      total: totalCached,
      recentlyAdded: recentlyAdded,
      byCountry,
      byService
    });

  } catch (error) {
    logger.error('Cache stats error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Clear cache for specific address (Admin only)
router.delete('/cache', authenticateToken, authorizeRoles(['admin']), async (req, res) => {
  try {
    const { address, country = 'GR' } = req.body;
    
    if (!address) {
      return res.status(400).json({ error: 'Address is required' });
    }

    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    
    const normalizedAddress = geocodingService.normalizeAddress(address);
    
    const { error } = await supabase
      .from('address_coordinates')
      .delete()
      .eq('address_text', normalizedAddress)
      .eq('country', country);

    if (error) {
      logger.error('Error clearing cache', { error, address, country });
      return res.status(500).json({ error: 'Failed to clear cache' });
    }

    logger.info('Cache cleared', { address, country, userId: req.user.id });
    res.json({ success: true, message: 'Cache cleared for address' });

  } catch (error) {
    logger.error('Clear cache error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;