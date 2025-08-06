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

// Submit GPS location (Driver only)
router.post('/location', authenticateToken, authorizeRoles(['driver']), async (req, res) => {
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
router.post('/start-trip', authenticateToken, authorizeRoles(['driver']), async (req, res) => {
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
      .eq('date', new Date().toISOString().split('T')[0])
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
      message: 'Trip started successfully' 
    });
  } catch (error) {
    logger.error('Start trip error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// End trip (Driver only)
router.post('/end-trip', authenticateToken, authorizeRoles(['driver']), async (req, res) => {
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
router.post('/incidents', authenticateToken, authorizeRoles(['driver', 'admin']), async (req, res) => {
  try {
    const incidentSchema = Joi.object({
      schedule_id: Joi.string().uuid().required(),
      type: Joi.string().valid('mechanical', 'accident', 'behavior', 'traffic', 'weather', 'medical', 'other').required(),
      severity: Joi.string().valid('low', 'medium', 'high', 'critical').required(),
      description: Joi.string().required(),
      location: Joi.string().optional(),
      latitude: Joi.number().min(-90).max(90).optional(),
      longitude: Joi.number().min(-180).max(180).optional(),
      students_involved: Joi.string().optional()
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
        buses(id, license_plate),
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

// Get incidents for admin/dispatcher
router.get('/incidents', authenticateToken, authorizeRoles(['admin', 'dispatcher']), async (req, res) => {
  try {
    const { status, severity, type, date } = req.query;
    
    let query = supabase
      .from('incidents')
      .select(`
        *,
        driver:profiles!driver_id(*),
        schedule:schedules(
          *,
          route:routes(*),
          bus:buses(*)
        )
      `)
      .order('created_at', { ascending: false });

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

module.exports = router;