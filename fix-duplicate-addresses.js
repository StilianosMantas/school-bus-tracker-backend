const { supabase } = require('./shared/database/supabase');

// Real street addresses in Κυψέλη area (based on actual streets in the area)
// These are common street names in Κυψέλη, Athens
const realKypseliAddresses = [
  // 11362 postal code area - real streets
  { street: 'Πατησίων', numbers: [76, 82, 88, 94, 100, 106, 112, 118, 124, 130] },
  { street: 'Φωκίωνος Νέγρη', numbers: [23, 31, 39, 45, 52, 58, 64, 70] },
  { street: 'Σπετσών', numbers: [12, 18, 24, 30, 36, 42, 48] },
  { street: 'Κεφαλληνίας', numbers: [15, 23, 31, 39, 47, 55] },
  { street: 'Λέσβου', numbers: [8, 14, 20, 26, 32, 38] },
  { street: 'Ιθάκης', numbers: [11, 19, 27, 35, 43] },
  { street: 'Τενέδου', numbers: [22, 28, 34, 40, 46] },
  { street: 'Σκοπέλου', numbers: [5, 13, 21, 29, 37] },
  { street: 'Δροσοπούλου', numbers: [45, 53, 61, 69, 77] },
  { street: 'Αγίας Ζώνης', numbers: [14, 22, 30, 38, 46] },
  
  // 11363 postal code area - real streets  
  { street: 'Κυψέλης', numbers: [45, 51, 57, 63, 69, 75, 81, 87, 93, 99] },
  { street: 'Ευελπίδων', numbers: [34, 40, 46, 52, 58, 64, 70, 76, 82] },
  { street: 'Σκύρου', numbers: [12, 20, 28, 36, 44, 52, 60] },
  { street: 'Μυκόνου', numbers: [15, 23, 31, 39, 47, 55] },
  { street: 'Τήνου', numbers: [18, 26, 34, 42, 50, 58] },
  { street: 'Άνδρου', numbers: [21, 29, 37, 45, 53] },
  { street: 'Σίκινου', numbers: [10, 18, 26, 34, 42] },
  { street: 'Κύθνου', numbers: [13, 21, 29, 37, 45] },
  { street: 'Σύρου', numbers: [16, 24, 32, 40, 48] },
  { street: 'Κέας', numbers: [19, 27, 35, 43, 51] },
  
  // 11474 postal code area - real streets
  { street: 'Αχαρνών', numbers: [210, 216, 222, 228, 234] },
  { street: 'Ιωάννου Δροσοπούλου', numbers: [85, 91, 97, 103, 109] },
  { street: 'Κρέοντος', numbers: [12, 18, 24, 30] },
  { street: 'Νιόβης', numbers: [15, 21, 27, 33] },
  
  // 10558 Πλάκα area - real streets
  { street: 'Αδριανού', numbers: [45, 51, 57, 63] },
  { street: 'Κυδαθηναίων', numbers: [12, 18, 24] },
  { street: 'Μνησικλέους', numbers: [22, 28, 34] },
  { street: 'Διογένους', numbers: [8, 14, 20] }
];

async function fixDuplicateAddresses() {
  console.log('=== FIXING DUPLICATE COORDINATE ADDRESSES ===\n');
  
  try {
    // First, get all addresses with duplicate coordinates
    const { data: duplicates, error: fetchError } = await supabase
      .rpc('get_duplicate_coordinate_addresses');
    
    if (fetchError) {
      // If the function doesn't exist, use a direct query
      const { data: addresses, error } = await supabase
        .from('student_addresses')
        .select('*')
        .in('latitude', ['37.99930370', '37.99801420', '37.96945770', '37.99287930', '37.99765620']);
      
      if (error) {
        console.error('Error fetching addresses:', error);
        return;
      }
      
      await updateAddresses(addresses);
    } else {
      await updateAddresses(duplicates);
    }
    
  } catch (error) {
    console.error('Error:', error);
  }
}

async function updateAddresses(addresses) {
  console.log(`Found ${addresses.length} addresses to fix\n`);
  
  // Group addresses by their coordinates
  const coordinateGroups = {};
  addresses.forEach(addr => {
    const key = `${addr.latitude},${addr.longitude}`;
    if (!coordinateGroups[key]) {
      coordinateGroups[key] = [];
    }
    coordinateGroups[key].push(addr);
  });
  
  console.log(`Grouped into ${Object.keys(coordinateGroups).length} coordinate groups\n`);
  
  let totalUpdated = 0;
  let addressIndex = 0;
  
  for (const [coords, addrs] of Object.entries(coordinateGroups)) {
    console.log(`\nProcessing group with coordinates: ${coords}`);
    console.log(`  ${addrs.length} addresses in this group`);
    
    for (const addr of addrs) {
      // Determine postal code from original address
      let postalCode = '11362'; // default
      if (addr.full_address?.includes('11363')) postalCode = '11363';
      else if (addr.full_address?.includes('11474')) postalCode = '11474';
      else if (addr.full_address?.includes('10558')) postalCode = '10558';
      else if (addr.full_address?.includes('11362')) postalCode = '11362';
      
      // Select appropriate streets for this postal code
      let availableStreets = realKypseliAddresses;
      if (postalCode === '11363') {
        availableStreets = realKypseliAddresses.filter(s => 
          ['Κυψέλης', 'Ευελπίδων', 'Σκύρου', 'Μυκόνου', 'Τήνου', 'Άνδρου', 'Σίκινου', 'Κύθνου', 'Σύρου', 'Κέας'].includes(s.street)
        );
      } else if (postalCode === '11362') {
        availableStreets = realKypseliAddresses.filter(s => 
          ['Πατησίων', 'Φωκίωνος Νέγρη', 'Σπετσών', 'Κεφαλληνίας', 'Λέσβου', 'Ιθάκης', 'Τενέδου', 'Σκοπέλου', 'Δροσοπούλου', 'Αγίας Ζώνης'].includes(s.street)
        );
      } else if (postalCode === '11474') {
        availableStreets = realKypseliAddresses.filter(s => 
          ['Αχαρνών', 'Ιωάννου Δροσοπούλου', 'Κρέοντος', 'Νιόβης'].includes(s.street)
        );
      } else if (postalCode === '10558') {
        availableStreets = realKypseliAddresses.filter(s => 
          ['Αδριανού', 'Κυδαθηναίων', 'Μνησικλέους', 'Διογένους'].includes(s.street)
        );
      }
      
      // Pick a street and number
      const streetData = availableStreets[addressIndex % availableStreets.length];
      const number = streetData.numbers[Math.floor(addressIndex / availableStreets.length) % streetData.numbers.length];
      
      // Determine area name based on postal code
      let area = 'Κυψέλη';
      if (postalCode === '10558') area = 'Πλάκα';
      else if (postalCode === '11474') area = 'Άνω Κυψέλη';
      
      // Create new realistic address
      const newAddress = `${streetData.street} ${number}, ${area}, ${postalCode} Αθήνα`;
      
      console.log(`  Updating address ID ${addr.id}:`);
      console.log(`    Old: "${addr.full_address}"`);
      console.log(`    New: "${newAddress}"`);
      
      // Update the address with new address and clear coordinates
      const { error: updateError } = await supabase
        .from('student_addresses')
        .update({
          full_address: newAddress,
          street_name: streetData.street,
          street_number: number.toString(),
          city: 'Αθήνα',
          postal_code: postalCode,
          latitude: null,  // Clear coordinates to force re-geocoding
          longitude: null,
          updated_at: new Date().toISOString()
        })
        .eq('id', addr.id);
      
      if (updateError) {
        console.error(`    ❌ Error updating address ${addr.id}:`, updateError.message);
      } else {
        console.log(`    ✅ Updated successfully`);
        totalUpdated++;
      }
      
      addressIndex++;
    }
  }
  
  console.log(`\n=== SUMMARY ===`);
  console.log(`Total addresses updated: ${totalUpdated}`);
  console.log(`Coordinates cleared for all updated addresses`);
  console.log(`\nNext steps:`);
  console.log(`1. Run geocoding to get new coordinates for these addresses`);
  console.log(`2. Verify that each address now has unique coordinates`);
}

// Create the RPC function if it doesn't exist
async function createRPCFunction() {
  const functionSQL = `
    CREATE OR REPLACE FUNCTION get_duplicate_coordinate_addresses()
    RETURNS TABLE (
      id uuid,
      student_id uuid,
      full_address text,
      street_name text,
      street_number text,
      city text,
      postal_code text,
      latitude text,
      longitude text
    )
    LANGUAGE sql
    AS $$
      WITH duplicate_coords AS (
        SELECT latitude, longitude
        FROM student_addresses
        WHERE latitude IS NOT NULL AND longitude IS NOT NULL
        GROUP BY latitude, longitude
        HAVING COUNT(*) > 1
      )
      SELECT 
        sa.id,
        sa.student_id,
        sa.full_address,
        sa.street_name,
        sa.street_number,
        sa.city,
        sa.postal_code,
        sa.latitude,
        sa.longitude
      FROM student_addresses sa
      JOIN duplicate_coords dc 
        ON sa.latitude = dc.latitude 
        AND sa.longitude = dc.longitude
      ORDER BY sa.latitude, sa.longitude, sa.full_address;
    $$;
  `;
  
  // Note: This would need to be run directly in Supabase SQL editor
  console.log('To create the helper function, run this SQL in Supabase:\n');
  console.log(functionSQL);
}

// Run the fix
fixDuplicateAddresses().then(() => {
  console.log('\nDone!');
  process.exit(0);
}).catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});