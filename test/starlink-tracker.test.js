const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  TYPE,
  pickNextPass,
  isLikelyVisible,
  formatDirectionLabel,
  weatherConditionLabel,
  buildStarlinkTrackPayload,
  createStarlinkTracker,
} = require('../src/starlink-tracker');
const { starlinkTrackFrames } = require('../src/vestaboard/formatters/feeds');

function pass(overrides = {}) {
  const startMs = overrides.startMs || Date.parse('2026-08-30T03:42:00Z');
  return {
    startUtc: new Date(startMs).toISOString(),
    endUtc: new Date(startMs + 5 * 60_000).toISOString(),
    startMs,
    maxElevationDeg: 52,
    direction: 'NW',
    skyCondition: 'Night',
    visibilityScore: 70,
    visibilityLabel: 'Good',
    satelliteIlluminated: true,
    noradId: '63503',
    name: 'STARLINK-33583',
    ...overrides,
  };
}

test('pickNextPass prefers soonest visible pass above min elevation', () => {
  const nowMs = Date.parse('2026-08-29T12:00:00Z');
  const chosen = pickNextPass([
    pass({
      startMs: nowMs + 3600_000,
      visibilityScore: 0,
      visibilityLabel: 'None',
      maxElevationDeg: 80,
      skyCondition: 'Day',
      satelliteIlluminated: true,
      direction: 'NW',
    }),
    pass({
      startMs: nowMs + 7200_000,
      visibilityScore: 60,
      visibilityLabel: 'Good',
      maxElevationDeg: 40,
      direction: 'SE',
    }),
    pass({
      startMs: nowMs + 7300_000,
      visibilityScore: 50,
      visibilityLabel: 'Good',
      maxElevationDeg: 55,
      direction: 'SE',
    }),
  ], { minElevation: 20, preferVisible: true, nowMs });
  assert.equal(chosen.direction, 'SE');
  assert.equal(chosen.trainCount, 2);
  assert.equal(chosen.maxElevationDeg, 55);
});

test('isLikelyVisible treats illuminated twilight as visible', () => {
  assert.equal(isLikelyVisible(pass()), true);
  assert.equal(isLikelyVisible(pass({
    visibilityScore: 0,
    visibilityLabel: 'None',
    skyCondition: 'Day',
    satelliteIlluminated: true,
  })), false);
});

test('formatDirectionLabel and weather labels fit the board', () => {
  assert.match(formatDirectionLabel(pass()), /NW/);
  assert.equal(weatherConditionLabel('partly_cloudy'), 'PARTLY CLOUDY');
  assert.equal(weatherConditionLabel('clear'), 'CLEAR SKY');
});

test('buildStarlinkTrackPayload makes a starlink.track card', () => {
  const payload = buildStarlinkTrackPayload({
    pass: pass({ startMs: Date.parse('2026-08-30T03:42:00Z') }),
    locale: {
      latitude: 40.41,
      longitude: -111.85,
      city: 'Lehi',
      timeZone: 'America/Denver',
    },
    weather: { current: { condition: 'clear' }, hourly: [] },
    nowMs: Date.parse('2026-08-29T18:00:00Z'),
  });
  assert.equal(payload.type, TYPE);
  assert.ok(payload.whenLabel);
  assert.ok(payload.directionLabel);
  assert.equal(payload.weatherLabel, 'CLEAR SKY');
  assert.equal(payload.visibilityBoard, 'GOOD VISIBILITY');

  const frames = starlinkTrackFrames(payload);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].source, 'starlink.track');
  assert.equal(frames[0].rows.length, 6);
  const { decodeCodes } = require('../src/vestaboard/encoder');
  assert.match(decodeCodes(frames[0].rows[0]), /STARLINK TRACKER/);
  assert.match(decodeCodes(frames[0].rows[5]), /GOOD VISIBILITY/);
});

test('starlinkTrackFrames support a no-pass card', () => {
  const frames = starlinkTrackFrames({
    type: TYPE,
    mode: 'none',
    whenLabel: 'NO PASS SOON',
    directionLabel: 'NEXT 72H',
    home: { city: 'LEHI' },
  });
  assert.equal(frames.length, 1);
  assert.equal(frames[0].source, 'starlink.track');
});

test('createStarlinkTracker loads catalog + passes from Satlas mocks', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starlink-'));
  const nowMs = Date.now();
  const api = createStarlinkTracker({
    starlinkTrackerSettingsPath: path.join(dir, 'starlink-tracker-settings.json'),
    starlinkTrackerFetchImpl: async (url) => {
      const href = String(url);
      if (href.includes('/satellites')) {
        return {
          ok: true,
          async json() {
            return {
              results: [
                { name: 'STARLINK-A', norad_id: '90001', category: 'STARLINK' },
                { name: 'STARLINK-B', norad_id: '90002', category: 'STARLINK' },
              ],
            };
          },
        };
      }
      if (href.includes('/pass')) {
        return {
          ok: true,
          async json() {
            return {
              passes: [{
                start_utc: new Date(nowMs + 3 * 3600_000).toISOString(),
                end_utc: new Date(nowMs + 3 * 3600_000 + 300_000).toISOString(),
                max_elevation_deg: 48,
                direction: 'NW',
                sky_condition: 'Night',
                visibility_score: 80,
                visibility_label: 'Good',
                satellite_illuminated: true,
              }],
            };
          },
        };
      }
      throw new Error(`unexpected ${href}`);
    },
  }, console);

  const payload = await api.nextPayload({
    locale: {
      latitude: 40.41,
      longitude: -111.85,
      city: 'Lehi',
      timeZone: 'America/Denver',
    },
    weatherFetch: async () => ({ current: { condition: 'clear' }, hourly: [] }),
  });
  assert.equal(payload.type, 'starlink.track');
  assert.equal(payload.direction, 'NW');
  assert.equal(payload.weatherLabel, 'CLEAR SKY');
  assert.ok(payload.whenLabel);
});
