const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFlightplanSettings } = require('../src/flightplan-settings');
const { createFlightplanStore } = require('../src/flightplan-store');
const { createFlightplanLedger } = require('../src/flightplan-ledger');
const { createFlightplanApi } = require('../src/flightplan-api');
const { createFlightplanPoller } = require('../src/flightplan-poller');
const { createFlightplanPayload } = require('../src/flightplan-payload');
const { diffMaterial, isMaterialChange } = require('../src/flightplan-changes');

test('no api key — search throws without outbound when key missing', async () => {
  let calls = 0;
  const api = createFlightplanApi({
    apiKeyProvider: async () => '',
    ledger: { canSpend: () => true, recordCall: () => {} },
    fetchImpl: async () => { calls += 1; return { ok: true, status: 200, text: async () => '[]' }; },
  });
  await assert.rejects(
    () => api.searchByNumber({ airline: 'DL', number: '1', date: '2026-09-01', manual: true }),
    /RapidAPI key/,
  );
  assert.equal(calls, 0);
});

test('ledger low stops background poll but allows manual', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-acc-'));
  const settings = createFlightplanSettings({ flightplanSettingsPath: path.join(root, 's.json') });
  settings.update({ softCapUnits: 100, hardCapUnits: 120 });
  const ledger = createFlightplanLedger({ config: { flightplanLedgerPath: path.join(root, 'l.json') }, settings });
  ledger.recordCall({ endpoint: 'flightStatus', units: 50 });
  ledger.recordCall({ endpoint: 'flightStatus', units: 50 });
  assert.equal(ledger.state(), 'low');
  assert.equal(ledger.canSpend(10, { manual: false }), false);
  assert.equal(ledger.canSpend(10, { manual: true }), true);
});

test('10 min delay not material; 20 min delay is material', () => {
  const before = {
    depTime: '2026-09-10T10:00:00',
    arrTime: '2026-09-10T14:00:00',
    depGate: 'B14',
    status: 'scheduled',
  };
  const small = diffMaterial(before, {
    ...before,
    depTime: '2026-09-10T10:10:00',
  }, { materialDelayMinutes: 15 });
  assert.equal(isMaterialChange(small), false);
  const big = diffMaterial(before, {
    ...before,
    depTime: '2026-09-10T10:20:00',
  }, { materialDelayMinutes: 15 });
  assert.equal(isMaterialChange(big), true);
});

test('poller log-only does not auto-push on material change', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-push-'));
  const settings = createFlightplanSettings({ flightplanSettingsPath: path.join(root, 's.json') });
  settings.update({ enabled: true, pollerLogOnly: true, autoPushEnabled: true });
  const store = createFlightplanStore({ flightplanStorePath: path.join(root, 'store.json') });
  const trip = store.createTrip({ name: 'Test' });
  const flight = store.createFlight({
    tripId: trip.trip.id,
    airline: 'DL',
    number: '167',
    date: '2026-09-10',
    scheduled: { departure: '2026-09-10T10:00:00' },
  });
  let pushes = 0;
  const poller = createFlightplanPoller({
    store,
    settings,
    ledger: { state: () => 'ok', canSpend: () => true, recordCall: () => {} },
    api: {
      fetchFlightStatus: async () => ({
        ok: true,
        leg: {
          raw: { status: 'Delayed', departure: { revisedTime: { local: '2026-09-10T10:25:00' } } },
          origin: { iata: 'SLC' },
          destination: { iata: 'NRT' },
          scheduled: { departure: '2026-09-10T10:25:00' },
        },
      }),
    },
    payload: createFlightplanPayload({ store, settings, ledger: { statusSummary: () => ({ state: 'ok' }) } }),
    sendUdpPayload: () => { pushes += 1; },
    now: () => Date.parse('2026-09-10T08:00:00Z'),
  });
  const result = await poller.refreshFlight(flight.flight.id);
  assert.equal(result.material, true);
  await poller.maybeAutoPush(flight.flight.id, result.changes);
  assert.equal(pushes, 0);
});

test('payload includes asOf and quota waiting flag when ledger out', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-payload-'));
  const settings = createFlightplanSettings({ flightplanSettingsPath: path.join(root, 's.json') });
  const store = createFlightplanStore({ flightplanStorePath: path.join(root, 'store.json') });
  const trip = store.createTrip({ name: 'Visit', kind: 'visitor' });
  store.createFlight({
    tripId: trip.trip.id,
    airline: 'DL',
    number: '167',
    date: '2026-09-10',
    origin: { iata: 'LAX' },
    destination: { iata: 'SLC' },
    scheduled: { departure: '2026-09-10T18:00:00' },
  });
  const payload = createFlightplanPayload({
    store,
    settings,
    ledger: { statusSummary: () => ({ state: 'out', cycleUsed: 600, hardCap: 600 }) },
    now: () => Date.parse('2026-09-10T12:00:00Z'),
  });
  const body = await payload.buildFlight({ mode: 'next' });
  assert.equal(body.type, 'flightplan.flight');
  assert.ok(body.asOf);
  assert.equal(body.waitingForQuota, true);
  assert.equal(body.trip.kind, 'visitor');
});
