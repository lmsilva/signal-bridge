const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  TYPE,
  haversineKm,
  bearingDegrees,
  compassLabel,
  formatCoord,
  formatSpeed,
  formatAltitude,
  buildIssTrackPayload,
  createIssTracker,
} = require('../src/iss-tracker');
const { issTrackFrames } = require('../src/vestaboard/formatters/feeds');

test('haversine and compass helpers are sane', () => {
  const km = haversineKm(40.41, -111.85, 41.41, -111.85);
  assert.ok(km > 100 && km < 130);
  assert.equal(compassLabel(0), 'N');
  assert.equal(compassLabel(90), 'E');
  assert.equal(compassLabel(bearingDegrees(0, 0, 0, 10)), 'E');
});

test('format helpers honour miles vs km', () => {
  assert.match(formatSpeed(27600, 'miles'), /MPH/);
  assert.match(formatSpeed(27600, 'km'), /KM\/H/);
  assert.match(formatAltitude(420, 'miles'), /MI UP/);
  assert.equal(formatCoord(41.234, -112.4), '41.2N 112.4W');
});

test('buildIssTrackPayload is a vestaboard iss.track card relative to home', () => {
  const payload = buildIssTrackPayload({
    position: {
      latitude: 41.2,
      longitude: -112.0,
      altitudeKm: 420,
      speedKmh: 27600,
      visibility: 'daylight',
      source: 'wheretheiss',
      timestamp: Date.now(),
    },
    locale: { latitude: 40.41, longitude: -111.85, city: 'Lehi' },
    settings: { distanceUnit: 'miles', showAltitude: true, showCoordinates: true, showVisibility: true },
  });
  assert.equal(payload.type, TYPE);
  assert.equal(payload.hasHome, true);
  assert.ok(payload.relativeLabel);
  assert.ok(payload.speedLabel);
  assert.equal(payload.visibilityLabel, 'DAYLIGHT');

  const frames = issTrackFrames(payload);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].source, 'iss.track');
  assert.equal(frames[0].rows.length, 6);
});

test('issTrackFrames refuse missing coordinates', () => {
  assert.deepEqual(issTrackFrames({ type: 'iss.track' }), []);
});

test('createIssTracker fetches WTIA and builds a payload', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iss-tracker-'));
  const api = createIssTracker({
    issTrackerSettingsPath: path.join(dir, 'iss-tracker-settings.json'),
    issTrackerFetchImpl: async (url) => {
      assert.match(String(url), /wheretheiss\.at/);
      return {
        ok: true,
        async json() {
          return {
            name: 'iss',
            id: 25544,
            latitude: 10.5,
            longitude: -20.25,
            altitude: 420,
            velocity: 27600,
            visibility: 'eclipsed',
            units: 'kilometers',
            timestamp: Math.floor(Date.now() / 1000),
          };
        },
      };
    },
  }, console);

  const payload = await api.nextPayload({
    locale: { latitude: 40.41, longitude: -111.85, city: 'Lehi' },
  });
  assert.equal(payload.type, 'iss.track');
  assert.equal(payload.source, 'wheretheiss');
  assert.equal(payload.visibilityLabel, 'ECLIPSED');
  assert.ok(payload.hasHome);
});

test('createIssTracker falls back to Open Notify', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iss-tracker-'));
  let calls = 0;
  const api = createIssTracker({
    issTrackerSettingsPath: path.join(dir, 'iss-tracker-settings.json'),
    issTrackerFetchImpl: async (url) => {
      calls += 1;
      if (String(url).includes('wheretheiss')) {
        throw new Error('down');
      }
      return {
        ok: true,
        async json() {
          return {
            message: 'success',
            timestamp: Math.floor(Date.now() / 1000),
            iss_position: { latitude: '15.0', longitude: '-40.0' },
          };
        },
      };
    },
  }, console);
  const payload = await api.nextPayload({ locale: {} });
  assert.equal(payload.source, 'open-notify');
  assert.equal(payload.hasHome, false);
  assert.ok(calls >= 2);
});
