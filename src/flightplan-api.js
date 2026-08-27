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
const AERODATABOX_SUBSCRIBE_URL = 'https://rapidapi.com/aedbx-aedbx/api/aerodatabox';

function formatApiFailure(message = '', status = 0) {
  const text = String(message || '').trim();
  if (/not subscribed|subscription/i.test(text)) {
    return {
      ok: false,
      error: 'Subscribe to AeroDataBox on RapidAPI (free tier works), then save that key under Settings → Flight Plan.',
      code: 'not_subscribed',
      subscribeUrl: AERODATABOX_SUBSCRIBE_URL,
    };
  }
  if (/rapidapi key is not configured/i.test(text)) {
    return {
      ok: false,
      error: 'Add your AeroDataBox RapidAPI key under Settings → Flight Plan.',
      code: 'no_api_key',
      subscribeUrl: AERODATABOX_SUBSCRIBE_URL,
    };
  }
  if (status === 401 || status === 403) {
    return {
      ok: false,
      error: text || 'AeroDataBox rejected the API key — check Settings → Flight Plan.',
      code: 'auth_failed',
      subscribeUrl: AERODATABOX_SUBSCRIBE_URL,
    };
  }
  return { ok: false, error: text || `AeroDataBox HTTP ${status || 'error'}`, code: 'api_error' };
}

function probeVerifyDate(nowMs = Date.now()) {
  const d = new Date(nowMs);
  d.setUTCDate(d.getUTCDate() - 14);
  return d.toISOString().slice(0, 10);
}

function isVerifyKeyAcceptedFailure(message = '', status = 0) {
  const text = String(message || '').trim();
  if (!text) return false;
  if (/not subscribed|subscription/i.test(text)) return false;
  if (/rapidapi key is not configured/i.test(text)) return false;
  if (status === 401 || status === 403) return false;
  if (/unauthorized|forbidden|invalid api key|x-rapidapi-key/i.test(text)) return false;
  if (/quota|too many requests|429/i.test(text)) return true;
  if (/must not be earlier than|no flights|not found|earlier than \d+ day/i.test(text)) return true;
  return status >= 400 && status < 500;
}

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

function splitAirlineNumber(airline, number) {
  let code = String(airline || '').trim().toUpperCase();
  let num = String(number || '').trim().toUpperCase().replace(/\s+/g, '');
  if (code && num.startsWith(code)) {
    num = num.slice(code.length);
  }
  if (!code) {
    const match = /^([A-Z]{2,3})(\d+[A-Z]?)$/.exec(num);
    if (match) {
      code = match[1];
      num = match[2];
    }
  }
  num = num.replace(/^0+(\d)/, '$1');
  return { airline: code, number: num };
}

function mapLeg(item = {}) {
  const dep = item.departure || {};
  const arr = item.arrival || {};
  const split = splitAirlineNumber(
    item.airline?.iata || item.airline?.icao || item.airline?.name || '',
    item.number || item.flightNumber || '',
  );
  return {
    id: item.id || item.flightId || null,
    airline: split.airline,
    number: split.number,
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

function legUsesAirport(leg, airportCode) {
  const code = String(airportCode || '').trim().toUpperCase();
  if (!code || !leg) return false;
  for (const point of [leg.origin, leg.destination]) {
    const iata = String(point?.iata || '').trim().toUpperCase();
    const icao = String(point?.icao || '').trim().toUpperCase();
    if (iata === code || icao === code) return true;
  }
  return false;
}

function filterLegsByAirport(legs, airportCode) {
  const code = String(airportCode || '').trim().toUpperCase();
  if (!code) return Array.isArray(legs) ? legs : [];
  return (legs || []).filter((leg) => legUsesAirport(leg, code));
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
      const failure = formatApiFailure(json?.message || json?.error || text, response.status);
      throw new Error(failure.error);
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
    try {
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
    } catch (error) {
      log?.warn?.('Flight Plan search failed', error?.message || error);
      return formatApiFailure(error?.message || String(error));
    }
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

  async function verifyApiKey({ manual = true } = {}) {
    const apiKey = await apiKeyProvider();
    if (!apiKey) {
      return formatApiFailure('Flight Plan RapidAPI key is not configured');
    }
    const probeDate = probeVerifyDate(now());
    const result = await searchByNumber({
      airline: 'AA',
      number: '1',
      date: probeDate,
      manual,
      cacheHours: 0,
    });
    if (result.ok) {
      return {
        ok: true,
        message: 'AeroDataBox accepted the API key.',
        probeDate,
        legsFound: (result.legs || []).length,
      };
    }
    if (isVerifyKeyAcceptedFailure(result.error, result.status)) {
      return {
        ok: true,
        message: 'AeroDataBox accepted the API key.',
        probeDate,
        legsFound: 0,
      };
    }
    return result;
  }

  return {
    RAPIDAPI_HOST,
    RAPIDAPI_BASE,
    ENDPOINTS,
    normaliseFlightNumber,
    mapLeg,
    searchByNumber,
    fetchFlightStatus,
    verifyApiKey,
    _clearSearchCacheForTest() { searchCache.clear(); },
  };
}

module.exports = {
  createFlightplanApi,
  RAPIDAPI_HOST,
  RAPIDAPI_BASE,
  ENDPOINTS,
  normaliseFlightNumber,
  splitAirlineNumber,
  mapLeg,
  legUsesAirport,
  filterLegsByAirport,
  formatApiFailure,
  probeVerifyDate,
  isVerifyKeyAcceptedFailure,
  AERODATABOX_SUBSCRIBE_URL,
};
