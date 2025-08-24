const axios = require('axios');

function hav(a, b) {
  const R = 6371000;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function angle(center, p) {
  const dy = p.lat - center.lat;
  const dx = p.lon - center.lon;
  const a = (Math.atan2(dy, dx) * 180) / Math.PI;
  return a >= 0 ? a : a + 360;
}

function toCoordString(lat, lon) {
  return `${Number(lat).toFixed(6)},${Number(lon).toFixed(6)}`;
}

// Find the furthest student from school using Haversine distance
function findFurthestStudent(students, school) {
  if (!students || students.length === 0) return null;
  
  let furthestStudent = null;
  let maxDistance = 0;
  
  students.forEach(student => {
    const distance = hav(school, { lat: student.lat, lon: student.lon });
    if (distance > maxDistance) {
      maxDistance = distance;
      furthestStudent = student;
    }
  });
  
  return furthestStudent;
}

function buildTomTomPath({ school, students, stops = [], routeType = 'pickup' }) {
  const parts = [];
  
  // Filter out students without valid coordinates
  const validStudents = students.filter(s => {
    const lat = s.lat;
    const lon = s.lon;
    
    // Check for null, undefined, empty string, 0, or NaN values
    if (lat == null || lon == null || 
        lat === '' || lon === '' ||
        lat === 0 || lon === 0 ||
        isNaN(Number(lat)) || isNaN(Number(lon))) {
      console.warn(`Student ${s.id} (${s.name}) has invalid coordinates: lat=${lat}, lon=${lon}`);
      return false;
    }
    
    // Additional check for realistic coordinate ranges
    const numLat = Number(lat);
    const numLon = Number(lon);
    
    if (numLat < -90 || numLat > 90 || numLon < -180 || numLon > 180) {
      console.warn(`Student ${s.id} (${s.name}) has out-of-range coordinates: lat=${numLat}, lon=${numLon}`);
      return false;
    }
    
    return true;
  });
  
  if (validStudents.length !== students.length) {
    console.warn(`Filtered out ${students.length - validStudents.length} students with invalid coordinates`);
  }
  
  // For pickup routes: Start from furthest student, end at school
  // For dropoff routes: Start from school, end at furthest student
  
  if (routeType === 'pickup') {
    // Find the furthest student to start the route
    const furthestStudent = findFurthestStudent(validStudents, school);
    console.log(`PICKUP ROUTE: Found furthest student: ${furthestStudent?.name} at ${furthestStudent?.lat}, ${furthestStudent?.lon}`);
    
    if (furthestStudent) {
      // Start from the furthest student
      parts.push(toCoordString(furthestStudent.lat, furthestStudent.lon));
      console.log(`PICKUP ROUTE: Starting from furthest student ${furthestStudent.name}`);
      
      // Add other students (TomTom will optimize the order between them)
      validStudents.forEach(s => {
        if (s.id !== furthestStudent.id) {
          parts.push(toCoordString(s.lat, s.lon));
        }
      });
      
      // Add route stops if provided
      if (stops && stops.length > 0) {
        stops.forEach(stop => {
          if (stop.latitude && stop.longitude) {
            parts.push(toCoordString(stop.latitude, stop.longitude));
          }
        });
      }
      
      // End at school
      parts.push(toCoordString(school.lat, school.lon));
    } else {
      // Fallback if no students
      parts.push(toCoordString(school.lat, school.lon));
    }
    
  } else if (routeType === 'dropoff') {
    // Start from school
    parts.push(toCoordString(school.lat, school.lon));
    
    // Add route stops if provided
    if (stops && stops.length > 0) {
      stops.forEach(stop => {
        if (stop.latitude && stop.longitude) {
          parts.push(toCoordString(stop.latitude, stop.longitude));
        }
      });
    }
    
    // Find the furthest student to end the route
    const furthestStudent = findFurthestStudent(validStudents, school);
    
    if (furthestStudent) {
      // Add other students first (TomTom will optimize the order)
      validStudents.forEach(s => {
        if (s.id !== furthestStudent.id) {
          parts.push(toCoordString(s.lat, s.lon));
        }
      });
      
      // End at the furthest student
      parts.push(toCoordString(furthestStudent.lat, furthestStudent.lon));
    }
  } else {
    // Default behavior (mixed or unknown route type)
    parts.push(toCoordString(school.lat, school.lon));
    
    if (stops && stops.length > 0) {
      stops.forEach(stop => {
        if (stop.latitude && stop.longitude) {
          parts.push(toCoordString(stop.latitude, stop.longitude));
        }
      });
    }
    
    validStudents.forEach(s => {
      parts.push(toCoordString(s.lat, s.lon));
    });
  }
  
  console.log(`Built ${routeType} route path with ${parts.length} waypoints`);
  console.log('Route waypoints order:', parts);
  console.log('Waypoints breakdown:');
  parts.forEach((coord, index) => {
    console.log(`  Waypoint ${index + 1}: ${coord}`);
  });
  
  const finalPath = parts.join(":");
  console.log('Final path string:', finalPath);
  
  return finalPath;
}

function extractOptimizedRoute(tomTomResponse, originalWaypoints) {
  
  const { routes, optimizedWaypoints } = tomTomResponse;
  
  if (!routes || routes.length === 0) {
    console.warn('No routes found in TomTom response');
    return { reorderedWaypoints: [], routeSegments: [] };
  }
  
  const route = routes[0];
  const legs = route.legs || [];
  
  console.log('=== TOMTOM WAYPOINT RECONSTRUCTION ===');
  console.log('Original waypoints count:', originalWaypoints.length);
  console.log('Optimized waypoints from TomTom:', optimizedWaypoints);
  
  let reorderedWaypoints = [];
  
  if (!optimizedWaypoints || optimizedWaypoints.length === 0) {
    // No optimization data, use original order
    console.log('No optimization data from TomTom, using original order');
    reorderedWaypoints = originalWaypoints;
  } else {
    // TomTom's optimizedWaypoints contains only the middle waypoints that can be reordered
    // providedIndex is relative to ONLY those middle waypoints, not the entire path
    
    // Extract the middle waypoints (exclude first and last from original)
    const middleOriginalWaypoints = originalWaypoints.slice(1, -1);
    console.log('Middle waypoints that were optimized:', middleOriginalWaypoints.map(w => w.id));
    
    // First waypoint is always fixed (not optimized)
    reorderedWaypoints.push(originalWaypoints[0]);
    
    // Add the reordered middle waypoints
    // providedIndex refers to the position in middleOriginalWaypoints array
    const reorderedMiddle = optimizedWaypoints
      .sort((a, b) => a.optimizedIndex - b.optimizedIndex)
      .map(wp => {
        const waypoint = middleOriginalWaypoints[wp.providedIndex];
        console.log(`Optimized middle waypoint ${wp.optimizedIndex}: Original middle index ${wp.providedIndex} = ${waypoint?.id}`);
        return waypoint;
      });
    reorderedWaypoints.push(...reorderedMiddle);
    
    // Last waypoint is always fixed (not optimized)
    reorderedWaypoints.push(originalWaypoints[originalWaypoints.length - 1]);
  }
  
  console.log('Final reordered waypoints:', reorderedWaypoints.map(w => ({type: w.type, id: w.id})));
  
  
  // Create route segments from consecutive waypoints
  const routeSegments = reorderedWaypoints.slice(0, -1).map((fromWaypoint, i) => {
    const toWaypoint = reorderedWaypoints[i + 1];
    const leg = legs[i];
    
    const segment = {
      from: fromWaypoint,
      to: toWaypoint,
      distanceMeters: leg?.summary?.lengthInMeters || 0,
      durationSeconds: leg?.summary?.travelTimeInSeconds || 0,
      durationMinutes: leg?.summary?.travelTimeInSeconds ? leg.summary.travelTimeInSeconds / 60 : 0
    };
    
    console.log(`Segment ${i}:`, segment);
    return segment;
  });
  
  return { reorderedWaypoints, routeSegments };
}

function sweepCluster({ school, students, buses }) {
  const pts = students
    .map(s => ({ id: s.id, lat: s.lat, lon: s.lon }))
    .sort((a, b) => {
      const aa = angle(school, a);
      const ab = angle(school, b);
      if (aa !== ab) return aa - ab;
      return hav(school, a) - hav(school, b);
    });
  const clusters = buses.map(b => ({ bus: b, ids: [] }));
  if (!clusters.length) return { clusters: [], unassigned: students.map(s => s.id) };
  let bi = 0;
  let left = clusters[bi].bus.capacity;
  for (const p of pts) {
    if (left === 0) {
      bi = Math.min(bi + 1, clusters.length - 1);
      left = clusters[bi].bus.capacity;
    }
    clusters[bi].ids.push(p.id);
    left -= 1;
  }
  for (let i = 0; i < clusters.length - 1; i++) {
    while (clusters[i].ids.length > clusters[i].bus.capacity && clusters[i + 1].ids.length < clusters[i + 1].bus.capacity) {
      clusters[i + 1].ids.unshift(clusters[i].ids.pop());
    }
    while (clusters[i].ids.length < clusters[i].bus.capacity && clusters[i + 1].ids.length > clusters[i + 1].bus.capacity) {
      clusters[i].ids.push(clusters[i + 1].ids.shift());
    }
  }
  const assigned = new Set(clusters.flatMap(c => c.ids));
  const unassigned = students.filter(s => !assigned.has(s.id)).map(s => s.id);
  return { clusters, unassigned };
}

function buildBusClusters({ school, students, buses }) {
  const { clusters } = sweepCluster({ school, students, buses });
  const idMap = new Map(students.map(s => [s.id, s]));
  return clusters.map(c => ({
    bus_id: c.bus.id,
    capacity: c.bus.capacity,
    students: c.ids.map(id => idMap.get(id)).filter(Boolean)
  }));
}

async function routeBusTomTom({ apiKey, school, students, stops = [], traffic = false, departAt, arriveAt, avoidTolls = false, timeout = 60000, baseUrl = "https://api.tomtom.com", routeType = 'pickup' }) {
  console.log('=== TOMTOM routeBusTomTom FUNCTION ===');
  console.log('School:', school);
  console.log('Students count:', students.length);
  console.log('Students:', students);
  console.log('Stops count:', stops.length);
  console.log('Stops:', stops);
  
  const path = buildTomTomPath({ school, students, stops, routeType });
  console.log('Built TomTom path:', path);
  
  // Get the same validStudents that buildTomTomPath uses
  const validStudents = students.filter(s => {
    const lat = s.lat;
    const lon = s.lon;
    
    if (lat == null || lon == null || 
        lat === '' || lon === '' ||
        lat === 0 || lon === 0 ||
        isNaN(Number(lat)) || isNaN(Number(lon))) {
      return false;
    }
    
    const numLat = Number(lat);
    const numLon = Number(lon);
    
    if (numLat < -90 || numLat > 90 || numLon < -180 || numLon > 180) {
      return false;
    }
    
    return true;
  });
  
  console.log(`=== STUDENT FILTERING DEBUG ===`);
  console.log(`Original students: ${students.length}`);
  console.log(`Valid students after filtering: ${validStudents.length}`);
  console.log(`Route type: ${routeType}`);
  console.log(`Valid students:`, validStudents.map(s => ({ id: s.id, name: s.name, lat: s.lat, lon: s.lon })));
  
  const url = `${baseUrl}/routing/1/calculateRoute/${path}/json`;
  const params = {
    key: apiKey,
    computeBestOrder: "true",
    routeType: "fastest",
    traffic: traffic ? "true" : "false"
  };
  
  // Add toll avoidance if requested
  if (avoidTolls) {
    params.avoid = "tollRoads";
  }
  
  if (departAt) params.departAt = departAt;
  if (arriveAt) params.arriveAt = arriveAt;
  
  const fullUrl = url + '?' + new URLSearchParams(params).toString();
  console.log('=== TOMTOM API REQUEST ===');
  console.log('EXACT URL BEING CALLED:');
  console.log(fullUrl);
  console.log('Number of waypoints in path:', path.split(':').length);
  
  const res = await axios.get(url, { params, timeout });
  
  // Build original waypoints array in the EXACT order they were sent to TomTom
  const originalWaypoints = [];
  
  // Reconstruct the order based on routeType (must match buildTomTomPath logic EXACTLY)
  if (routeType === 'pickup') {
    const furthestStudent = findFurthestStudent(validStudents, school);
    
    if (furthestStudent) {
      // Start from the furthest student
      originalWaypoints.push({
        type: 'student',
        data: furthestStudent,
        id: furthestStudent.id
      });
      
      // Add other students (only those that are NOT the furthest student)
      const otherStudents = validStudents.filter(s => s.id !== furthestStudent.id);
      otherStudents.forEach(s => {
        originalWaypoints.push({
          type: 'student',
          data: s,
          id: s.id
        });
      });
      
      // Add route stops (if they have valid coordinates)
      if (stops && stops.length > 0) {
        stops.forEach((stop, index) => {
          if (stop.latitude && stop.longitude) {
            originalWaypoints.push({
              type: 'stop',
              data: stop,
              id: stop.id || `stop_${index}`
            });
          }
        });
      }
      
      // End at school
      originalWaypoints.push({
        type: 'school',
        data: school,
        id: 'school'
      });
    } else {
      // Fallback if no students - just school
      originalWaypoints.push({
        type: 'school',
        data: school,
        id: 'school'
      });
    }
  } else if (routeType === 'dropoff') {
    // Start from school
    originalWaypoints.push({
      type: 'school',
      data: school,
      id: 'school'
    });
    
    // Add stops
    if (stops && stops.length > 0) {
      stops.forEach((stop, index) => {
        originalWaypoints.push({
          type: 'stop',
          data: stop,
          id: stop.id || `stop_${index}`
        });
      });
    }
    
    const furthestStudent = findFurthestStudent(validStudents, school);
    
    if (furthestStudent) {
      // Add other students first
      validStudents.forEach(s => {
        if (s.id !== furthestStudent.id) {
          originalWaypoints.push({
            type: 'student',
            data: s,
            id: s.id
          });
        }
      });
      
      // End at furthest student
      originalWaypoints.push({
        type: 'student',
        data: furthestStudent,
        id: furthestStudent.id
      });
    }
  } else {
    // Default/mixed - use original order
    originalWaypoints.push({
      type: 'school',
      data: school,
      id: 'school'
    });
    
    if (stops && stops.length > 0) {
      stops.forEach((stop, index) => {
        originalWaypoints.push({
          type: 'stop',
          data: stop,
          id: stop.id || `stop_${index}`
        });
      });
    }
    
    validStudents.forEach(student => {
      originalWaypoints.push({
        type: 'student',
        data: student,
        id: student.id
      });
    });
  }
  
  console.log('=== WAYPOINT RECONSTRUCTION DEBUG ===');
  console.log('TomTom path parts:', path.split(':').length);
  console.log('Original waypoints reconstructed:', originalWaypoints.length);
  console.log('Waypoints detail:', originalWaypoints.map(w => ({ type: w.type, id: w.id })));
  console.log('=== END DEBUG ===');
  
  // Use the extraction function to get optimized route
  const extractedRoute = extractOptimizedRoute(res.data, originalWaypoints);
  
  // Separate students and stops from reordered waypoints
  const optimizedStudents = extractedRoute.reorderedWaypoints
    .filter(wp => wp.type === 'student')
    .map(wp => wp.data);
  
  const optimizedStops = extractedRoute.reorderedWaypoints
    .filter(wp => wp.type === 'stop')
    .map(wp => wp.data);
  
  console.log('=== WAYPOINT SEPARATION ===');
  console.log('All reordered waypoints:', extractedRoute.reorderedWaypoints.length);
  console.log('Students found:', optimizedStudents.length);
  console.log('Stops found:', optimizedStops.length);
  console.log('Students:', optimizedStudents);
  console.log('Stops:', optimizedStops);
  console.log('=== END SEPARATION ===');
  
  // Calculate total distance
  const totalDistance = extractedRoute.routeSegments.reduce((sum, segment) => sum + segment.distanceMeters, 0);
  
  const result = { 
    student_ids_ordered: optimizedStudents.map(s => s.id),
    stops_ordered: optimizedStops,
    students_ordered: optimizedStudents,
    route_segments: extractedRoute.routeSegments,
    reordered_waypoints: extractedRoute.reorderedWaypoints,
    total_distance_m: totalDistance
  };
  
  console.log('routeBusTomTom final result:', result);
  console.log('=== END TOMTOM routeBusTomTom ===');
  
  return result;
}

function buildBatchItem({ apiKey, school, clusterStudents, stops = [], traffic = false, departAt, arriveAt, baseUrl, routeType = 'pickup' }) {
  const path = buildTomTomPath({ school, students: clusterStudents, stops, routeType });
  const base = `/routing/1/calculateRoute/${path}/json?key=${encodeURIComponent(apiKey)}&computeBestOrder=true&routeType=fastest&traffic=${traffic ? "true" : "false"}`;
  const q = departAt ? `${base}&departAt=${encodeURIComponent(departAt)}` : arriveAt ? `${base}&arriveAt=${encodeURIComponent(arriveAt)}` : base;
  return { query: q, method: "GET", headers: [], body: "" };
}

async function batchRouteTomTom({ apiKey, school, busClusters, stops = [], traffic = false, departAt, arriveAt, timeout = 120000, baseUrl = "https://api.tomtom.com", routeType = 'pickup' }) {
  console.log('=== TOMTOM BATCH REQUEST ===');
  console.log('School:', school);
  console.log('Bus clusters count:', busClusters.length);
  console.log('Bus clusters:', busClusters);
  console.log('Stops:', stops);
  
  const items = busClusters.map(c => buildBatchItem({ apiKey, school, clusterStudents: c.students, stops, traffic, departAt, arriveAt, baseUrl, routeType }));
  const url = `${baseUrl}/routing/batch/sync/json`;
  const requestBody = { batchItems: items };
  
  console.log('POST URL:', url);
  console.log('POST Body:', JSON.stringify(requestBody, null, 2));
  console.log('=== END BATCH REQUEST ===');
  
  const res = await axios.post(url, requestBody, { timeout });
  const out = [];
  for (let i = 0; i < busClusters.length; i++) {
    const it = res.data?.batchItems?.[i];
    const route = it?.response?.routes?.[0];
    const opt = route?.optimizedWaypoints || [];
    
    // Calculate the offset for student IDs (school + stops count)
    const studentOffset = 1 + (stops ? stops.length : 0);
    
    // Extract student sequence from optimized waypoints
    const seq = opt
      .map(o => o.originalIndex)
      .filter(idx => idx >= studentOffset) // Only include student waypoints
      .map(idx => busClusters[i].students[idx - studentOffset].id); // Adjust index for student array
    
    // Extract stops sequence if any
    const stopsOrdered = stops && stops.length > 0 ? opt
      .map(o => o.originalIndex)
      .filter(i => i >= 1 && i < studentOffset) // Only include stop waypoints
      .map(i => stops[i - 1]) // Adjust index for stops array
      : [];
    
    const dist = (route?.legs || []).reduce((a, l) => a + (l.summary?.lengthInMeters || 0), 0);
    out.push({ 
      bus_id: busClusters[i].bus_id, 
      capacity: busClusters[i].capacity, 
      student_ids_ordered: seq, 
      stops_ordered: stopsOrdered,
      total_distance_m: dist 
    });
  }
  const assigned = new Set(out.flatMap(r => r.student_ids_ordered));
  const unassigned = busClusters.flatMap(c => c.students).filter(s => !assigned.has(s.id)).map(s => s.id);
  return { routes: out, unassigned_student_ids: unassigned };
}

async function planWithTomTom({ apiKey, school, students, buses, stops = [], useBatch = true, traffic = false, departAt, arriveAt, timeout, baseUrl, routeType = 'pickup' }) {
  console.log('=== TOMTOM planWithTomTom FUNCTION ===');
  console.log('Input students count:', students.length);
  console.log('Input students:', students);
  console.log('Input stops count:', stops.length);
  console.log('Input stops:', stops);
  console.log('Input school:', school);
  console.log('Input buses:', buses);
  console.log('UseBatch:', useBatch);
  
  const busClusters = buildBusClusters({ school, students, buses });
  console.log('Built bus clusters:', busClusters);
  
  if (useBatch) {
    console.log('=== USING BATCH MODE (POST) ===');
    return batchRouteTomTom({ apiKey, school, busClusters, stops, traffic, departAt, arriveAt, timeout, baseUrl, routeType });
  } else {
    console.log('=== USING SINGLE MODE (GET) ===');
    const routes = [];
    for (const bc of busClusters) {
      console.log('Processing bus cluster:', bc);
      console.log('  - Bus ID:', bc.bus_id);
      console.log('  - Students in cluster:', bc.students.length);
      console.log('  - Students data:', bc.students);
      
      const r = await routeBusTomTom({ apiKey, school, students: bc.students, stops, traffic, departAt, arriveAt, timeout, baseUrl });
      console.log('TomTom result for cluster:', r);
      
      routes.push({ 
        bus_id: bc.bus_id, 
        capacity: bc.capacity, 
        student_ids_ordered: r.student_ids_ordered, 
        stops_ordered: r.stops_ordered || [],
        total_distance_m: r.total_distance_m 
      });
    }
    const assigned = new Set(routes.flatMap(r => r.student_ids_ordered));
    const unassigned = students.filter(s => !assigned.has(s.id)).map(s => s.id);
    console.log('Final planWithTomTom result:', { routes, unassigned_student_ids: unassigned });
    return { routes, unassigned_student_ids: unassigned };
  }
}


//
function haversine(a, b) {
  const R = 6371000;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function estimateAddedDistance(route, newStudent, school) {
  if (route.length === 0) return haversine(newStudent, school);
  const last = route[route.length - 1];
  return haversine(last, newStudent) + haversine(newStudent, school) - haversine(last, school);
}

function sortStudentsByCrowFly(students, school) {
  return [...students].sort((a, b) => haversine(a, school) - haversine(b, school));
}

function clusterStudentsBalancedByRouteLoad({ school, students, buses }) {
  const totalStudents = students.length;
  const totalCapacity = buses.reduce((sum, b) => sum + b.capacity, 0);
  const idMap = new Map(students.map(s => [s.id, s]));

  const busTargets = buses.map(b => ({
    bus: b,
    targetSize: totalStudents * (b.capacity / totalCapacity)
  }));

  const clusters = busTargets.map(bt => ({
    bus: bt.bus,
    targetSize: bt.targetSize,
    studentIds: []
  }));

  const sortedStudents = sortStudentsByCrowFly(students, school);

  for (const student of sortedStudents) {
    const candidates = clusters
      .filter(c => c.studentIds.length < c.bus.capacity)
      .map(c => ({
        cluster: c,
        addedDistance: estimateAddedDistance(c.studentIds.map(id => idMap.get(id)), student, school),
        penalty: Math.abs(c.studentIds.length + 1 - c.targetSize)
      }))
      .sort((a, b) => (a.addedDistance + a.penalty * 1000) - (b.addedDistance + b.penalty * 1000));

    if (candidates.length > 0) {
      candidates[0].cluster.studentIds.push(student.id);
    }
  }

  return clusters.map(c => ({
    bus_id: c.bus.id,
    capacity: c.bus.capacity,
    students: c.studentIds.map(id => idMap.get(id)).filter(Boolean)
  }));
}
/**
 * K-Means Geographic Clustering
 * Groups students into geographic clusters using k-means algorithm
 * Ensures buses stay in localized areas and balances load
 */
function kMeansGeographicClustering({ school, students, buses }) {
  if (buses.length === 0 || students.length === 0) {
    return buses.map(b => ({
      bus_id: b.id,
      capacity: b.capacity,
      students: []
    }));
  }

  // Create ID map for safe student lookups
  const idMap = new Map(students.map(s => [s.id, s]));

  // Initialize cluster centers - spread them around the school area
  const angleStep = (2 * Math.PI) / buses.length;
  const radius = 0.01; // About 1km in lat/lon degrees
  
  let centers = buses.map((bus, i) => ({
    bus_id: bus.id,
    capacity: bus.capacity,
    lat: school.lat + radius * Math.cos(i * angleStep),
    lon: school.lon + radius * Math.sin(i * angleStep),
    studentIds: []
  }));

  // K-means iterations
  const maxIterations = 50;
  let changed = true;
  let iteration = 0;

  while (changed && iteration < maxIterations) {
    changed = false;
    iteration++;

    // Clear current assignments
    centers.forEach(c => c.studentIds = []);

    // Assign each student to nearest center with capacity
    const assignedStudents = new Set();
    
    // Sort students by distance to school to prioritize closer students
    const sortedStudents = [...students].sort((a, b) => 
      haversine(a, school) - haversine(b, school)
    );

    for (const student of sortedStudents) {
      // Find nearest center with available capacity
      const distances = centers
        .filter(c => c.studentIds.length < c.capacity)
        .map(center => ({
          center,
          distance: haversine(student, center)
        }))
        .sort((a, b) => a.distance - b.distance);

      if (distances.length > 0) {
        distances[0].center.studentIds.push(student.id);
        assignedStudents.add(student.id);
      }
    }

    // Update centers to be the centroid of assigned students
    const newCenters = centers.map(center => {
      if (center.studentIds.length > 0) {
        const clusterStudents = center.studentIds.map(id => idMap.get(id)).filter(Boolean);
        const avgLat = clusterStudents.reduce((sum, s) => sum + s.lat, 0) / clusterStudents.length;
        const avgLon = clusterStudents.reduce((sum, s) => sum + s.lon, 0) / clusterStudents.length;
        
        if (Math.abs(center.lat - avgLat) > 0.0001 || Math.abs(center.lon - avgLon) > 0.0001) {
          changed = true;
        }
        
        return {
          ...center,
          lat: avgLat,
          lon: avgLon
        };
      }
      return center;
    });

    centers = newCenters;
  }

  // Balance load between nearby clusters
  balanceNearbyClusterLoads(centers, idMap);

  // Map back to original student objects using the ID map
  return centers.map(c => ({
    bus_id: c.bus_id,
    capacity: c.capacity,
    students: c.studentIds.map(id => {
      const student = idMap.get(id);
      // Return a new object to avoid reference sharing
      return student ? {
        id: student.id,
        name: student.name,
        grade: student.grade,
        lat: student.lat,
        lon: student.lon,
        address: student.address
      } : null;
    }).filter(Boolean)
  }));
}

/**
 * Grid-Based Clustering
 * Divides the area into a grid and assigns buses to grid cells
 * Ensures geographic locality and balanced distribution
 */
function gridBasedClustering({ school, students, buses }) {
  if (buses.length === 0 || students.length === 0) {
    return buses.map(b => ({
      bus_id: b.id,
      capacity: b.capacity,
      students: []
    }));
  }

  const idMap = new Map(students.map(s => [s.id, s]));

  // Find bounding box of all students
  const lats = students.map(s => s.lat);
  const lons = students.map(s => s.lon);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);

  // Create grid dimensions based on number of buses
  const gridSize = Math.ceil(Math.sqrt(buses.length));
  const latStep = (maxLat - minLat) / gridSize;
  const lonStep = (maxLon - minLon) / gridSize;

  // Assign students to grid cells
  const grid = {};
  for (const student of students) {
    const row = Math.min(Math.floor((student.lat - minLat) / latStep), gridSize - 1);
    const col = Math.min(Math.floor((student.lon - minLon) / lonStep), gridSize - 1);
    const key = `${row},${col}`;
    if (!grid[key]) {
      grid[key] = [];
    }
    grid[key].push(student.id); // Store only student ID
  }

  // Sort grid cells by number of students (prioritize dense areas)
  const sortedCells = Object.entries(grid)
    .sort((a, b) => b[1].length - a[1].length);

  // Assign buses to grid cells
  const clusters = buses.map(b => ({
    bus_id: b.id,
    capacity: b.capacity,
    studentIds: [],
    assignedCells: []
  }));

  // First pass: assign each bus to the most populated cell
  sortedCells.forEach((cell, index) => {
    if (index < buses.length) {
      const cluster = clusters[index];
      const studentIdsToAdd = cell[1].slice(0, cluster.capacity);
      cluster.studentIds.push(...studentIdsToAdd);
      cluster.assignedCells.push(cell[0]);
    }
  });

  // Second pass: distribute remaining students to nearest buses with capacity
  const assignedStudentIds = new Set(clusters.flatMap(c => c.studentIds));
  const unassignedStudents = students.filter(s => !assignedStudentIds.has(s.id));

  for (const student of unassignedStudents) {
    // Find cluster with capacity and minimum total distance to existing students
    const availableClusters = clusters
      .filter(c => c.studentIds.length < c.capacity)
      .map(c => ({
        cluster: c,
        avgDistance: c.studentIds.length > 0 
          ? c.studentIds.reduce((sum, id) => sum + haversine(student, idMap.get(id)), 0) / c.studentIds.length
          : haversine(student, school)
      }))
      .sort((a, b) => a.avgDistance - b.avgDistance);

    if (availableClusters.length > 0) {
      availableClusters[0].cluster.studentIds.push(student.id);
    }
  }

  return clusters.map(c => ({
    bus_id: c.bus_id,
    capacity: c.capacity,
    students: c.studentIds.map(id => idMap.get(id)).filter(Boolean)
  }));
}

/**
 * Density-Based Nearest Neighbor Clustering
 * Starts from dense areas and expands clusters by adding nearest neighbors
 * Optimizes for minimal travel distance within each cluster
 */
function densityBasedNearestNeighbor({ school, students, buses }) {
  if (buses.length === 0 || students.length === 0) {
    return buses.map(b => ({
      bus_id: b.id,
      capacity: b.capacity,
      students: []
    }));
  }

  const idMap = new Map(students.map(s => [s.id, s]));

  // Calculate student density for each student (number of neighbors within 500m)
  const densityRadius = 500; // meters
  const studentDensities = students.map(student => {
    const neighbors = students.filter(s => 
      s.id !== student.id && haversine(student, s) <= densityRadius
    ).length;
    return { student, density: neighbors };
  });

  // Sort by density (descending) to start clusters in dense areas
  studentDensities.sort((a, b) => b.density - a.density);

  // Initialize clusters with buses
  const clusters = buses.map(b => ({
    bus_id: b.id,
    capacity: b.capacity,
    studentIds: [],
    center: null
  }));

  const assignedStudents = new Set();

  // Assign seed students to each cluster (highest density areas)
  for (let i = 0; i < Math.min(buses.length, studentDensities.length); i++) {
    if (clusters[i].studentIds.length < clusters[i].capacity) {
      const seedStudent = studentDensities[i].student;
      clusters[i].studentIds.push(seedStudent.id);
      clusters[i].center = { lat: seedStudent.lat, lon: seedStudent.lon };
      assignedStudents.add(seedStudent.id);
    }
  }

  // Grow clusters by adding nearest unassigned neighbors
  let hasCapacity = true;
  while (hasCapacity && assignedStudents.size < students.length) {
    hasCapacity = false;

    for (const cluster of clusters) {
      if (cluster.studentIds.length >= cluster.capacity) continue;
      hasCapacity = true;

      // Find nearest unassigned student to any student in the cluster
      let nearestStudent = null;
      let minDistance = Infinity;

      for (const studentId of cluster.studentIds) {
        const clusterStudent = idMap.get(studentId);
        for (const candidate of students) {
          if (assignedStudents.has(candidate.id)) continue;
          
          const distance = haversine(clusterStudent, candidate);
          if (distance < minDistance) {
            minDistance = distance;
            nearestStudent = candidate;
          }
        }
      }

      if (nearestStudent && cluster.studentIds.length < cluster.capacity) {
        cluster.studentIds.push(nearestStudent.id);
        assignedStudents.add(nearestStudent.id);
        
        // Update cluster center
        const clusterStudents = cluster.studentIds.map(id => idMap.get(id));
        cluster.center = {
          lat: clusterStudents.reduce((sum, s) => sum + s.lat, 0) / clusterStudents.length,
          lon: clusterStudents.reduce((sum, s) => sum + s.lon, 0) / clusterStudents.length
        };
      }
    }
  }

  // Assign any remaining unassigned students
  const unassigned = students.filter(s => !assignedStudents.has(s.id));
  for (const student of unassigned) {
    const availableClusters = clusters
      .filter(c => c.studentIds.length < c.capacity)
      .map(c => ({
        cluster: c,
        distance: c.center ? haversine(student, c.center) : haversine(student, school)
      }))
      .sort((a, b) => a.distance - b.distance);

    if (availableClusters.length > 0) {
      availableClusters[0].cluster.studentIds.push(student.id);
    }
  }

  return clusters.map(c => ({
    bus_id: c.bus_id,
    capacity: c.capacity,
    students: c.studentIds.map(id => idMap.get(id)).filter(Boolean)
  }));
}

/**
 * Helper function to balance loads between nearby clusters
 */
function balanceNearbyClusterLoads(clusters, idMap = null) {
  const maxTransferDistance = 1000; // meters
  
  for (let i = 0; i < clusters.length; i++) {
    for (let j = i + 1; j < clusters.length; j++) {
      const c1 = clusters[i];
      const c2 = clusters[j];
      
      // Check if clusters are nearby
      const clusterDistance = haversine(
        { lat: c1.lat, lon: c1.lon },
        { lat: c2.lat, lon: c2.lon }
      );
      
      if (clusterDistance > maxTransferDistance) continue;
      
      // Support both old (students) and new (studentIds) format
      const useStudentIds = c1.studentIds !== undefined;
      
      if (useStudentIds && !idMap) {
        continue; // Skip balancing if using studentIds but no idMap provided
      }
      
      const getStudentCount = (cluster) => useStudentIds ? cluster.studentIds.length : cluster.students.length;
      const getStudents = (cluster) => useStudentIds ? cluster.studentIds.map(id => idMap.get(id)) : cluster.students;
      const removeStudent = (cluster, studentId) => {
        if (useStudentIds) {
          cluster.studentIds = cluster.studentIds.filter(id => id !== studentId);
        } else {
          cluster.students = cluster.students.filter(s => s.id !== studentId);
        }
      };
      const addStudent = (cluster, student) => {
        if (useStudentIds) {
          cluster.studentIds.push(student.id);
        } else {
          cluster.students.push({ ...student });
        }
      };
      
      // Balance if one is overloaded and other has capacity
      while (getStudentCount(c1) > c1.capacity && getStudentCount(c2) < c2.capacity) {
        // Find student in c1 closest to c2
        let bestStudent = null;
        let minDistance = Infinity;
        
        for (const student of getStudents(c1)) {
          const dist = haversine(student, { lat: c2.lat, lon: c2.lon });
          if (dist < minDistance) {
            minDistance = dist;
            bestStudent = student;
          }
        }
        
        if (bestStudent) {
          removeStudent(c1, bestStudent.id);
          addStudent(c2, bestStudent);
        } else {
          break;
        }
      }
      
      // Reverse direction
      while (getStudentCount(c2) > c2.capacity && getStudentCount(c1) < c1.capacity) {
        let bestStudent = null;
        let minDistance = Infinity;
        
        for (const student of getStudents(c2)) {
          const dist = haversine(student, { lat: c1.lat, lon: c1.lon });
          if (dist < minDistance) {
            minDistance = dist;
            bestStudent = student;
          }
        }
        
        if (bestStudent) {
          removeStudent(c2, bestStudent.id);
          addStudent(c1, bestStudent);
        } else {
          break;
        }
      }
    }
  }
}

//



module.exports = {
  sweepCluster,
  buildBusClusters,
  routeBusTomTom,
  batchRouteTomTom,
  planWithTomTom,
  clusterStudentsBalancedByRouteLoad,
  kMeansGeographicClustering,
  gridBasedClustering,
  densityBasedNearestNeighbor
};