/**
 * Flight Plan live position — free ADS-B by registration/callsign.
 */

const { createAirplanesLiveProvider } = require('./overhead-providers');
const { findAirport } = require('./flightplan-airports');

function pickBestAircraft(rows = []) {
  if (!rows.length) return null;
  return rows[0];
}

function normalisePosition(ac = {}) {
  const lat = Number(ac.lat ?? ac.latitude);
  const lon = Number(ac.lon ?? ac.longitude);
  const track = Number(ac.track ?? ac.heading);
  const alt = ac.alt_baro ?? ac.altitude ?? ac.alt_geom;
  return {
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
    heading: Number.isFinite(track) ? track : null,
    altitudeFt: alt != null && alt !== 'ground' ? Number(alt) : null,
    seenAt: new Date().toISOString(),
    callsign: ac.flight || ac.callsign || null,
    registration: ac.r || ac.registration || null,
  };
}

function createFlightplanLive({
  adsb = null,
  settings,
  log = console,
  now = () => Date.now(),
} = {}) {
  const provider = adsb || createAirplanesLiveProvider({ log, now });

  async function lookupPosition(flight = {}) {
    const reg = String(flight.registration || '').trim();
    const cs = String(flight.callsign || '').trim();
    let rows = [];
    try {
      if (reg) rows = await provider.fetchByRegistration(reg);
      if (!rows.length && cs) rows = await provider.fetchByCallsign(cs);
    } catch (error) {
      log?.debug?.('Flight Plan ADS-B lookup failed', error?.message || error);
      return { ok: false, error: error?.message || String(error) };
    }
    const ac = pickBestAircraft(rows);
    if (!ac) return { ok: false, error: 'No ADS-B position' };
    return { ok: true, position: normalisePosition(ac) };
  }

  function stageMode(flight = {}, position = null) {
    const staleMinutes = Number(settings?.get?.()?.livePositionStaleMinutes) || 15;
    if (flight.state === 'landed') {
      return { mode: 'ground', note: 'on the ground' };
    }
    if (flight.state !== 'active') {
      return { mode: 'preflight', note: 'not departed' };
    }
    if (!position?.seenAt) {
      return { mode: 'estimated', note: 'position estimated' };
    }
    const ageMs = now() - Date.parse(position.seenAt);
    if (ageMs > staleMinutes * 60_000) {
      return { mode: 'estimated', note: 'position estimated' };
    }
    return { mode: 'live', note: 'in the air · position live' };
  }

  function routeEndpoints(flight = {}, config = {}) {
    const origin = findAirport(flight.origin?.iata || flight.origin?.icao, config)
      || flight.origin;
    const destination = findAirport(flight.destination?.iata || flight.destination?.icao, config)
      || flight.destination;
    return {
      origin: origin?.lat != null ? origin : {
        lat: Number(origin?.lat),
        lon: Number(origin?.lon),
        iata: origin?.iata,
      },
      destination: destination?.lat != null ? destination : {
        lat: Number(destination?.lat),
        lon: Number(destination?.lon),
        iata: destination?.iata,
      },
    };
  }

  return {
    lookupPosition,
    stageMode,
    routeEndpoints,
    normalisePosition,
  };
}

module.exports = {
  createFlightplanLive,
  normalisePosition,
};
