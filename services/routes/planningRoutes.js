const express = require('express');
const { supabase } = require('../../shared/database/supabase');
const { createServiceLogger } = require('../../shared/logger');
const { authenticateToken, authorizeRoles } = require('../auth/middleware');
const { 
  planWithTomTom, 
  buildBusClusters,
  clusterStudentsBalancedByRouteLoad,
  kMeansGeographicClustering,
  gridBasedClustering,
  densityBasedNearestNeighbor
} = require('./routeplanning.js');

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
      useBatch = true,
      single_cluster = null,
      include_stops = false
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
        student_addresses!inner(
          id, latitude, longitude, full_address, address_type
        )
      `)
      .eq('is_active', true)
      .eq('student_addresses.address_type', 'primary')
      .eq('student_addresses.is_active', true)
      .not('student_addresses.latitude', 'is', null)
      .not('student_addresses.longitude', 'is', null);

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
      .select('id, bus_number, capacity, status')
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

    // If single cluster optimization, use provided data directly
    if (single_cluster) {
      logger.info('Single cluster optimization requested', { 
        cluster: single_cluster,
        students_count: single_cluster.students?.length 
      });

      if (!single_cluster.students || single_cluster.students.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'Single cluster must have students'
        });
      }

      // Use the provided cluster data directly
      const formattedStudents = single_cluster.students.map(s => ({
        id: s.id,
        name: s.name,
        grade: s.grade,
        lat: parseFloat(s.lat),
        lon: parseFloat(s.lon),
        address: s.address
      }));

      // Find the bus for this cluster
      const bus = buses.find(b => b.id === single_cluster.bus_id);
      if (!bus) {
        return res.status(400).json({
          success: false,
          error: 'Bus not found for the specified cluster'
        });
      }

      const formattedBuses = [{
        id: bus.id,
        name: bus.bus_number,
        capacity: bus.capacity || 30
      }];

      // Get route stops from single_cluster if provided
      const routeStops = single_cluster.stops || [];

      console.log('=== BACKEND: SINGLE CLUSTER OPTIMIZATION ===');
      console.log('Cluster bus_id:', single_cluster.bus_id);
      console.log('Formatted students count:', formattedStudents.length);
      console.log('Formatted students:', formattedStudents);
      console.log('Route stops count:', routeStops.length);
      console.log('Route stops:', routeStops);
      console.log('Include stops flag:', include_stops);
      console.log('School location:', school_location);
      console.log('=== END BACKEND CLUSTER DATA ===');

      // Call TomTom API directly for single cluster (bypass clustering)
      const { routeBusTomTom } = require('./routeplanning.js');
      
      console.log('=== CALLING TOMTOM DIRECTLY FOR SINGLE CLUSTER ===');
      const tomTomResult = await routeBusTomTom({
        apiKey: process.env.TOMTOM_API_KEY,
        school: {
          lat: parseFloat(school_location.lat),
          lon: parseFloat(school_location.lon)
        },
        students: formattedStudents,
        stops: routeStops,
        traffic,
        departAt,
        arriveAt,
        timeout: 120000
      });
      
      console.log('Direct TomTom result:', tomTomResult);
      
      // Format as a single route result
      const result = {
        routes: [{
          bus_id: bus.id,
          capacity: bus.capacity || 30,
          student_ids_ordered: tomTomResult.student_ids_ordered,
          stops_ordered: tomTomResult.stops_ordered || [],
          students_ordered: tomTomResult.students_ordered || [],
          route_segments: tomTomResult.route_segments || [],
          reordered_waypoints: tomTomResult.reordered_waypoints || [],
          total_distance_m: tomTomResult.total_distance_m
        }],
        unassigned_student_ids: []
      };

      // Format response
      const routesWithBusInfo = result.routes.map(route => ({
        ...route,
        bus_name: bus.bus_number,
        students_assigned: route.student_ids_ordered.length,
        distance_km: Math.round(route.total_distance_m / 1000 * 100) / 100,
        estimated_duration_minutes: Math.round(route.total_distance_m / 1000 / 40 * 60) // Estimate at 40 km/h
      }));

      return res.json({
        success: true,
        data: {
          routes: routesWithBusInfo,
          unassigned_students: [],
          total_buses_used: 1,
          total_students_assigned: routesWithBusInfo[0]?.students_assigned || 0,
          total_distance_km: routesWithBusInfo[0]?.distance_km || 0,
          planning_params: {
            school_location,
            traffic,
            departAt,
            arriveAt,
            single_cluster: true
          }
        }
      });
    }

    // Format data for planning algorithm (multi-route planning)
    const formattedStudents = students.map(s => ({
      id: s.id,
      name: s.name,
      grade: s.grade,
      lat: parseFloat(s.student_addresses[0].latitude),
      lon: parseFloat(s.student_addresses[0].longitude),
      address: s.student_addresses[0].full_address
    }));

    const formattedBuses = buses.map(b => ({
      id: b.id,
      name: b.bus_number,
      capacity: b.capacity || 30 // Default capacity if not set
    }));

    // Import the CommonJS module
//    const { planWithTomTom } = require('./routeplanning.js');
    
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
    const { school_location, clustering_algorithm = 'balanced' } = req.body;

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
        student_addresses!inner(
          latitude, longitude, full_address, address_type
        )
      `)
      .eq('is_active', true)
      .eq('student_addresses.address_type', 'primary')
      .eq('student_addresses.is_active', true)
      .not('student_addresses.latitude', 'is', null)
      .not('student_addresses.longitude', 'is', null);

    if (studentsError) throw studentsError;

    // Fetch available buses
    const { data: buses, error: busesError } = await supabase
      .from('buses')
      .select('id, bus_number, capacity, status')
      .eq('status', 'active');

    if (busesError) throw busesError;

    // Just do clustering without TomTom optimization
    const formattedStudents = students.map(s => ({
      id: s.id,
      name: s.name,
      grade: s.grade,
      lat: parseFloat(s.student_addresses[0].latitude),
      lon: parseFloat(s.student_addresses[0].longitude),
      address: s.student_addresses[0].full_address
    }));

    const formattedBuses = buses.map(b => ({
      id: b.id,
      name: b.bus_number,
      capacity: b.capacity || 30
    }));

    // Select clustering algorithm based on parameter
    let clusteringFunction;
    switch (clustering_algorithm) {
      case 'sweep':
        clusteringFunction = buildBusClusters;
        break;
      case 'balanced':
        clusteringFunction = clusterStudentsBalancedByRouteLoad;
        break;
      case 'kmeans':
        clusteringFunction = kMeansGeographicClustering;
        break;
      case 'grid':
        clusteringFunction = gridBasedClustering;
        break;
      case 'density':
        clusteringFunction = densityBasedNearestNeighbor;
        break;
      default:
        clusteringFunction = clusterStudentsBalancedByRouteLoad;
    }

    const clusters = clusteringFunction({
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