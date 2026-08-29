const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFlightplanSettings, DEFAULTS } = require('../src/flightplan-settings');
const { createFlightplanStore } = require('../src/flightplan-store');
const { createFlightplanLedger } = require('../src/flightplan-ledger');
const { createFlightplanApi, formatApiFailure } = require('../src/flightplan-api');
const {
  resolveFlightStatus,
  isMaterialDelay,
  formatBoardFlightNumber,
} = require('../src/flightplan-status');

test('flightplan settings default home airport is SLC', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-set-'));
  const settings = createFlightplanSettings({ flightplanSettingsPath: path.join(root, 's.json') });
  assert.equal(settings.get().homeAirport, 'SLC');
  assert.equal(settings.get().enabled, false);
});

test('flightplan settings persist updates', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-set2-'));
  const p = path.join(root, 's.json');
  const settings = createFlightplanSettings({ flightplanSettingsPath: p });
  settings.update({ enabled: true, softCapUnits: 450 });
  const reloaded = createFlightplanSettings({ flightplanSettingsPath: p });
  assert.equal(reloaded.get().enabled, true);
  assert.equal(reloaded.get().softCapUnits, 450);
});

test('flightplan store trip and flight CRUD', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-store-'));
  const store = createFlightplanStore({ flightplanStorePath: path.join(root, 'store.json') });
  const trip = store.createTrip({ name: 'Japan Trip 2026', kind: 'ours', startDate: '2026-09-01' });
  assert.equal(trip.ok, true);
  const flight = store.createFlight({
    tripId: trip.trip.id,
    airline: 'DL',
    number: '167',
    date: '2026-09-10',
    scheduled: { departure: '2026-09-10T10:15:00' },
  });
  assert.equal(flight.ok, true);
  assert.equal(store.flightsForTrip(trip.trip.id).length, 1);
  const deleted = store.deleteTrip(trip.trip.id);
  assert.equal(deleted.ok, true);
  assert.equal(store.getFlight(flight.flight.id), null);
});

test('updateFlight persists a state change to disk', () => {
  // `maybeArchiveTrip` used to reload the store mid-write, so every patch was
  // written back as the pre-patch snapshot — flights never went active.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-update-'));
  const storePath = path.join(root, 'store.json');
  const store = createFlightplanStore({ flightplanStorePath: storePath });
  const trip = store.createTrip({ name: 'Japan Trip 2026', kind: 'ours' });
  const flight = store.createFlight({
    tripId: trip.trip.id,
    airline: 'DL',
    number: '167',
    date: '2026-09-10',
    scheduled: { departure: '2026-09-10T10:15:00' },
  });
  const updated = store.updateFlight(flight.flight.id, {
    state: 'active',
    registration: 'N801DZ',
  });
  assert.equal(updated.ok, true);
  assert.equal(store.getFlight(flight.flight.id).state, 'active');
  assert.equal(store.getFlight(flight.flight.id).registration, 'N801DZ');

  const reopened = createFlightplanStore({ flightplanStorePath: storePath });
  assert.equal(reopened.getFlight(flight.flight.id).state, 'active');
});

test('resolveNextFlight picks earliest upcoming flight', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-next-'));
  const store = createFlightplanStore({ flightplanStorePath: path.join(root, 'store.json') });
  const trip = store.createTrip({ name: 'Visit', kind: 'visitor' });
  store.createFlight({
    tripId: trip.trip.id,
    airline: 'AA',
    number: '100',
    date: '2026-12-01',
    scheduled: { departure: '2026-12-01T18:00:00' },
  });
  store.createFlight({
    tripId: trip.trip.id,
    airline: 'UA',
    number: '200',
    date: '2026-11-01',
    scheduled: { departure: '2026-11-01T08:00:00' },
  });
  const next = store.resolveNextFlight({ nowMs: Date.parse('2026-10-01T00:00:00Z') });
  assert.equal(next.flight.number, '200');
});

test('ledger transitions ok low out', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-led-'));
  const settings = createFlightplanSettings({
    flightplanSettingsPath: path.join(root, 's.json'),
  });
  settings.update({ softCapUnits: 100, hardCapUnits: 120 });
  const ledger = createFlightplanLedger({
    config: { flightplanLedgerPath: path.join(root, 'l.json') },
    settings,
  });
  assert.equal(ledger.state(), 'ok');
  ledger.recordCall({ endpoint: 'flightStatus', units: 50 });
  ledger.recordCall({ endpoint: 'flightStatus', units: 50 });
  assert.equal(ledger.state(), 'low');
  assert.equal(ledger.canSpend(10, { manual: false }), false);
  assert.equal(ledger.canSpend(10, { manual: true }), true);
  ledger.recordCall({ endpoint: 'flightStatus', units: 10, manual: true });
  ledger.recordCall({ endpoint: 'flightStatus', units: 10, manual: true });
  assert.equal(ledger.state(), 'out');
});

test('verifyApiKey succeeds when AeroDataBox rejects stale probe date but key is valid', async () => {
  const { createFlightplanApi } = require('../src/flightplan-api');
  const api = createFlightplanApi({
    apiKeyProvider: async () => 'test-key',
    ledger: { canSpend: () => true, recordCall: () => {}, state: () => 'ok' },
    fetchImpl: async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({
        message: "Specified date-time '15.06.2020 00:00' must not be earlier than 365 day(s) ago.",
      }),
    }),
    now: () => Date.parse('2026-08-26T12:00:00Z'),
  });
  const result = await api.verifyApiKey({ manual: true });
  assert.equal(result.ok, true);
  assert.match(result.message, /accepted/i);
});

test('isVerifyKeyAcceptedFailure treats stale probe date as key accepted', () => {
  const { isVerifyKeyAcceptedFailure } = require('../src/flightplan-api');
  const msg = "Specified date-time '15.06.2020 00:00' must not be earlier than 365 day(s) ago.";
  assert.equal(isVerifyKeyAcceptedFailure(msg, 400), true);
  assert.equal(isVerifyKeyAcceptedFailure('You are not subscribed to this API.', 403), false);
});

test('probeVerifyDate stays within AeroDataBox rolling window', () => {
  const { probeVerifyDate } = require('../src/flightplan-api');
  // Measure the offset against the same instant we fed in — reading the real
  // clock here would make the test start failing a day after it was written.
  const now = Date.parse('2026-08-26T12:00:00Z');
  const date = probeVerifyDate(now);
  assert.match(date, /^2026-/);
  const daysAgo = (now - Date.parse(`${date}T12:00:00Z`)) / 86400000;
  assert.ok(daysAgo >= 13 && daysAgo <= 15);
});

test('filterLegsByAirport keeps legs that use the airport as origin or destination', () => {
  const { filterLegsByAirport } = require('../src/flightplan-api');
  const legs = [
    { origin: { iata: 'SLC' }, destination: { iata: 'ATL' } },
    { origin: { iata: 'ATL' }, destination: { iata: 'NRT' } },
  ];
  const slc = filterLegsByAirport(legs, 'SLC');
  assert.equal(slc.length, 1);
  assert.equal(slc[0].destination.iata, 'ATL');
  const atl = filterLegsByAirport(legs, 'ATL');
  assert.equal(atl.length, 2);
});

test('formatApiFailure maps RapidAPI not-subscribed message', () => {
  const result = formatApiFailure('You are not subscribed to this API.', 403);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'not_subscribed');
  assert.match(result.error, /AeroDataBox/i);
});

test('flightplan api records ledger units and caches search', async () => {
  let calls = 0;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-api-'));
  const settings = createFlightplanSettings({ flightplanSettingsPath: path.join(root, 's.json') });
  const ledger = createFlightplanLedger({ config: { flightplanLedgerPath: path.join(root, 'l.json') }, settings });
  const api = createFlightplanApi({
    apiKeyProvider: async () => 'test-key',
    ledger,
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify([{
          number: '167',
          airline: { iata: 'DL' },
          departure: { airport: { iata: 'SLC' }, scheduledTime: { local: '2026-09-10T10:15:00' } },
          arrival: { airport: { iata: 'NRT' }, scheduledTime: { local: '2026-09-11T14:00:00' } },
          status: 'Scheduled',
        }]),
      };
    },
  });
  const first = await api.searchByNumber({ airline: 'DL', number: '167', date: '2026-09-10', cacheHours: 6 });
  const second = await api.searchByNumber({ airline: 'DL', number: '167', date: '2026-09-10', cacheHours: 6 });
  assert.equal(first.legs.length, 1);
  assert.equal(second.cached, true);
  assert.equal(calls, 1);
  assert.equal(ledger.statusSummary().cycleUsed, 2);
});

test('material delay threshold respected in status vocabulary', () => {
  assert.equal(isMaterialDelay('2026-09-10T10:00:00', '2026-09-10T10:09:00', 15), false);
  assert.equal(isMaterialDelay('2026-09-10T10:00:00', '2026-09-10T10:20:00', 15), true);
  const status = resolveFlightStatus({
    scheduled: { departure: '2026-09-10T10:00:00' },
    latest: {
      status: 'Delayed',
      departure: { scheduledTime: { local: '2026-09-10T10:00:00' }, revisedTime: { local: '2026-09-10T10:20:00' } },
    },
  }, { materialDelayMinutes: 15 });
  assert.match(status.displayLine, /DELAYED 20 MIN/);
  assert.equal(status.headline, 'DELAYED 20 MIN');
  assert.equal(status.gateLine, '');
});

test('flightPlanBoardFrames builds a valid Vestaboard layout for a trip board', () => {
  const { flightPlanBoardFrames } = require('../src/vestaboard/formatters/feeds');
  const { assertValidLayout, decodeCodes } = require('../src/vestaboard/encoder');
  const frames = flightPlanBoardFrames({
    type: 'flightplan.flight',
    mode: 'board',
    asOf: '2026-08-26T18:00:00Z',
    trip: { name: 'Japan 2027', kind: 'ours' },
    flights: [{
      airline: 'DL',
      number: 'DL167',
      origin: { iata: 'SEA' },
      destination: { iata: 'HND' },
      scheduled: {
        departure: '2027-06-24T13:45:00-07:00',
        arrival: '2027-06-25T16:00:00+09:00',
      },
      state: 'upcoming',
    }],
  }, { timeZone: 'America/Denver', now: new Date('2026-08-26T18:00:00Z') });
  assert.equal(frames.length, 1);
  assertValidLayout(frames[0].rows, 'flight plan board');
  assert.ok(frames[0].dwellSeconds >= 15);
  const text = frames[0].rows.map((row) => decodeCodes(row)).join('\n');
  assert.match(text, /JAPAN 2027/);
  assert.match(text, /DL 167/);
  assert.match(text, /SEA -/);
  assert.match(text, /HND/);
  assert.match(text, /1:45P/);
  assert.match(text, /4:00P/);
  assert.match(text, /ON TIME/);
  assert.match(text, /AS OF/);
  assert.match(text, /12:00/); // 18:00Z → noon MDT
  assert.match(text, /D-\d+/);
  assert.doesNotMatch(text, /DEP\s+FLIGHT/);
});

test('board flight number is zero-padded', () => {
  assert.equal(formatBoardFlightNumber('DL', '167'), 'DL0167');
});

test('tracker flight number is readable', () => {
  const { formatTrackerFlightNumber } = require('../src/flightplan-status');
  assert.equal(formatTrackerFlightNumber('DL', '167'), 'DL 167');
  assert.equal(formatTrackerFlightNumber('DL', 'DL167'), 'DL 167');
});

test('formatBoardTime keeps airport-local wall clock from ISO offset', () => {
  const { formatBoardTime, formatTrackerClock } = require('../src/flightplan-status');
  assert.equal(formatBoardTime('2027-06-24T13:45:00-07:00'), '1345');
  assert.equal(formatBoardTime('2027-06-24T19:00:00'), '1900');
  assert.equal(formatTrackerClock('2027-06-24T13:45:00-07:00'), '1:45P');
  assert.equal(formatTrackerClock('2027-06-24T19:00:00'), '7:00P');
  assert.equal(formatTrackerClock('2027-06-24T00:05:00'), '12:05A');
  assert.equal(formatTrackerClock('2027-06-24T12:00:00'), '12:00P');
});
