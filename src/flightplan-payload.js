/**
 * Flight Plan UDP payload builder — type flightplan.flight
 */

const { resolveFlightStatus, parseIsoMs } = require('./flightplan-status');
const { findAirport } = require('./flightplan-airports');

const MINUTE_MS = 60_000;

function bestDepartureMs(flight = {}) {
  const dep = flight.latest?.departure || {};
  return parseIsoMs(
    dep.actualTime?.local || dep.revisedTime?.local || dep.estimatedTime?.local,
  ) ?? parseIsoMs(flight.scheduled?.departure || dep.scheduledTime?.local);
}

function bestArrivalMs(flight = {}) {
  const arr = flight.latest?.arrival || {};
  return parseIsoMs(
    arr.actualTime?.local || arr.revisedTime?.local || arr.estimatedTime?.local,
  ) ?? parseIsoMs(flight.scheduled?.arrival || arr.scheduledTime?.local);
}

/**
 * Where the flight sits between wheels-up and wheels-down.
 *
 * The panel draws a journey rail from this, so an upcoming flight must report a
 * real countdown rather than a bare zero — that is the only number worth
 * showing before the aircraft exists on ADS-B.
 */
function flightProgress(flight = {}, nowMs = Date.now()) {
  const departure = bestDepartureMs(flight);
  const arrival = bestArrivalMs(flight);
  const durationMinutes = departure != null && arrival != null && arrival > departure
    ? Math.round((arrival - departure) / MINUTE_MS)
    : null;
  const departsInMinutes = departure != null
    ? Math.round((departure - nowMs) / MINUTE_MS)
    : null;
  const arrivesInMinutes = arrival != null
    ? Math.round((arrival - nowMs) / MINUTE_MS)
    : null;

  let phase = 'upcoming';
  if (flight.state === 'landed') phase = 'landed';
  else if (flight.state === 'active') phase = 'airborne';
  else if (departsInMinutes != null && departsInMinutes <= 0) phase = 'airborne';
  else if (departsInMinutes != null && departsInMinutes <= 90) phase = 'boarding-soon';

  let fraction = 0;
  if (phase === 'landed') {
    fraction = 1;
  } else if (departure != null && arrival != null && arrival > departure) {
    fraction = Math.max(0, Math.min(1, (nowMs - departure) / (arrival - departure)));
  }

  return {
    phase,
    fraction,
    durationMinutes,
    departsInMinutes,
    arrivesInMinutes,
    elapsedMinutes: departure != null && nowMs > departure
      ? Math.round((nowMs - departure) / MINUTE_MS)
      : 0,
    remainingMinutes: arrival != null && arrival > nowMs
      ? Math.round((arrival - nowMs) / MINUTE_MS)
      : 0,
  };
}

function legSummary(row, ctx = {}) {
  const status = resolveFlightStatus(row, ctx);
  const progress = flightProgress(row, ctx.nowMs || Date.now());
  return {
    id: row.id,
    airline: row.airline,
    number: row.number,
    date: row.date,
    origin: row.origin,
    destination: row.destination,
    scheduled: row.scheduled,
    state: row.state,
    status: {
      code: status.code,
      displayLine: status.displayLine,
      boardCode: status.boardCode,
      colorToken: status.colorToken,
    },
    durationMinutes: progress.durationMinutes,
    departsInMinutes: progress.departsInMinutes,
    remainingMinutes: progress.remainingMinutes,
    latest: row.latest || null,
  };
}

function titleForTripKind(kind, state) {
  if (kind === 'visitor') {
    if (state === 'landed') return 'arrived';
    return 'arriving';
  }
  if (state === 'active') return 'in flight';
  return 'upcoming flight';
}

function createFlightplanPayload({
  store,
  settings,
  ledger,
  live,
  config = {},
  now = () => Date.now(),
} = {}) {
  async function buildFlight({
    mode = 'next',
    flightId = null,
    tripId = null,
  } = {}) {
    let trip = null;
    let flight = null;
    if (flightId) {
      flight = store.getFlight(flightId);
      trip = flight ? store.getTrip(flight.tripId) : null;
    } else if (mode === 'board' && tripId) {
      trip = store.getTrip(tripId);
      const flights = store.flightsForTrip(tripId).filter((row) => row.state !== 'landed');
      flight = flights[0] || null;
    } else {
      const next = store.resolveNextFlight({ nowMs: now() });
      trip = next?.trip || null;
      flight = next?.flight || null;
    }
    if (!trip || !flight) return null;

    const cfg = settings.get();
    const ledgerState = ledger?.statusSummary?.() || { state: 'ok' };
    const asOf = flight.updatedAt || new Date(now()).toISOString();
    let position = null;
    if (flight.state === 'active' && live?.lookupPosition) {
      try {
        const lookup = await live.lookupPosition(flight);
        if (lookup.ok) position = lookup.position;
      } catch {
        position = null;
      }
    }
    const stage = live?.stageMode?.(flight, position) || { mode: 'preflight', note: 'not departed' };
    const status = resolveFlightStatus(flight, {
      materialDelayMinutes: cfg.materialDelayMinutes,
      asOf,
    });
    const origin = findAirport(flight.origin?.iata || flight.origin?.icao, config) || flight.origin;
    const destination = findAirport(flight.destination?.iata || flight.destination?.icao, config)
      || flight.destination;
    // The panel draws the great-circle from these two points, so a route without
    // coordinates is a blank map. Prefer the catalog hit over the live guess.
    const liveRoute = live?.routeEndpoints?.(flight, config) || {};
    const route = {
      origin: Number.isFinite(Number(origin?.lat)) ? origin : liveRoute.origin,
      destination: Number.isFinite(Number(destination?.lat)) ? destination : liveRoute.destination,
    };
    // The board is the whole itinerary; landed legs stay so a trip mid-journey
    // still reads as a trip rather than a single orphan flight.
    const tripFlights = mode === 'board'
      ? store.flightsForTrip(trip.id)
      : [flight];

    const image = Array.isArray(trip.images) && trip.images.length
      ? trip.images[0]
      : null;

    return {
      type: 'flightplan.flight',
      mode,
      displaySeconds: cfg.displaySeconds || 120,
      asOf,
      quotaState: ledgerState.state,
      waitingForQuota: ledgerState.state === 'low' || ledgerState.state === 'out',
      trip: {
        id: trip.id,
        name: trip.name,
        kind: trip.kind,
        traveller: trip.traveller || null,
        title: titleForTripKind(trip.kind, flight.state),
      },
      flight: {
        id: flight.id,
        airline: flight.airline,
        number: flight.number,
        date: flight.date,
        origin,
        destination,
        scheduled: flight.scheduled,
        latest: flight.latest,
        state: flight.state,
        registration: flight.registration,
        callsign: flight.callsign,
      },
      flights: tripFlights.map((row) => legSummary(row, {
        materialDelayMinutes: cfg.materialDelayMinutes,
        asOf,
        nowMs: now(),
      })),
      status,
      progress: flightProgress(flight, now()),
      stage: {
        ...stage,
        position,
        route,
        imageUrl: image?.url || null,
        imageCaption: image?.caption || null,
      },
    };
  }

  function hasContent() {
    return Boolean(store.resolveNextFlight({ nowMs: now() }));
  }

  return {
    buildFlight,
    hasContent,
    titleForTripKind,
  };
}

module.exports = {
  createFlightplanPayload,
  titleForTripKind,
  flightProgress,
  legSummary,
};
