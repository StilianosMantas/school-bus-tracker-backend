const express = require('express');
const router = express.Router();
const winston = require('winston');
const { createClient } = require('@supabase/supabase-js');
const Joi = require('joi');
const { authenticateToken, authorizeRoles } = require('../auth/middleware');
const { getCurrentDate, getCurrentTimestamp, toDateString } = require('../../shared/utils/dateUtils');

// Initialize logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.File({ filename: 'analytics.log' }),
    new winston.transports.Console({ format: winston.format.simple() })
  ]
});

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Validation schemas
const dateRangeSchema = Joi.object({
  start_date: Joi.date().iso().required(),
  end_date: Joi.date().iso().min(Joi.ref('start_date')).required()
});

const reportSchema = Joi.object({
  type: Joi.string().valid('daily', 'weekly', 'monthly', 'custom').required(),
  start_date: Joi.date().iso().when('type', {
    is: 'custom',
    then: Joi.required(),
    otherwise: Joi.optional()
  }),
  end_date: Joi.date().iso().when('type', {
    is: 'custom',
    then: Joi.required(),
    otherwise: Joi.optional()
  }),
  route_id: Joi.string().uuid().optional(),
  bus_id: Joi.string().uuid().optional()
});

// Overview endpoint for Reports page
router.get('/overview', authenticateToken, authorizeRoles(['admin', 'dispatcher']), async (req, res) => {
  try {
    const todayString = getCurrentDate();
    const today = new Date(todayString + 'T00:00:00.000Z');
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // Get total routes with student counts
    const { data: routes, error: routesError } = await supabase
      .from('routes')
      .select(`
        id,
        name,
        is_active
      `)
      .eq('is_active', true);

    if (routesError) {
      logger.error('Error fetching routes for overview:', routesError);
      return res.status(500).json({ error: 'Failed to fetch routes data' });
    }

    // Get student counts per route (simplified for overview)
    const { data: studentCounts, error: studentCountsError } = await supabase
      .from('student_stops')
      .select(`
        student_id,
        stops(route_id)
      `)
      .eq('is_active', true);

    // Count students per route
    const routeStudentCounts = {};
    studentCounts?.forEach(assignment => {
      const routeId = assignment.stops?.route_id;
      if (routeId) {
        if (!routeStudentCounts[routeId]) {
          routeStudentCounts[routeId] = new Set();
        }
        routeStudentCounts[routeId].add(assignment.student_id);
      }
    });

    // Transform routes data for frontend
    const routesWithCounts = routes?.map(route => ({
      id: route.id,
      name: route.name,
      total_trips: 0, // Placeholder for now
      student_count: routeStudentCounts[route.id]?.size || 0
    })) || [];

    // Get total students
    const { count: totalStudents } = await supabase
      .from('students')
      .select('*', { count: 'exact', head: true })
      .eq('is_active', true);

    // Get active buses count
    const { count: activeBuses } = await supabase
      .from('active_trips')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', today.toISOString())
      .is('ended_at', null);

    // Get incidents count
    const { count: incidentsCount } = await supabase
      .from('incidents')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', today.toISOString());

    // Mock attendance data for now
    const attendanceData = {
      present: Math.floor((totalStudents || 0) * 0.85),
      absent: Math.floor((totalStudents || 0) * 0.10),
      no_show: Math.floor((totalStudents || 0) * 0.05)
    };

    res.json({
      total_trips: 0, // Will be calculated from actual trips data
      total_students: totalStudents || 0,
      active_buses: activeBuses || 0,
      incidents_count: incidentsCount || 0,
      routes: routesWithCounts,
      attendance: attendanceData,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error fetching overview data:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Dashboard overview
router.get('/dashboard', authenticateToken, authorizeRoles(['admin', 'dispatcher']), async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // Get active buses count
    const { data: activeBuses, error: busError, count: activeBusCount } = await supabase
      .from('active_trips')
      .select('bus_id', { count: 'exact' })
      .gte('created_at', today.toISOString())
      .is('ended_at', null);

    // Get total routes
    const { count: totalRoutes } = await supabase
      .from('routes')
      .select('*', { count: 'exact', head: true })
      .eq('is_active', true);

    // Get total students
    const { count: totalStudents } = await supabase
      .from('students')
      .select('*', { count: 'exact', head: true })
      .eq('is_active', true);

    // Get incidents today
    const { count: incidentsToday } = await supabase
      .from('incidents')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', today.toISOString())
      .lt('created_at', tomorrow.toISOString());

    // Get on-time performance (last 7 days)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    
    const { data: tripStats, error: tripError } = await supabase
      .from('trip_analytics')
      .select('on_time')
      .gte('created_at', sevenDaysAgo.toISOString());

    const onTimePercentage = tripStats && tripStats.length > 0
      ? (tripStats.filter(t => t.on_time).length / tripStats.length * 100).toFixed(1)
      : 100;

    // Get average trip duration
    const { data: avgDuration } = await supabase
      .from('trip_analytics')
      .select('duration_minutes')
      .gte('created_at', sevenDaysAgo.toISOString());

    const averageDuration = avgDuration && avgDuration.length > 0
      ? Math.round(avgDuration.reduce((sum, t) => sum + t.duration_minutes, 0) / avgDuration.length)
      : 0;

    // Get weekly trips data
    const { data: weeklyTrips } = await supabase
      .from('weekly_trips_summary')
      .select('*')
      .gte('date', sevenDaysAgo.toISOString())
      .order('date', { ascending: true });

    // Get incident types
    const { data: incidentTypes } = await supabase
      .from('incident_types_summary')
      .select('*');

    res.json({
      overview: {
        active_buses: activeBusCount || 0,
        total_routes: totalRoutes || 0,
        total_students: totalStudents || 0,
        incidents_today: incidentsToday || 0,
        on_time_percentage: parseFloat(onTimePercentage) || 100,
        average_trip_duration: averageDuration || 0,
        weekly_trips: weeklyTrips || [],
        incident_types: incidentTypes || []
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error fetching dashboard data:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Route performance metrics
router.get('/routes/performance', authenticateToken, authorizeRoles(['admin', 'dispatcher']), async (req, res) => {
  try {
    const { error: validationError, value } = dateRangeSchema.validate(req.query);
    if (validationError) {
      return res.status(400).json({ error: validationError.details[0].message });
    }

    const { start_date, end_date } = value;

    // Get route performance data
    const { data: routePerformance, error } = await supabase
      .from('route_performance_view')
      .select(`
        route_id,
        route_name,
        total_trips,
        on_time_trips,
        delayed_trips,
        average_delay_minutes,
        incident_count
      `)
      .gte('date', start_date)
      .lte('date', end_date);

    if (error) {
      logger.error('Error fetching route performance:', error);
      return res.status(500).json({ error: 'Failed to fetch performance data' });
    }

    // Aggregate by route
    const aggregated = routePerformance.reduce((acc, perf) => {
      if (!acc[perf.route_id]) {
        acc[perf.route_id] = {
          route_id: perf.route_id,
          route_name: perf.route_name,
          total_trips: 0,
          on_time_trips: 0,
          delayed_trips: 0,
          total_delay_minutes: 0,
          incident_count: 0
        };
      }
      
      acc[perf.route_id].total_trips += perf.total_trips;
      acc[perf.route_id].on_time_trips += perf.on_time_trips;
      acc[perf.route_id].delayed_trips += perf.delayed_trips;
      acc[perf.route_id].total_delay_minutes += perf.average_delay_minutes * perf.delayed_trips;
      acc[perf.route_id].incident_count += perf.incident_count;
      
      return acc;
    }, {});

    // Calculate final metrics
    const results = Object.values(aggregated).map(route => ({
      ...route,
      on_time_percentage: route.total_trips > 0 
        ? (route.on_time_trips / route.total_trips * 100).toFixed(1)
        : 100,
      average_delay_minutes: route.delayed_trips > 0
        ? (route.total_delay_minutes / route.delayed_trips).toFixed(1)
        : 0
    }));

    res.json({
      routes: results,
      period: { start_date, end_date }
    });
  } catch (error) {
    logger.error('Error in route performance:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Driver performance metrics
router.get('/drivers/performance', authenticateToken, authorizeRoles(['admin', 'dispatcher']), async (req, res) => {
  try {
    const { error: validationError, value } = dateRangeSchema.validate(req.query);
    if (validationError) {
      return res.status(400).json({ error: validationError.details[0].message });
    }

    const { start_date, end_date } = value;

    // Get driver performance data
    const { data: driverStats, error } = await supabase
      .from('driver_performance_view')
      .select(`
        driver_id,
        driver_name,
        total_trips,
        on_time_trips,
        incidents_reported,
        average_speed_kmh,
        total_distance_km
      `)
      .gte('date', start_date)
      .lte('date', end_date);

    if (error) {
      logger.error('Error fetching driver performance:', error);
      return res.status(500).json({ error: 'Failed to fetch performance data' });
    }

    // Aggregate by driver
    const aggregated = driverStats.reduce((acc, stat) => {
      if (!acc[stat.driver_id]) {
        acc[stat.driver_id] = {
          driver_id: stat.driver_id,
          driver_name: stat.driver_name,
          total_trips: 0,
          on_time_trips: 0,
          incidents_reported: 0,
          total_distance_km: 0,
          speed_sum: 0
        };
      }
      
      acc[stat.driver_id].total_trips += stat.total_trips;
      acc[stat.driver_id].on_time_trips += stat.on_time_trips;
      acc[stat.driver_id].incidents_reported += stat.incidents_reported;
      acc[stat.driver_id].total_distance_km += stat.total_distance_km;
      acc[stat.driver_id].speed_sum += stat.average_speed_kmh * stat.total_trips;
      
      return acc;
    }, {});

    // Calculate final metrics
    const results = Object.values(aggregated).map(driver => ({
      driver_id: driver.driver_id,
      driver_name: driver.driver_name,
      total_trips: driver.total_trips,
      on_time_percentage: driver.total_trips > 0 
        ? (driver.on_time_trips / driver.total_trips * 100).toFixed(1)
        : 100,
      incidents_reported: driver.incidents_reported,
      average_speed_kmh: driver.total_trips > 0
        ? (driver.speed_sum / driver.total_trips).toFixed(1)
        : 0,
      total_distance_km: driver.total_distance_km.toFixed(1),
      safety_score: calculateSafetyScore(driver)
    }));

    res.json({
      drivers: results,
      period: { start_date, end_date }
    });
  } catch (error) {
    logger.error('Error in driver performance:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Calculate driver safety score (0-100)
function calculateSafetyScore(driver) {
  let score = 100;
  
  // Deduct points for incidents
  score -= driver.incidents_reported * 10;
  
  // Deduct points for low on-time percentage
  const onTimePercentage = driver.total_trips > 0 
    ? (driver.on_time_trips / driver.total_trips * 100)
    : 100;
  if (onTimePercentage < 80) {
    score -= (80 - onTimePercentage) * 0.5;
  }
  
  // Ensure score is between 0 and 100
  return Math.max(0, Math.min(100, score)).toFixed(0);
}

// Student attendance analytics
router.get('/students/attendance', authenticateToken, authorizeRoles(['admin', 'dispatcher']), async (req, res) => {
  try {
    const { error: validationError, value } = dateRangeSchema.validate(req.query);
    if (validationError) {
      return res.status(400).json({ error: validationError.details[0].message });
    }

    const { start_date, end_date } = value;

    // Get attendance data
    const { data: attendance, error } = await supabase
      .from('student_attendance')
      .select(`
        date,
        total_students,
        present_count,
        absent_count,
        no_show_count
      `)
      .gte('date', start_date)
      .lte('date', end_date)
      .order('date', { ascending: false });

    if (error) {
      logger.error('Error fetching attendance data:', error);
      return res.status(500).json({ error: 'Failed to fetch attendance data' });
    }

    // Calculate summary
    const summary = attendance.reduce((acc, day) => {
      acc.total_days += 1;
      acc.total_student_days += day.total_students;
      acc.total_present += day.present_count;
      acc.total_absent += day.absent_count;
      acc.total_no_shows += day.no_show_count;
      return acc;
    }, {
      total_days: 0,
      total_student_days: 0,
      total_present: 0,
      total_absent: 0,
      total_no_shows: 0
    });

    summary.attendance_rate = summary.total_student_days > 0
      ? ((summary.total_present / summary.total_student_days) * 100).toFixed(1)
      : 0;

    res.json({
      summary,
      daily_attendance: attendance,
      period: { start_date, end_date }
    });
  } catch (error) {
    logger.error('Error in student attendance:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Generate reports
router.post('/reports/generate', authenticateToken, authorizeRoles(['admin']), async (req, res) => {
  try {
    const { error: validationError, value } = reportSchema.validate(req.body);
    if (validationError) {
      return res.status(400).json({ error: validationError.details[0].message });
    }

    const { type, start_date, end_date, route_id, bus_id } = value;

    // Determine date range based on report type
    let reportStart, reportEnd;
    const now = new Date();
    
    switch (type) {
      case 'daily':
        reportStart = new Date(now);
        reportStart.setHours(0, 0, 0, 0);
        reportEnd = new Date(reportStart);
        reportEnd.setDate(reportEnd.getDate() + 1);
        break;
      case 'weekly':
        reportStart = new Date(now);
        reportStart.setDate(reportStart.getDate() - 7);
        reportStart.setHours(0, 0, 0, 0);
        reportEnd = new Date(now);
        break;
      case 'monthly':
        reportStart = new Date(now);
        reportStart.setMonth(reportStart.getMonth() - 1);
        reportStart.setHours(0, 0, 0, 0);
        reportEnd = new Date(now);
        break;
      case 'custom':
        reportStart = new Date(start_date);
        reportEnd = new Date(end_date);
        break;
    }

    // Generate report data
    const reportData = {
      type,
      period: {
        start: reportStart.toISOString(),
        end: reportEnd.toISOString()
      },
      generated_at: new Date().toISOString(),
      generated_by: req.user.id
    };

    // Get trip summary
    let tripQuery = supabase
      .from('trips')
      .select('*', { count: 'exact' })
      .gte('started_at', reportStart.toISOString())
      .lt('started_at', reportEnd.toISOString());

    if (route_id) tripQuery = tripQuery.eq('route_id', route_id);
    if (bus_id) tripQuery = tripQuery.eq('bus_id', bus_id);

    const { data: trips, count: totalTrips } = await tripQuery;

    // Get incident summary
    let incidentQuery = supabase
      .from('incidents')
      .select('*', { count: 'exact' })
      .gte('created_at', reportStart.toISOString())
      .lt('created_at', reportEnd.toISOString());

    if (bus_id) incidentQuery = incidentQuery.eq('bus_id', bus_id);

    const { data: incidents, count: totalIncidents } = await incidentQuery;

    // Calculate metrics
    const completedTrips = trips?.filter(t => t.ended_at).length || 0;
    const onTimeTrips = trips?.filter(t => t.on_time).length || 0;
    const avgDuration = trips && trips.length > 0
      ? trips.reduce((sum, t) => {
          if (t.ended_at) {
            const duration = (new Date(t.ended_at) - new Date(t.started_at)) / 60000;
            return sum + duration;
          }
          return sum;
        }, 0) / completedTrips
      : 0;

    reportData.summary = {
      total_trips: totalTrips || 0,
      completed_trips: completedTrips,
      on_time_percentage: totalTrips > 0 
        ? ((onTimeTrips / totalTrips) * 100).toFixed(1)
        : 100,
      average_trip_duration: avgDuration.toFixed(1),
      total_incidents: totalIncidents || 0,
      incidents_by_type: incidents?.reduce((acc, inc) => {
        acc[inc.type] = (acc[inc.type] || 0) + 1;
        return acc;
      }, {}) || {}
    };

    // Store report
    const { data: report, error: reportError } = await supabase
      .from('reports')
      .insert(reportData)
      .select()
      .single();

    if (reportError) {
      logger.error('Error generating report:', reportError);
      return res.status(500).json({ error: 'Failed to generate report' });
    }

    res.json({
      report_id: report.id,
      ...reportData
    });
  } catch (error) {
    logger.error('Error generating report:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get historical reports
router.get('/reports', authenticateToken, authorizeRoles(['admin', 'dispatcher']), async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    const { data: reports, error, count } = await supabase
      .from('reports')
      .select('*', { count: 'exact' })
      .order('generated_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      logger.error('Error fetching reports:', error);
      return res.status(500).json({ error: 'Failed to fetch reports' });
    }

    res.json({
      reports,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count,
        pages: Math.ceil(count / limit)
      }
    });
  } catch (error) {
    logger.error('Error fetching reports:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Real-time metrics
router.get('/realtime/buses', authenticateToken, authorizeRoles(['admin', 'dispatcher']), async (req, res) => {
  try {
    // Get all active buses with their current status
    const { data: activeBuses, error } = await supabase
      .from('active_trips_with_location')
      .select(`
        trip_id,
        bus_id,
        bus_number,
        route_id,
        route_name,
        driver_id,
        driver_name,
        started_at,
        current_stop,
        next_stop,
        students_on_board,
        last_location,
        last_update,
        speed,
        status
      `);

    if (error) {
      logger.error('Error fetching real-time data:', error);
      return res.status(500).json({ error: 'Failed to fetch real-time data' });
    }

    // Calculate additional metrics
    const busesWithMetrics = activeBuses?.map(bus => {
      const timeSinceUpdate = bus.last_update 
        ? (Date.now() - new Date(bus.last_update).getTime()) / 1000
        : null;

      return {
        ...bus,
        is_delayed: bus.status === 'delayed',
        connection_status: timeSinceUpdate > 120 ? 'offline' : 'online',
        seconds_since_update: timeSinceUpdate
      };
    }) || [];

    res.json({
      buses: busesWithMetrics,
      summary: {
        total_active: busesWithMetrics.length,
        on_time: busesWithMetrics.filter(b => !b.is_delayed).length,
        delayed: busesWithMetrics.filter(b => b.is_delayed).length,
        offline: busesWithMetrics.filter(b => b.connection_status === 'offline').length
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error in real-time metrics:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;