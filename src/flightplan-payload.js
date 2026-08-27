/**
 * Flight Plan UDP payload builder — type flightplan.flight
 */

const { resolveFlightStatus } = require('./flightplan-status');
const { findAirport } = require('./flightplan-airports');

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
    const route = live?.routeEndpoints?.(flight, config) || {};
    const origin = findAirport(flight.origin?.iata || flight.origin?.icao, config) || flight.origin;
    const destination = findAirport(flight.destination?.iata || flight.destination?.icao, config)
      || flight.destination;
    const tripFlights = mode === 'board'
      ? store.flightsForTrip(trip.id).filter((row) => row.state !== 'landed')
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
      flights: tripFlights.map((row) => ({
        id: row.id,
        airline: row.airline,
        number: row.number,
        date: row.date,
        origin: row.origin,
        destination: row.destination,
        scheduled: row.scheduled,
        state: row.state,
      })),
      status,
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
};
