const { supabase } = require('../database/supabase');
const { createServiceLogger } = require('../logger');

const logger = createServiceLogger('timezone-cache');

class TimezoneCache {
  constructor() {
    this.timezones = null;
    this.lastFetch = null;
    this.cacheDuration = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
    this.fetchPromise = null; // Prevent concurrent fetches
  }

  async getTimezones() {
    const now = Date.now();
    
    // Check if cache is still valid
    if (this.timezones && this.lastFetch && (now - this.lastFetch) < this.cacheDuration) {
      logger.debug('Returning cached timezone data');
      return this.timezones;
    }

    // If already fetching, wait for that promise
    if (this.fetchPromise) {
      logger.debug('Waiting for existing timezone fetch');
      return this.fetchPromise;
    }

    // Start new fetch
    this.fetchPromise = this._fetchTimezones();
    
    try {
      this.timezones = await this.fetchPromise;
      this.lastFetch = now;
      logger.info(`Cached ${this.timezones.length} timezones`);
      return this.timezones;
    } catch (error) {
      logger.error('Failed to fetch timezones:', error);
      // Return cached data if fetch fails and we have it
      if (this.timezones) {
        logger.warn('Using stale timezone cache due to fetch error');
        return this.timezones;
      }
      throw error;
    } finally {
      this.fetchPromise = null;
    }
  }

  async _fetchTimezones() {
    logger.debug('Fetching fresh timezone data from database');
    
    const { data, error } = await supabase.rpc('get_timezone_names');
    
    if (error) {
      // Fallback to direct query if RPC doesn't exist
      const { data: directData, error: directError } = await supabase
        .from('pg_timezone_names')
        .select('name')
        .order('name');
        
      if (directError) {
        throw new Error(`Failed to fetch timezones: ${directError.message}`);
      }
      
      return directData.map(tz => tz.name);
    }
    
    return data;
  }

  // Method to get common timezones only (much smaller list)
  getCommonTimezones() {
    return [
      'UTC',
      'US/Eastern',
      'US/Central', 
      'US/Mountain',
      'US/Pacific',
      'Europe/London',
      'Europe/Paris',
      'Asia/Tokyo',
      'Australia/Sydney'
    ];
  }

  // Clear cache manually if needed
  clearCache() {
    this.timezones = null;
    this.lastFetch = null;
    this.fetchPromise = null;
    logger.info('Timezone cache cleared');
  }

  // Get cache status
  getCacheStatus() {
    const now = Date.now();
    return {
      hasCachedData: !!this.timezones,
      cacheAge: this.lastFetch ? now - this.lastFetch : null,
      isExpired: this.lastFetch ? (now - this.lastFetch) > this.cacheDuration : true,
      timezoneCount: this.timezones ? this.timezones.length : 0
    };
  }
}

// Create singleton instance
const timezoneCache = new TimezoneCache();

// Preload cache on startup
timezoneCache.getTimezones().catch(error => {
  logger.error('Failed to preload timezone cache:', error);
});

module.exports = timezoneCache;