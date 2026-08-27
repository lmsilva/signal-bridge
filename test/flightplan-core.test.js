const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFlightplanSettings, DEFAULTS } = require('../src/flightplan-settings');
const { createFlightplanStore } = require('../src/flightplan-store');
const { createFlightplanLedger } = require('../src/flightplan-ledger');
const { createFlightplanApi } = require('../src/flightplan-api');
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
});

test('board flight number is zero-padded', () => {
  assert.equal(formatBoardFlightNumber('DL', '167'), 'DL0167');
});
