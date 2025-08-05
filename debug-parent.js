const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '../.env' });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

async function testParentEndpoints() {
  try {
    // Sign in as parent
    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
      email: 'parent1@schoolbus.gr',
      password: 'password123'
    });

    if (authError) {
      console.error('Auth error:', authError);
      return;
    }

    console.log('✓ Authenticated as parent');
    console.log('User ID:', authData.user.id);
    console.log('Access token:', authData.session.access_token.substring(0, 20) + '...');

    // Test students endpoint
    try {
      const response = await axios.get(`http://localhost:3000/api/students/parent/${authData.user.id}`, {
        headers: {
          'Authorization': `Bearer ${authData.session.access_token}`
        }
      });
      console.log('\n✓ Students endpoint response:', response.data);
    } catch (error) {
      console.error('\n✗ Students endpoint error:', error.response?.data || error.message);
      if (error.response) {
        console.error('Status:', error.response.status);
        console.error('Headers:', error.response.headers);
      }
    }

    // Test notifications endpoint
    try {
      const response = await axios.get(`http://localhost:3000/api/notifications/parent/${authData.user.id}`, {
        headers: {
          'Authorization': `Bearer ${authData.session.access_token}`
        }
      });
      console.log('\n✓ Notifications endpoint response:', response.data);
    } catch (error) {
      console.error('\n✗ Notifications endpoint error:', error.response?.data || error.message);
      if (error.response) {
        console.error('Status:', error.response.status);
      }
    }

    // Sign out
    await supabase.auth.signOut();
    console.log('\n✓ Signed out');

  } catch (error) {
    console.error('Test error:', error);
  }
}

testParentEndpoints();