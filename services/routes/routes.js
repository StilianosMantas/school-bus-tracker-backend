const express = require('express');
const router = express.Router();
const { supabase } = require('../../shared/database/supabase');
const { createServiceLogger } = require('../../shared/logger');
const { authenticateToken, authorizeRoles } = require('../auth/middleware');
const Joi = require('joi');

const logger = createServiceLogger('routes-service');

// Validation schemas
const routeSchema = Joi.object({
  name: Joi.string().min(3).max(100).required(),
  description: Joi.string().max(500).optional(),
  type: Joi.string().valid('regular', 'field_trip', 'special').default('regular'),
  is_active: Joi.boolean().default(true)
});

const stopSchema = Joi.object({
  name: Joi.string().min(2).max(100).required(),
  address: Joi.string().max(200).required(),
  latitude: Joi.number().min(-90).max(90).required(),
  longitude: Joi.number().min(-180).max(180).required(),
  stop_order: Joi.number().integer().min(1).required(),
  scheduled_time: Joi.string().pattern(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$/).required()
});

const scheduleSchema = Joi.object({
  route_id: Joi.string().uuid().required(),
  bus_id: Joi.string().uuid().required(),
  driver_id: Joi.string().uuid().required(),
  date: Joi.date().iso().required(),
  start_time: Joi.string().pattern(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$/).optional(),
  end_time: Joi.string().pattern(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$/).optional()
});

// Health check
router.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'routes',
    message: 'Routes service is running' 
  });
});

// Get all routes
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { type, is_active } = req.query;
    
    let query = supabase
      .from('routes')
      .select(`
        *,
        stops(*)
      `)
      .order('name');

    if (type) {
      query = query.eq('type', type);
    }
    if (is_active !== undefined) {
      query = query.eq('is_active', is_active === 'true');
    }

    const { data, error } = await query;

    if (error) {
      logger.error('Failed to fetch routes', { error });
      return res.status(500).json({ error: 'Failed to fetch routes' });
    }

    // Sort stops by order
    data.forEach(route => {
      if (route.stops) {
        route.stops.sort((a, b) => a.stop_order - b.stop_order);
      }
    });

    res.json({ data });
  } catch (error) {
    logger.error('Get routes error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get route by ID
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('routes')
      .select(`
        *,
        stops(*)
      `)
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Route not found' });
      }
      logger.error('Failed to fetch route', { error });
      return res.status(500).json({ error: 'Failed to fetch route' });
    }

    // Sort stops by order
    if (data.stops) {
      data.stops.sort((a, b) => a.stop_order - b.stop_order);
    }

    res.json({ data });
  } catch (error) {
    logger.error('Get route error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create new route (Admin only)
router.post('/', authenticateToken, authorizeRoles(['admin']), async (req, res) => {
  try {
    const { error: validationError, value } = routeSchema.validate(req.body);
    if (validationError) {
      return res.status(400).json({ error: validationError.details[0].message });
    }

    const { data, error } = await supabase
      .from('routes')
      .insert(value)
      .select()
      .single();

    if (error) {
      logger.error('Failed to create route', { error });
      return res.status(500).json({ error: 'Failed to create route' });
    }

    logger.info('Route created', { routeId: data.id, userId: req.user.id });

    res.status(201).json({ data });
  } catch (error) {
    logger.error('Create route error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update route (Admin only)
router.put('/:id', authenticateToken, authorizeRoles(['admin']), async (req, res) => {
  try {
    const { id } = req.params;
    const updates = {};

    // Validate and pick allowed fields
    const allowedFields = ['name', 'description', 'type', 'is_active'];
    allowedFields.forEach(field => {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    });

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const { data, error } = await supabase
      .from('routes')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Route not found' });
      }
      logger.error('Failed to update route', { error });
      return res.status(500).json({ error: 'Failed to update route' });
    }

    logger.info('Route updated', { routeId: id, userId: req.user.id });

    res.json({ data });
  } catch (error) {
    logger.error('Update route error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete route (Admin only)
router.delete('/:id', authenticateToken, authorizeRoles(['admin']), async (req, res) => {
  try {
    const { id } = req.params;

    // Check if route has active schedules
    const { data: schedules } = await supabase
      .from('schedules')
      .select('id')
      .eq('route_id', id)
      .eq('status', 'in_progress')
      .limit(1);

    if (schedules && schedules.length > 0) {
      return res.status(400).json({ 
        error: 'Cannot delete route with active schedules' 
      });
    }

    const { error } = await supabase
      .from('routes')
      .delete()
      .eq('id', id);

    if (error) {
      logger.error('Failed to delete route', { error });
      return res.status(500).json({ error: 'Failed to delete route' });
    }

    logger.info('Route deleted', { routeId: id, userId: req.user.id });

    res.json({ message: 'Route deleted successfully' });
  } catch (error) {
    logger.error('Delete route error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Add stop to route (Admin only)
router.post('/:routeId/stops', authenticateToken, authorizeRoles(['admin']), async (req, res) => {
  try {
    const { routeId } = req.params;
    const { error: validationError, value } = stopSchema.validate(req.body);
    
    if (validationError) {
      return res.status(400).json({ error: validationError.details[0].message });
    }

    // Check if route exists
    const { data: route } = await supabase
      .from('routes')
      .select('id')
      .eq('id', routeId)
      .single();

    if (!route) {
      return res.status(404).json({ error: 'Route not found' });
    }

    // Check if stop_order already exists
    const { data: existingStop } = await supabase
      .from('stops')
      .select('id')
      .eq('route_id', routeId)
      .eq('stop_order', value.stop_order)
      .single();

    if (existingStop) {
      return res.status(400).json({ 
        error: 'Stop order already exists. Please reorder stops first.' 
      });
    }

    const { data, error } = await supabase
      .from('stops')
      .insert({
        ...value,
        route_id: routeId
      })
      .select()
      .single();

    if (error) {
      logger.error('Failed to add stop', { error });
      return res.status(500).json({ error: 'Failed to add stop' });
    }

    logger.info('Stop added', { 
      stopId: data.id, 
      routeId, 
      userId: req.user.id 
    });

    res.status(201).json({ data });
  } catch (error) {
    logger.error('Add stop error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update stop (Admin only)
router.put('/:routeId/stops/:stopId', authenticateToken, authorizeRoles(['admin']), async (req, res) => {
  try {
    const { routeId, stopId } = req.params;
    const updates = {};

    // Validate and pick allowed fields
    const allowedFields = ['name', 'address', 'latitude', 'longitude', 'stop_order', 'scheduled_time'];
    allowedFields.forEach(field => {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    });

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const { data, error } = await supabase
      .from('stops')
      .update(updates)
      .eq('id', stopId)
      .eq('route_id', routeId)
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Stop not found' });
      }
      logger.error('Failed to update stop', { error });
      return res.status(500).json({ error: 'Failed to update stop' });
    }

    logger.info('Stop updated', { stopId, routeId, userId: req.user.id });

    res.json({ data });
  } catch (error) {
    logger.error('Update stop error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete stop (Admin only)
router.delete('/:routeId/stops/:stopId', authenticateToken, authorizeRoles(['admin']), async (req, res) => {
  try {
    const { routeId, stopId } = req.params;

    const { error } = await supabase
      .from('stops')
      .delete()
      .eq('id', stopId)
      .eq('route_id', routeId);

    if (error) {
      logger.error('Failed to delete stop', { error });
      return res.status(500).json({ error: 'Failed to delete stop' });
    }

    logger.info('Stop deleted', { stopId, routeId, userId: req.user.id });

    res.json({ message: 'Stop deleted successfully' });
  } catch (error) {
    logger.error('Delete stop error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get schedules for a route
router.get('/:routeId/schedules', authenticateToken, async (req, res) => {
  try {
    const { routeId } = req.params;
    const { date, status } = req.query;

    let query = supabase
      .from('schedules')
      .select(`
        *,
        buses(*),
        driver:profiles!driver_id(*)
      `)
      .eq('route_id', routeId)
      .order('date', { ascending: false });

    if (date) {
      query = query.eq('date', date);
    }
    if (status) {
      query = query.eq('status', status);
    }

    const { data, error } = await query;

    if (error) {
      logger.error('Failed to fetch schedules', { error });
      return res.status(500).json({ error: 'Failed to fetch schedules' });
    }

    res.json({ data });
  } catch (error) {
    logger.error('Get schedules error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create schedule (Admin/Dispatcher only)
router.post('/schedule', authenticateToken, authorizeRoles(['admin', 'dispatcher']), async (req, res) => {
  try {
    const { error: validationError, value } = scheduleSchema.validate(req.body);
    if (validationError) {
      return res.status(400).json({ error: validationError.details[0].message });
    }

    // Check for conflicts
    const { data: existingSchedule } = await supabase
      .from('schedules')
      .select('id')
      .eq('date', value.date)
      .or(`bus_id.eq.${value.bus_id},driver_id.eq.${value.driver_id}`)
      .eq('status', 'scheduled')
      .single();

    if (existingSchedule) {
      return res.status(400).json({ 
        error: 'Bus or driver already scheduled for this date' 
      });
    }

    const { data, error } = await supabase
      .from('schedules')
      .insert({
        ...value,
        status: 'scheduled'
      })
      .select()
      .single();

    if (error) {
      logger.error('Failed to create schedule', { error });
      return res.status(500).json({ error: 'Failed to create schedule' });
    }

    logger.info('Schedule created', { 
      scheduleId: data.id, 
      userId: req.user.id 
    });

    res.status(201).json({ data });
  } catch (error) {
    logger.error('Create schedule error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get driver's schedules
router.get('/driver/schedules', authenticateToken, authorizeRoles(['driver']), async (req, res) => {
  try {
    const { date } = req.query;
    
    let query = supabase
      .from('schedules')
      .select(`
        *,
        routes(*),
        buses(*),
        stops!inner(*)
      `)
      .eq('driver_id', req.user.id)
      .order('date', { ascending: false })
      .order('start_time');

    if (date) {
      query = query.eq('date', date);
    } else {
      // Default to today and future
      query = query.gte('date', new Date().toISOString().split('T')[0]);
    }

    const { data, error } = await query;

    if (error) {
      logger.error('Failed to fetch driver schedules', { error });
      return res.status(500).json({ error: 'Failed to fetch schedules' });
    }

    // Organize stops by route
    data.forEach(schedule => {
      if (schedule.stops) {
        schedule.stops.sort((a, b) => a.stop_order - b.stop_order);
      }
    });

    res.json({ data });
  } catch (error) {
    logger.error('Get driver schedules error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;