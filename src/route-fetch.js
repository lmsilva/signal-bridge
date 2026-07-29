// Free, no-key route data for the Route Planner voice feature. Driving
// routes/distance/duration come from OSRM's public demo server (fair-use
// only — no SLA, so callers must be ready for it to fail); when no drivable
// route exists (e.g. overseas), we fall back to a great-circle "as the plane
// flies" estimate so the feature still answers something useful.
const OSRM_ROUTE_URL = 'https://router.project-osrm.org/route/v1/driving';
const OSRM_TIMEOUT_MS = 12000;

const EARTH_RADIUS_MILES = 3958.8;
const FLIGHT_CRUISE_SPEED_MPH = 500;
// Rough fixed overhead for taxi/takeoff/climb/descent/landing — this whole
// mode is explicitly a "just curious" estimate, not real flight planning.
const FLIGHT_OVERHEAD_MIN = 45;

function toRadians(deg) {
  return (deg * Math.PI) / 180;
}

function haversineMiles(lat1, lon1, lat2, lon2) {
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_MILES * c;
}

function metersToMiles(meters) {
  return meters / 1609.344;
}

function secondsToMinutes(seconds) {
  return seconds / 60;
}

function hasValidCoords(origin, destination) {
  const values = [origin?.latitude, origin?.longitude, destination?.latitude, destination?.longitude];
  return values.every((value) => value != null && !Number.isNaN(Number(value)));
}

// Returns `{ ok:true, distanceMiles, durationMin, geometry }` (geometry is a
// simplified `[[lat, lon], ...]` polyline) or `{ ok:false }` when OSRM has no
// drivable route (e.g. across an ocean) or the request itself fails.
async function fetchDrivingRoute(origin, destination) {
  if (!hasValidCoords(origin, destination)) {
    return { ok: false };
  }

  const url = `${OSRM_ROUTE_URL}/${origin.longitude},${origin.latitude};${destination.longitude},${destination.latitude}?overview=simplified&geometries=geojson`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OSRM_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      return { ok: false };
    }
    const data = await response.json();
    if (data?.code !== 'Ok' || !data?.routes?.length) {
      return { ok: false };
    }
    const route = data.routes[0];
    const coordinates = Array.isArray(route?.geometry?.coordinates) ? route.geometry.coordinates : [];

    return {
      ok: true,
      distanceMiles: Math.round(metersToMiles(route.distance) * 10) / 10,
      durationMin: Math.max(1, Math.round(secondsToMinutes(route.duration))),
      geometry: coordinates.map(([lon, lat]) => [lat, lon]),
    };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  } finally {
    clearTimeout(timer);
  }
}

// Straight-line "flight" fallback: haversine distance plus a flat cruise
// speed and fixed ground-time overhead. Good enough for "roughly how far/how
// long" curiosity, not a real flight-planning tool.
function greatCircleEstimate(origin, destination) {
  if (!hasValidCoords(origin, destination)) {
    return null;
  }

  const lat1 = Number(origin.latitude);
  const lon1 = Number(origin.longitude);
  const lat2 = Number(destination.latitude);
  const lon2 = Number(destination.longitude);
  const distanceMiles = haversineMiles(lat1, lon1, lat2, lon2);
  const durationMin = Math.max(1, Math.round((distanceMiles / FLIGHT_CRUISE_SPEED_MPH) * 60 + FLIGHT_OVERHEAD_MIN));

  return {
    distanceMiles: Math.round(distanceMiles * 10) / 10,
    durationMin,
    geometry: [[lat1, lon1], [lat2, lon2]],
  };
}

module.exports = {
  fetchDrivingRoute,
  greatCircleEstimate,
  haversineMiles,
  OSRM_TIMEOUT_MS,
};
