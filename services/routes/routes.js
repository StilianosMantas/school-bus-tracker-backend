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
  description: Joi.string().max(500).allow(null, '').optional(),
  type: Joi.string().valid('regular', 'field_trip', 'special').default('regular'),
  route_direction: Joi.string().valid('pickup', 'dropoff', 'circular').default('pickup'),
  is_active: Joi.boolean().default(true),
  driver_id: Joi.string().uuid().allow(null).optional(),
  bus_id: Joi.string().uuid().allow(null).optional()
});

const stopSchema = Joi.object({
  name: Joi.string().min(2).max(100).required(),
  address: Joi.string().max(200).required(),
  latitude: Joi.number().min(-90).max(90).required(),
  longitude: Joi.number().min(-180).max(180).required(),
  stop_order: Joi.number().integer().min(1).required(),
  scheduled_time: Joi.string().pattern(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$/).required(),
  notes: Joi.string().max(500).allow(null, '').optional()
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

// Debug endpoint for driver schedules
router.get('/driver/debug', authenticateToken, authorizeRoles(['driver']), async (req, res) => {
  try {
    const driverId = req.user.id;
    const debug = {};
    
    // Check if driver exists
    const { data: profile } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', driverId)
      .single();
    debug.driver = profile;
    
    // Check routes assigned to driver
    const { data: routes } = await supabase
      .from('routes')
      .select('*')
      .or(`driver_id.eq.${driverId},permanent_driver_id.eq.${driverId}`);
    debug.assigned_routes = routes;
    
    // Check if daily_schedules exists
    const { error: dailyScheduleError } = await supabase
      .from('daily_schedules')
      .select('count')
      .limit(1);
    debug.daily_schedules_exists = !dailyScheduleError;
    debug.daily_schedules_error = dailyScheduleError?.message;
    
    // Check buses
    const { data: buses } = await supabase
      .from('buses')
      .select('count');
    debug.buses_count = buses?.[0]?.count || 0;
    
    res.json(debug);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all drivers for assignment (Admin only)
router.get('/drivers', authenticateToken, authorizeRoles(['admin', 'dispatcher']), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, full_name, email, phone')
      .eq('role', 'driver')
      .order('full_name');

    if (error) {
      logger.error('Failed to fetch drivers', { error });
      return res.status(500).json({ error: 'Failed to fetch drivers' });
    }

    res.json({ data });
  } catch (error) {
    logger.error('Get drivers error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all buses for assignment (Admin only)
router.get('/buses', authenticateToken, authorizeRoles(['admin', 'dispatcher']), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('buses')
      .select('id, bus_number, capacity, status')
      .order('bus_number');

    if (error) {
      logger.error('Failed to fetch buses', { error });
      return res.status(500).json({ error: 'Failed to fetch buses' });
    }

    res.json({ data });
  } catch (error) {
    logger.error('Get buses error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all routes
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { type, is_active } = req.query;
    
    let query = supabase
      .from('routes')
      .select(`
        *,
        stops(*),
        driver:profiles!driver_id(id, full_name, email, phone),
        bus:buses!bus_id(id, bus_number, capacity, status)
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

// Get daily schedules (smart scheduling - permanent + exceptions)
router.get('/daily-schedules', authenticateToken, authorizeRoles(['admin', 'dispatcher']), async (req, res) => {
  try {
    const { date } = req.query;
    const targetDate = date || new Date().toISOString().split('T')[0];

    const { data, error } = await supabase
      .from('daily_schedules')
      .select('*')
      .eq('schedule_date', targetDate)
      .order('route_name');

    if (error) {
      logger.error('Failed to fetch daily schedules', { error });
      return res.status(500).json({ error: 'Failed to fetch daily schedules' });
    }

    res.json({ data, date: targetDate });
  } catch (error) {
    logger.error('Get daily schedules error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get schedule exceptions for a date range
router.get('/schedule-exceptions', authenticateToken, authorizeRoles(['admin', 'dispatcher']), async (req, res) => {
  try {
    const { start_date, end_date, route_id } = req.query;

    let query = supabase
      .from('schedule_exceptions')
      .select(`
        *,
        routes(name),
        override_bus:buses!override_bus_id(bus_number),
        override_driver:profiles!override_driver_id(full_name)
      `)
      .eq('status', 'active')
      .order('date');

    if (start_date) query = query.gte('date', start_date);
    if (end_date) query = query.lte('date', end_date);
    if (route_id) query = query.eq('route_id', route_id);

    const { data, error } = await query;

    if (error) {
      logger.error('Failed to fetch schedule exceptions', { error });
      return res.status(500).json({ error: 'Failed to fetch schedule exceptions' });
    }

    res.json({ data });
  } catch (error) {
    logger.error('Get schedule exceptions error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create schedule exception
router.post('/schedule-exceptions', authenticateToken, authorizeRoles(['admin', 'dispatcher']), async (req, res) => {
  try {
    const { route_id, date, exception_type, override_bus_id, override_driver_id, override_start_time, override_end_time, reason, notes } = req.body;

    if (!route_id || !date || !exception_type) {
      return res.status(400).json({ error: 'Route ID, date, and exception type are required' });
    }

    const { data, error } = await supabase
      .from('schedule_exceptions')
      .insert({
        route_id,
        date,
        exception_type,
        override_bus_id: override_bus_id || null,
        override_driver_id: override_driver_id || null,
        override_start_time: override_start_time || null,
        override_end_time: override_end_time || null,
        reason,
        notes,
        created_by: req.user.id
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(400).json({ error: 'Exception already exists for this route and date' });
      }
      logger.error('Failed to create schedule exception', { error });
      return res.status(500).json({ error: 'Failed to create schedule exception' });
    }

    logger.info('Schedule exception created', { 
      exceptionId: data.id, 
      routeId: route_id,
      date,
      userId: req.user.id 
    });

    res.status(201).json({ data });
  } catch (error) {
    logger.error('Create schedule exception error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete schedule exception
router.delete('/schedule-exceptions/:id', authenticateToken, authorizeRoles(['admin', 'dispatcher']), async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from('schedule_exceptions')
      .delete()
      .eq('id', id);

    if (error) {
      logger.error('Failed to delete schedule exception', { error });
      return res.status(500).json({ error: 'Failed to delete schedule exception' });
    }

    logger.info('Schedule exception deleted', { exceptionId: id, userId: req.user.id });

    res.json({ message: 'Schedule exception deleted successfully' });
  } catch (error) {
    logger.error('Delete schedule exception error', { error: error.message });
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
        stops(*),
        driver:profiles!driver_id(id, full_name, email, phone),
        bus:buses!bus_id(id, bus_number, capacity, status)
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
    const allowedFields = ['name', 'description', 'type', 'is_active', 'driver_id', 'bus_id'];
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

// Get stops for a route
router.get('/:routeId/stops', authenticateToken, async (req, res) => {
  try {
    const { routeId } = req.params;

    const { data, error } = await supabase
      .from('stops')
      .select('*')
      .eq('route_id', routeId)
      .order('stop_order');

    if (error) {
      logger.error('Failed to fetch stops', { error });
      return res.status(500).json({ error: 'Failed to fetch stops' });
    }

    res.json({ data });
  } catch (error) {
    logger.error('Get stops error', { error: error.message });
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
    const allowedFields = ['name', 'address', 'latitude', 'longitude', 'stop_order', 'scheduled_time', 'notes'];
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

// Get driver's schedules (MUST be before /:routeId/schedules to avoid conflict)
router.get('/driver/schedules', authenticateToken, async (req, res) => {
  try {
    logger.error('ROUTE HIT: /driver/schedules - before any processing', {
      headers: req.headers.authorization ? 'Bearer token present' : 'No auth header',
      user: req.user ? 'User object exists' : 'No user object'
    });
    const { date } = req.query;
    const targetDate = date || new Date().toISOString().split('T')[0];
    
    logger.error('DEBUG - Full req.user object', { 
      fullUser: req.user,
      userKeys: Object.keys(req.user || {}),
      userId: req.user?.id,
      userIdType: typeof req.user?.id,
      userIdValue: JSON.stringify(req.user?.id)
    });

    // Check if user ID is literally the string "driver"
    if (req.user.id === 'driver') {
      logger.error('User ID is literally the string "driver" - authentication problem');
      return res.status(401).json({ error: 'Authentication error - invalid user ID' });
    }

    // First, let's try the simple case - just return empty array for now to test auth
    if (!req.user.id || typeof req.user.id !== 'string' || req.user.id.length < 10) {
      logger.error('Invalid driver ID', { userId: req.user.id, type: typeof req.user.id });
      return res.status(400).json({ error: 'Invalid driver ID' });
    }

    // Try to fetch routes assigned to this driver (permanent assignments)  
    // First try permanent assignments
    const { data: permanentRoutes } = await supabase
      .from('routes')
      .select(`
        id,
        name,
        type,
        is_active,
        permanent_driver_id,
        driver_id,
        permanent_bus_id,
        bus_id,
        default_start_time,
        default_end_time
      `)
      .eq('is_active', true)
      .eq('permanent_driver_id', req.user.id);

    // Then try regular assignments  
    const { data: regularRoutes } = await supabase
      .from('routes')
      .select(`
        id,
        name,
        type,
        is_active,
        permanent_driver_id,
        driver_id,
        permanent_bus_id,
        bus_id,
        default_start_time,
        default_end_time
      `)
      .eq('is_active', true)
      .eq('driver_id', req.user.id);

    // Combine results and remove duplicates
    const allRoutes = [...(permanentRoutes || []), ...(regularRoutes || [])];
    const routes = allRoutes.filter((route, index, self) => 
      index === self.findIndex(r => r.id === route.id)
    );
    
    const routesError = null; // No error from individual queries

    if (routesError) {
      logger.error('Error fetching driver routes', { 
        error: routesError, 
        driverId: req.user.id,
        query: `permanent_driver_id.eq.${req.user.id},driver_id.eq.${req.user.id}`
      });
      return res.status(500).json({ error: 'Failed to fetch schedules' });
    }

    if (!routes || routes.length === 0) {
      logger.info('No routes found for driver', { driverId: req.user.id });
      return res.json({ data: [] });
    }

    // Transform routes into schedule format
    const schedules = [];
    for (const route of routes) {
      try {
        // Get bus info if available
        let busData = null;
        const busId = route.permanent_bus_id || route.bus_id;
        if (busId) {
          const { data: bus } = await supabase
            .from('buses')
            .select('id, bus_number, capacity, status')
            .eq('id', busId)
            .single();
          busData = bus;
        }

        // Get stops for the route
        const { data: stops } = await supabase
          .from('stops')
          .select('*')
          .eq('route_id', route.id)
          .order('stop_order');

        // Check if there's an existing schedule record for today
        const { data: existingSchedule } = await supabase
          .from('schedules')
          .select('id, status, start_time, end_time')
          .eq('route_id', route.id)
          .eq('driver_id', req.user.id)
          .eq('date', targetDate)
          .single();

        // Use existing schedule data if available, otherwise create synthetic schedule
        const scheduleData = {
          id: existingSchedule ? existingSchedule.id : `${route.id}_${targetDate}`,
          route_id: route.id,
          bus_id: busId,
          driver_id: req.user.id,
          date: targetDate,
          start_time: existingSchedule?.start_time || route.default_start_time || '08:00:00',
          end_time: existingSchedule?.end_time || route.default_end_time || '16:00:00',
          status: existingSchedule?.status || 'scheduled',
          routes: {
            id: route.id,
            name: route.name,
            type: route.type,
            stops: stops || []
          },
          buses: busData || {
            bus_number: 'N/A',
            capacity: 0
          }
        };

        schedules.push(scheduleData);
      } catch (scheduleError) {
        logger.warn('Error processing route for schedule', { 
          routeId: route.id, 
          error: scheduleError.message 
        });
      }
    }

    logger.info('Returning schedules', { count: schedules.length, driverId: req.user.id });
    res.json({ data: schedules });

  } catch (error) {
    logger.error('Get driver schedules error', { 
      error: error.message, 
      stack: error.stack,
      driverId: req.user?.id 
    });
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


// Check for scheduling conflicts
router.post('/schedules/check-conflicts', authenticateToken, authorizeRoles(['admin', 'dispatcher']), async (req, res) => {
  try {
    const { bus_id, driver_id, date, start_time, end_time, exclude_schedule_id } = req.body;

    const conflicts = [];

    if (bus_id) {
      let query = supabase
        .from('schedules')
        .select('*, routes(name)')
        .eq('bus_id', bus_id)
        .eq('date', date)
        .in('status', ['scheduled', 'in_progress'])
        .or(`and(start_time.lte.${end_time},end_time.gte.${start_time})`);

      if (exclude_schedule_id) {
        query = query.neq('id', exclude_schedule_id);
      }

      const { data: busConflicts } = await query;
      
      if (busConflicts && busConflicts.length > 0) {
        conflicts.push({
          type: 'bus',
          conflicts: busConflicts
        });
      }
    }

    if (driver_id) {
      let query = supabase
        .from('schedules')
        .select('*, routes(name)')
        .eq('driver_id', driver_id)
        .eq('date', date)
        .in('status', ['scheduled', 'in_progress'])
        .or(`and(start_time.lte.${end_time},end_time.gte.${start_time})`);

      if (exclude_schedule_id) {
        query = query.neq('id', exclude_schedule_id);
      }

      const { data: driverConflicts } = await query;
      
      if (driverConflicts && driverConflicts.length > 0) {
        conflicts.push({
          type: 'driver',
          conflicts: driverConflicts
        });
      }
    }

    res.json({ 
      has_conflicts: conflicts.length > 0,
      conflicts 
    });
  } catch (error) {
    logger.error('Check conflicts error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update permanent route assignments
router.put('/:id/permanent-assignment', authenticateToken, authorizeRoles(['admin']), async (req, res) => {
  try {
    const { id } = req.params;
    const { permanent_bus_id, permanent_driver_id, default_start_time, default_end_time, active_days, effective_from, effective_until } = req.body;

    const updates = {};
    if (permanent_bus_id !== undefined) updates.permanent_bus_id = permanent_bus_id;
    if (permanent_driver_id !== undefined) updates.permanent_driver_id = permanent_driver_id;
    if (default_start_time !== undefined) updates.default_start_time = default_start_time;
    if (default_end_time !== undefined) updates.default_end_time = default_end_time;
    if (active_days !== undefined) updates.active_days = active_days;
    if (effective_from !== undefined) updates.effective_from = effective_from;
    if (effective_until !== undefined) updates.effective_until = effective_until;

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
      logger.error('Failed to update permanent assignment', { error });
      return res.status(500).json({ error: 'Failed to update permanent assignment' });
    }

    logger.info('Permanent assignment updated', { routeId: id, userId: req.user.id });

    res.json({ data });
  } catch (error) {
    logger.error('Update permanent assignment error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get students assigned to a route (Admin only)
router.get('/:routeId/students', authenticateToken, authorizeRoles(['admin', 'dispatcher']), async (req, res) => {
  try {
    const { routeId } = req.params;

    // Get students assigned to any stop in this route via student_stops table
    const { data: studentStops, error: studentStopsError } = await supabase
      .from('student_stops')
      .select(`
        id,
        student_id,
        stop_id,
        route_type,
        is_active,
        student:students(id, name, grade, address, is_active, parent:profiles!parent_id(id, full_name)),
        stop:stops!inner(id, name, route_id)
      `)
      .eq('stops.route_id', routeId)
      .eq('is_active', true)
      .eq('students.is_active', true);

    if (studentStopsError) {
      logger.error('Failed to fetch route students', { error: studentStopsError, routeId });
      return res.status(500).json({ error: 'Failed to fetch route students' });
    }

    // Also get students directly assigned via students.stop_id
    const { data: directStudents, error: directError } = await supabase
      .from('students')
      .select(`
        id, name, grade, address, is_active, stop_id,
        parent:profiles!parent_id(id, full_name),
        stop:stops!inner(id, name, route_id)
      `)
      .eq('stops.route_id', routeId)
      .eq('is_active', true);

    if (directError) {
      logger.error('Failed to fetch direct route students', { error: directError, routeId });
      return res.status(500).json({ error: 'Failed to fetch route students' });
    }

    // Combine and deduplicate students
    const allStudents = new Map();
    
    // Add students from student_stops
    studentStops?.forEach(assignment => {
      if (assignment.student) {
        const studentId = assignment.student.id;
        if (!allStudents.has(studentId)) {
          allStudents.set(studentId, {
            ...assignment.student,
            assignments: []
          });
        }
        allStudents.get(studentId).assignments.push({
          id: assignment.id,
          stop_id: assignment.stop_id,
          stop_name: assignment.stop.name,
          route_type: assignment.route_type
        });
      }
    });

    // Add students with direct assignment
    directStudents?.forEach(student => {
      if (!allStudents.has(student.id)) {
        allStudents.set(student.id, {
          ...student,
          assignments: [{
            stop_id: student.stop_id,
            stop_name: student.stop.name,
            route_type: 'direct'
          }]
        });
      }
    });

    const students = Array.from(allStudents.values());

    res.json({ data: students });
  } catch (error) {
    logger.error('Get route students error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get available students for route assignment (not already assigned to this route)
router.get('/:routeId/available-students', authenticateToken, authorizeRoles(['admin', 'dispatcher']), async (req, res) => {
  try {
    const { routeId } = req.params;

    // Get all active students
    const { data: allStudents, error: studentsError } = await supabase
      .from('students')
      .select(`
        id, name, grade, address, is_active,
        parent:profiles!parent_id(id, full_name, phone)
      `)
      .eq('is_active', true)
      .order('name');

    if (studentsError) {
      logger.error('Failed to fetch all students', { error: studentsError });
      return res.status(500).json({ error: 'Failed to fetch students' });
    }

    // Get students already assigned to this route
    const { data: assignedStudents } = await supabase
      .from('student_stops')
      .select('student_id, stops!inner(route_id)')
      .eq('stops.route_id', routeId)
      .eq('is_active', true);

    const assignedIds = new Set(assignedStudents?.map(a => a.student_id) || []);

    // Filter out already assigned students
    const availableStudents = allStudents?.filter(student => !assignedIds.has(student.id)) || [];

    res.json({ data: availableStudents });
  } catch (error) {
    logger.error('Get available students error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Assign students to route (Admin only)
router.post('/:routeId/students', authenticateToken, authorizeRoles(['admin', 'dispatcher']), async (req, res) => {
  try {
    const { routeId } = req.params;
    const { student_ids, stop_id } = req.body;

    if (!student_ids || !Array.isArray(student_ids) || student_ids.length === 0) {
      return res.status(400).json({ error: 'Student IDs array is required' });
    }

    if (!stop_id) {
      return res.status(400).json({ error: 'Stop ID is required' });
    }

    // Verify route and stop exist
    const { data: stop, error: stopError } = await supabase
      .from('stops')
      .select('id, route_id')
      .eq('id', stop_id)
      .eq('route_id', routeId)
      .single();

    if (stopError || !stop) {
      return res.status(404).json({ error: 'Stop not found in this route' });
    }

    // Verify all students exist and are active
    const { data: students, error: studentsError } = await supabase
      .from('students')
      .select('id, name')
      .in('id', student_ids)
      .eq('is_active', true);

    if (studentsError || students.length !== student_ids.length) {
      return res.status(400).json({ error: 'One or more students not found or inactive' });
    }

    // Create assignments
    const assignments = student_ids.map(student_id => ({
      student_id,
      stop_id,
      route_type: 'regular',
      is_active: true
    }));

    const { data, error } = await supabase
      .from('student_stops')
      .insert(assignments)
      .select(`
        *,
        student:students(id, name, grade),
        stop:stops(id, name)
      `);

    if (error) {
      if (error.code === '23505') {
        return res.status(400).json({ error: 'One or more students are already assigned to this stop' });
      }
      logger.error('Failed to assign students to route', { error, routeId });
      return res.status(500).json({ error: 'Failed to assign students to route' });
    }

    logger.info('Students assigned to route', { 
      routeId, 
      stopId: stop_id,
      studentCount: student_ids.length,
      userId: req.user.id 
    });

    res.status(201).json({ data });
  } catch (error) {
    logger.error('Assign students to route error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Remove student from route (Admin only)
router.delete('/:routeId/students/:studentId', authenticateToken, authorizeRoles(['admin', 'dispatcher']), async (req, res) => {
  try {
    const { routeId, studentId } = req.params;

    // Remove from student_stops table
    const { error } = await supabase
      .from('student_stops')
      .delete()
      .eq('student_id', studentId)
      .in('stop_id', 
        supabase
          .from('stops')
          .select('id')
          .eq('route_id', routeId)
      );

    if (error) {
      logger.error('Failed to remove student from route', { error, routeId, studentId });
      return res.status(500).json({ error: 'Failed to remove student from route' });
    }

    logger.info('Student removed from route', { routeId, studentId, userId: req.user.id });

    res.json({ message: 'Student removed from route successfully' });
  } catch (error) {
    logger.error('Remove student from route error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;