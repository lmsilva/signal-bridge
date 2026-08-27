/**
 * AeroDataBox client via RapidAPI for Flight Plan.
 *
 * Feature namespace: flightplan (this bridge feature).
 * AeroDataBox field: filedFlightPlan — US mainland ATC flight plan in status
 * responses; on RapidAPI free tier it doubles the unit charge for that call.
 *
 * Unit costs (verified 2026-08-26 from aerodatabox.com/pricing + RapidAPI):
 *   Tier 1 = 1 unit, Tier 2 = 2 units, Tier 3 = 6 units
 *   Flight status (by number/date) = Tier 2 → 2 units baseline
 *   filedFlightPlan present on free plan → charge ×2 → up to 4 units
 *   RapidAPI free: 600 units/month, 1 req/s, 1000 req/hour cap
 *
 * Data retention (AeroDataBox ToU Article 5 — verify periodically):
 *   Keep full status blobs while trip/flight is active; on archive trim to
 *   essential history fields only (see flightplan-store trimArchivedFlightLatest).
 */

const RAPIDAPI_HOST = 'aerodatabox.p.rapidapi.com';
const RAPIDAPI_BASE = `https://${RAPIDAPI_HOST}`;

const ENDPOINTS = Object.freeze({
  flightStatus: {
    id: 'flightStatus',
    tier: 2,
    maxUnits: 4,
    path: ({ number, date }) => `/flights/number/${encodeURIComponent(number)}/${encodeURIComponent(date)}`,
  },
});

const MIN_INTERVAL_MS = 1000;

function normaliseFlightNumber(airline, number) {
  const code = String(airline || '').trim().toUpperCase();
  const num = String(number || '').trim();
  return `${code}${num}`.replace(/\s+/g, '');
}

function pickRegistration(json) {
  return json?.aircraft?.reg
    || json?.aircraft?.registration
    || json?.registration
    || null;
}

function pickCallsign(json) {
  return json?.callSign
    || json?.callsign
    || json?.callsignIcao
    || null;
}

function mapLeg(item = {}) {
  const dep = item.departure || {};
  const arr = item.arrival || {};
  return {
    id: item.id || item.flightId || null,
    airline: item.airline?.iata || item.airline?.icao || item.airline?.name || '',
    number: item.number || item.flightNumber || '',
    origin: {
      iata: dep.airport?.iata || dep.airport?.code?.iata,
      icao: dep.airport?.icao || dep.airport?.code?.icao,
      name: dep.airport?.name || dep.airport?.shortName,
    },
    destination: {
      iata: arr.airport?.iata || arr.airport?.code?.iata,
      icao: arr.airport?.icao || arr.airport?.code?.icao,
      name: arr.airport?.name || arr.airport?.shortName,
    },
    scheduled: {
      departure: dep.scheduledTime?.local || dep.scheduledTime?.utc || dep.scheduledTime,
      arrival: arr.scheduledTime?.local || arr.scheduledTime?.utc || arr.scheduledTime,
    },
    status: item.status || item.flightStatus,
    registration: pickRegistration(item),
    callsign: pickCallsign(item),
    raw: item,
  };
}

function createFlightplanApi({
  apiKeyProvider = async () => '',
  ledger = null,
  fetchImpl = global.fetch,
  log = console,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  let lastRequestAt = 0;
  const searchCache = new Map();

  async function waitSlot() {
    const elapsed = now() - lastRequestAt;
    if (elapsed < MIN_INTERVAL_MS) {
      await sleep(MIN_INTERVAL_MS - elapsed);
    }
    lastRequestAt = now();
  }

  async function rawGet(path, { query = {}, manual = false } = {}) {
    const apiKey = await apiKeyProvider();
    if (!apiKey) {
      throw new Error('Flight Plan RapidAPI key is not configured');
    }
    if (ledger?.state?.() === 'out') {
      throw new Error('Flight Plan API quota exhausted');
    }
    const endpoint = ENDPOINTS.flightStatus;
    const unitsNeeded = endpoint.maxUnits;
    if (!ledger?.canSpend?.(unitsNeeded, { manual })) {
      throw new Error('Flight Plan API unit budget exhausted');
    }

    await waitSlot();
    const url = new URL(`${RAPIDAPI_BASE}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value != null && value !== '') url.searchParams.set(key, String(value));
    }
    const response = await fetchImpl(url.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'x-rapidapi-host': RAPIDAPI_HOST,
        'x-rapidapi-key': apiKey,
      },
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }

    if (response.status === 429 || /quota|too many/i.test(text)) {
      ledger?.markQuotaError?.();
      throw new Error(json?.message || 'AeroDataBox quota exceeded');
    }
    if (!response.ok) {
      throw new Error(json?.message || json?.error || `AeroDataBox HTTP ${response.status}`);
    }

    const filedFlightPlan = Boolean(json?.filedFlightPlan || json?.hasFiledFlightPlan);
    ledger?.recordCall?.({
      endpoint: endpoint.id,
      tier: endpoint.tier,
      filedFlightPlan,
      manual,
    });

    return { ok: true, json, filedFlightPlan };
  }

  function cacheKey({ airline, number, date }) {
    return `${String(airline).toUpperCase()}|${String(number).trim()}|${date}`;
  }

  async function searchByNumber({ airline, number, date, cacheHours = 6, manual = false } = {}) {
    const key = cacheKey({ airline, number, date });
    const cached = searchCache.get(key);
    if (cached && (now() - cached.at) < cacheHours * 3_600_000) {
      return { ok: true, legs: cached.legs, cached: true };
    }
    const flightNumber = normaliseFlightNumber(airline, number);
    const result = await rawGet(ENDPOINTS.flightStatus.path({ number: flightNumber, date }), {
      query: {
        dateLocalRole: 'Both',
        withFlightPlan: 'false',
        withLocation: 'false',
        withAircraftImage: 'false',
      },
      manual,
    });
    const rows = Array.isArray(result.json) ? result.json : (result.json ? [result.json] : []);
    const legs = rows.map(mapLeg);
    searchCache.set(key, { at: now(), legs });
    return { ok: true, legs, cached: false, filedFlightPlan: result.filedFlightPlan };
  }

  async function fetchFlightStatus({ airline, number, date, manual = false } = {}) {
    const search = await searchByNumber({ airline, number, date, manual });
    if (!search.ok) return search;
    const leg = search.legs[0] || null;
    return {
      ok: Boolean(leg),
      leg,
      legs: search.legs,
      cached: search.cached,
    };
  }

  return {
    RAPIDAPI_HOST,
    RAPIDAPI_BASE,
    ENDPOINTS,
    normaliseFlightNumber,
    mapLeg,
    searchByNumber,
    fetchFlightStatus,
    _clearSearchCacheForTest() { searchCache.clear(); },
  };
}

module.exports = {
  createFlightplanApi,
  RAPIDAPI_HOST,
  RAPIDAPI_BASE,
  ENDPOINTS,
  normaliseFlightNumber,
  mapLeg,
};
