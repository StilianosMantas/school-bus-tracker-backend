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
// Helper function to determine route context and get appropriate timing
const getRouteContext = async (departAt, arriveAt, schoolLocation) => {
  try {
    // Determine timezone based on school location (Greece uses EET/EEST)
    const timezone = 'Europe/Athens'; // Default for Greece
    
    // Fetch available time slots to understand pickup vs dropoff timing
    const { data: timeSlots, error } = await supabase
      .from('school_time_slots')
      .select('*')
      .eq('is_active', true)
      .order('time_value');

    if (error) {
      logger.warn('Could not fetch time slots for context determination', { error });
      return { context: 'unknown', suggestedTime: departAt || arriveAt };
    }

    const pickupSlots = timeSlots.filter(slot => slot.slot_type === 'pickup');
    const dropoffSlots = timeSlots.filter(slot => slot.slot_type === 'dropoff');

    // If specific time provided, determine context based on time slots
    if (departAt || arriveAt) {
      const targetTime = departAt || arriveAt;
      
      // Parse time considering timezone
      const targetDate = new Date(targetTime);
      const localTime = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hour12: false,
        hour: '2-digit',
        minute: '2-digit'
      }).formatToParts(targetDate);
      
      const targetHour = parseInt(localTime.find(part => part.type === 'hour').value);
      const targetMinute = parseInt(localTime.find(part => part.type === 'minute').value);
      const targetTimeInMinutes = targetHour * 60 + targetMinute;

      // Check if time falls within typical pickup hours (early morning)
      const isPickupTime = pickupSlots.some(slot => {
        const [slotHour, slotMinute] = slot.time_value.split(':').map(Number);
        const slotTimeInMinutes = slotHour * 60 + slotMinute;
        const timeDifference = Math.abs(targetTimeInMinutes - slotTimeInMinutes);
        return timeDifference <= 120; // Within 2 hours (120 minutes) of pickup slots
      });

      // Check if time falls within typical dropoff hours (afternoon)
      const isDropoffTime = dropoffSlots.some(slot => {
        const [slotHour, slotMinute] = slot.time_value.split(':').map(Number);
        const slotTimeInMinutes = slotHour * 60 + slotMinute;
        const timeDifference = Math.abs(targetTimeInMinutes - slotTimeInMinutes);
        return timeDifference <= 120; // Within 2 hours (120 minutes) of dropoff slots
      });

      if (isPickupTime) {
        return { 
          context: 'pickup', 
          suggestedTime: departAt || targetTime,
          description: 'Morning pickup route (home → school)',
          timezone: timezone,
          localHour: targetHour
        };
      } else if (isDropoffTime) {
        return { 
          context: 'dropoff', 
          suggestedTime: arriveAt || targetTime,
          description: 'Afternoon delivery route (school → home)',
          timezone: timezone,
          localHour: targetHour
        };
      }
    }

    // Default context based on available time slots
    if (pickupSlots.length > 0 && dropoffSlots.length === 0) {
      return { 
        context: 'pickup', 
        suggestedTime: departAt,
        description: 'Default pickup route context'
      };
    } else if (dropoffSlots.length > 0 && pickupSlots.length === 0) {
      return { 
        context: 'dropoff', 
        suggestedTime: arriveAt,
        description: 'Default dropoff route context'
      };
    }

    // Mixed or unknown - use provided timing
    return { 
      context: 'mixed', 
      suggestedTime: departAt || arriveAt,
      description: 'Mixed route context - using provided timing'
    };

  } catch (error) {
    logger.error('Error determining route context', { error });
    return { context: 'unknown', suggestedTime: departAt || arriveAt };
  }
};

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
      clusters = null, // Multiple clusters for batch optimization
      include_stops = false,
      route_context = null, // Allow manual override of route context
      route_type = 'pickup', // pickup, dropoff, or both
      day_of_week,
      pickup_time_slot_id,
      dropoff_time_slot_id
    } = req.body;
 
    // Determine route context for better TomTom optimization
    const routeContext = route_context || await getRouteContext(departAt, arriveAt, school_location);
    
    logger.info('Starting route planning', { 
      school_location, 
      traffic, 
      departAt, 
      arriveAt, 
      useBatch,
      context: routeContext
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

    // If clusters are provided directly from frontend, use them
    if (clusters && clusters.length > 0) {
      logger.info('Using clusters provided from frontend', { 
        clusters_count: clusters.length,
        total_students: clusters.reduce((sum, c) => sum + c.students.length, 0)
      });

      const { routeBusTomTom } = require('./routeplanning.js');
      const allRoutes = [];
      const allUnassigned = [];

      // Process each cluster
      for (let i = 0; i < clusters.length; i++) {
        const cluster = clusters[i];
        
        console.log(`=== PROCESSING CLUSTER ${i} ===`);
        console.log('Cluster bus_id:', cluster.bus_id);
        console.log('Students count:', cluster.students.length);
        console.log('Students:', cluster.students);

        if (!cluster.students || cluster.students.length === 0) {
          console.log(`Skipping cluster ${i} - no students`);
          continue;
        }

        const formattedStudents = cluster.students.map(s => ({
          id: s.id,
          name: s.name,
          grade: s.grade,
          lat: parseFloat(s.lat),
          lon: parseFloat(s.lon),
          address: s.address
        }));

        // Call TomTom for this cluster
        try {
          const tomTomResult = await routeBusTomTom({
            apiKey: process.env.TOMTOM_API_KEY,
            school: {
              lat: parseFloat(school_location.lat),
              lon: parseFloat(school_location.lon)
            },
            students: formattedStudents,
            stops: [],
            traffic,
            departAt,
            arriveAt,
            routeContext: routeContext,
            routeType: route_type,
            timeout: 120000
          });

          allRoutes.push({
            bus_id: cluster.bus_id,
            bus_name: cluster.bus_name,
            capacity: cluster.capacity || 30,
            student_ids_ordered: tomTomResult.student_ids_ordered,
            stops_ordered: tomTomResult.stops_ordered || [],
            students_ordered: tomTomResult.students_ordered || [],
            route_segments: tomTomResult.route_segments || [],
            reordered_waypoints: tomTomResult.reordered_waypoints || [],
            total_distance_m: tomTomResult.total_distance_m
          });
        } catch (error) {
          logger.error(`Error optimizing cluster ${i}:`, error);
          // Continue with other clusters
        }
      }

      const totalDistance = allRoutes.reduce((sum, r) => sum + (r.total_distance_m || 0), 0);
      const totalStudents = allRoutes.reduce((sum, r) => sum + (r.student_ids_ordered?.length || 0), 0);

      return res.json({
        success: true,
        data: {
          routes: allRoutes,
          unassigned_students: allUnassigned,
          total_buses_used: allRoutes.length,
          total_students_assigned: totalStudents,
          total_distance_km: (totalDistance / 1000).toFixed(2),
          route_context: routeContext
        }
      });
    }

    // Fetch students with schedules and addresses based on filters
    let studentsQuery;
    
    if (day_of_week && (pickup_time_slot_id || dropoff_time_slot_id)) {
      // Fetch students with schedule-based filtering
      studentsQuery = supabase
        .from('students')
        .select(`
          id, name, grade,
          schedules:student_weekly_schedules!inner(
            day_of_week, pickup_address_id, pickup_time_slot_id,
            dropoff_address_id, dropoff_time_slot_id, is_active
          ),
          addresses:student_addresses(
            id, latitude, longitude, full_address, address_type, is_active
          )
        `)
        .eq('is_active', true)
        .eq('schedules.is_active', true)
        .eq('schedules.day_of_week', day_of_week);
      
      // Add timeslot filters based on route type
      if (route_type === 'pickup' && pickup_time_slot_id) {
        studentsQuery = studentsQuery.eq('schedules.pickup_time_slot_id', pickup_time_slot_id);
      } else if (route_type === 'dropoff' && dropoff_time_slot_id) {
        studentsQuery = studentsQuery.eq('schedules.dropoff_time_slot_id', dropoff_time_slot_id);
      } else if (route_type === 'both') {
        if (pickup_time_slot_id) {
          studentsQuery = studentsQuery.eq('schedules.pickup_time_slot_id', pickup_time_slot_id);
        }
        if (dropoff_time_slot_id) {
          studentsQuery = studentsQuery.eq('schedules.dropoff_time_slot_id', dropoff_time_slot_id);
        }
      }
    } else {
      // Fallback to primary addresses (original logic)
      studentsQuery = supabase
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
    }

    const { data: students, error: studentsError } = await studentsQuery;

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
      console.log('Using route context:', routeContext);
      
      // Adjust timing based on route context
      let contextualDepartAt = departAt;
      let contextualArriveAt = arriveAt;
      
      if (routeContext.context === 'pickup' && !departAt && !arriveAt) {
        // For pickup routes, we typically depart from school early morning
        // Use school as the departure point with students as destinations
        contextualDepartAt = routeContext.suggestedTime;
      } else if (routeContext.context === 'dropoff' && !departAt && !arriveAt) {
        // For dropoff routes, we typically arrive at school by a certain time
        // Use students as pickup points with school as final destination
        contextualArriveAt = routeContext.suggestedTime;
      }

      const tomTomResult = await routeBusTomTom({
        apiKey: process.env.TOMTOM_API_KEY,
        school: {
          lat: parseFloat(school_location.lat),
          lon: parseFloat(school_location.lon)
        },
        students: formattedStudents,
        stops: routeStops,
        traffic,
        departAt: contextualDepartAt,
        arriveAt: contextualArriveAt,
        routeContext: routeContext, // Pass context to TomTom function
        routeType: route_type, // Pass route type for distance-based routing
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
            departAt: contextualDepartAt,
            arriveAt: contextualArriveAt,
            route_context: routeContext,
            single_cluster: true
          }
        }
      });
    }

    // Format data for planning algorithm (multi-route planning)
    const formattedStudents = [];
    const studentsWithoutCoordinates = [];
    
    students.forEach(s => {
      if (day_of_week && s.schedules && s.schedules.length > 0) {
        // Handle schedule-based filtering
        const daySchedule = s.schedules[0]; // We filtered by day_of_week, so first schedule is for the selected day
        
        // Determine which address to use based on route type
        let targetAddressId = null;
        if (route_type === 'pickup') {
          targetAddressId = daySchedule.pickup_address_id;
        } else if (route_type === 'dropoff') {
          targetAddressId = daySchedule.dropoff_address_id;
        } else {
          // For 'both', prefer pickup address, fallback to dropoff
          targetAddressId = daySchedule.pickup_address_id || daySchedule.dropoff_address_id;
        }
        
        // Find the corresponding address
        const targetAddress = s.addresses?.find(addr => 
          addr.id === targetAddressId && addr.is_active &&
          addr.latitude && addr.longitude
        );
        
        if (targetAddress) {
          const lat = parseFloat(targetAddress.latitude);
          const lon = parseFloat(targetAddress.longitude);
          
          if (!isNaN(lat) && !isNaN(lon) && lat != null && lon != null) {
            formattedStudents.push({
              id: s.id,
              name: s.name,
              grade: s.grade,
              lat: lat,
              lon: lon,
              address: targetAddress.full_address,
              scheduleType: route_type
            });
          } else {
            studentsWithoutCoordinates.push({
              id: s.id,
              name: s.name,
              grade: s.grade,
              reason: 'Invalid coordinates in scheduled address'
            });
          }
        } else {
          studentsWithoutCoordinates.push({
            id: s.id,
            name: s.name,
            grade: s.grade,
            reason: 'No valid address found for schedule'
          });
        }
      } else if (s.student_addresses && s.student_addresses.length > 0) {
        // Handle primary address fallback (original logic)
        const primaryAddress = s.student_addresses[0];
        if (primaryAddress.latitude && primaryAddress.longitude) {
          const lat = parseFloat(primaryAddress.latitude);
          const lon = parseFloat(primaryAddress.longitude);
          
          if (!isNaN(lat) && !isNaN(lon) && lat != null && lon != null) {
            formattedStudents.push({
              id: s.id,
              name: s.name,
              grade: s.grade,
              lat: lat,
              lon: lon,
              address: primaryAddress.full_address
            });
          } else {
            studentsWithoutCoordinates.push({
              id: s.id,
              name: s.name,
              grade: s.grade,
              reason: 'Invalid coordinates in primary address'
            });
          }
        } else {
          studentsWithoutCoordinates.push({
            id: s.id,
            name: s.name,
            grade: s.grade,
            reason: 'No coordinates in primary address'
          });
        }
      }
    });

    // Check if we have any valid students after formatting
    if (formattedStudents.length === 0) {
      return res.json({
        success: true,
        data: {
          routes: [],
          unassigned_students: [],
          total_buses_used: 0,
          total_students_assigned: 0,
          message: 'No students found matching the specified criteria (day/timeslot/route type)'
        }
      });
    }

    logger.info(`Formatted ${formattedStudents.length} students for route planning`);
    
    if (studentsWithoutCoordinates.length > 0) {
      logger.warn(`Found ${studentsWithoutCoordinates.length} students without valid coordinates:`, 
        studentsWithoutCoordinates.map(s => `${s.name} (${s.reason})`));
    }

    const formattedBuses = buses.map(b => ({
      id: b.id,
      name: b.bus_number,
      capacity: b.capacity || 30 // Default capacity if not set
    }));

    // Import the CommonJS module
//    const { planWithTomTom } = require('./routeplanning.js');
    
    // Plan routes using TomTom API
    logger.info('Calling TomTom route planning API');
    // Apply contextual timing for multi-route planning as well
    let contextualDepartAt = departAt;
    let contextualArriveAt = arriveAt;
    
    if (routeContext.context === 'pickup' && !departAt && !arriveAt) {
      contextualDepartAt = routeContext.suggestedTime;
    } else if (routeContext.context === 'dropoff' && !departAt && !arriveAt) {
      contextualArriveAt = routeContext.suggestedTime;
    }

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
      departAt: contextualDepartAt,
      arriveAt: contextualArriveAt,
      routeContext: routeContext, // Pass context to TomTom function
      routeType: route_type, // Pass route type for distance-based routing
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
        students_without_coordinates: studentsWithoutCoordinates,
        total_buses_used: result.routes.length,
        total_students_assigned: result.routes.reduce((sum, r) => sum + r.student_ids_ordered.length, 0),
        total_students_excluded: studentsWithoutCoordinates.length,
        total_distance_km: routesWithBusInfo.reduce((sum, r) => sum + r.distance_km, 0),
        planning_params: {
          school_location,
          traffic,
          departAt: contextualDepartAt,
          arriveAt: contextualArriveAt,
          route_context: routeContext,
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
    const { school_location, clustering_algorithm = 'balanced', route_type = 'pickup' } = req.body;

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