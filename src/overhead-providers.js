/**
 * Flight data providers for Overhead.
 */

const AIRPLANES_LIVE_MIN_INTERVAL_MS = 1000;

const ADSB_FETCH_HEADERS = {
  Accept: 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent': 'SignalBridge/1.0 (Overhead household display)',
};

/** airplanes.live now 403s unregistered clients; try public readsb-compatible APIs first. */
const PUBLIC_ADSB_SOURCES = [
  {
    id: 'adsb-lol',
    hostLabel: 'adsb.lol',
    buildUrl: (lat, lon, radius) => `https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/${radius}`,
  },
  {
    id: 'adsb-fi',
    hostLabel: 'adsb.fi',
    buildUrl: (lat, lon, radius) => `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${radius}`,
  },
  {
    id: 'airplanes-live',
    hostLabel: 'airplanes.live',
    buildUrl: (lat, lon, radius) => `https://api.airplanes.live/v2/point/${lat}/${lon}/${radius}`,
  },
];

function aircraftFromBody(body) {
  if (Array.isArray(body?.ac)) return body.ac;
  if (Array.isArray(body?.aircraft)) return body.aircraft;
  return [];
}

function isRetryableStatus(status) {
  return status === 401 || status === 403 || status === 404 || status === 429 || status >= 500;
}

async function httpErrorFor(source, response) {
  let detail = '';
  try {
    const text = await response.text();
    const parsed = JSON.parse(text);
    const message = parsed?.error || parsed?.message;
    if (message) detail = `: ${String(message).replace(/\s+/g, ' ').trim().slice(0, 160)}`;
  } catch {
    // ignore non-JSON bodies
  }
  const error = new Error(`${source.hostLabel} HTTP ${response.status}${detail}`);
  error.status = response.status;
  return error;
}

function createAirplanesLiveProvider({ fetchImpl = fetch, log = console, now = () => Date.now() } = {}) {
  let lastFetchAt = 0;
  let preferredSourceId = null;

  function sourcesInOrder() {
    if (!preferredSourceId) return PUBLIC_ADSB_SOURCES;
    const preferred = PUBLIC_ADSB_SOURCES.filter((source) => source.id === preferredSourceId);
    const rest = PUBLIC_ADSB_SOURCES.filter((source) => source.id !== preferredSourceId);
    return [...preferred, ...rest];
  }

  async function fetchFromSource(source, lat, lon, radius) {
    const url = source.buildUrl(lat, lon, radius);
    const response = await fetchImpl(url, { headers: { ...ADSB_FETCH_HEADERS } });
    if (!response.ok) {
      throw await httpErrorFor(source, response);
    }
    return aircraftFromBody(await response.json());
  }

  async function fetchPoint(lat, lon, radiusNm) {
    const latN = Number(lat);
    const lonN = Number(lon);
    const radius = Math.max(1, Math.round(Number(radiusNm) || 40));
    if (!Number.isFinite(latN) || !Number.isFinite(lonN)) {
      throw new Error('Invalid lat/lon for public ADS-B');
    }

    const elapsed = now() - lastFetchAt;
    if (elapsed < AIRPLANES_LIVE_MIN_INTERVAL_MS) {
      await new Promise((resolve) => {
        setTimeout(resolve, AIRPLANES_LIVE_MIN_INTERVAL_MS - elapsed);
      });
    }
    lastFetchAt = now();

    const errors = [];
    for (const source of sourcesInOrder()) {
      try {
        const aircraft = await fetchFromSource(source, latN, lonN, radius);
        preferredSourceId = source.id;
        log?.debug?.('overhead ADS-B fetch', { source: source.id, count: aircraft.length, radius });
        return aircraft;
      } catch (error) {
        const message = error?.message || String(error);
        errors.push(message);
        const status = Number(error?.status);
        const retryable = !Number.isFinite(status) || isRetryableStatus(status);
        log?.warn?.('overhead ADS-B source failed', { source: source.id, error: message });
        if (!retryable) throw error;
      }
    }
    throw new Error(errors[0] || 'Public ADS-B providers failed');
  }

  async function testConnection(lat, lon, radiusNm = 40) {
    try {
      const aircraft = await fetchPoint(lat, lon, radiusNm);
      return { ok: true, aircraftCount: aircraft.length, source: preferredSourceId };
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  }

  return {
    id: 'airplanes-live',
    minIntervalMs: AIRPLANES_LIVE_MIN_INTERVAL_MS,
    fetchPoint,
    testConnection,
  };
}

function createLocalReadsbProvider({ localReceiverUrl = '', fetchImpl = fetch } = {}) {
  const baseUrl = String(localReceiverUrl || '').trim().replace(/\/+$/, '');

  async function fetchPoint(_lat, _lon, _radiusNm) {
    if (!baseUrl) {
      throw new Error('localReceiverUrl is not configured');
    }
    const url = `${baseUrl}/data/aircraft.json`;
    const response = await fetchImpl(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) {
      throw new Error(`readsb HTTP ${response.status}`);
    }
    const body = await response.json();
    return Array.isArray(body?.aircraft) ? body.aircraft : [];
  }

  async function testConnection(lat, lon, radiusNm) {
    try {
      const aircraft = await fetchPoint(lat, lon, radiusNm);
      return { ok: true, aircraftCount: aircraft.length };
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  }

  return {
    id: 'local-readsb',
    minIntervalMs: 1000,
    fetchPoint,
    testConnection,
  };
}

function createOpenskyProvider() {
  async function fetchPoint() {
    throw new Error('OpenSky provider is not implemented');
  }

  async function testConnection() {
    return { ok: false, error: 'OpenSky provider is not implemented' };
  }

  return {
    id: 'opensky',
    minIntervalMs: 1000,
    fetchPoint,
    testConnection,
  };
}

function createProvider(id, opts = {}) {
  switch (id) {
    case 'local-readsb':
      return createLocalReadsbProvider(opts);
    case 'opensky':
      return createOpenskyProvider(opts);
    case 'airplanes-live':
    default:
      return createAirplanesLiveProvider(opts);
  }
}

module.exports = {
  AIRPLANES_LIVE_MIN_INTERVAL_MS,
  ADSB_FETCH_HEADERS,
  PUBLIC_ADSB_SOURCES,
  createProvider,
  createAirplanesLiveProvider,
  createLocalReadsbProvider,
  createOpenskyProvider,
};
