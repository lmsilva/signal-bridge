/**
 * Flight data providers for Overhead.
 */

const AIRPLANES_LIVE_MIN_INTERVAL_MS = 1000;

function createAirplanesLiveProvider({ fetchImpl = fetch, log = console, now = () => Date.now() } = {}) {
  let lastFetchAt = 0;

  async function fetchPoint(lat, lon, radiusNm) {
    const latN = Number(lat);
    const lonN = Number(lon);
    const radius = Math.max(1, Math.round(Number(radiusNm) || 40));
    if (!Number.isFinite(latN) || !Number.isFinite(lonN)) {
      throw new Error('Invalid lat/lon for airplanes.live');
    }

    const elapsed = now() - lastFetchAt;
    if (elapsed < AIRPLANES_LIVE_MIN_INTERVAL_MS) {
      await new Promise((resolve) => {
        setTimeout(resolve, AIRPLANES_LIVE_MIN_INTERVAL_MS - elapsed);
      });
    }
    lastFetchAt = now();

    const url = `https://api.airplanes.live/v2/point/${latN}/${lonN}/${radius}`;
    const response = await fetchImpl(url, {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`airplanes.live HTTP ${response.status}`);
    }
    const body = await response.json();
    const aircraft = Array.isArray(body?.ac)
      ? body.ac
      : (Array.isArray(body?.aircraft) ? body.aircraft : []);
    log?.debug?.('airplanes.live fetch', { count: aircraft.length, radius });
    return aircraft;
  }

  async function testConnection(lat, lon, radiusNm = 40) {
    try {
      const aircraft = await fetchPoint(lat, lon, radiusNm);
      return { ok: true, aircraftCount: aircraft.length };
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
  createProvider,
  createAirplanesLiveProvider,
  createLocalReadsbProvider,
  createOpenskyProvider,
};
