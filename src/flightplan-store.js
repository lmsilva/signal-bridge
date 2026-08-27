const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const VERSION = 1;
const TRIP_KINDS = Object.freeze(['ours', 'visitor']);
const FLIGHT_STATES = Object.freeze(['upcoming', 'active', 'landed']);
const TRIP_FILTERS = Object.freeze(['upcoming', 'active', 'past', 'all']);
const TRIP_SORTS = Object.freeze(['date', 'name', 'flightCount']);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function generateId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function slugify(value, fallback = 'trip') {
  const text = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return text || fallback;
}

function validDateOnly(value) {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const [y, m, d] = text.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function parseDepartureMs(flight = {}) {
  const raw = flight.scheduled?.departure
    || flight.latest?.departure?.scheduledTime?.local
    || flight.latest?.departure?.scheduledTime?.utc
    || flight.date;
  const ms = Date.parse(String(raw || ''));
  return Number.isFinite(ms) ? ms : null;
}

function emptyStore() {
  return { version: VERSION, trips: [], flights: [] };
}

function createFlightplanStore(config = {}, log = console) {
  const root = config.ROOT || path.resolve(__dirname, '..');
  const storePath = path.resolve(
    config.flightplanStorePath || path.join(root, 'data', 'flightplan-store.json'),
  );
  let data = emptyStore();
  const listeners = new Set();

  function notify(reason, meta = {}) {
    const event = { reason, ...meta };
    for (const listener of listeners) {
      try { listener(event); } catch (error) {
        log?.warn?.('Flight Plan store listener failed', error?.message || error);
      }
    }
  }

  function onChange(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function load() {
    try {
      if (!fs.existsSync(storePath)) {
        data = emptyStore();
        return data;
      }
      const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      data = {
        version: VERSION,
        trips: Array.isArray(parsed?.trips) ? parsed.trips : [],
        flights: Array.isArray(parsed?.flights) ? parsed.flights : [],
      };
    } catch (error) {
      log?.warn?.('Flight Plan store load failed — starting empty', error?.message || error);
      data = emptyStore();
    }
    return data;
  }

  function persist() {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const tmp = `${storePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, storePath);
  }

  load();

  function getTrip(id) {
    load();
    return clone(data.trips.find((row) => row.id === id) || null);
  }

  function getFlight(id) {
    load();
    return clone(data.flights.find((row) => row.id === id) || null);
  }

  function flightsForTrip(tripId) {
    load();
    const trip = data.trips.find((row) => row.id === tripId);
    const order = Array.isArray(trip?.flights) ? trip.flights : [];
    const byId = new Map(data.flights.map((row) => [row.id, row]));
    return order.map((id) => byId.get(id)).filter(Boolean).map(clone);
  }

  function tripPhase(trip, nowMs = Date.now()) {
    if (trip.archived) return 'past';
    const flights = flightsForTrip(trip.id);
    if (!flights.length) {
      const start = Date.parse(String(trip.startDate || ''));
      const end = Date.parse(String(trip.endDate || ''));
      if (Number.isFinite(end) && end < nowMs) return 'past';
      if (Number.isFinite(start) && start <= nowMs) return 'active';
      return 'upcoming';
    }
    if (flights.every((row) => row.state === 'landed')) return 'past';
    if (flights.some((row) => row.state === 'active')) return 'active';
    const nextDep = flights.map(parseDepartureMs).filter(Number.isFinite).sort((a, b) => a - b)[0];
    if (nextDep != null && nextDep <= nowMs) return 'active';
    return 'upcoming';
  }

  function listTrips({
    filter = 'all',
    sort = 'date',
    dir = 'desc',
  } = {}) {
    load();
    const nowMs = Date.now();
    let rows = data.trips.map((trip) => {
      const flights = flightsForTrip(trip.id);
      return {
        ...clone(trip),
        flightCount: flights.length,
        phase: tripPhase(trip, nowMs),
      };
    });
    if (filter !== 'all') {
      rows = rows.filter((row) => row.phase === filter);
    }
    const asc = String(dir).toLowerCase() === 'asc';
    const key = TRIP_SORTS.includes(sort) ? sort : 'date';
    rows.sort((a, b) => {
      let av;
      let bv;
      if (key === 'name') {
        av = String(a.name || '').toLowerCase();
        bv = String(b.name || '').toLowerCase();
        return asc ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      if (key === 'flightCount') {
        av = Number(a.flightCount) || 0;
        bv = Number(b.flightCount) || 0;
        return asc ? av - bv : bv - av;
      }
      av = Date.parse(String(a.startDate || '')) || 0;
      bv = Date.parse(String(b.startDate || '')) || 0;
      return asc ? av - bv : bv - av;
    });
    return rows;
  }

  function resolveNextFlight({ nowMs = Date.now() } = {}) {
    load();
    const candidates = [];
    for (const trip of data.trips) {
      if (trip.archived) continue;
      for (const flightId of trip.flights || []) {
        const flight = data.flights.find((row) => row.id === flightId);
        if (!flight || flight.state === 'landed') continue;
        const depMs = parseDepartureMs(flight);
        candidates.push({
          flight: clone(flight),
          trip: clone(trip),
          depMs: depMs ?? Number.MAX_SAFE_INTEGER,
        });
      }
    }
    candidates.sort((a, b) => a.depMs - b.depMs);
    return candidates[0] || null;
  }

  function maybeArchiveTrip(tripId) {
    const trip = data.trips.find((row) => row.id === tripId);
    if (!trip) return;
    const flights = flightsForTrip(tripId);
    if (flights.length && flights.every((row) => row.state === 'landed')) {
      trip.archived = true;
      trip.updatedAt = new Date().toISOString();
    }
  }

  function trimArchivedFlightLatest(flight) {
    if (!flight?.latest) return flight;
    return {
      ...flight,
      latest: {
        status: flight.latest.status || flight.latest.flightStatus,
        departure: flight.latest.departure,
        arrival: flight.latest.arrival,
        registration: flight.registration,
        callsign: flight.callsign,
      },
    };
  }

  function createTrip(payload = {}) {
    load();
    const name = String(payload.name || '').trim();
    if (!name) return { ok: false, error: 'Trip name is required' };
    const kind = TRIP_KINDS.includes(payload.kind) ? payload.kind : 'ours';
    const id = payload.id || slugify(name, generateId('trip'));
    if (data.trips.some((row) => row.id === id)) {
      return { ok: false, error: 'Trip id already exists' };
    }
    const now = new Date().toISOString();
    const trip = {
      id,
      name,
      kind,
      traveller: String(payload.traveller || '').trim(),
      startDate: validDateOnly(payload.startDate) ? payload.startDate : '',
      endDate: validDateOnly(payload.endDate) ? payload.endDate : '',
      notes: String(payload.notes || ''),
      locations: Array.isArray(payload.locations) ? payload.locations : [],
      images: Array.isArray(payload.images) ? payload.images : [],
      flights: [],
      archived: false,
      createdAt: now,
      updatedAt: now,
    };
    data.trips.push(trip);
    persist();
    notify('trip-created', { tripId: id });
    return { ok: true, trip: clone(trip) };
  }

  function updateTrip(id, patch = {}) {
    load();
    const trip = data.trips.find((row) => row.id === id);
    if (!trip) return { ok: false, error: 'Trip not found' };
    if (patch.name != null) {
      const name = String(patch.name).trim();
      if (!name) return { ok: false, error: 'Trip name cannot be empty' };
      trip.name = name;
    }
    if (patch.kind != null && TRIP_KINDS.includes(patch.kind)) trip.kind = patch.kind;
    if (patch.traveller != null) trip.traveller = String(patch.traveller || '').trim();
    if (patch.startDate != null) trip.startDate = validDateOnly(patch.startDate) ? patch.startDate : '';
    if (patch.endDate != null) trip.endDate = validDateOnly(patch.endDate) ? patch.endDate : '';
    if (patch.notes != null) trip.notes = String(patch.notes || '');
    if (Array.isArray(patch.locations)) trip.locations = patch.locations;
    if (Array.isArray(patch.images)) trip.images = patch.images;
    if (Array.isArray(patch.flights)) trip.flights = [...new Set(patch.flights.map(String))];
    if (patch.archived != null) trip.archived = patch.archived === true;
    trip.updatedAt = new Date().toISOString();
    persist();
    notify('trip-updated', { tripId: id });
    return { ok: true, trip: clone(trip) };
  }

  function deleteTrip(id) {
    load();
    const index = data.trips.findIndex((row) => row.id === id);
    if (index < 0) return { ok: false, error: 'Trip not found' };
    const trip = data.trips[index];
    const flightIds = [...(trip.flights || [])];
    data.trips.splice(index, 1);
    data.flights = data.flights.filter((row) => row.tripId !== id);
    persist();
    notify('trip-deleted', { tripId: id, flightIds });
    return { ok: true, tripId: id, flightIds };
  }

  function createFlight(payload = {}) {
    load();
    const tripId = String(payload.tripId || '').trim();
    const trip = data.trips.find((row) => row.id === tripId);
    if (!trip) return { ok: false, error: 'Trip not found' };
    const airline = String(payload.airline || '').trim().toUpperCase();
    const number = String(payload.number || '').trim();
    const date = validDateOnly(payload.date) ? payload.date : '';
    if (!airline || !number || !date) {
      return { ok: false, error: 'Airline, flight number, and date are required' };
    }
    const id = payload.id || generateId('flt');
    const now = new Date().toISOString();
    const flight = {
      id,
      tripId,
      airline,
      number,
      date,
      origin: payload.origin || null,
      destination: payload.destination || null,
      scheduled: payload.scheduled || null,
      latest: payload.latest || null,
      registration: payload.registration || null,
      callsign: payload.callsign || null,
      history: Array.isArray(payload.history) ? payload.history : [],
      state: FLIGHT_STATES.includes(payload.state) ? payload.state : 'upcoming',
      createdAt: now,
      updatedAt: now,
    };
    data.flights.push(flight);
    if (!trip.flights.includes(id)) trip.flights.push(id);
    trip.updatedAt = now;
    persist();
    notify('flight-created', { tripId, flightId: id });
    return { ok: true, flight: clone(flight) };
  }

  function updateFlight(id, patch = {}) {
    load();
    const flight = data.flights.find((row) => row.id === id);
    if (!flight) return { ok: false, error: 'Flight not found' };
    if (patch.airline != null) flight.airline = String(patch.airline || '').trim().toUpperCase();
    if (patch.number != null) flight.number = String(patch.number || '').trim();
    if (patch.date != null && validDateOnly(patch.date)) flight.date = patch.date;
    if (patch.origin != null) flight.origin = patch.origin;
    if (patch.destination != null) flight.destination = patch.destination;
    if (patch.scheduled != null) flight.scheduled = patch.scheduled;
    if (patch.latest != null) flight.latest = patch.latest;
    if (patch.registration != null) flight.registration = patch.registration;
    if (patch.callsign != null) flight.callsign = patch.callsign;
    if (Array.isArray(patch.history)) flight.history = patch.history;
    if (patch.state != null && FLIGHT_STATES.includes(patch.state)) flight.state = patch.state;
    if (flight.state === 'landed') {
      flight.latest = trimArchivedFlightLatest(flight).latest;
    }
    flight.updatedAt = new Date().toISOString();
    maybeArchiveTrip(flight.tripId);
    persist();
    notify('flight-updated', { flightId: id, tripId: flight.tripId });
    return { ok: true, flight: clone(flight) };
  }

  function deleteFlight(id) {
    load();
    const flight = data.flights.find((row) => row.id === id);
    if (!flight) return { ok: false, error: 'Flight not found' };
    data.flights = data.flights.filter((row) => row.id !== id);
    const trip = data.trips.find((row) => row.id === flight.tripId);
    if (trip) {
      trip.flights = (trip.flights || []).filter((rowId) => rowId !== id);
      trip.updatedAt = new Date().toISOString();
    }
    persist();
    notify('flight-deleted', { flightId: id, tripId: flight.tripId });
    return { ok: true, flightId: id, tripId: flight.tripId };
  }

  function reorderTripFlights(tripId, flightIds = []) {
    load();
    const trip = data.trips.find((row) => row.id === tripId);
    if (!trip) return { ok: false, error: 'Trip not found' };
    const allowed = new Set((trip.flights || []));
    trip.flights = flightIds.map(String).filter((id) => allowed.has(id));
    trip.updatedAt = new Date().toISOString();
    persist();
    notify('flights-reordered', { tripId });
    return { ok: true, flights: flightsForTrip(tripId) };
  }

  function appendFlightHistory(id, entry) {
    load();
    const flight = data.flights.find((row) => row.id === id);
    if (!flight) return { ok: false, error: 'Flight not found' };
    flight.history = Array.isArray(flight.history) ? flight.history : [];
    flight.history.push({
      at: new Date().toISOString(),
      ...entry,
    });
    flight.updatedAt = new Date().toISOString();
    persist();
    notify('flight-history', { flightId: id });
    return { ok: true, flight: clone(flight) };
  }

  function listFlightsNeedingPoll({ nowMs = Date.now() } = {}) {
    load();
    return data.flights.filter((flight) => {
      const trip = data.trips.find((row) => row.id === flight.tripId);
      if (!trip || trip.archived || flight.state === 'landed') return false;
      const depMs = parseDepartureMs(flight);
      if (depMs == null) return false;
      const hoursOut = (depMs - nowMs) / 3_600_000;
      return hoursOut <= 24;
    }).map(clone);
  }

  return {
    storePath,
    load,
    onChange,
    getTrip,
    getFlight,
    flightsForTrip,
    listTrips,
    resolveNextFlight,
    createTrip,
    updateTrip,
    deleteTrip,
    createFlight,
    updateFlight,
    deleteFlight,
    reorderTripFlights,
    appendFlightHistory,
    listFlightsNeedingPoll,
    tripPhase,
    parseDepartureMs,
    TRIP_KINDS,
    FLIGHT_STATES,
    TRIP_FILTERS,
    TRIP_SORTS,
  };
}

module.exports = {
  createFlightplanStore,
  VERSION,
  TRIP_KINDS,
  FLIGHT_STATES,
  parseDepartureMs,
};
