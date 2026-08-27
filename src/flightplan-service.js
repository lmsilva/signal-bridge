/**
 * Flight Plan facade — store, settings, API, ledger, poller, payload.
 */

const path = require('path');
const { createFlightplanSettings } = require('./flightplan-settings');
const { createFlightplanStore } = require('./flightplan-store');
const { createFlightplanLedger } = require('./flightplan-ledger');
const { createFlightplanApi } = require('./flightplan-api');
const {
  defaultCredentialsPath,
  resolveFlightplanApiKey,
  saveFlightplanApiKey,
  credentialsStatus,
} = require('./flightplan-credentials');
const { createFlightplanLive } = require('./flightplan-live');
const { createFlightplanImages } = require('./flightplan-images');
const { createFlightplanPayload } = require('./flightplan-payload');
const { createFlightplanPoller } = require('./flightplan-poller');
const { searchAirports, findAirport, resolveAirportCode } = require('./flightplan-airports');
const { mapLeg, splitAirlineNumber } = require('./flightplan-api');

function createFlightplanService({
  config = {},
  log = console,
  sendUdpPayload = null,
  dependencies = {},
} = {}) {
  const settings = dependencies.settings || createFlightplanSettings(config, log);
  const store = dependencies.store || createFlightplanStore(config, log);
  const ledger = dependencies.ledger || createFlightplanLedger({ config, settings, log });
  const credentialsPath = dependencies.credentialsPath
    || defaultCredentialsPath(config.ROOT || path.resolve(__dirname, '..'));

  const apiKeyRef = { current: '' };
  function refreshApiKey() {
    apiKeyRef.current = resolveFlightplanApiKey({
      env: config.env || process.env,
      credentialsPath,
    }).apiKey;
  }
  refreshApiKey();

  const api = dependencies.api || createFlightplanApi({
    apiKeyProvider: async () => apiKeyRef.current,
    ledger,
    fetchImpl: dependencies.fetchImpl || global.fetch,
    log,
  });
  const live = dependencies.live || createFlightplanLive({ settings, log });
  const images = dependencies.images || createFlightplanImages({ config, settings, log });
  const payload = dependencies.payload || createFlightplanPayload({
    store, settings, ledger, live, config, log,
  });
  const poller = dependencies.poller || createFlightplanPoller({
    store, api, settings, ledger, live, payload, sendUdpPayload, log,
  });

  function statusSnapshot() {
    refreshApiKey();
    const next = store.resolveNextFlight();
    return {
      enabled: settings.get().enabled,
      settings: settings.get(),
      credentials: credentialsStatus(credentialsPath, { env: config.env || process.env }),
      ledger: ledger.statusSummary(),
      hasUpcomingFlight: Boolean(next),
      nextFlightId: next?.flight?.id || null,
      nextTripId: next?.trip?.id || null,
      tripCount: store.listTrips({ filter: 'all' }).length,
    };
  }

  async function saveApiKey(apiKey) {
    const key = String(apiKey || '').trim();
    if (!key) throw new Error('RapidAPI key is empty');
    const previous = apiKeyRef.current;
    apiKeyRef.current = key;
    const verified = await api.verifyApiKey({ manual: true });
    if (!verified.ok) {
      apiKeyRef.current = previous;
      refreshApiKey();
      return {
        ok: false,
        error: verified.error,
        code: verified.code,
        subscribeUrl: verified.subscribeUrl,
        credentials: credentialsStatus(credentialsPath, { env: config.env || process.env }),
      };
    }
    saveFlightplanApiKey(credentialsPath, key);
    refreshApiKey();
    return { ok: true, credentials: credentialsStatus(credentialsPath, { env: config.env || process.env }) };
  }

  async function verifyApiKey(overrideKey) {
    refreshApiKey();
    const key = String(overrideKey || '').trim();
    if (key) {
      const previous = apiKeyRef.current;
      apiKeyRef.current = key;
      const result = await api.verifyApiKey({ manual: true });
      apiKeyRef.current = previous;
      refreshApiKey();
      return result;
    }
    return api.verifyApiKey({ manual: true });
  }

  async function importFlightLeg(tripId, leg, { date } = {}) {
    const mapped = leg.raw ? leg : mapLeg(leg);
    const split = splitAirlineNumber(mapped.airline || leg.airline, mapped.number || leg.number);
    return store.createFlight({
      tripId,
      airline: split.airline,
      number: split.number,
      date,
      origin: mapped.origin,
      destination: mapped.destination,
      scheduled: mapped.scheduled,
      latest: mapped.raw,
      registration: mapped.registration,
      callsign: mapped.callsign,
      state: 'upcoming',
    });
  }

  async function pushNext({ send, tripId } = {}) {
    let body = null;
    if (tripId) {
      const flights = store.flightsForTrip(tripId)
        .filter((row) => row.state !== 'landed')
        .sort((a, b) => String(a.scheduled?.departure || a.date || '').localeCompare(
          String(b.scheduled?.departure || b.date || ''),
        ));
      const flight = flights[0] || null;
      if (!flight) return { ok: false, error: 'No upcoming flight in this trip' };
      body = await payload.buildFlight({ mode: 'next', flightId: flight.id });
    } else {
      body = await payload.buildFlight({ mode: 'next' });
    }
    if (!body) return { ok: false, error: 'No upcoming flight' };
    const emit = typeof send === 'function' ? send : sendUdpPayload;
    if (!emit) return { ok: false, error: 'UDP sender unavailable' };
    const delivery = emit(body, { source: 'manual', commandId: 'flightplan.next' });
    return {
      ok: true,
      type: body.type,
      mode: 'next',
      tripId: body.trip?.id || tripId || null,
      flightId: body.flight?.id || null,
      vestaboard: delivery?.vestaboard || null,
    };
  }

  async function pushBoard({ tripId, send } = {}) {
    const id = tripId || store.resolveNextFlight()?.trip?.id;
    if (!id) return { ok: false, error: 'No trip for board' };
    const body = await payload.buildFlight({ mode: 'board', tripId: id });
    if (!body) return { ok: false, error: 'No flights for board' };
    const emit = typeof send === 'function' ? send : sendUdpPayload;
    if (!emit) return { ok: false, error: 'UDP sender unavailable' };
    const delivery = emit(body, { source: 'manual', commandId: 'flightplan.board' });
    return {
      ok: true,
      type: body.type,
      mode: 'board',
      tripId: id,
      vestaboard: delivery?.vestaboard || null,
    };
  }

  function start() {
    if (settings.get().enabled) poller.start();
  }

  function close() {
    poller.stop();
  }

  return {
    settings,
    store,
    ledger,
    api,
    live,
    images,
    payload,
    poller,
    statusSnapshot,
    saveApiKey,
    verifyApiKey,
    refreshApiKey,
    importFlightLeg,
    pushNext,
    pushBoard,
    searchAirports: (q) => searchAirports(q, { config }),
    findAirport: (code) => findAirport(code, config),
    resolveAirportCode: (q) => resolveAirportCode(q, { config }),
    start,
    close,
    credentialsPath,
  };
}

module.exports = {
  createFlightplanService,
};
