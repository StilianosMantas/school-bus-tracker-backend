const express = require('express');
const router = express.Router();
const { supabasePublic } = require('../../shared/database/supabase');
const { createServiceLogger } = require('../../shared/logger');
const { validateLogin, validateSignup } = require('./validators');
const { authenticateToken, authorizeRoles } = require('./middleware');

const logger = createServiceLogger('auth-service');

// Login endpoint
router.post('/login', validateLogin, async (req, res) => {
  try {
    const { email, password } = req.body;
    
    logger.info('Login attempt', { email });
    
    // Sign in with Supabase
    const { data, error } = await supabasePublic.auth.signInWithPassword({
      email,
      password
    });

    if (error) {
      logger.error('Login failed', { email, error: error.message });
      return res.status(401).json({ 
        error: 'Invalid credentials' 
      });
    }

    // Get user profile with role
    const { data: profile, error: profileError } = await supabasePublic
      .from('profiles')
      .select('*')
      .eq('id', data.user.id)
      .single();

    if (profileError) {
      logger.error('Profile fetch failed', { userId: data.user.id, error: profileError });
    }

    logger.info('Login successful', { email, userId: data.user.id });

    res.json({
      user: {
        id: data.user.id,
        email: data.user.email,
        role: profile?.role || 'parent',
        fullName: profile?.full_name,
        phone: profile?.phone
      },
      session: data.session
    });
  } catch (error) {
    logger.error('Login error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Signup endpoint (admin only can create new users)
router.post('/signup', authenticateToken, authorizeRoles(['admin']), validateSignup, async (req, res) => {
  try {
    const { email, password, fullName, role, phone } = req.body;
    
    logger.info('Signup attempt', { email, role, createdBy: req.user.id });
    
    // Create user in Supabase
    const { data, error } = await supabasePublic.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        full_name: fullName
      }
    });

    if (error) {
      logger.error('Signup failed', { email, error: error.message });
      return res.status(400).json({ 
        error: error.message 
      });
    }

    // Create profile
    const { error: profileError } = await supabasePublic
      .from('profiles')
      .insert({
        id: data.user.id,
        email,
        full_name: fullName,
        role,
        phone
      });

    if (profileError) {
      logger.error('Profile creation failed', { userId: data.user.id, error: profileError });
      // Note: User is created but profile failed - needs cleanup
    }

    logger.info('Signup successful', { email, userId: data.user.id, role });

    res.status(201).json({
      user: {
        id: data.user.id,
        email: data.user.email,
        role,
        fullName,
        phone
      }
    });
  } catch (error) {
    logger.error('Signup error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Logout endpoint
router.post('/logout', authenticateToken, async (req, res) => {
  try {
    logger.info('Logout attempt', { userId: req.user.id });
    
    const { error } = await supabasePublic.auth.signOut();
    
    if (error) {
      logger.error('Logout failed', { userId: req.user.id, error: error.message });
      return res.status(400).json({ error: error.message });
    }

    logger.info('Logout successful', { userId: req.user.id });
    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    logger.error('Logout error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get current user endpoint
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const { data: profile, error } = await supabasePublic
      .from('profiles')
      .select('*')
      .eq('id', req.user.id)
      .single();

    if (error) {
      logger.error('Profile fetch failed', { userId: req.user.id, error });
      return res.status(404).json({ error: 'Profile not found' });
    }

    res.json({
      user: {
        id: profile.id,
        email: profile.email,
        role: profile.role,
        fullName: profile.full_name,
        phone: profile.phone
      }
    });
  } catch (error) {
    logger.error('Get user error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update profile endpoint
router.put('/profile', authenticateToken, async (req, res) => {
  try {
    const { fullName, phone } = req.body;
    const updates = {};
    
    if (fullName !== undefined) updates.full_name = fullName;
    if (phone !== undefined) updates.phone = phone;
    
    const { data, error } = await supabasePublic
      .from('profiles')
      .update(updates)
      .eq('id', req.user.id)
      .select()
      .single();

    if (error) {
      logger.error('Profile update failed', { userId: req.user.id, error });
      return res.status(400).json({ error: error.message });
    }

    logger.info('Profile updated', { userId: req.user.id });

    res.json({
      user: {
        id: data.id,
        email: data.email,
        role: data.role,
        fullName: data.full_name,
        phone: data.phone
      }
    });
  } catch (error) {
    logger.error('Update profile error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;