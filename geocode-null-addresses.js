const geocodingService = require('./services/geocoding/geocoding-service');
const { supabase } = require('./shared/database/supabase');
const { createServiceLogger } = require('./shared/logger');

const logger = createServiceLogger('geocode-null-addresses');

async function geocodeNullAddresses() {
  console.log('=== GEOCODING ADDRESSES WITH NULL COORDINATES ===\n');
  
  try {
    // Fetch all addresses with NULL coordinates
    const { data: addresses, error } = await supabase
      .from('student_addresses')
      .select('*')
      .is('latitude', null)
      .is('longitude', null)
      .order('full_address');
    
    if (error) {
      console.error('Error fetching addresses:', error);
      return;
    }
    
    console.log(`Found ${addresses.length} addresses with NULL coordinates\n`);
    
    let successCount = 0;
    let failureCount = 0;
    const failedAddresses = [];
    
    // Process each address
    for (let i = 0; i < addresses.length; i++) {
      const addr = addresses[i];
      console.log(`\n[${i + 1}/${addresses.length}] Processing: "${addr.full_address}"`);
      
      // Geocode the address using TomTom API
      const result = await geocodingService.geocodeAddress(addr.full_address, 'GR');
      
      if (result && result.latitude && result.longitude) {
        // Update the address with the new coordinates
        const { error: updateError } = await supabase
          .from('student_addresses')
          .update({
            latitude: result.latitude.toString(),
            longitude: result.longitude.toString(),
            updated_at: new Date().toISOString()
          })
          .eq('id', addr.id);
        
        if (updateError) {
          console.error(`  ❌ Error updating address: ${updateError.message}`);
          failureCount++;
          failedAddresses.push({ address: addr.full_address, error: updateError.message });
        } else {
          console.log(`  ✅ Geocoded: ${result.latitude}, ${result.longitude}`);
          if (result.postal_code) {
            console.log(`     Postal code: ${result.postal_code}`);
          }
          if (result.cached) {
            console.log(`     (from cache)`);
          }
          successCount++;
        }
      } else {
        console.log(`  ⚠️  Failed to geocode address`);
        failureCount++;
        failedAddresses.push({ address: addr.full_address, error: 'No geocoding result' });
      }
      
      // Add a small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    
    // Print summary
    console.log('\n=== GEOCODING SUMMARY ===');
    console.log(`Total addresses processed: ${addresses.length}`);
    console.log(`Successfully geocoded: ${successCount}`);
    console.log(`Failed to geocode: ${failureCount}`);
    
    if (failedAddresses.length > 0) {
      console.log('\nFailed addresses:');
      failedAddresses.forEach(fa => {
        console.log(`  - "${fa.address}": ${fa.error}`);
      });
    }
    
    // Check for any remaining duplicate coordinates
    console.log('\n=== CHECKING FOR DUPLICATE COORDINATES ===');
    
    const { data: duplicateCheck, error: dupError } = await supabase
      .from('student_addresses')
      .select('latitude, longitude')
      .not('latitude', 'is', null)
      .not('longitude', 'is', null);
    
    if (!dupError && duplicateCheck) {
      const coordMap = new Map();
      let duplicatesFound = 0;
      
      duplicateCheck.forEach(addr => {
        const key = `${addr.latitude},${addr.longitude}`;
        if (coordMap.has(key)) {
          coordMap.set(key, coordMap.get(key) + 1);
        } else {
          coordMap.set(key, 1);
        }
      });
      
      coordMap.forEach((count, coords) => {
        if (count > 1) {
          duplicatesFound++;
          console.log(`  Coordinates ${coords} appears ${count} times`);
        }
      });
      
      if (duplicatesFound === 0) {
        console.log('  ✅ No duplicate coordinates found! All addresses have unique coordinates.');
      } else {
        console.log(`  ⚠️  Found ${duplicatesFound} sets of duplicate coordinates`);
      }
    }
    
  } catch (error) {
    console.error('Fatal error:', error);
  }
}

// Run the geocoding
geocodeNullAddresses().then(() => {
  console.log('\nGeocoding complete!');
  process.exit(0);
}).catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});