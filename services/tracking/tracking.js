const express = require('express');
const router = express.Router();
const { supabase } = require('../../shared/database/supabase');
const { createServiceLogger } = require('../../shared/logger');
const { authenticateToken, authorizeRoles } = require('../auth/middleware');

const logger = createServiceLogger('tracking-service');

// Health check
router.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'tracking',
    message: 'Tracking service is running' 
  });
});

// Get route progress for a specific date
router.get('/route-progress', authenticateToken, async (req, res) => {
  try {
    const { date, route_id, status } = req.query;
    const targetDate = date || new Date().toISOString().split('T')[0];

    let query = supabase
      .from('route_progress')
      .select(`
        *,
        routes(name, route_direction, estimated_duration_minutes),
        current_stop:stops!current_stop_id(name, stop_order),
        student_boarding(
          id, student_name, action, timestamp, 
          stop:stops(name, stop_order)
        )
      `)
      .eq('date', targetDate)
      .order('created_at');

    if (route_id) query = query.eq('route_id', route_id);
    if (status) query = query.eq('status', status);

    const { data, error } = await query;

    if (error) {
      logger.error('Failed to fetch route progress', { error });
      return res.status(500).json({ error: 'Failed to fetch route progress' });
    }

    // Calculate ETAs for in_progress routes
    const progressWithETA = await Promise.all(data.map(async (progress) => {
      if (progress.status === 'in_progress') {
        const { data: etaData, error: etaError } = await supabase
          .rpc('calculate_route_eta', { p_route_progress_id: progress.id });
        
        if (!etaError) {
          progress.estimated_eta = etaData;
        }
      }
      return progress;
    }));

    res.json({ data: progressWithETA, date: targetDate });
  } catch (error) {
    logger.error('Get route progress error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Start a route
router.post('/route-progress/:route_id/start', authenticateToken, authorizeRoles(['driver', 'admin', 'dispatcher']), async (req, res) => {
  try {
    const { route_id } = req.params;
    const { current_location, schedule_id } = req.body;
    const today = new Date().toISOString().split('T')[0];

    // Check if route progress already exists for today
    const { data: existing } = await supabase
      .from('route_progress')
      .select('*')
      .eq('route_id', route_id)
      .eq('date', today)
      .single();

    if (existing) {
      return res.status(400).json({ error: 'Route already started today' });
    }

    // Create route progress record
    const { data, error } = await supabase
      .from('route_progress')
      .insert({
        route_id,
        schedule_id: schedule_id || null,
        date: today,
        status: 'in_progress',
        actual_start_time: new Date().toISOString(),
        current_location: current_location || null,
        total_students_onboard: 0
      })
      .select()
      .single();

    if (error) {
      logger.error('Failed to start route', { error });
      return res.status(500).json({ error: 'Failed to start route' });
    }

    logger.info('Route started', { 
      routeId: route_id, 
      progressId: data.id,
      userId: req.user.id 
    });

    res.status(201).json({ data });
  } catch (error) {
    logger.error('Start route error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update route location
router.put('/route-progress/:id/location', authenticateToken, authorizeRoles(['driver', 'admin', 'dispatcher']), async (req, res) => {
  try {
    const { id } = req.params;
    const { current_location, current_stop_id } = req.body;

    const updateData = {
      current_location,
      updated_at: new Date().toISOString()
    };

    if (current_stop_id !== undefined) {
      updateData.current_stop_id = current_stop_id;
    }

    const { data, error } = await supabase
      .from('route_progress')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      logger.error('Failed to update route location', { error });
      return res.status(500).json({ error: 'Failed to update route location' });
    }

    res.json({ data });
  } catch (error) {
    logger.error('Update route location error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Record student boarding/offboarding
router.post('/route-progress/:id/student-boarding', authenticateToken, authorizeRoles(['driver', 'admin', 'dispatcher']), async (req, res) => {
  try {
    const { id: route_progress_id } = req.params;
    const { student_name, stop_id, action, notes } = req.body;

    if (!student_name || !stop_id || !action) {
      return res.status(400).json({ error: 'Student name, stop ID, and action are required' });
    }

    const { data, error } = await supabase
      .from('student_boarding')
      .insert({
        route_progress_id,
        student_name,
        stop_id,
        action,
        notes,
        created_by: req.user.id
      })
      .select(`
        *,
        stop:stops(name, stop_order)
      `)
      .single();

    if (error) {
      logger.error('Failed to record student boarding', { error });
      return res.status(500).json({ error: 'Failed to record student boarding' });
    }

    // Update total students onboard
    if (action === 'board') {
      await supabase.rpc('increment', { 
        table_name: 'route_progress',
        column_name: 'total_students_onboard',
        row_id: route_progress_id 
      });
    } else if (action === 'offboard') {
      await supabase.rpc('decrement', { 
        table_name: 'route_progress',
        column_name: 'total_students_onboard', 
        row_id: route_progress_id 
      });
    }

    logger.info('Student boarding recorded', { 
      routeProgressId: route_progress_id,
      studentName: student_name,
      action,
      userId: req.user.id 
    });

    res.status(201).json({ data });
  } catch (error) {
    logger.error('Record student boarding error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Complete a route
router.put('/route-progress/:id/complete', authenticateToken, authorizeRoles(['driver', 'admin', 'dispatcher']), async (req, res) => {
  try {
    const { id } = req.params;
    const { final_location } = req.body;

    const { data, error } = await supabase
      .from('route_progress')
      .update({
        status: 'completed',
        actual_end_time: new Date().toISOString(),
        current_location: final_location || null,
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      logger.error('Failed to complete route', { error });
      return res.status(500).json({ error: 'Failed to complete route' });
    }

    logger.info('Route completed', { 
      routeProgressId: id,
      userId: req.user.id 
    });

    res.json({ data });
  } catch (error) {
    logger.error('Complete route error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get predefined locations
router.get('/predefined-locations', authenticateToken, async (req, res) => {
  try {
    const { category, is_active = true } = req.query;

    let query = supabase
      .from('predefined_locations')
      .select('*')
      .eq('is_active', is_active)
      .order('category', { ascending: true })
      .order('name', { ascending: true });

    if (category) {
      query = query.eq('category', category);
    }

    const { data: locations, error } = await query;

    if (error) {
      logger.error('Failed to fetch predefined locations', { error });
      return res.status(500).json({ error: 'Failed to fetch predefined locations' });
    }

    // Get settings to match category display names
    const { data: settings } = await supabase
      .from('settings')
      .select('key, value')
      .like('key', 'location_category_%');

    // Create category display name mapping from settings
    const categoryMap = {};
    settings?.forEach(setting => {
      if (setting.key.startsWith('location_category_')) {
        const category = setting.key.replace('location_category_', '');
        try {
          const value = JSON.parse(setting.value);
          categoryMap[category] = value.display_name;
        } catch (e) {
          // If parsing fails, use the value as is
          categoryMap[category] = setting.value;
        }
      }
    });

    // Enhance locations with display names from settings
    const enhancedLocations = locations?.map(location => ({
      ...location,
      category_display_name: categoryMap[location.category] || location.category
    }));

    res.json({ data: enhancedLocations });
  } catch (error) {
    logger.error('Get predefined locations error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create predefined location (Admin only)
router.post('/predefined-locations', authenticateToken, authorizeRoles(['admin']), async (req, res) => {
  try {
    const { name, category, address, latitude, longitude, description } = req.body;

    if (!name || !category || !address || !latitude || !longitude) {
      return res.status(400).json({ error: 'Name, category, address, latitude, and longitude are required' });
    }

    const { data, error } = await supabase
      .from('predefined_locations')
      .insert({
        name,
        category,
        address,
        latitude,
        longitude,
        description
      })
      .select()
      .single();

    if (error) {
      logger.error('Failed to create predefined location', { error });
      return res.status(500).json({ error: 'Failed to create predefined location' });
    }

    logger.info('Predefined location created', { 
      locationId: data.id,
      name,
      userId: req.user.id 
    });

    res.status(201).json({ data });
  } catch (error) {
    logger.error('Create predefined location error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;