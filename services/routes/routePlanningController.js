const { supabase } = require('../../shared/database/supabase');
const { createServiceLogger } = require('../../shared/logger');
const { 
  planWithTomTom, 
  buildBusClusters,
  clusterStudentsBalancedByRouteLoad,
  kMeansGeographicClustering,
  gridBasedClustering,
  densityBasedNearestNeighbor,
  routeBusTomTom
} = require('./routeplanning.js');

const logger = createServiceLogger('route-planning');

// Helper function to determine route context and get appropriate timing
const getRouteContext = async (departAt, arriveAt, schoolLocation) => {
  try {
    const timezone = 'Europe/Athens'; // Default for Greece
    
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

    if (departAt || arriveAt) {
      const targetTime = departAt || arriveAt;
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

      const isWithinTimeSlot = (slots, targetMinutes) => slots.some(slot => {
        const [slotHour, slotMinute] = slot.time_value.split(':').map(Number);
        const slotTimeInMinutes = slotHour * 60 + slotMinute;
        const timeDifference = Math.abs(targetMinutes - slotTimeInMinutes);
        return timeDifference <= 120; // Within 2 hours
      });

      if (isWithinTimeSlot(pickupSlots, targetTimeInMinutes)) {
        return { 
          context: 'pickup', 
          suggestedTime: departAt || targetTime,
          description: 'Morning pickup route (home → school)',
          timezone: timezone,
          localHour: targetHour
        };
      } else if (isWithinTimeSlot(dropoffSlots, targetTimeInMinutes)) {
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

// Validate required parameters for route planning
const validatePlanningParams = (req) => {
  const { school_location } = req.body;
  
  if (!school_location || !school_location.lat || !school_location.lon) {
    return 'School location with lat/lon coordinates is required';
  }

  if (!process.env.TOMTOM_API_KEY) {
    return 'TomTom API key not configured';
  }

  return null;
};

// Fetch students based on schedule or fallback to primary addresses
const fetchStudentsForPlanning = async (req) => {
  const { 
    day_of_week, 
    pickup_time_slot_id, 
    dropoff_time_slot_id, 
    route_type 
  } = req.body;

  let studentsQuery;
  
  if (day_of_week && (pickup_time_slot_id || dropoff_time_slot_id)) {
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

  return await studentsQuery;
};

// Fetch available buses for planning
const fetchAvailableBuses = async () => {
  return await supabase
    .from('buses')
    .select('id, bus_number, capacity, status')
    .eq('status', 'active');
};

// Format student data for route planning
const formatStudentsForPlanning = (students, day_of_week, route_type) => {
  const formattedStudents = [];
  const studentsWithoutCoordinates = [];
  
  students.forEach(s => {
    if (day_of_week && s.schedules && s.schedules.length > 0) {
      const daySchedule = s.schedules[0];
      
      let targetAddressId = null;
      if (route_type === 'pickup') {
        targetAddressId = daySchedule.pickup_address_id;
      } else if (route_type === 'dropoff') {
        targetAddressId = daySchedule.dropoff_address_id;
      } else {
        targetAddressId = daySchedule.pickup_address_id || daySchedule.dropoff_address_id;
      }
      
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

  return { formattedStudents, studentsWithoutCoordinates };
};

// Process multiple clusters from frontend
const processMultipleClusters = async (clusters, req) => {
  const { school_location, traffic, departAt, arriveAt, route_type } = req.body;
  const routeContext = req.body.route_context || await getRouteContext(departAt, arriveAt, school_location);
  
  logger.info('Using clusters provided from frontend', { 
    clusters_count: clusters.length,
    total_students: clusters.reduce((sum, c) => sum + c.students.length, 0)
  });

  const allRoutes = [];
  const allUnassigned = [];

  for (let i = 0; i < clusters.length; i++) {
    const cluster = clusters[i];
    
    if (!cluster.students || cluster.students.length === 0) {
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
    }
  }

  const totalDistance = allRoutes.reduce((sum, r) => sum + (r.total_distance_m || 0), 0);
  const totalStudents = allRoutes.reduce((sum, r) => sum + (r.student_ids_ordered?.length || 0), 0);

  return {
    routes: allRoutes,
    unassigned_students: allUnassigned,
    total_buses_used: allRoutes.length,
    total_students_assigned: totalStudents,
    total_distance_km: (totalDistance / 1000).toFixed(2),
    route_context: routeContext
  };
};

// Process single cluster optimization
const processSingleCluster = async (single_cluster, req) => {
  const { school_location, traffic, departAt, arriveAt, route_type } = req.body;
  const routeContext = req.body.route_context || await getRouteContext(departAt, arriveAt, school_location);

  if (!single_cluster.students || single_cluster.students.length === 0) {
    throw new Error('Single cluster must have students');
  }

  // Fetch available buses to validate the cluster's bus
  const { data: buses, error: busesError } = await fetchAvailableBuses();
  if (busesError) {
    throw new Error('Failed to fetch buses: ' + busesError.message);
  }

  const bus = buses.find(b => b.id === single_cluster.bus_id);
  if (!bus) {
    throw new Error('Bus not found for the specified cluster');
  }

  const formattedStudents = single_cluster.students.map(s => ({
    id: s.id,
    name: s.name,
    grade: s.grade,
    lat: parseFloat(s.lat),
    lon: parseFloat(s.lon),
    address: s.address
  }));

  const routeStops = single_cluster.stops || [];

  // Adjust timing based on route context
  let contextualDepartAt = departAt;
  let contextualArriveAt = arriveAt;
  
  if (routeContext.context === 'pickup' && !departAt && !arriveAt) {
    contextualDepartAt = routeContext.suggestedTime;
  } else if (routeContext.context === 'dropoff' && !departAt && !arriveAt) {
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
    routeContext: routeContext,
    routeType: route_type,
    timeout: 120000
  });
  
  const routeWithBusInfo = {
    bus_id: bus.id,
    bus_name: bus.bus_number,
    capacity: bus.capacity || 30,
    student_ids_ordered: tomTomResult.student_ids_ordered,
    stops_ordered: tomTomResult.stops_ordered || [],
    students_ordered: tomTomResult.students_ordered || [],
    route_segments: tomTomResult.route_segments || [],
    reordered_waypoints: tomTomResult.reordered_waypoints || [],
    total_distance_m: tomTomResult.total_distance_m,
    students_assigned: tomTomResult.student_ids_ordered.length,
    distance_km: Math.round(tomTomResult.total_distance_m / 1000 * 100) / 100,
    estimated_duration_minutes: Math.round(tomTomResult.total_distance_m / 1000 / 40 * 60) // Estimate at 40 km/h
  };

  return {
    routes: [routeWithBusInfo],
    unassigned_students: [],
    total_buses_used: 1,
    total_students_assigned: routeWithBusInfo.students_assigned || 0,
    total_distance_km: routeWithBusInfo.distance_km || 0,
    planning_params: {
      school_location,
      traffic,
      departAt: contextualDepartAt,
      arriveAt: contextualArriveAt,
      route_context: routeContext,
      single_cluster: true
    }
  };
};

// Apply contextual timing based on route context
const applyContextualTiming = (routeContext, departAt, arriveAt) => {
  let contextualDepartAt = departAt;
  let contextualArriveAt = arriveAt;
  
  if (routeContext.context === 'pickup' && !departAt && !arriveAt) {
    contextualDepartAt = routeContext.suggestedTime;
  } else if (routeContext.context === 'dropoff' && !departAt && !arriveAt) {
    contextualArriveAt = routeContext.suggestedTime;
  }

  return { contextualDepartAt, contextualArriveAt };
};

// Process multi-route planning
const processMultiRoutePlanning = async (formattedStudents, formattedBuses, req, routeContext) => {
  const { traffic, useBatch, route_type, departAt, arriveAt, school_location } = req.body;
  
  const { contextualDepartAt, contextualArriveAt } = applyContextualTiming(routeContext, departAt, arriveAt);

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
    routeContext: routeContext,
    routeType: route_type,
    timeout: 120000
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

  return {
    routesWithBusInfo,
    unassignedStudentDetails,
    result,
    contextualDepartAt,
    contextualArriveAt
  };
};

// Main route planning function
const planRoutes = async (req, res) => {
  try {
    const { 
      school_location, 
      traffic = false, 
      departAt, 
      arriveAt,
      useBatch = true,
      single_cluster = null,
      clusters = null,
      route_type = 'pickup',
      day_of_week,
      pickup_time_slot_id,
      dropoff_time_slot_id
    } = req.body;

    console.log(req.body);

    // Validate required parameters
    const validationError = validatePlanningParams(req);
    if (validationError) {
      return res.status(validationError.includes('configured') ? 500 : 400).json({
        success: false,
        error: validationError
      });
    }

    // Determine route context for better TomTom optimization
    const routeContext = req.body.route_context || await getRouteContext(departAt, arriveAt, school_location);
    
    logger.info('Starting route planning', { 
      school_location, 
      traffic, 
      departAt, 
      arriveAt, 
      useBatch,
      context: routeContext
    });

    // Handle multiple clusters from frontend
    if (clusters && clusters.length > 0) {
      const result = await processMultipleClusters(clusters, req);
      return res.json({
        success: true,
        data: result
      });
    }

    // Handle single cluster optimization (check before fetching all data)
    if (single_cluster) {

      console.log('++++++++++++++')

      const result = await processSingleCluster(single_cluster, req);
      return res.json({
        success: true,
        data: result
      });
    }

    // Fetch students and buses for multi-route planning
    const { data: students, error: studentsError } = await fetchStudentsForPlanning(req);
    if (studentsError) {
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

    const { data: buses, error: busesError } = await fetchAvailableBuses();
    if (busesError) {
      throw new Error('Failed to fetch buses: ' + busesError.message);
    }

    if (!buses || buses.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No active buses available for route planning'
      });
    }

    logger.info(`Found ${students.length} students and ${buses.length} buses for planning`);

    // Format data for multi-route planning
    const { formattedStudents, studentsWithoutCoordinates } = formatStudentsForPlanning(
      students, 
      day_of_week, 
      route_type
    );

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

    if (studentsWithoutCoordinates.length > 0) {
      logger.warn(`Found ${studentsWithoutCoordinates.length} students without valid coordinates:`, 
        studentsWithoutCoordinates.map(s => `${s.name} (${s.reason})`));
    }

    const formattedBuses = buses.map(b => ({
      id: b.id,
      name: b.bus_number,
      capacity: b.capacity || 30
    }));

    // Process multi-route planning
    const {
      routesWithBusInfo,
      unassignedStudentDetails,
      result,
      contextualDepartAt,
      contextualArriveAt
    } = await processMultiRoutePlanning(formattedStudents, formattedBuses, req, routeContext);

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
};

// Get route planning preview (without calling TomTom API)
const planPreview = async (req, res) => {
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
    const { data: buses, error: busesError } = await fetchAvailableBuses();
    if (busesError) throw busesError;

    // Format data for clustering
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

    // Select clustering algorithm
    const clusteringFunctions = {
      'sweep': buildBusClusters,
      'balanced': clusterStudentsBalancedByRouteLoad,
      'kmeans': kMeansGeographicClustering,
      'grid': gridBasedClustering,
      'density': densityBasedNearestNeighbor
    };

    const clusteringFunction = clusteringFunctions[clustering_algorithm] || clusterStudentsBalancedByRouteLoad;

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
          address: s.address,
          lat: s.lat,
          lon: s.lon
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
};

module.exports = {
  planRoutes,
  planPreview,
  getRouteContext,
  validatePlanningParams,
  fetchStudentsForPlanning,
  fetchAvailableBuses,
  formatStudentsForPlanning,
  processMultipleClusters,
  processSingleCluster,
  applyContextualTiming,
  processMultiRoutePlanning
};