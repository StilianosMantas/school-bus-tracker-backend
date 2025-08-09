const express = require('express');
const router = express.Router();
const { supabase, supabasePublic } = require('../../shared/database/supabase');
const { createServiceLogger } = require('../../shared/logger');
const { validateLogin, validateSignup } = require('./validators');
const { authenticateToken, authorizeRoles } = require('./middleware');
const Joi = require('joi');

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

// User validation schema
const userSchema = Joi.object({
  email: Joi.string().email().required(),
  full_name: Joi.string().min(2).max(100).required(),
  phone: Joi.string().pattern(/^(\+30)?[0-9]{10}$/).optional().allow(''),
  role: Joi.string().valid('admin', 'dispatcher', 'driver', 'parent').required()
});

// Get all users (Admin only)
router.get('/users', authenticateToken, authorizeRoles(['admin']), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select(`
        id,
        email,
        full_name,
        phone,
        role,
        created_at,
        updated_at
      `)
      .order('created_at', { ascending: false });

    if (error) {
      logger.error('Failed to fetch users', { error });
      return res.status(500).json({ error: 'Failed to fetch users' });
    }

    // Get auth info for each user
    const usersWithAuth = await Promise.all(data.map(async (user) => {
      try {
        const { data: authUser } = await supabase.auth.admin.getUserById(user.id);
        return {
          ...user,
          email_confirmed_at: authUser.user?.email_confirmed_at || null,
          last_sign_in_at: authUser.user?.last_sign_in_at || null
        };
      } catch (authError) {
        return {
          ...user,
          email_confirmed_at: null,
          last_sign_in_at: null
        };
      }
    }));

    res.json({ data: usersWithAuth });
  } catch (error) {
    logger.error('Get users error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create new user (Admin only)
router.post('/users', authenticateToken, authorizeRoles(['admin']), async (req, res) => {
  try {
    const { error: validationError, value } = userSchema.validate(req.body);
    if (validationError) {
      return res.status(400).json({ error: validationError.details[0].message });
    }

    const { email, full_name, phone, role } = value;

    // Create user in Supabase Auth
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password: Math.random().toString(36).slice(-12), // Temporary random password
      email_confirm: true,
      user_metadata: {
        full_name
      }
    });

    if (authError) {
      logger.error('Failed to create auth user', { error: authError });
      return res.status(400).json({ error: authError.message });
    }

    // Send welcome email with magic link for new users
    const redirectUrl = role === 'driver' ? 
      `${process.env.REACT_APP_DRIVER_URL || 'http://localhost:3002'}/welcome` :
      role === 'parent' ?
      `${process.env.REACT_APP_PARENT_URL || 'http://localhost:3001'}/welcome` :
      `${process.env.REACT_APP_ADMIN_URL || 'http://localhost:3003'}/welcome`;

    const { data: magicLinkData, error: magicLinkError } = await supabase.auth.admin.generateLink({
      type: 'magiclink',
      email,
      options: {
        redirectTo: redirectUrl
      }
    });

    if (magicLinkError) {
      logger.warn('Failed to send welcome magic link to new user', { 
        error: magicLinkError, 
        email, 
        role 
      });
      // Don't fail user creation if email fails, just log it
    } else {
      logger.info('Welcome magic link sent to new user', { 
        email, 
        role,
        magicLink: magicLinkData.properties?.action_link 
      });
    }

    // Update the existing profile created by the trigger, or create if doesn't exist
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .upsert({
        id: authData.user.id,
        email,
        full_name,
        phone: phone || null,
        role
      })
      .select()
      .single();

    if (profileError) {
      logger.error('Failed to create/update profile', { error: profileError });
      // Cleanup: delete the auth user
      await supabase.auth.admin.deleteUser(authData.user.id);
      return res.status(500).json({ error: 'Failed to create user profile' });
    }

    logger.info('User created', { userId: profile.id, email, role, createdBy: req.user.id });

    res.status(201).json({ 
      data: {
        ...profile,
        email_confirmed_at: authData.user.email_confirmed_at
      },
      message: `${role === 'driver' ? 'Οδηγός' : role === 'parent' ? 'Γονέας' : 'Χρήστης'} δημιουργήθηκε επιτυχώς. Θα λάβει email καλωσορίσματος με σύνδεσμο για πρόσβαση στην εφαρμογή.`
    });
  } catch (error) {
    logger.error('Create user error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update user (Admin only)
router.put('/users/:id', authenticateToken, authorizeRoles(['admin']), async (req, res) => {
  try {
    const { id } = req.params;
    const updates = {};

    // Validate and pick allowed fields
    const allowedFields = ['full_name', 'phone', 'role'];
    allowedFields.forEach(field => {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    });

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const { data, error } = await supabase
      .from('profiles')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'User not found' });
      }
      logger.error('Failed to update user', { error });
      return res.status(500).json({ error: 'Failed to update user' });
    }

    logger.info('User updated', { userId: id, updatedBy: req.user.id });

    res.json({ data });
  } catch (error) {
    logger.error('Update user error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete user (Admin only)
router.delete('/users/:id', authenticateToken, authorizeRoles(['admin']), async (req, res) => {
  try {
    const { id } = req.params;

    // Don't allow deletion of current user
    if (id === req.user.id) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }

    // Check if user has related data (students, etc.)
    const { data: students } = await supabase
      .from('students')
      .select('id')
      .eq('parent_id', id)
      .limit(1);

    if (students && students.length > 0) {
      return res.status(400).json({ 
        error: 'Cannot delete user with associated students' 
      });
    }

    // Delete from profiles table
    const { error: profileError } = await supabase
      .from('profiles')
      .delete()
      .eq('id', id);

    if (profileError) {
      logger.error('Failed to delete user profile', { error: profileError });
      return res.status(500).json({ error: 'Failed to delete user' });
    }

    // Delete from Supabase Auth
    const { error: authError } = await supabase.auth.admin.deleteUser(id);
    if (authError) {
      logger.error('Failed to delete auth user', { error: authError });
      // Profile is already deleted, log but don't fail
    }

    logger.info('User deleted', { userId: id, deletedBy: req.user.id });

    res.json({ message: 'User deleted successfully' });
  } catch (error) {
    logger.error('Delete user error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;