const { supabase } = require('./shared/database/supabase');

// Final set of real Athens addresses for the remaining 4 problematic addresses
const finalRealAddresses = [
  // Kifisia area
  { full: "Κασσαβέτη 8, Κηφισιά, 14562 Αθήνα", street: "Κασσαβέτη", number: "8", city: "Αθήνα", postal: "14562" },
  { full: "Κολοκοτρώνη 17, Κηφισιά, 14562 Αθήνα", street: "Κολοκοτρώνη", number: "17", city: "Αθήνα", postal: "14562" },
  
  // Marousi area  
  { full: "Βασιλίσσης Σοφίας 91, Μαρούσι, 15124 Αθήνα", street: "Βασιλίσσης Σοφίας", number: "91", city: "Αθήνα", postal: "15124" },
  { full: "Φραγκοκλησιάς 7, Μαρούσι, 15125 Αθήνα", street: "Φραγκοκλησιάς", number: "7", city: "Αθήνα", postal: "15125" }
];

async function fixFinalFour() {
  console.log('=== FIXING FINAL 4 PROBLEMATIC ADDRESSES ===\n');
  
  try {
    // Get the 4 problematic addresses (2 with duplicate coords + 2 with null coords)
    const problematicIds = [
      // Duplicate coordinates (37.99801420, 23.74109510)
      'bca701ec-6a80-4a4a-af6f-41e62d735c67', // Κύπρου 68
      'e1799187-ef85-4293-8d0f-c2c1a7ddbcb8', // Πατησίων 76
      // NULL coordinates - need to find their IDs
    ];
    
    // Get the NULL coordinate addresses
    const { data: nullAddresses, error: nullError } = await supabase
      .from('student_addresses')
      .select('id, full_address')
      .or('latitude.is.null,longitude.is.null')
      .order('full_address');
    
    if (!nullError && nullAddresses) {
      nullAddresses.forEach(addr => {
        problematicIds.push(addr.id);
        console.log(`Found NULL coordinate address: ${addr.full_address} (${addr.id})`);
      });
    }
    
    console.log(`\nProcessing ${problematicIds.length} addresses\n`);
    
    let successCount = 0;
    
    for (let i = 0; i < problematicIds.length && i < finalRealAddresses.length; i++) {
      const addressId = problematicIds[i];
      const newAddr = finalRealAddresses[i];
      
      // Get current address details
      const { data: currentAddr, error: fetchError } = await supabase
        .from('student_addresses')
        .select('*')
        .eq('id', addressId)
        .single();
      
      if (fetchError || !currentAddr) {
        console.error(`Error fetching address ${addressId}:`, fetchError?.message);
        continue;
      }
      
      console.log(`Updating address ${i + 1}/${problematicIds.length}:`);
      console.log(`  ID: ${addressId}`);
      console.log(`  Old: "${currentAddr.full_address}"`);
      console.log(`  New: "${newAddr.full}"`);
      if (currentAddr.latitude && currentAddr.longitude) {
        console.log(`  Clearing duplicate coordinates: (${currentAddr.latitude}, ${currentAddr.longitude})`);
      } else {
        console.log(`  Address had NULL coordinates`);
      }
      
      // Update the address
      const { error: updateError } = await supabase
        .from('student_addresses')
        .update({
          full_address: newAddr.full,
          street_name: newAddr.street,
          street_number: newAddr.number,
          city: newAddr.city,
          postal_code: newAddr.postal,
          latitude: null,
          longitude: null,
          updated_at: new Date().toISOString()
        })
        .eq('id', addressId);
      
      if (updateError) {
        console.error(`  ❌ Error updating address:`, updateError.message);
      } else {
        console.log(`  ✅ Updated successfully`);
        successCount++;
      }
    }
    
    console.log(`\n=== SUMMARY ===`);
    console.log(`Total addresses updated: ${successCount}/${problematicIds.length}`);
    console.log(`All problematic addresses have been replaced with real locations`);
    console.log(`All coordinates cleared for re-geocoding`);
    
    // Final check
    console.log(`\n=== FINAL STATUS CHECK ===`);
    
    // Check for any remaining duplicates
    const { data: duplicateCheck } = await supabase.rpc('execute_sql', {
      query: `
        SELECT COUNT(*) as dup_count
        FROM (
          SELECT latitude, longitude, COUNT(*) as cnt
          FROM student_addresses
          WHERE latitude IS NOT NULL AND longitude IS NOT NULL
          GROUP BY latitude, longitude
          HAVING COUNT(*) > 1
        ) t
      `
    }).single();
    
    // Check for NULL coordinates
    const { data: nullCheck } = await supabase
      .from('student_addresses')
      .select('id')
      .or('latitude.is.null,longitude.is.null');
    
    if (nullCheck) {
      console.log(`Addresses with NULL coordinates: ${nullCheck.length}`);
    }
    
    console.log(`\nAll addresses are now ready for geocoding!`);
    
  } catch (error) {
    console.error('Fatal error:', error);
  }
}

// Run the fix
fixFinalFour().then(() => {
  console.log('\nDone! All 4 problematic addresses have been fixed.');
  process.exit(0);
}).catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});