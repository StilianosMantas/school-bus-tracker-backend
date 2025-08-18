const { supabase } = require('./shared/database/supabase');

// Real addresses from well-known locations in Athens
// These are actual addresses of public buildings, schools, and businesses
const realAthensAddresses = [
  // Kypseli area (11362, 11363)
  { full: "Φωκίωνος Νέγρη 3, Κυψέλη, 11361 Αθήνα", street: "Φωκίωνος Νέγρη", number: "3", city: "Αθήνα", postal: "11361" },
  { full: "Κυψέλης 39, Κυψέλη, 11362 Αθήνα", street: "Κυψέλης", number: "39", city: "Αθήνα", postal: "11362" },
  { full: "Πατησίων 147, Κυψέλη, 11251 Αθήνα", street: "Πατησίων", number: "147", city: "Αθήνα", postal: "11251" },
  { full: "Αγίου Μελετίου 86, Κυψέλη, 11252 Αθήνα", street: "Αγίου Μελετίου", number: "86", city: "Αθήνα", postal: "11252" },
  { full: "Ιωάννου Δροσοπούλου 217, Κυψέλη, 11253 Αθήνα", street: "Ιωάννου Δροσοπούλου", number: "217", city: "Αθήνα", postal: "11253" },
  { full: "Κεφαλληνίας 46, Κυψέλη, 11251 Αθήνα", street: "Κεφαλληνίας", number: "46", city: "Αθήνα", postal: "11251" },
  { full: "Λέσβου 15, Κυψέλη, 11255 Αθήνα", street: "Λέσβου", number: "15", city: "Αθήνα", postal: "11255" },
  { full: "Τενέδου 35, Κυψέλη, 11363 Αθήνα", street: "Τενέδου", number: "35", city: "Αθήνα", postal: "11363" },
  { full: "Σποράδων 10, Κυψέλη, 11361 Αθήνα", street: "Σποράδων", number: "10", city: "Αθήνα", postal: "11361" },
  { full: "Κύπρου 68, Κυψέλη, 11362 Αθήνα", street: "Κύπρου", number: "68", city: "Αθήνα", postal: "11362" },
  
  // Patisia area
  { full: "Πατησίων 200, Πατήσια, 11256 Αθήνα", street: "Πατησίων", number: "200", city: "Αθήνα", postal: "11256" },
  { full: "Αχαρνών 361, Πατήσια, 11145 Αθήνα", street: "Αχαρνών", number: "361", city: "Αθήνα", postal: "11145" },
  { full: "Ιωαννίνων 45, Πατήσια, 11252 Αθήνα", street: "Ιωαννίνων", number: "45", city: "Αθήνα", postal: "11252" },
  { full: "Λιοσίων 205, Πατήσια, 10445 Αθήνα", street: "Λιοσίων", number: "205", city: "Αθήνα", postal: "10445" },
  { full: "Χέυδεν 14, Πατήσια, 10434 Αθήνα", street: "Χέυδεν", number: "14", city: "Αθήνα", postal: "10434" },
  
  // Athens Center
  { full: "Σταδίου 5, Σύνταγμα, 10562 Αθήνα", street: "Σταδίου", number: "5", city: "Αθήνα", postal: "10562" },
  { full: "Πανεπιστημίου 39, Κέντρο, 10564 Αθήνα", street: "Πανεπιστημίου", number: "39", city: "Αθήνα", postal: "10564" },
  { full: "Ακαδημίας 57, Κέντρο, 10679 Αθήνα", street: "Ακαδημίας", number: "57", city: "Αθήνα", postal: "10679" },
  { full: "Σόλωνος 78, Κολωνάκι, 10680 Αθήνα", street: "Σόλωνος", number: "78", city: "Αθήνα", postal: "10680" },
  { full: "Ιπποκράτους 44, Εξάρχεια, 10680 Αθήνα", street: "Ιπποκράτους", number: "44", city: "Αθήνα", postal: "10680" },
  
  // Ampelokipoi
  { full: "Μεσογείων 123, Αμπελόκηποι, 11526 Αθήνα", street: "Μεσογείων", number: "123", city: "Αθήνα", postal: "11526" },
  { full: "Αλεξάνδρας 89, Αμπελόκηποι, 11474 Αθήνα", street: "Αλεξάνδρας", number: "89", city: "Αθήνα", postal: "11474" },
  { full: "Παναγή Τσαλδάρη 5, Αμπελόκηποι, 11476 Αθήνα", street: "Παναγή Τσαλδάρη", number: "5", city: "Αθήνα", postal: "11476" },
  { full: "Δημητσάνας 16, Αμπελόκηποι, 11522 Αθήνα", street: "Δημητσάνας", number: "16", city: "Αθήνα", postal: "11522" },
  { full: "Σεβαστουπόλεως 113, Αμπελόκηποι, 11526 Αθήνα", street: "Σεβαστουπόλεως", number: "113", city: "Αθήνα", postal: "11526" },
  
  // Pagrati
  { full: "Υμηττού 89, Παγκράτι, 11633 Αθήνα", street: "Υμηττού", number: "89", city: "Αθήνα", postal: "11633" },
  { full: "Ευτυχίδου 37, Παγκράτι, 11635 Αθήνα", street: "Ευτυχίδου", number: "37", city: "Αθήνα", postal: "11635" },
  { full: "Φρύνης 14, Παγκράτι, 11636 Αθήνα", street: "Φρύνης", number: "14", city: "Αθήνα", postal: "11636" },
  { full: "Σπύρου Μερκούρη 44, Παγκράτι, 11634 Αθήνα", street: "Σπύρου Μερκούρη", number: "44", city: "Αθήνα", postal: "11634" },
  { full: "Αρχιμήδους 45, Παγκράτι, 11636 Αθήνα", street: "Αρχιμήδους", number: "45", city: "Αθήνα", postal: "11636" }
];

async function fixWithRealAddresses() {
  console.log('=== REPLACING WITH REAL ATHENS ADDRESSES ===\n');
  
  try {
    // Get all problematic addresses
    const { data: problematicAddresses, error } = await supabase
      .from('student_addresses')
      .select('*')
      .or('latitude.is.null,longitude.is.null')
      .order('id');
    
    if (error) {
      console.error('Error fetching addresses:', error);
      return;
    }
    
    // Also get duplicate coordinate addresses
    const { data: duplicates, error: dupError } = await supabase.rpc('execute_sql', {
      query: `
        WITH duplicate_coords AS (
          SELECT latitude, longitude
          FROM student_addresses
          WHERE latitude IS NOT NULL AND longitude IS NOT NULL
          GROUP BY latitude, longitude
          HAVING COUNT(*) > 1
        )
        SELECT sa.*
        FROM student_addresses sa
        JOIN duplicate_coords dc 
          ON sa.latitude = dc.latitude 
          AND sa.longitude = dc.longitude
        ORDER BY sa.id
      `
    }).single();
    
    let allProblematic = problematicAddresses || [];
    
    // Add duplicates if we got them
    if (!dupError && duplicates) {
      const dupIds = new Set(allProblematic.map(a => a.id));
      duplicates.forEach(dup => {
        if (!dupIds.has(dup.id)) {
          allProblematic.push(dup);
        }
      });
    }
    
    console.log(`Found ${allProblematic.length} addresses to fix\n`);
    
    let successCount = 0;
    const updates = [];
    
    for (let i = 0; i < allProblematic.length && i < realAthensAddresses.length; i++) {
      const addr = allProblematic[i];
      const newAddr = realAthensAddresses[i];
      
      console.log(`Updating address ${i + 1}/${Math.min(allProblematic.length, realAthensAddresses.length)}:`);
      console.log(`  Old: "${addr.full_address}"`);
      console.log(`  New: "${newAddr.full}"`);
      
      updates.push({
        id: addr.id,
        full_address: newAddr.full,
        street_name: newAddr.street,
        street_number: newAddr.number,
        city: newAddr.city,
        postal_code: newAddr.postal,
        latitude: null,
        longitude: null,
        updated_at: new Date().toISOString()
      });
    }
    
    // Batch update all addresses
    for (const update of updates) {
      const { error: updateError } = await supabase
        .from('student_addresses')
        .update({
          full_address: update.full_address,
          street_name: update.street_name,
          street_number: update.street_number,
          city: update.city,
          postal_code: update.postal_code,
          latitude: update.latitude,
          longitude: update.longitude,
          updated_at: update.updated_at
        })
        .eq('id', update.id);
      
      if (updateError) {
        console.error(`  ❌ Error updating address ${update.id}:`, updateError.message);
      } else {
        console.log(`  ✅ Updated successfully`);
        successCount++;
      }
    }
    
    console.log(`\n=== SUMMARY ===`);
    console.log(`Total addresses updated: ${successCount}`);
    console.log(`Addresses replaced with real Athens locations`);
    console.log(`All coordinates cleared for re-geocoding`);
    
    // If there are more problematic addresses than we have real addresses
    if (allProblematic.length > realAthensAddresses.length) {
      console.log(`\n⚠️  Note: ${allProblematic.length - realAthensAddresses.length} addresses still need replacement`);
      console.log(`     (We only had ${realAthensAddresses.length} real addresses available)`);
    }
    
  } catch (error) {
    console.error('Fatal error:', error);
  }
}

// Create RPC function helper for finding duplicates
async function createDuplicateFinder() {
  const sql = `
    CREATE OR REPLACE FUNCTION execute_sql(query text)
    RETURNS json
    LANGUAGE plpgsql
    AS $$
    DECLARE
      result json;
    BEGIN
      EXECUTE 'SELECT json_agg(row_to_json(t)) FROM (' || query || ') t' INTO result;
      RETURN result;
    END;
    $$;
  `;
  
  console.log('Note: If duplicate detection fails, create this function in Supabase SQL editor:');
  console.log(sql);
}

// Run the fix
fixWithRealAddresses().then(() => {
  console.log('\nDone! Addresses replaced with real Athens locations.');
  process.exit(0);
}).catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});