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
const { searchAirports, findAirport } = require('./flightplan-airports');
const { mapLeg } = require('./flightplan-api');

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
    saveFlightplanApiKey(credentialsPath, apiKey);
    refreshApiKey();
    return { ok: true, credentials: credentialsStatus(credentialsPath) };
  }

  async function importFlightLeg(tripId, leg, { date } = {}) {
    const mapped = leg.raw ? leg : mapLeg(leg);
    return store.createFlight({
      tripId,
      airline: mapped.airline || leg.airline,
      number: mapped.number || leg.number,
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

  async function pushNext({ send } = {}) {
    const body = await payload.buildFlight({ mode: 'next' });
    if (!body) return { ok: false, error: 'No upcoming flight' };
    const emit = typeof send === 'function' ? send : sendUdpPayload;
    if (!emit) return { ok: false, error: 'UDP sender unavailable' };
    emit(body, { source: 'manual' });
    return { ok: true, type: body.type, mode: 'next' };
  }

  async function pushBoard({ tripId, send } = {}) {
    const id = tripId || store.resolveNextFlight()?.trip?.id;
    if (!id) return { ok: false, error: 'No trip for board' };
    const body = await payload.buildFlight({ mode: 'board', tripId: id });
    if (!body) return { ok: false, error: 'No flights for board' };
    const emit = typeof send === 'function' ? send : sendUdpPayload;
    if (!emit) return { ok: false, error: 'UDP sender unavailable' };
    emit(body, { source: 'manual' });
    return { ok: true, type: body.type, mode: 'board' };
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
    importFlightLeg,
    pushNext,
    pushBoard,
    searchAirports: (q) => searchAirports(q, { config }),
    findAirport: (code) => findAirport(code, config),
    start,
    close,
    credentialsPath,
  };
}

module.exports = {
  createFlightplanService,
};
