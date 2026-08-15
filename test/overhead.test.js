const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  sanitiseSettings,
  cycleSecondsFor,
  estimateDuration,
  pageCount,
  createOverheadSettings,
} = require('../src/overhead-settings');
const {
  normaliseAircraft,
  filterAircraft,
  sortAircraft,
  categoryToIconClass,
  cardinalBearing,
} = require('../src/overhead-model');
const { createProvider } = require('../src/overhead-providers');
const { createEnrichmentCache, routeLabel, routeFields } = require('../src/overhead-enrichment');
const { createOverheadService, getHomeLatLon } = require('../src/overhead-service');
const {
  buildOverheadRoundPayload,
  buildOverheadUpdatePayload,
  buildOverheadClosePayload,
} = require('../src/udp-payload');
const { createCommandRegistry } = require('../src/command-registry');

test('settings sanitise clamps radius and refresh', () => {
  const settings = sanitiseSettings({ radiusNm: 5, refreshSeconds: 1, provider: 'nope' });
  assert.equal(settings.radiusNm, 10);
  assert.equal(settings.refreshSeconds, 3);
  assert.equal(settings.provider, 'airplanes-live');
});

test('duration estimate uses pages × pageSeconds × loops + slack', () => {
  assert.equal(pageCount({ maxPages: 6, rowsPerPage: 4 }, 10), 3);
  assert.equal(cycleSecondsFor({ pageSeconds: 8, maxPages: 6, rowsPerPage: 4 }, 10), 24);
  assert.equal(estimateDuration({ pageSeconds: 8, maxPages: 6, rowsPerPage: 4, loops: '2' }, 10), 52);
});

test('normalise ADS-B aircraft maps fields and label', () => {
  const ac = normaliseAircraft({
    hex: 'abc123',
    flight: '  dal123  ',
    r: 'N12345',
    t: 'B738',
    category: 'A3',
    alt_baro: 32000,
    gs: 420,
    track: 90,
    baro_rate: 1200,
    lat: 40.1,
    lon: -111.9,
    dst: 12.4,
    dir: 45,
    squawk: '1200',
    emergency: 'none',
    seen_pos: 1.2,
  });
  assert.equal(ac.hex, 'abc123');
  assert.equal(ac.callsign, 'DAL123');
  assert.equal(ac.iconClass, 'jet');
  assert.equal(ac.label, 'DAL123');
  assert.equal(ac.altFt, 32000);
  assert.equal(ac.bearingLabel, 'NE');
});

test('category and type fallback icon classes', () => {
  assert.equal(categoryToIconClass('A7'), 'heli');
  assert.equal(categoryToIconClass('', 'EC35'), 'heli');
  assert.equal(categoryToIconClass('', 'PA28'), 'light');
  assert.equal(categoryToIconClass('C1'), 'generic');
});

test('surface categories are excluded during normalise', () => {
  assert.equal(normaliseAircraft({ hex: 'aaa', category: 'C2' }), null);
});

test('emergency aircraft sort first', () => {
  const sorted = sortAircraft([
    { hex: '1', label: 'AAA', dstNm: 1, isEmergency: false },
    { hex: '2', label: 'ZZZ', dstNm: 20, isEmergency: true, squawk: '7700' },
    { hex: '3', label: 'BBB', dstNm: 2, isEmergency: false },
  ]);
  assert.equal(sorted[0].hex, '2');
  assert.equal(sorted[1].hex, '1');
});

test('filter respects altitude floor and ground', () => {
  const list = [
    { hex: 'a', altFt: 0, category: 'A1' },
    { hex: 'b', altFt: 500, category: 'A1' },
    { hex: 'c', altFt: 100, category: 'A1' },
  ];
  assert.equal(filterAircraft(list, { altitudeFloorFt: 200, includeGround: false }).length, 1);
  assert.equal(filterAircraft(list, { includeGround: true }).length, 3);
});

test('cardinal bearing helper', () => {
  assert.equal(cardinalBearing(0), 'N');
  assert.equal(cardinalBearing(90), 'E');
});

test('public ADS-B provider uses mock fetch and sends User-Agent', async () => {
  let url = '';
  let headers = null;
  const provider = createProvider('airplanes-live', {
    fetchImpl: async (u, opts) => {
      url = u;
      headers = opts?.headers || {};
      return {
        ok: true,
        json: async () => ({ ac: [{ hex: 'abc', flight: 'UAL1', alt_baro: 1000, category: 'A3' }] }),
      };
    },
  });
  const rows = await provider.fetchPoint(40.35, -111.9, 40);
  assert.match(url, /api\.adsb\.lol\/v2\/lat\/40\.35\/lon\/-111\.9\/dist\/40/);
  assert.match(String(headers['User-Agent'] || ''), /SignalBridge/);
  assert.equal(rows.length, 1);
});

test('public ADS-B provider falls back after 403', async () => {
  const urls = [];
  let clock = 10_000;
  const provider = createProvider('airplanes-live', {
    now: () => { clock += 2000; return clock; },
    fetchImpl: async (u) => {
      urls.push(u);
      if (String(u).includes('adsb.lol')) {
        return {
          ok: false,
          status: 403,
          text: async () => JSON.stringify({ error: 'Please contact us at contact@airplanes.live' }),
        };
      }
      return {
        ok: true,
        json: async () => ({ aircraft: [{ hex: 'def', flight: 'UAL2' }] }),
      };
    },
  });
  const rows = await provider.fetchPoint(40.35, -111.9, 40);
  assert.equal(rows.length, 1);
  assert.match(urls[0], /adsb\.lol/);
  assert.match(urls[1], /adsb\.fi/);
  const again = await provider.fetchPoint(40.35, -111.9, 40);
  assert.equal(again.length, 1);
  assert.match(urls[2], /adsb\.fi/);
});

test('public ADS-B testConnection reports fallback source', async () => {
  const provider = createProvider('airplanes-live', {
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ ac: [{ hex: 'abc' }, { hex: 'def' }] }),
    }),
  });
  const result = await provider.testConnection(40.35, -111.9, 40);
  assert.equal(result.ok, true);
  assert.equal(result.aircraftCount, 2);
  assert.equal(result.source, 'adsb-lol');
});

test('enrichment cache hits disk for hex metadata', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'overhead-enr-'));
  const hex = 'abc999';
  const hexFile = path.join(tmp, 'hex', `${hex}.json`);
  fs.mkdirSync(path.dirname(hexFile), { recursive: true });
  fs.writeFileSync(hexFile, JSON.stringify({ meta: { type: 'A320' }, fetchedAt: Date.now() }));

  let calls = 0;
  const cache = createEnrichmentCache({
    config: { ROOT: tmp, overheadEnrichmentDir: tmp },
    fetchImpl: async () => {
      calls += 1;
      throw new Error('network');
    },
  });
  const result = await cache.enrichAircraftList([{ hex }]);
  assert.equal(calls, 0);
  assert.equal(result.aircraft[0].typeCode, 'A320');
});

test('route label prefers municipality then IATA', () => {
  assert.equal(
    routeLabel({
      origin: { municipality: 'Salt Lake City', iata_code: 'SLC' },
      destination: { iata_code: 'LAX', name: 'Los Angeles Intl' },
    }),
    'Salt Lake City → LAX',
  );
});

test('routeFields returns structured origin/destination for the display client', () => {
  const fields = routeFields({
    origin: { municipality: 'Salt Lake City', iata_code: 'SLC' },
    destination: { municipality: 'Denver', iata_code: 'DEN' },
  });
  assert.equal(fields.originCity, 'Salt Lake City');
  assert.equal(fields.destCity, 'Denver');
  assert.equal(fields.originIata, 'SLC');
  assert.equal(fields.destIata, 'DEN');
  assert.equal(fields.label, 'Salt Lake City → Denver');
});

test('UDP payload shapes', () => {
  const round = buildOverheadRoundPayload({
    settings: { radiusNm: 40, pageSeconds: 8, rowsPerPage: 'auto', sort: 'nearest' },
    home: { lat: 40.35, lon: -111.9, name: 'Home' },
    aircraft: [{ hex: 'abc', label: 'UAL1', iconClass: 'jet' }],
    routes: { abc: 'SLC → LAX' },
    sessionId: 'overhead-1',
    durationSeconds: 12,
    geoBaseUrl: 'https://bridge.test',
  });
  assert.equal(round.type, 'overhead.round');
  assert.equal(round.overhead.sessionId, 'overhead-1');
  assert.equal(round.overhead.aircraft.length, 1);
  assert.match(round.overhead.geo.homeArea, /overhead-geo\/home-area\.json/);

  const update = buildOverheadUpdatePayload({
    sessionId: 'overhead-1',
    aircraft: [{ hex: 'abc', label: 'UAL1' }],
    routes: { abc: 'SLC → LAX' },
  });
  assert.equal(update.type, 'overhead.update');
  assert.equal(update.overhead.routes.abc, 'SLC → LAX');

  const close = buildOverheadClosePayload({ sessionId: 'overhead-1' });
  assert.equal(close.type, 'overhead.close');
});

test('command registry overhead entry', () => {
  const registry = createCommandRegistry({
    getOverheadStatus: () => ({
      hasContent: true,
      aircraftInRange: 4,
      settings: { pageSeconds: 8, maxPages: 6, rowsPerPage: 4, loops: 'once' },
      estimatedDurationSeconds: 36,
    }),
  });
  assert.equal(registry.hasContent('overhead.show'), true);
  assert.equal(registry.estimateDuration('overhead.show'), 36);
  const cmd = registry.list().find((c) => c.id === 'overhead.show');
  assert.equal(cmd.group, 'Sky');
  assert.equal(cmd.variableDuration, true);
});

test('service push uses home lat/lon from config', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'overhead-svc-'));
  const sent = [];
  const service = createOverheadService({
    config: {
      ROOT: tmp,
      overheadSettingsPath: path.join(tmp, 'settings.json'),
      voiceEvents: {
        defaultLocation: { name: 'Home', latitude: 40.35, longitude: -111.9 },
      },
    },
    sendUdpPayload: (p) => sent.push(p),
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        ac: [
          { hex: 'abc', flight: 'UAL1', alt_baro: 5000, category: 'A3', dst: 5 },
        ],
      }),
    }),
  });
  assert.deepEqual(getHomeLatLon({
    voiceEvents: { defaultLocation: { name: 'Home', latitude: 40.35, longitude: -111.9 } },
  }), {
    lat: 40.35,
    lon: -111.9,
    name: 'Home',
  });
  const result = await service.push({});
  assert.equal(result.ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'overhead.round');
  service.closeSession('test');
  assert.equal(sent.some((p) => p.type === 'overhead.close'), true);
});

test('persisted overhead settings round-trip', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'overhead-set-'));
  const store = createOverheadSettings({
    overheadSettingsPath: path.join(tmp, 'overhead-settings.json'),
    ROOT: tmp,
  });
  const updated = store.update({ radiusNm: 55, sort: 'altitude' });
  assert.equal(updated.radiusNm, 55);
  assert.equal(store.get().sort, 'altitude');
});
