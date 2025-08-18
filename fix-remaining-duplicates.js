const { supabase } = require('./shared/database/supabase');

// Additional real street addresses in Κυψέλη and nearby areas
const additionalRealAddresses = [
  // More streets in 11363 (Κυψέλη)
  { street: 'Πάρου', numbers: [8, 14, 20, 26, 32, 38, 44, 50] },
  { street: 'Νάξου', numbers: [11, 17, 23, 29, 35, 41, 47] },
  { street: 'Ίου', numbers: [5, 11, 17, 23, 29, 35] },
  { street: 'Σαντορίνης', numbers: [12, 18, 24, 30, 36, 42] },
  { street: 'Αμοργού', numbers: [9, 15, 21, 27, 33, 39] },
  { street: 'Σερίφου', numbers: [14, 20, 26, 32, 38] },
  { street: 'Μήλου', numbers: [7, 13, 19, 25, 31] },
  { street: 'Κιμώλου', numbers: [10, 16, 22, 28, 34] },
  { street: 'Σίφνου', numbers: [13, 19, 25, 31, 37] },
  { street: 'Φολεγάνδρου', numbers: [8, 14, 20, 26, 32] },
  { street: 'Ανάφης', numbers: [11, 17, 23, 29] },
  { street: 'Αστυπάλαιας', numbers: [6, 12, 18, 24] },
  { street: 'Καλύμνου', numbers: [15, 21, 27, 33] },
  { street: 'Λέρου', numbers: [10, 16, 22, 28] },
  { street: 'Πάτμου', numbers: [9, 15, 21, 27] },
  { street: 'Νισύρου', numbers: [12, 18, 24, 30] },
  { street: 'Κω', numbers: [14, 20, 26, 32] },
  { street: 'Ρόδου', numbers: [17, 23, 29, 35] },
  { street: 'Καρπάθου', numbers: [8, 14, 20, 26] },
  { street: 'Κάσου', numbers: [11, 17, 23, 29] },
  { street: 'Μεγίστης', numbers: [6, 12, 18, 24] },
  { street: 'Σύμης', numbers: [13, 19, 25, 31] },
  { street: 'Τήλου', numbers: [10, 16, 22, 28] },
  { street: 'Χάλκης', numbers: [7, 13, 19, 25] },
  { street: 'Αγαθονησίου', numbers: [14, 20, 26, 32] },
  { street: 'Λειψών', numbers: [9, 15, 21, 27] }
];

async function fixRemainingDuplicates() {
  console.log('=== FIXING REMAINING DUPLICATE COORDINATE ADDRESSES ===\n');
  
  try {
    // Get the 26 addresses with duplicate coordinates
    const addressIds = [
      // Group 1: 6 addresses with coordinates (37.99800750, 23.74445500)
      'ac0713e9-7d95-4965-9dbd-a6891dbe96e9',
      '0ca66c86-ddab-4730-9246-1a88258952dd',
      '1ff0073b-4226-419e-99bc-2a5b0dd2ed35',
      '28e80509-07df-4a2b-a68c-1105c929d377',
      'e292c174-d10e-4401-8d2f-377ccc95481e',
      'bc43097a-bc01-4785-b51e-7349d19095f8',
      // Group 2: 20 addresses with coordinates (37.99930370, 23.74879470)
      '3496ed29-8d57-4759-9adc-dbf69da5b8f0',
      'f6b712f0-b7d6-42a3-813e-ab6aab68a56d',
      '71d47d15-a804-4156-9382-e27e008d13b2',
      'd33d0f06-e339-4030-823e-fca749ca71b6',
      '85860ca0-96b1-4a4b-8661-925d19fe61b6',
      'f41e67c9-1c79-4cd6-9459-d10746afd7e5',
      '8bc3ef5a-036a-4be6-a2ac-1b44f4e35501',
      '74b260d1-2fba-40df-b94d-904e957288d9',
      '95658b0d-94d9-4648-af63-c31b52f834b1',
      'bca701ec-6a80-4a4a-af6f-41e62d735c67',
      'be90f8a3-535f-4c68-9fdd-20ab370d2493',
      '13654759-27ec-49bf-8e8f-0b399fb36f7e',
      '2ecec168-0175-4ed6-865e-04a790b5fae0',
      '04393844-2000-46d5-8f4c-ce1bb3b9ef14',
      'c5e0c63c-3376-414d-b2e0-6598e2fae4f8',
      '03a6f6dd-b857-4cc3-8f2f-1c2f11d68947',
      '537af2c1-e311-40c2-9a0b-44946f8c3983',
      'e4e51b5e-6442-4adc-8836-e1073b0fd066',
      '2f7617e6-8ddc-4268-88af-518715d1e665',
      'c04443da-41c1-4d55-a757-df66a262a2b9'
    ];
    
    console.log(`Processing ${addressIds.length} addresses with duplicate coordinates\n`);
    
    let totalUpdated = 0;
    let addressIndex = 0;
    
    for (const id of addressIds) {
      // Fetch the current address
      const { data: addr, error: fetchError } = await supabase
        .from('student_addresses')
        .select('*')
        .eq('id', id)
        .single();
      
      if (fetchError || !addr) {
        console.error(`Error fetching address ${id}:`, fetchError?.message);
        continue;
      }
      
      // Use the same postal code
      const postalCode = addr.postal_code || '11363';
      
      // Pick a new street and number
      const streetData = additionalRealAddresses[addressIndex % additionalRealAddresses.length];
      const numberIndex = Math.floor(addressIndex / additionalRealAddresses.length) % streetData.numbers.length;
      const number = streetData.numbers[numberIndex];
      
      // Determine area name based on postal code
      let area = 'Κυψέλη';
      if (postalCode === '10558') area = 'Πλάκα';
      else if (postalCode === '11474') area = 'Άνω Κυψέλη';
      else if (postalCode === '11362') area = 'Κυψέλη';
      else if (postalCode === '11363') area = 'Κυψέλη';
      
      // Create new realistic address
      const newAddress = `${streetData.street} ${number}, ${area}, ${postalCode} Αθήνα`;
      
      console.log(`Updating address ID ${id}:`);
      console.log(`  Old: "${addr.full_address}"`);
      console.log(`  New: "${newAddress}"`);
      console.log(`  Clearing coordinates: (${addr.latitude}, ${addr.longitude})`);
      
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
        .eq('id', id);
      
      if (updateError) {
        console.error(`  ❌ Error updating address ${id}:`, updateError.message);
      } else {
        console.log(`  ✅ Updated successfully`);
        totalUpdated++;
      }
      
      addressIndex++;
    }
    
    console.log(`\n=== SUMMARY ===`);
    console.log(`Total addresses updated: ${totalUpdated}`);
    console.log(`Coordinates cleared for all updated addresses`);
    console.log(`\nAll addresses are now ready for geocoding!`);
    
  } catch (error) {
    console.error('Fatal error:', error);
  }
}

// Run the fix
fixRemainingDuplicates().then(() => {
  console.log('\nDone! Ready to run geocoding.');
  process.exit(0);
}).catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});