/**
 * adsbdb.com enrichment cache for Overhead routes and type metadata.
 */

const fs = require('fs');
const path = require('path');

const ROUTE_TTL_MS = 12 * 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 6 * 60 * 60 * 1000;

function cityLabel(place = {}) {
  const municipality = String(place.municipality || '').trim();
  if (municipality) return municipality;
  const iata = String(place.iata_code || place.iata || '').trim();
  if (iata) return iata;
  const name = String(place.name || '').trim();
  return name || null;
}

function routeFields(route = {}) {
  if (!route || typeof route !== 'object') return null;
  const origin = route.origin || route.departure || {};
  const destination = route.destination || route.arrival || {};
  const originCity = cityLabel(origin);
  const destCity = cityLabel(destination);
  const originIata = String(origin.iata_code || origin.iata || '').trim() || null;
  const destIata = String(destination.iata_code || destination.iata || '').trim() || null;
  if (!originCity && !destCity && !originIata && !destIata) return null;
  const labelOrigin = originCity || originIata || '?';
  const labelDest = destCity || destIata || '?';
  return {
    originCity: originCity || null,
    destCity: destCity || null,
    originIata,
    destIata,
    label: `${labelOrigin} → ${labelDest}`,
  };
}

/** @deprecated prefer routeFields — kept for older call sites/tests */
function routeLabel(route = {}) {
  return routeFields(route)?.label || null;
}

function createEnrichmentCache({
  config = {},
  log = console,
  fetchImpl = fetch,
  now = () => Date.now(),
} = {}) {
  const root = config.ROOT || path.resolve(__dirname, '..');
  const cacheDir = config.overheadEnrichmentDir
    || path.resolve(root, 'data', 'overhead-enrichment');
  const hexDir = path.join(cacheDir, 'hex');
  const routeFile = path.join(cacheDir, 'routes.json');

  const routeMem = new Map();
  const negativeMem = new Map();
  let chain = Promise.resolve();

  function ensureDirs() {
    fs.mkdirSync(hexDir, { recursive: true });
  }

  function loadRoutesDisk() {
    try {
      if (!fs.existsSync(routeFile)) return;
      const parsed = JSON.parse(fs.readFileSync(routeFile, 'utf8'));
      Object.entries(parsed || {}).forEach(([key, entry]) => {
        routeMem.set(key, entry);
      });
    } catch (error) {
      log?.warn?.('Could not read overhead route cache', error?.message || error);
    }
  }

  function saveRoutesDisk() {
    try {
      ensureDirs();
      const obj = Object.fromEntries(routeMem.entries());
      fs.writeFileSync(routeFile, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
    } catch (error) {
      log?.warn?.('Could not save overhead route cache', error?.message || error);
    }
  }

  function readHexFile(hex) {
    const file = path.join(hexDir, `${String(hex).toLowerCase()}.json`);
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }

  function writeHexFile(hex, data) {
    ensureDirs();
    const file = path.join(hexDir, `${String(hex).toLowerCase()}.json`);
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  }

  function negativeKey(kind, id) {
    return `${kind}:${String(id).toUpperCase()}`;
  }

  function isNegative(kind, id) {
    const entry = negativeMem.get(negativeKey(kind, id));
    return entry && entry.expiresAt > now();
  }

  function rememberNegative(kind, id) {
    negativeMem.set(negativeKey(kind, id), { expiresAt: now() + NEGATIVE_TTL_MS });
  }

  function rememberRoute(callsign, route) {
    const key = String(callsign || '').trim().toUpperCase();
    if (!key) return;
    routeMem.set(key, { route, fetchedAt: now() });
    saveRoutesDisk();
  }

  function cachedRoute(callsign) {
    const key = String(callsign || '').trim().toUpperCase();
    if (!key) return null;
    const entry = routeMem.get(key);
    if (!entry) return null;
    if (now() - Number(entry.fetchedAt || 0) > ROUTE_TTL_MS) {
      routeMem.delete(key);
      return null;
    }
    return entry.route || null;
  }

  function cachedHexMeta(hex) {
    const entry = readHexFile(hex);
    if (!entry) return null;
    if (entry.negative) return null;
    return entry.meta || entry;
  }

  function enqueue(task) {
    chain = chain.then(task, task);
    return chain;
  }

  async function fetchRoute(callsign) {
    const key = String(callsign || '').trim().toUpperCase();
    if (!key || isNegative('callsign', key)) return null;
    const cached = cachedRoute(key);
    if (cached) return cached;

    const url = `https://api.adsbdb.com/v0/callsign/${encodeURIComponent(key)}`;
    const response = await fetchImpl(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) {
      rememberNegative('callsign', key);
      return null;
    }
    const body = await response.json();
    const route = body?.response?.flightroute || body?.response?.route || body?.route || null;
    const fields = route ? routeFields(route) : null;
    const value = fields ? { ...fields, raw: route } : null;
    if (value) {
      rememberRoute(key, value);
    } else {
      rememberNegative('callsign', key);
    }
    return value;
  }

  async function fetchHexMeta(hex) {
    const key = String(hex || '').trim().toLowerCase();
    if (!key || isNegative('hex', key)) return null;
    const cached = cachedHexMeta(key);
    if (cached) return cached;

    const url = `https://api.adsbdb.com/v0/aircraft/${encodeURIComponent(key)}`;
    const response = await fetchImpl(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) {
      writeHexFile(key, { negative: true, fetchedAt: now() });
      rememberNegative('hex', key);
      return null;
    }
    const body = await response.json();
    const aircraft = body?.response?.aircraft || body?.aircraft || body?.response || null;
    if (!aircraft) {
      writeHexFile(key, { negative: true, fetchedAt: now() });
      rememberNegative('hex', key);
      return null;
    }
    const meta = {
      type: aircraft.type || aircraft.aircraft_type || null,
      manufacturer: aircraft.manufacturer || null,
      registration: aircraft.registration || null,
      airline: aircraft.airline?.name || aircraft.airline || null,
    };
    writeHexFile(key, { meta, fetchedAt: now() });
    return meta;
  }

  async function enrichAircraftList(list = []) {
    const routes = {};
    const enriched = [];

    for (const ac of list) {
      if (!ac?.hex) continue;
      let next = { ...ac };
      if (!next.typeCode) {
        try {
          const meta = await enqueue(() => fetchHexMeta(ac.hex));
          if (meta?.type) {
            next = { ...next, typeCode: String(meta.type).toUpperCase() };
          }
        } catch (error) {
          log?.debug?.('Overhead hex enrich failed', error?.message || error);
        }
      }
      if (next.callsign) {
        try {
          const route = await enqueue(() => fetchRoute(next.callsign));
          if (route?.label) {
            const slim = {
              originCity: route.originCity || null,
              destCity: route.destCity || null,
              originIata: route.originIata || null,
              destIata: route.destIata || null,
              label: route.label,
            };
            routes[next.hex] = slim;
            next = { ...next, route: slim };
          }
        } catch (error) {
          log?.debug?.('Overhead route enrich failed', error?.message || error);
        }
      }
      enriched.push(next);
    }

    return { aircraft: enriched, routes };
  }

  loadRoutesDisk();

  return {
    enrichAircraftList,
    cachedRoute,
    cachedHexMeta,
    routeLabel,
    routeFields,
    cityLabel,
    cacheDir,
  };
}

module.exports = {
  ROUTE_TTL_MS,
  NEGATIVE_TTL_MS,
  routeLabel,
  routeFields,
  cityLabel,
  createEnrichmentCache,
};
