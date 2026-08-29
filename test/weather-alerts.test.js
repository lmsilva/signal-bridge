const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  TYPE,
  chipColorFor,
  formatUntil,
  isLikelyUs,
  normaliseAlert,
  filterAlerts,
  buildWeatherAlertsPayload,
  createWeatherAlerts,
  DEFAULT_SETTINGS,
} = require('../src/weather-alerts');
const { weatherAlertsFrames } = require('../src/vestaboard/formatters/alexa');

const LEHI = {
  city: 'Lehi',
  label: 'Lehi, UT',
  country: 'US',
  postalCode: '84043',
  latitude: 40.41,
  longitude: -111.85,
  timeZone: 'America/Denver',
};

function feature(overrides = {}) {
  return {
    id: overrides.id || 'https://api.weather.gov/alerts/urn:oid:1',
    properties: {
      id: overrides.id || 'urn:oid:1',
      event: overrides.event || 'Tornado Warning',
      headline: overrides.headline || 'Tornado Warning for Utah County',
      severity: overrides.severity || 'Extreme',
      urgency: 'Immediate',
      certainty: 'Observed',
      ends: overrides.ends || '2026-08-28T20:45:00-06:00',
      areaDesc: overrides.areaDesc || 'Utah, UT',
      ...overrides.properties,
    },
  };
}

test('chipColorFor maps event families to marketplace colours', () => {
  assert.equal(chipColorFor('Tornado Warning', 'Extreme'), 'red');
  assert.equal(chipColorFor('Flash Flood Warning', 'Severe'), 'blue');
  assert.equal(chipColorFor('Winter Storm Watch', 'Moderate'), 'white');
  assert.equal(chipColorFor('Red Flag Warning', 'Severe'), 'orange');
  assert.equal(chipColorFor('Dense Fog Advisory', 'Minor'), 'violet');
});

test('isLikelyUs accepts US pins and ZIP codes', () => {
  assert.equal(isLikelyUs(LEHI), true);
  assert.equal(isLikelyUs({ latitude: 51.5, longitude: -0.12, country: 'GB' }), false);
  assert.equal(isLikelyUs({ latitude: 40.7, longitude: -74, postalCode: '10001' }), true);
});

test('filterAlerts honours severity and watch/advisory toggles', () => {
  const alerts = [
    normaliseAlert(feature({ event: 'Tornado Warning', severity: 'Extreme' })),
    normaliseAlert(feature({ id: '2', event: 'Winter Storm Watch', severity: 'Moderate' })),
    normaliseAlert(feature({ id: '3', event: 'Wind Advisory', severity: 'Minor' })),
  ];
  const filtered = filterAlerts(alerts, {
    minSeverity: 'Moderate',
    includeWatches: false,
    includeAdvisories: true,
    maxAlerts: 3,
  });
  assert.deepEqual(filtered.map((row) => row.event), ['TORNADO WARNING']);
});

test('buildWeatherAlertsPayload pages active alerts for a US pin', () => {
  const payload = buildWeatherAlertsPayload({
    locale: LEHI,
    features: [
      feature({ event: 'Tornado Warning', severity: 'Extreme' }),
      feature({ id: '2', event: 'Severe Thunderstorm Warning', severity: 'Severe', areaDesc: 'Salt Lake, UT' }),
    ],
    settings: { ...DEFAULT_SETTINGS, maxAlerts: 2 },
  });
  assert.equal(payload.type, TYPE);
  assert.equal(payload.mode, 'alerts');
  assert.equal(payload.alerts.length, 2);
  assert.equal(payload.alerts[0].color, 'red');

  const frames = weatherAlertsFrames(payload);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].source, 'weather.alerts');
  assert.equal(frames[0].priority, 'alert');
});

test('buildWeatherAlertsPayload shows all-clear when NWS returns nothing', () => {
  const payload = buildWeatherAlertsPayload({ locale: LEHI, features: [] });
  assert.equal(payload.mode, 'clear');
  const frames = weatherAlertsFrames(payload);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].priority, 'snapshot');
});

test('all-clear uses the full row so long city names are not clipped', () => {
  const { CHAR_BY_CODE } = require('../src/vestaboard/encoder');
  const rowText = (row) => row.map((code) => CHAR_BY_CODE.get(code) || (code === 0 ? ' ' : '#')).join('');
  const frames = weatherAlertsFrames({ mode: 'clear', city: 'Saratoga Springs' });
  assert.match(rowText(frames[0].rows[3]), /FOR SARATOGA SPRINGS/);
  assert.doesNotMatch(rowText(frames[0].rows[3]), /SPRIN $/);
});

test('buildWeatherAlertsPayload explains outside-US coverage', () => {
  const payload = buildWeatherAlertsPayload({
    locale: {
      city: 'London',
      country: 'GB',
      latitude: 51.5,
      longitude: -0.12,
      timeZone: 'Europe/London',
    },
    features: [],
  });
  assert.equal(payload.mode, 'outside-us');
  assert.equal(weatherAlertsFrames(payload).length, 1);
});

test('formatUntil prints a board-safe local clock', () => {
  const label = formatUntil('2026-08-28T20:45:00-06:00', 'America/Denver');
  assert.match(label, /^UNTIL /);
  assert.match(label, /PM|AM/);
});

test('createWeatherAlerts persists filters and builds via a mocked NWS fetch', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weather-alerts-'));
  const api = createWeatherAlerts({
    weatherAlertsSettingsPath: path.join(dir, 'weather-alerts-settings.json'),
  });
  api.updateSettings({ minSeverity: 'Severe', maxAlerts: 1, includeWatches: false });
  assert.equal(api.getSettings().minSeverity, 'Severe');

  const payload = await api.nextPayload({
    locale: LEHI,
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return { features: [feature({ event: 'Tornado Warning', severity: 'Extreme' })] };
      },
    }),
  });
  assert.equal(payload.mode, 'alerts');
  assert.equal(payload.alerts.length, 1);
});
