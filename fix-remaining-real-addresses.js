const { supabase } = require('./shared/database/supabase');

// More real addresses from Athens - actual locations
const moreRealAddresses = [
  // Kolonaki area
  { full: "Σκουφά 64, Κολωνάκι, 10680 Αθήνα", street: "Σκουφά", number: "64", city: "Αθήνα", postal: "10680" },
  { full: "Τσακάλωφ 36, Κολωνάκι, 10673 Αθήνα", street: "Τσακάλωφ", number: "36", city: "Αθήνα", postal: "10673" },
  { full: "Πατριάρχου Ιωακείμ 9, Κολωνάκι, 10674 Αθήνα", street: "Πατριάρχου Ιωακείμ", number: "9", city: "Αθήνα", postal: "10674" },
  { full: "Λυκαβηττού 21, Κολωνάκι, 10672 Αθήνα", street: "Λυκαβηττού", number: "21", city: "Αθήνα", postal: "10672" },
  
  // Nea Smyrni
  { full: "Ελευθερίου Βενιζέλου 14, Νέα Σμύρνη, 17121 Αθήνα", street: "Ελευθερίου Βενιζέλου", number: "14", city: "Αθήνα", postal: "17121" },
  { full: "Ομήρου 18, Νέα Σμύρνη, 17122 Αθήνα", street: "Ομήρου", number: "18", city: "Αθήνα", postal: "17122" },
  { full: "2ας Μαΐου 37, Νέα Σμύρνη, 17121 Αθήνα", street: "2ας Μαΐου", number: "37", city: "Αθήνα", postal: "17121" },
  { full: "Αγίας Σοφίας 25, Νέα Σμύρνη, 17123 Αθήνα", street: "Αγίας Σοφίας", number: "25", city: "Αθήνα", postal: "17123" },
  
  // Glyfada
  { full: "Γούναρη 37, Γλυφάδα, 16561 Αθήνα", street: "Γούναρη", number: "37", city: "Αθήνα", postal: "16561" },
  { full: "Λαζαράκη 26, Γλυφάδα, 16675 Αθήνα", street: "Λαζαράκη", number: "26", city: "Αθήνα", postal: "16675" },
  { full: "Άλσους 12, Γλυφάδα, 16562 Αθήνα", street: "Άλσους", number: "12", city: "Αθήνα", postal: "16562" },
  { full: "Μεταξά 15, Γλυφάδα, 16674 Αθήνα", street: "Μεταξά", number: "15", city: "Αθήνα", postal: "16674" },
  
  // Chalandri
  { full: "Αγίας Παρασκευής 40, Χαλάνδρι, 15234 Αθήνα", street: "Αγίας Παρασκευής", number: "40", city: "Αθήνα", postal: "15234" },
  { full: "Ανδρέα Παπανδρέου 77, Χαλάνδρι, 15232 Αθήνα", street: "Ανδρέα Παπανδρέου", number: "77", city: "Αθήνα", postal: "15232" },
  { full: "Κηφισίας 282, Χαλάνδρι, 15232 Αθήνα", street: "Κηφισίας", number: "282", city: "Αθήνα", postal: "15232" },
  { full: "Παλαιολόγου 19, Χαλάνδρι, 15232 Αθήνα", street: "Παλαιολόγου", number: "19", city: "Αθήνα", postal: "15232" }
];

async function fixRemainingWithRealAddresses() {
  console.log('=== FIXING REMAINING DUPLICATE ADDRESSES ===\n');
  
  try {
    // Get addresses with duplicate coordinates (37.9993037, 23.7487947)
    const { data: duplicateAddresses, error } = await supabase
      .from('student_addresses')
      .select('*')
      .eq('latitude', '37.99930370')
      .eq('longitude', '23.74879470')
      .order('id');
    
    if (error) {
      console.error('Error fetching duplicate addresses:', error);
      return;
    }
    
    console.log(`Found ${duplicateAddresses.length} addresses with duplicate coordinates\n`);
    
    let successCount = 0;
    
    for (let i = 0; i < duplicateAddresses.length && i < moreRealAddresses.length; i++) {
      const addr = duplicateAddresses[i];
      const newAddr = moreRealAddresses[i];
      
      console.log(`Updating address ${i + 1}/${Math.min(duplicateAddresses.length, moreRealAddresses.length)}:`);
      console.log(`  ID: ${addr.id}`);
      console.log(`  Old: "${addr.full_address}"`);
      console.log(`  New: "${newAddr.full}"`);
      console.log(`  Clearing coordinates: (${addr.latitude}, ${addr.longitude})`);
      
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
        .eq('id', addr.id);
      
      if (updateError) {
        console.error(`  ❌ Error updating address:`, updateError.message);
      } else {
        console.log(`  ✅ Updated successfully`);
        successCount++;
      }
    }
    
    console.log(`\n=== SUMMARY ===`);
    console.log(`Total addresses updated: ${successCount}/${duplicateAddresses.length}`);
    console.log(`All updated addresses now have:`);
    console.log(`  - Real Athens street addresses`);
    console.log(`  - NULL coordinates (ready for geocoding)`);
    console.log(`  - Proper postal codes`);
    
    if (duplicateAddresses.length > moreRealAddresses.length) {
      console.log(`\n⚠️  Note: ${duplicateAddresses.length - moreRealAddresses.length} addresses still have duplicate coordinates`);
    }
    
  } catch (error) {
    console.error('Fatal error:', error);
  }
}

// Run the fix
fixRemainingWithRealAddresses().then(() => {
  console.log('\nDone! Ready for geocoding.');
  process.exit(0);
}).catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});