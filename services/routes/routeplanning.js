import axios from "axios";

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

function buildTomTomPath({ school, students }) {
  const parts = [toCoordString(school.lat, school.lon), ...students.map(s => toCoordString(s.lat, s.lon))];
  return parts.join(":");
}

export function sweepCluster({ school, students, buses }) {
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

export function buildBusClusters({ school, students, buses }) {
  const { clusters } = sweepCluster({ school, students, buses });
  const idMap = new Map(students.map(s => [s.id, s]));
  return clusters.map(c => ({
    bus_id: c.bus.id,
    capacity: c.bus.capacity,
    students: c.ids.map(id => idMap.get(id)).filter(Boolean)
  }));
}

export async function routeBusTomTom({ apiKey, school, students, traffic = false, departAt, arriveAt, timeout = 60000, baseUrl = "https://api.tomtom.com" }) {
  const path = buildTomTomPath({ school, students });
  const url = `${baseUrl}/routing/1/calculateRoute/${path}/json`;
  const params = {
    key: apiKey,
    computeBestOrder: "true",
    routeType: "fastest",
    traffic: traffic ? "true" : "false"
  };
  if (departAt) params.departAt = departAt;
  if (arriveAt) params.arriveAt = arriveAt;
  const res = await axios.get(url, { params, timeout });
  const route = res.data?.routes?.[0];
  const opt = route?.optimizedWaypoints || [];
  const seq = opt.map(o => o.originalIndex).filter(i => i > 0).map(i => students[i - 1].id);
  const dist = (route?.legs || []).reduce((a, l) => a + (l.summary?.lengthInMeters || 0), 0);
  return { student_ids_ordered: seq, total_distance_m: dist };
}

function buildBatchItem({ apiKey, school, clusterStudents, traffic = false, departAt, arriveAt, baseUrl }) {
  const path = buildTomTomPath({ school, students: clusterStudents });
  const base = `/routing/1/calculateRoute/${path}/json?key=${encodeURIComponent(apiKey)}&computeBestOrder=true&routeType=fastest&traffic=${traffic ? "true" : "false"}`;
  const q = departAt ? `${base}&departAt=${encodeURIComponent(departAt)}` : arriveAt ? `${base}&arriveAt=${encodeURIComponent(arriveAt)}` : base;
  return { query: q, method: "GET", headers: [], body: "" };
}

export async function batchRouteTomTom({ apiKey, school, busClusters, traffic = false, departAt, arriveAt, timeout = 120000, baseUrl = "https://api.tomtom.com" }) {
  const items = busClusters.map(c => buildBatchItem({ apiKey, school, clusterStudents: c.students, traffic, departAt, arriveAt, baseUrl }));
  const url = `${baseUrl}/routing/batch/sync/json`;
  const res = await axios.post(url, { batchItems: items }, { timeout });
  const out = [];
  for (let i = 0; i < busClusters.length; i++) {
    const it = res.data?.batchItems?.[i];
    const route = it?.response?.routes?.[0];
    const opt = route?.optimizedWaypoints || [];
    const seq = opt.map(o => o.originalIndex).filter(idx => idx > 0).map(idx => busClusters[i].students[idx - 1].id);
    const dist = (route?.legs || []).reduce((a, l) => a + (l.summary?.lengthInMeters || 0), 0);
    out.push({ bus_id: busClusters[i].bus_id, capacity: busClusters[i].capacity, student_ids_ordered: seq, total_distance_m: dist });
  }
  const assigned = new Set(out.flatMap(r => r.student_ids_ordered));
  const unassigned = busClusters.flatMap(c => c.students).filter(s => !assigned.has(s.id)).map(s => s.id);
  return { routes: out, unassigned_student_ids: unassigned };
}

export async function planWithTomTom({ apiKey, school, students, buses, useBatch = true, traffic = false, departAt, arriveAt, timeout, baseUrl }) {
  const busClusters = buildBusClusters({ school, students, buses });
  if (useBatch) {
    return batchRouteTomTom({ apiKey, school, busClusters, traffic, departAt, arriveAt, timeout, baseUrl });
  } else {
    const routes = [];
    for (const bc of busClusters) {
      const r = await routeBusTomTom({ apiKey, school, students: bc.students, traffic, departAt, arriveAt, timeout, baseUrl });
      routes.push({ bus_id: bc.bus_id, capacity: bc.capacity, student_ids_ordered: r.student_ids_ordered, total_distance_m: r.total_distance_m });
    }
    const assigned = new Set(routes.flatMap(r => r.student_ids_ordered));
    const unassigned = students.filter(s => !assigned.has(s.id)).map(s => s.id);
    return { routes, unassigned_student_ids: unassigned };
  }
}

export default {
  sweepCluster,
  buildBusClusters,
  routeBusTomTom,
  batchRouteTomTom,
  planWithTomTom
};