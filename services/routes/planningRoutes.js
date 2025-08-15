const express = require('express');
const { supabase } = require('../../shared/database/supabase');
const { createServiceLogger } = require('../../shared/logger');
const { authenticateToken, authorizeRoles } = require('../auth/middleware');

const router = express.Router();

const logger = createServiceLogger('route-planning');

// Plan optimal routes using TomTom API
router.post('/plan-routes', authenticateToken, authorizeRoles(['admin']), async (req, res) => {
  try {
    const { 
      school_location, 
      traffic = false, 
      departAt, 
      arriveAt,
      route_name_prefix = 'Auto-Generated Route',
      useBatch = true
    } = req.body;

    logger.info('Starting route planning', { 
      school_location, 
      traffic, 
      departAt, 
      arriveAt, 
      useBatch 
    });

    // Validate required parameters
    if (!school_location || !school_location.lat || !school_location.lon) {
      return res.status(400).json({
        success: false,
        error: 'School location with lat/lon coordinates is required'
      });
    }

    if (!process.env.TOMTOM_API_KEY) {
      return res.status(500).json({
        success: false,
        error: 'TomTom API key not configured'
      });
    }

    // Fetch students with addresses (primary addresses with coordinates)
    const { data: students, error: studentsError } = await supabase
      .from('students')
      .select(`
        id, name, grade,
        addresses!inner(
          id, latitude, longitude, full_address, address_type
        )
      `)
      .eq('is_active', true)
      .eq('addresses.address_type', 'primary')
      .eq('addresses.is_active', true)
      .not('addresses.latitude', 'is', null)
      .not('addresses.longitude', 'is', null);

    if (studentsError) {
      logger.error('Error fetching students:', studentsError);
      throw new Error('Failed to fetch students: ' + studentsError.message);
    }

    if (!students || students.length === 0) {
      return res.json({
        success: true,
        data: {
          routes: [],
          unassigned_students: [],
          total_buses_used: 0,
          total_students_assigned: 0,
          message: 'No students found with valid addresses and coordinates'
        }
      });
    }

    // Fetch available buses
    const { data: buses, error: busesError } = await supabase
      .from('buses')
      .select('id, name, capacity, status')
      .eq('status', 'active');

    if (busesError) {
      logger.error('Error fetching buses:', busesError);
      throw new Error('Failed to fetch buses: ' + busesError.message);
    }

    if (!buses || buses.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No active buses available for route planning'
      });
    }

    logger.info(`Found ${students.length} students and ${buses.length} buses for planning`);

    // Format data for planning algorithm
    const formattedStudents = students.map(s => ({
      id: s.id,
      name: s.name,
      grade: s.grade,
      lat: parseFloat(s.addresses[0].latitude),
      lon: parseFloat(s.addresses[0].longitude),
      address: s.addresses[0].full_address
    }));

    const formattedBuses = buses.map(b => ({
      id: b.id,
      name: b.name,
      capacity: b.capacity || 30 // Default capacity if not set
    }));

    // Dynamically import the ES module
    const { planWithTomTom } = await import('./routeplanning.js');
    
    // Plan routes using TomTom API
    logger.info('Calling TomTom route planning API');
    const result = await planWithTomTom({
      apiKey: process.env.TOMTOM_API_KEY,
      school: {
        lat: parseFloat(school_location.lat),
        lon: parseFloat(school_location.lon)
      },
      students: formattedStudents,
      buses: formattedBuses,
      useBatch,
      traffic,
      departAt,
      arriveAt,
      timeout: 120000 // 2 minutes timeout
    });

    logger.info('Route planning completed', {
      routesGenerated: result.routes.length,
      studentsAssigned: result.routes.reduce((sum, r) => sum + r.student_ids_ordered.length, 0),
      unassignedStudents: result.unassigned_student_ids.length
    });

    // Add bus names to routes
    const routesWithBusInfo = result.routes.map(route => {
      const bus = formattedBuses.find(b => b.id === route.bus_id);
      return {
        ...route,
        bus_name: bus?.name || `Bus ${route.bus_id}`,
        students_assigned: route.student_ids_ordered.length,
        distance_km: Math.round(route.total_distance_m / 1000 * 100) / 100
      };
    });

    // Get student details for unassigned students
    const unassignedStudentDetails = formattedStudents
      .filter(s => result.unassigned_student_ids.includes(s.id))
      .map(s => ({
        id: s.id,
        name: s.name,
        grade: s.grade,
        address: s.address
      }));

    res.json({
      success: true,
      data: {
        routes: routesWithBusInfo,
        unassigned_students: unassignedStudentDetails,
        total_buses_used: result.routes.length,
        total_students_assigned: result.routes.reduce((sum, r) => sum + r.student_ids_ordered.length, 0),
        total_distance_km: routesWithBusInfo.reduce((sum, r) => sum + r.distance_km, 0),
        planning_params: {
          school_location,
          traffic,
          departAt,
          arriveAt,
          useBatch
        }
      }
    });

  } catch (error) {
    logger.error('Route planning error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to plan routes'
    });
  }
});

// Get route planning preview (without calling TomTom API)
router.post('/plan-preview', authenticateToken, authorizeRoles(['admin']), async (req, res) => {
  try {
    const { school_location } = req.body;

    if (!school_location || !school_location.lat || !school_location.lon) {
      return res.status(400).json({
        success: false,
        error: 'School location with lat/lon coordinates is required'
      });
    }

    // Fetch students with addresses
    const { data: students, error: studentsError } = await supabase
      .from('students')
      .select(`
        id, name, grade,
        addresses!inner(
          latitude, longitude, full_address, address_type
        )
      `)
      .eq('is_active', true)
      .eq('addresses.address_type', 'primary')
      .eq('addresses.is_active', true)
      .not('addresses.latitude', 'is', null)
      .not('addresses.longitude', 'is', null);

    if (studentsError) throw studentsError;

    // Fetch available buses
    const { data: buses, error: busesError } = await supabase
      .from('buses')
      .select('id, name, capacity, status')
      .eq('status', 'active');

    if (busesError) throw busesError;

    // Just do clustering without TomTom optimization
    const formattedStudents = students.map(s => ({
      id: s.id,
      name: s.name,
      grade: s.grade,
      lat: parseFloat(s.addresses[0].latitude),
      lon: parseFloat(s.addresses[0].longitude),
      address: s.addresses[0].full_address
    }));

    const formattedBuses = buses.map(b => ({
      id: b.id,
      name: b.name,
      capacity: b.capacity || 30
    }));

    // Dynamically import the ES module
    const { buildBusClusters } = await import('./routeplanning.js');
    const clusters = buildBusClusters({
      school: {
        lat: parseFloat(school_location.lat),
        lon: parseFloat(school_location.lon)
      },
      students: formattedStudents,
      buses: formattedBuses
    });

    const preview = clusters.map(cluster => {
      const bus = formattedBuses.find(b => b.id === cluster.bus_id);
      return {
        bus_id: cluster.bus_id,
        bus_name: bus?.name || `Bus ${cluster.bus_id}`,
        capacity: cluster.capacity,
        students_assigned: cluster.students.length,
        students: cluster.students.map(s => ({
          id: s.id,
          name: s.name,
          address: s.address
        }))
      };
    });

    res.json({
      success: true,
      data: {
        preview,
        total_students: formattedStudents.length,
        total_buses: formattedBuses.length,
        students_that_can_be_assigned: clusters.reduce((sum, c) => sum + c.students.length, 0)
      }
    });

  } catch (error) {
    logger.error('Route planning preview error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to generate route preview'
    });
  }
});

module.exports = router;