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
  formatAway,
  formatGoing,
  formatHigh,
  formatIssClock,
  buildIssTrackPayload,
  createIssTracker,
} = require('../src/iss-tracker');
const { issTrackFrames } = require('../src/vestaboard/formatters/feeds');
const { decodeCodes, CHIPS } = require('../src/vestaboard/encoder');

test('haversine and compass helpers are sane', () => {
  const km = haversineKm(40.41, -111.85, 41.41, -111.85);
  assert.ok(km > 100 && km < 130);
  assert.equal(compassLabel(0), 'N');
  assert.equal(compassLabel(90), 'E');
  assert.equal(compassLabel(bearingDegrees(0, 0, 0, 10)), 'E');
});

test('format helpers match the marketplace ISS board', () => {
  assert.match(formatGoing(27600, 'miles'), /^GOING [\d,]+ MPH$/);
  assert.match(formatHigh(420, 'miles'), /^@  [\d,]+ MI HIGH$/);
  assert.equal(formatCoord(-1.45, -33.56), '1.45° S,  33.56° W');
  assert.match(formatAway(6305, 'miles'), /MI AWAY @$/);
  assert.match(formatIssClock('2026-08-29T15:20:00.000Z', 'America/Denver'), /09:20 AM/);
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
    locale: { latitude: 40.41, longitude: -111.85, city: 'Lehi', timeZone: 'America/Denver' },
    settings: { distanceUnit: 'miles', showAltitude: true, showCoordinates: true, showVisibility: true },
  });
  assert.equal(payload.type, TYPE);
  assert.equal(payload.hasHome, true);
  assert.match(payload.awayLabel, /AWAY @$/);
  assert.match(payload.speedLabel, /^GOING /);
  assert.match(payload.altitudeLabel, /HIGH$/);
  assert.match(payload.coordLabel, /°/);
  assert.ok(payload.timeLabel);
  assert.equal(payload.visibilityLabel, 'DAYLIGHT');

  const frames = issTrackFrames(payload);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].source, 'iss.track');
  assert.equal(frames[0].rows.length, 6);
  assert.match(decodeCodes(frames[0].rows[0]), /ISS SPACE ORBIT/);
  assert.equal(frames[0].rows[0][0], CHIPS.white);
  assert.equal(frames[0].rows[0][1], CHIPS.white);
  assert.equal(frames[0].rows[1][0], CHIPS.white);
  assert.equal(frames[0].rows[1][21], CHIPS.white);
  assert.match(decodeCodes(frames[0].rows[2]), /AWAY/);
  assert.match(decodeCodes(frames[0].rows[5]), /GOING/);
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
  assert.match(payload.awayLabel, /AWAY @$/);
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
