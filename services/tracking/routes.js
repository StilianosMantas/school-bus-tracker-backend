const express = require('express');
const router = express.Router();
const { supabase } = require('../../shared/database/supabase');
const { createServiceLogger } = require('../../shared/logger');
const { authenticateToken, authorizeRoles } = require('../auth/middleware');
const { EventEmitter } = require('events');
const Joi = require('joi');

const logger = createServiceLogger('tracking-service');

// SSE event emitter for real-time updates
const trackingEvents = new EventEmitter();
trackingEvents.setMaxListeners(100); // Support many concurrent connections

// GPS data validation schema
const gpsSchema = Joi.object({
  scheduleId: Joi.string().uuid().required(),
  latitude: Joi.number().min(-90).max(90).required(),
  longitude: Joi.number().min(-180).max(180).required(),
  speed: Joi.number().min(0).max(200).optional(),
  heading: Joi.number().min(0).max(360).optional(),
  accuracy: Joi.number().min(0).optional()
});

// Health check
router.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'tracking',
    message: 'Tracking service is running' 
  });
});

// Get driver's trip history
router.get('/driver-trips', authenticateToken, authorizeRoles(['driver', 'escort']), async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    const driverId = req.user.id;

    // First get routes that belong to this driver
    const { data: driverRoutes } = await supabase
      .from('routes')
      .select('id')
      .or(`driver_id.eq.${driverId},permanent_driver_id.eq.${driverId}`);

    if (!driverRoutes || driverRoutes.length === 0) {
      return res.json({ data: [] });
    }

    const routeIds = driverRoutes.map(route => route.id);

    // Query route_progress table for trips on routes assigned to this driver
    let query = supabase
      .from('route_progress')
      .select(`
        *,
        routes!inner(name, type)
      `)
      .in('route_id', routeIds)
      .order('date', { ascending: false })
      .order('actual_start_time', { ascending: false });

    if (start_date) {
      query = query.gte('date', start_date);
    }
    if (end_date) {
      query = query.lte('date', end_date);
    }

    const { data, error } = await query;

    if (error) {
      logger.error('Failed to fetch driver trip history', { error, driverId, routeIds });
      return res.status(500).json({ error: 'Failed to fetch trip history' });
    }

    res.json({ data: data || [] });
  } catch (error) {
    logger.error('Get driver trips error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Submit bulk GPS locations (Driver only) - for GPS service buffering
router.post('/bulk', authenticateToken, authorizeRoles(['driver']), async (req, res) => {
  try {
    const { locations } = req.body;

    if (!locations || !Array.isArray(locations) || locations.length === 0) {
      return res.status(400).json({ error: 'Locations array is required' });
    }

    let successCount = 0;
    const errors = [];

    for (const location of locations) {
      try {
        // Validate each location
        const { error: validationError, value } = gpsSchema.validate({
          scheduleId: location.tripId, // GPS service sends tripId, convert to scheduleId
          latitude: location.latitude,
          longitude: location.longitude,
          speed: location.speed,
          heading: location.heading,
          accuracy: location.accuracy
        });

        if (validationError) {
          errors.push({ location, error: validationError.details[0].message });
          continue;
        }

        // Verify driver is assigned to this schedule
        const { data: schedule, error: scheduleError } = await supabase
          .from('schedules')
          .select('*, routes(*), buses(*)')
          .eq('id', value.scheduleId)
          .eq('driver_id', req.user.id)
          .single();

        if (scheduleError || !schedule) {
          errors.push({ location, error: 'Not authorized for this schedule' });
          continue;
        }

        // Insert GPS data
        const { error: insertError } = await supabase
          .from('gps_tracks')
          .insert({
            schedule_id: value.scheduleId,
            latitude: value.latitude,
            longitude: value.longitude,
            speed: value.speed || 0,
            heading: value.heading,
            accuracy: value.accuracy,
            timestamp: location.timestamp || new Date().toISOString()
          });

        if (!insertError) {
          successCount++;
        } else {
          errors.push({ location, error: insertError.message });
        }
      } catch (err) {
        errors.push({ location, error: err.message });
      }
    }

    logger.info('Bulk GPS data processed', { 
      driverId: req.user.id,
      total: locations.length,
      successful: successCount,
      errors: errors.length
    });

    res.json({ 
      success: true,
      processed: locations.length,
      successful: successCount,
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (error) {
    logger.error('Bulk location update error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Submit GPS location (Driver only)
router.post('/location', authenticateToken, authorizeRoles(['driver', 'escort']), async (req, res) => {
  try {
    const { error: validationError, value } = gpsSchema.validate(req.body);
    if (validationError) {
      return res.status(400).json({ error: validationError.details[0].message });
    }

    const { scheduleId, latitude, longitude, speed, heading, accuracy } = value;

    // Verify driver is assigned to this schedule
    const { data: schedule, error: scheduleError } = await supabase
      .from('schedules')
      .select('*, routes(*), buses(*)')
      .eq('id', scheduleId)
      .eq('driver_id', req.user.id)
      .single();

    if (scheduleError || !schedule) {
      logger.warn('Unauthorized tracking attempt', { 
        driverId: req.user.id, 
        scheduleId 
      });
      return res.status(403).json({ error: 'Not authorized for this schedule' });
    }

    // Check if schedule is active
    if (schedule.status !== 'in_progress') {
      return res.status(400).json({ error: 'Schedule is not active' });
    }

    // Calculate speed if not provided
    let calculatedSpeed = speed;
    if (!speed) {
      // Get last GPS point
      const { data: lastPoint } = await supabase
        .from('gps_tracks')
        .select('*')
        .eq('schedule_id', scheduleId)
        .order('timestamp', { ascending: false })
        .limit(1)
        .single();

      if (lastPoint) {
        const distance = calculateDistance(
          lastPoint.latitude, 
          lastPoint.longitude, 
          latitude, 
          longitude
        );
        const timeDiff = (Date.now() - new Date(lastPoint.timestamp).getTime()) / 1000; // seconds
        calculatedSpeed = (distance / timeDiff) * 3.6; // km/h
      }
    }

    // Insert GPS data
    const { data: gpsData, error: insertError } = await supabase
      .from('gps_tracks')
      .insert({
        schedule_id: scheduleId,
        latitude,
        longitude,
        speed: calculatedSpeed || 0,
        heading,
        accuracy
      })
      .select()
      .single();

    if (insertError) {
      logger.error('Failed to insert GPS data', { error: insertError });
      return res.status(500).json({ error: 'Failed to save location' });
    }

    // Check proximity to stops
    const { data: stops } = await supabase
      .from('stops')
      .select('*')
      .eq('route_id', schedule.route_id)
      .order('stop_order');

    let nearStop = null;
    for (const stop of stops || []) {
      const distance = calculateDistance(
        latitude, 
        longitude, 
        stop.latitude, 
        stop.longitude
      );
      
      if (distance <= 10 && calculatedSpeed < 2) { // Within 10m and stopped
        nearStop = stop;
        break;
      }
    }

    // Emit real-time update
    const update = {
      scheduleId,
      busId: schedule.bus_id,
      routeId: schedule.route_id,
      location: {
        latitude,
        longitude,
        speed: calculatedSpeed,
        heading,
        accuracy
      },
      nearStop,
      timestamp: new Date().toISOString()
    };

    trackingEvents.emit('location-update', update);

    logger.info('GPS location updated', { 
      driverId: req.user.id, 
      scheduleId,
      nearStop: nearStop?.name 
    });

    res.json({ 
      success: true,
      data: gpsData,
      nearStop 
    });
  } catch (error) {
    logger.error('Location update error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get current bus locations (for admin/dispatcher)
router.get('/current', authenticateToken, authorizeRoles(['admin', 'dispatcher']), async (req, res) => {
  try {
    // Get all active schedules with latest GPS data
    const { data: activeSchedules, error } = await supabase
      .from('schedules')
      .select(`
        *,
        buses(*),
        routes(*),
        drivers:profiles!driver_id(*),
        gps_tracks(
          latitude,
          longitude,
          speed,
          heading,
          accuracy,
          timestamp
        )
      `)
      .eq('status', 'in_progress')
      .eq('date', new Date().toISOString().split('T')[0]);

    if (error) {
      logger.error('Failed to fetch active schedules', { error });
      return res.status(500).json({ error: 'Failed to fetch data' });
    }

    // Get latest GPS point for each schedule
    const currentLocations = activeSchedules.map(schedule => {
      const latestGps = schedule.gps_tracks
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];

      return {
        scheduleId: schedule.id,
        bus: {
          id: schedule.buses.id,
          number: schedule.buses.bus_number
        },
        route: {
          id: schedule.routes.id,
          name: schedule.routes.name
        },
        driver: {
          id: schedule.drivers.id,
          name: schedule.drivers.full_name
        },
        location: latestGps || null,
        lastUpdate: latestGps?.timestamp || null
      };
    });

    res.json({ data: currentLocations });
  } catch (error) {
    logger.error('Current locations error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get location history for a schedule
router.get('/history/:scheduleId', authenticateToken, async (req, res) => {
  try {
    const { scheduleId } = req.params;
    const { from, to } = req.query;

    // Build query
    let query = supabase
      .from('gps_tracks')
      .select('*')
      .eq('schedule_id', scheduleId)
      .order('timestamp', { ascending: true });

    if (from) {
      query = query.gte('timestamp', from);
    }
    if (to) {
      query = query.lte('timestamp', to);
    }

    const { data, error } = await query;

    if (error) {
      logger.error('Failed to fetch GPS history', { error });
      return res.status(500).json({ error: 'Failed to fetch history' });
    }

    res.json({ data });
  } catch (error) {
    logger.error('History fetch error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// SSE endpoint for real-time tracking
router.get('/live', authenticateToken, (req, res) => {
  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  // Send initial connection
  res.write('data: {"type":"connected"}\n\n');

  // Location update handler
  const locationHandler = (update) => {
    // Filter based on user role
    if (req.user.role === 'parent') {
      // Parents only see buses their children are on
      // TODO: Implement parent filtering logic
      return;
    }

    res.write(`data: ${JSON.stringify(update)}\n\n`);
  };

  // Add listener
  trackingEvents.on('location-update', locationHandler);

  // Keep connection alive
  const keepAlive = setInterval(() => {
    res.write('data: {"type":"ping"}\n\n');
  }, 30000);

  // Clean up on disconnect
  req.on('close', () => {
    trackingEvents.removeListener('location-update', locationHandler);
    clearInterval(keepAlive);
    logger.info('SSE connection closed', { userId: req.user.id });
  });
});

// SSE endpoint for admin dashboard updates
router.get('/admin-updates', async (req, res) => {
  try {
    // Handle token from query parameter for SSE (EventSource doesn't support custom headers)
    const token = req.query.token;
    
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    // Verify token with Supabase
    const { supabasePublic } = require('../../shared/database/supabase');
    const { data: { user }, error } = await supabasePublic.auth.getUser(token);
    
    if (error || !user) {
      logger.warn('Invalid token in SSE connection', { error: error?.message });
      return res.status(401).json({ error: 'Invalid token' });
    }

    // Get user profile with role
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single();

    if (profileError) {
      logger.error('Profile fetch failed in SSE', { userId: user.id, error: profileError });
      return res.status(500).json({ error: 'Failed to fetch user profile' });
    }

    // Check role authorization
    const userRole = profile?.role || 'parent';
    if (!['admin', 'dispatcher'].includes(userRole)) {
      logger.warn('Unauthorized SSE access', { userId: user.id, userRole });
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Create authenticated user object
    const authUser = {
      id: user.id,
      email: user.email,
      role: userRole,
      fullName: profile?.full_name,
      phone: profile?.phone
    };

    // Set SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization'
    });

    // Send initial connection
    res.write('data: {"type":"connected","message":"Admin dashboard connected"}\n\n');

    // Location update handler
    const locationHandler = (update) => {
      res.write(`data: ${JSON.stringify({...update, type: 'location-update'})}\n\n`);
    };

    // Incident handler
    const incidentHandler = (incident) => {
      res.write(`data: ${JSON.stringify({...incident, type: 'incident'})}\n\n`);
    };

    // Add listeners
    trackingEvents.on('location-update', locationHandler);
    trackingEvents.on('critical-incident', incidentHandler);

    // Keep connection alive
    const keepAlive = setInterval(() => {
      res.write('data: {"type":"ping"}\n\n');
    }, 30000);

    // Clean up on disconnect
    req.on('close', () => {
      trackingEvents.removeListener('location-update', locationHandler);
      trackingEvents.removeListener('critical-incident', incidentHandler);
      clearInterval(keepAlive);
      logger.info('Admin SSE connection closed', { userId: authUser.id });
    });

  } catch (error) {
    logger.error('Admin SSE connection error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Start trip (Driver only)
router.post('/start-trip', authenticateToken, authorizeRoles(['driver', 'escort']), async (req, res) => {
  try {
    const { scheduleId, routeId, busId } = req.body;
    const today = new Date().toISOString().split('T')[0];

    // Handle synthetic schedule IDs from the driver app
    if (scheduleId && scheduleId.includes('_')) {
      const [extractedRouteId, scheduleDate] = scheduleId.split('_');
      
      // Check if this is today's date
      if (scheduleDate !== today) {
        return res.status(400).json({ error: 'Cannot start trip for past or future dates' });
      }

      // Verify driver is assigned to this route
      const { data: route, error: routeError } = await supabase
        .from('routes')
        .select('*')
        .eq('id', extractedRouteId)
        .eq('is_active', true)
        .or(`driver_id.eq.${req.user.id},permanent_driver_id.eq.${req.user.id}`)
        .single();

      if (routeError || !route) {
        return res.status(403).json({ error: 'Not authorized for this route' });
      }

      // Check if schedule already exists for today
      const { data: existingSchedule } = await supabase
        .from('schedules')
        .select('*')
        .eq('route_id', extractedRouteId)
        .eq('driver_id', req.user.id)
        .eq('date', today)
        .single();

      if (existingSchedule) {
        if (existingSchedule.status === 'in_progress') {
          return res.json({ 
            success: true,
            message: 'Trip already in progress',
            schedule_id: existingSchedule.id
          });
        } else if (existingSchedule.status === 'completed') {
          return res.status(400).json({ error: 'Trip already completed for today' });
        }
        
        // Update existing schedule to in_progress
        const { error: updateError } = await supabase
          .from('schedules')
          .update({ 
            status: 'in_progress',
            start_time: new Date().toISOString().split('T')[1].split('.')[0]
          })
          .eq('id', existingSchedule.id);

        if (updateError) {
          logger.error('Failed to start existing trip', { error: updateError });
          return res.status(500).json({ error: 'Failed to start trip' });
        }

        logger.info('Existing trip started', { driverId: req.user.id, scheduleId: existingSchedule.id });
        return res.json({ 
          success: true,
          message: 'Trip started successfully',
          schedule_id: existingSchedule.id
        });
      }

      // Create new schedule record
      const { data: newSchedule, error: createError } = await supabase
        .from('schedules')
        .insert({
          route_id: extractedRouteId,
          bus_id: route.permanent_bus_id || route.bus_id,
          driver_id: req.user.id,
          date: today,
          start_time: route.default_start_time || new Date().toISOString().split('T')[1].split('.')[0],
          status: 'in_progress'
        })
        .select()
        .single();

      if (createError) {
        logger.error('Failed to create schedule', { error: createError });
        return res.status(500).json({ error: 'Failed to create schedule' });
      }

      logger.info('New trip started', { driverId: req.user.id, scheduleId: newSchedule.id });
      return res.json({ 
        success: true,
        message: 'Trip started successfully',
        schedule_id: newSchedule.id
      });
    }

    // Handle regular schedule IDs (fallback for existing functionality)
    if (!scheduleId) {
      return res.status(400).json({ error: 'Schedule ID required' });
    }

    // Verify driver is assigned to this schedule
    const { data: schedule, error: scheduleError } = await supabase
      .from('schedules')
      .select('*')
      .eq('id', scheduleId)
      .eq('driver_id', req.user.id)
      .eq('date', today)
      .single();

    if (scheduleError || !schedule) {
      return res.status(403).json({ error: 'Not authorized for this schedule' });
    }

    if (schedule.status !== 'scheduled') {
      return res.status(400).json({ error: 'Trip already started or completed' });
    }

    // Update schedule status
    const { error: updateError } = await supabase
      .from('schedules')
      .update({ 
        status: 'in_progress',
        start_time: new Date().toISOString().split('T')[1].split('.')[0]
      })
      .eq('id', scheduleId);

    if (updateError) {
      logger.error('Failed to start trip', { error: updateError });
      return res.status(500).json({ error: 'Failed to start trip' });
    }

    logger.info('Trip started', { driverId: req.user.id, scheduleId });

    res.json({ 
      success: true,
      message: 'Trip started successfully',
      schedule_id: scheduleId
    });
  } catch (error) {
    logger.error('Start trip error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// End trip (Driver only)
router.post('/end-trip', authenticateToken, authorizeRoles(['driver', 'escort']), async (req, res) => {
  try {
    const { scheduleId } = req.body;

    if (!scheduleId) {
      return res.status(400).json({ error: 'Schedule ID required' });
    }

    // Verify driver is assigned to this schedule
    const { data: schedule, error: scheduleError } = await supabase
      .from('schedules')
      .select('*')
      .eq('id', scheduleId)
      .eq('driver_id', req.user.id)
      .single();

    if (scheduleError || !schedule) {
      return res.status(403).json({ error: 'Not authorized for this schedule' });
    }

    if (schedule.status !== 'in_progress') {
      return res.status(400).json({ error: 'Trip not in progress' });
    }

    // Update schedule status
    const { error: updateError } = await supabase
      .from('schedules')
      .update({ 
        status: 'completed',
        end_time: new Date().toISOString().split('T')[1].split('.')[0]
      })
      .eq('id', scheduleId);

    if (updateError) {
      logger.error('Failed to end trip', { error: updateError });
      return res.status(500).json({ error: 'Failed to end trip' });
    }

    logger.info('Trip ended', { driverId: req.user.id, scheduleId });

    res.json({ 
      success: true,
      message: 'Trip ended successfully' 
    });
  } catch (error) {
    logger.error('End trip error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Helper function to calculate distance between two coordinates (in meters)
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // Earth's radius in meters
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;

  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) *
    Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

// Report incident (Driver and Admin)
router.post('/incidents', authenticateToken, authorizeRoles(['driver', 'escort', 'admin']), async (req, res) => {
  try {
    const incidentSchema = Joi.object({
      schedule_id: Joi.string().uuid().required(),
      type: Joi.string().valid('mechanical', 'accident', 'behavior', 'traffic', 'weather', 'medical', 'other').required(),
      severity: Joi.string().valid('low', 'medium', 'high', 'critical').required(),
      description: Joi.string().required(),
      location: Joi.string().allow('', null).optional(),
      latitude: Joi.number().min(-90).max(90).optional(),
      longitude: Joi.number().min(-180).max(180).optional(),
      students_involved: Joi.string().allow('', null).optional()
    });

    const { error: validationError, value } = incidentSchema.validate(req.body);
    if (validationError) {
      return res.status(400).json({ error: validationError.details[0].message });
    }

    // Verify schedule exists and user authorization
    const { data: schedule, error: scheduleError } = await supabase
      .from('schedules')
      .select('*, routes(*), buses(*)')
      .eq('id', value.schedule_id)
      .single();

    if (scheduleError || !schedule) {
      logger.warn('Schedule not found for incident report', { 
        userId: req.user.id, 
        scheduleId: value.schedule_id,
        error: scheduleError 
      });
      return res.status(404).json({ error: 'Schedule not found' });
    }

    // For drivers, verify they are assigned to this schedule
    // For admins, allow creating incidents for any schedule
    if (req.user.role === 'driver' && schedule.driver_id !== req.user.id) {
      logger.warn('Unauthorized incident report attempt', { 
        driverId: req.user.id, 
        scheduleId: value.schedule_id 
      });
      return res.status(403).json({ error: 'Not authorized for this schedule' });
    }

    // Create incident record with derived fields from schedule
    const { data: incident, error: incidentError } = await supabase
      .from('incidents')
      .insert({
        ...value,
        driver_id: req.user.role === 'driver' ? req.user.id : schedule.driver_id,
        route_id: schedule.route_id,
        bus_id: schedule.bus_id,
        status: 'open',
        reported_at: new Date().toISOString()
      })
      .select(`
        *,
        driver:profiles!driver_id(*),
        schedule:schedules(
          *,
          route:routes(*),
          bus:buses(*)
        )
      `)
      .single();

    if (incidentError) {
      logger.error('Failed to create incident:', incidentError);
      return res.status(500).json({ error: 'Failed to create incident' });
    }

    // Send notification based on severity
    if (value.severity === 'critical' || value.severity === 'high') {
      // Emit event for notification service
      trackingEvents.emit('critical-incident', {
        incident,
        driverId: req.user.id,
        routeId: schedule.route_id,
        busId: schedule.bus_id
      });
    }

    logger.info(`Incident reported: ${incident.id} - Type: ${value.type}, Severity: ${value.severity}`);
    
    // Transform the data to match frontend expectations
    const transformedIncident = {
      ...incident,
      route: incident.schedule?.route || null,
      bus: incident.schedule?.bus || null
    };

    res.json({ success: true, incident: transformedIncident });
  } catch (error) {
    logger.error('Error reporting incident:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update incident status (Admin/Dispatcher only)
router.patch('/incidents/:id', authenticateToken, authorizeRoles(['admin', 'dispatcher']), async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!['open', 'in_progress', 'resolved', 'closed'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const { data: incident, error } = await supabase
      .from('incidents')
      .update({ 
        status,
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      logger.error('Failed to update incident:', error);
      return res.status(500).json({ error: 'Failed to update incident' });
    }

    logger.info(`Incident ${id} status updated to: ${status}`);
    res.json({ success: true, incident });
  } catch (error) {
    logger.error('Error updating incident:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get available schedules for incident creation (Admin only)
router.get('/schedules', authenticateToken, authorizeRoles(['admin', 'dispatcher']), async (req, res) => {
  try {
    const { date } = req.query;
    const today = date || new Date().toISOString().split('T')[0];
    
    const { data: schedules, error } = await supabase
      .from('schedules')
      .select(`
        *,
        routes(id, name),
        buses(id, bus_number),
        driver:profiles!driver_id(id, full_name)
      `)
      .eq('date', today)
      .in('status', ['scheduled', 'in_progress'])
      .order('start_time');

    if (error) {
      logger.error('Failed to fetch schedules for incidents', { error });
      return res.status(500).json({ error: 'Failed to fetch schedules' });
    }

    res.json({ schedules });
  } catch (error) {
    logger.error('Get schedules error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get incidents for admin/dispatcher/driver
router.get('/incidents', authenticateToken, authorizeRoles(['admin', 'dispatcher', 'driver', 'escort']), async (req, res) => {
  try {
    const { status, severity, type, date, driver_id } = req.query;
    
    let query = supabase
      .from('incidents')
      .select('*')
      .order('created_at', { ascending: false });

    // Restrict drivers to only see their own incidents
    if (req.user.role === 'driver') {
      // Try both possible field names for the driver
      query = query.eq('driver_id', req.user.id);
    } else if (driver_id) {
      // Admin/dispatcher can filter by specific driver
      query = query.eq('driver_id', driver_id);
    }

    if (status) query = query.eq('status', status);
    if (severity) query = query.eq('severity', severity);
    if (type) query = query.eq('type', type);
    if (date) {
      const startDate = new Date(date);
      const endDate = new Date(date);
      endDate.setDate(endDate.getDate() + 1);
      query = query.gte('created_at', startDate.toISOString())
                   .lt('created_at', endDate.toISOString());
    }

    const { data: incidents, error } = await query;

    if (error) {
      logger.error('Failed to fetch incidents:', error);
      return res.status(500).json({ error: 'Failed to fetch incidents' });
    }

    // Transform the data to match frontend expectations
    const transformedIncidents = incidents.map(incident => ({
      ...incident,
      route: incident.schedule?.route || null,
      bus: incident.schedule?.bus || null
    }));

    res.json({ incidents: transformedIncidents });
  } catch (error) {
    logger.error('Error fetching incidents:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ========== ROUTE PROGRESS TRACKING ENDPOINTS ==========

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
router.post('/route-progress/:route_id/start', authenticateToken, authorizeRoles(['driver', 'escort', 'admin', 'dispatcher']), async (req, res) => {
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

// Update route location and progress
router.put('/route-progress/:id/location', authenticateToken, authorizeRoles(['driver', 'escort', 'admin', 'dispatcher']), async (req, res) => {
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
router.post('/route-progress/:id/student-boarding', authenticateToken, authorizeRoles(['driver', 'escort', 'admin', 'dispatcher']), async (req, res) => {
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
    const { data: currentProgress } = await supabase
      .from('route_progress')
      .select('total_students_onboard')
      .eq('id', route_progress_id)
      .single();

    const currentCount = currentProgress?.total_students_onboard || 0;
    const newCount = action === 'board' ? currentCount + 1 : Math.max(0, currentCount - 1);

    await supabase
      .from('route_progress')
      .update({ total_students_onboard: newCount })
      .eq('id', route_progress_id);

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
router.put('/route-progress/:id/complete', authenticateToken, authorizeRoles(['driver', 'escort', 'admin', 'dispatcher']), async (req, res) => {
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

    const { data, error } = await query;

    if (error) {
      logger.error('Failed to fetch predefined locations', { error });
      return res.status(500).json({ error: 'Failed to fetch predefined locations' });
    }

    res.json({ data });
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