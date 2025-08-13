const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { createServiceLogger } = require('../../shared/logger');

// Initialize Supabase client
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const logger = createServiceLogger('geocoding-service');

class GeocodingService {
  constructor() {
    this.tomtomApiKey = process.env.TOMTOM_API_KEY;
    this.baseUrl = 'https://api.tomtom.com/search/2/geocode';
    this.defaultCountry = 'GR';
    
    if (!this.tomtomApiKey) {
      logger.warn('TomTom API key not found. Geocoding will be disabled.');
    }
  }

  /**
   * Normalize address text for consistent lookups
   * @param {string} address - Raw address string
   * @returns {string} - Normalized address
   */
  normalizeAddress(address) {
    return address.trim().toLowerCase().replace(/\s+/g, ' ');
  }

  /**
   * Check if coordinates already exist in cache
   * @param {string} address - Address to lookup
   * @param {string} country - Country code (default: GR)
   * @returns {Object|null} - Cached coordinates or null
   */
  async getCachedCoordinates(address, country = this.defaultCountry) {
    try {
      const normalizedAddress = this.normalizeAddress(address);
      
      const { data, error } = await supabase
        .from('address_coordinates')
        .select('*')
        .eq('address_text', normalizedAddress)
        .eq('country', country)
        .single();

      if (error && error.code !== 'PGRST116') { // Not found error is expected
        logger.error('Error checking cached coordinates', { error, address, country });
        return null;
      }

      if (data) {
        logger.info('Found cached coordinates', { address, coordinates: { lat: data.latitude, lon: data.longitude } });
        return {
          latitude: parseFloat(data.latitude),
          longitude: parseFloat(data.longitude),
          postal_code: data.zip_code,
          cached: true
        };
      }

      return null;
    } catch (error) {
      logger.error('Error in getCachedCoordinates', { error: error.message, address, country });
      return null;
    }
  }

  /**
   * Save coordinates to cache
   * @param {string} address - Original address
   * @param {string} country - Country code
   * @param {Object} geocodingResult - Result from geocoding API
   */
  async cacheCoordinates(address, country, geocodingResult) {
    try {
      const normalizedAddress = this.normalizeAddress(address);
      
      const { error } = await supabase
        .from('address_coordinates')
        .insert({
          address_text: normalizedAddress,
          country: country,
          zip_code: geocodingResult.postal_code || null,
          latitude: geocodingResult.latitude,
          longitude: geocodingResult.longitude,
          geocoding_service: 'tomtom',
          geocoding_response: geocodingResult.full_response || null
        });

      if (error) {
        logger.error('Error caching coordinates', { error, address, country });
      } else {
        logger.info('Cached coordinates', { address, country, coordinates: { lat: geocodingResult.latitude, lon: geocodingResult.longitude } });
      }
    } catch (error) {
      logger.error('Error in cacheCoordinates', { error: error.message, address, country });
    }
  }

  /**
   * Call TomTom Geocoding API
   * @param {string} address - Address to geocode
   * @param {string} country - Country code for bias
   * @returns {Object|null} - Geocoding result or null
   */
  async callTomTomAPI(address, country = this.defaultCountry) {
    if (!this.tomtomApiKey) {
      logger.warn('TomTom API key not configured');
      return null;
    }

    try {
      const encodedAddress = encodeURIComponent(address);
      const url = `${this.baseUrl}/${encodedAddress}.json`;
      
      const params = {
        key: this.tomtomApiKey,
        countrySet: country,
        limit: 1 // Only get the best result
      };

      logger.info('Calling TomTom Geocoding API', { address, country, url });

      const response = await axios.get(url, { 
        params,
        timeout: 10000 // 10 second timeout
      });

      if (response.data && response.data.results && response.data.results.length > 0) {
        const result = response.data.results[0];
        
        return {
          latitude: result.position.lat,
          longitude: result.position.lon,
          postal_code: result.address?.postalCode || null,
          formatted_address: result.address?.freeformAddress || address,
          full_response: result // Store full response for debugging
        };
      }

      logger.warn('No results from TomTom API', { address, country });
      return null;

    } catch (error) {
      if (error.response) {
        logger.error('TomTom API error response', { 
          status: error.response.status, 
          data: error.response.data, 
          address, 
          country 
        });
      } else {
        logger.error('TomTom API request failed', { error: error.message, address, country });
      }
      return null;
    }
  }

  /**
   * Main geocoding function - checks cache first, then calls API
   * @param {string} address - Address to geocode
   * @param {string} country - Country code (default: GR)
   * @returns {Object|null} - Coordinates result or null
   */
  async geocodeAddress(address, country = this.defaultCountry) {
    if (!address || typeof address !== 'string' || address.trim().length === 0) {
      logger.warn('Invalid address provided for geocoding', { address });
      return null;
    }

    try {
      // First check cache
      const cachedResult = await this.getCachedCoordinates(address, country);
      if (cachedResult) {
        return cachedResult;
      }

      // If not in cache, call TomTom API
      const apiResult = await this.callTomTomAPI(address, country);
      if (apiResult) {
        // Cache the result
        await this.cacheCoordinates(address, country, apiResult);
        
        return {
          latitude: apiResult.latitude,
          longitude: apiResult.longitude,
          postal_code: apiResult.postal_code,
          cached: false
        };
      }

      return null;

    } catch (error) {
      logger.error('Error in geocodeAddress', { error: error.message, address, country });
      return null;
    }
  }

  /**
   * Batch geocode multiple addresses
   * @param {Array} addresses - Array of {address, country?} objects
   * @returns {Array} - Array of results with same order as input
   */
  async geocodeBatch(addresses) {
    const results = [];
    
    for (const addressObj of addresses) {
      const address = typeof addressObj === 'string' ? addressObj : addressObj.address;
      const country = addressObj.country || this.defaultCountry;
      
      const result = await this.geocodeAddress(address, country);
      results.push({
        address: address,
        country: country,
        coordinates: result
      });

      // Add small delay to avoid hitting rate limits
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    return results;
  }

  /**
   * Test the geocoding service
   * @param {string} testAddress - Address to test with
   * @returns {Object} - Test result
   */
  async testGeocoding(testAddress = "Πλατεία Συντάγματος, Αθήνα") {
    try {
      logger.info('Testing geocoding service', { testAddress });
      
      const result = await this.geocodeAddress(testAddress);
      
      return {
        success: !!result,
        address: testAddress,
        result: result,
        message: result ? 'Geocoding service is working' : 'Geocoding failed'
      };
    } catch (error) {
      logger.error('Geocoding test failed', { error: error.message, testAddress });
      return {
        success: false,
        address: testAddress,
        result: null,
        message: `Geocoding test failed: ${error.message}`
      };
    }
  }
}

module.exports = new GeocodingService();