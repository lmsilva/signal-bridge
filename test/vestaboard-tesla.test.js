'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { validate } = require('../src/vestaboard/encoder');
const { parseLayout, formatLayout } = require('../src/vestaboard/notation');
const tesla = require('../src/vestaboard/formatters/tesla');

const DEG = '\u00b0';

function assertLayout(actual, drawing, label) {
  assert.equal(validate(actual).ok, true, `${label} failed validation`);
  const expected = parseLayout(drawing.join('\n'), { label });
  if (formatLayout(actual) !== formatLayout(expected)) {
    assert.fail(
      `${label} does not match the spec drawing\n\n`
      + `--- expected ---\n${formatLayout(expected)}\n\n`
      + `--- actual ---\n${formatLayout(actual)}\n`,
    );
  }
}

const SNAPSHOT = new Date(2026, 7, 23, 14, 38);

function dashboard(overrides = {}) {
  return {
    version: 2,
    type: 'tesla-dashboard.query',
    timestamp: SNAPSHOT.toISOString(),
    dashboard: {
      status: 'ok',
      fetchedAt: SNAPSHOT.toISOString(),
      vehicle: { model: 'Model Y', name: 'Kylie' },
      battery: {
        percent: 73,
        rangeMiles: 201,
        charging: false,
        chargingLabel: 'Not plugged in',
        chargerPowerKw: null,
      },
      map: { drivingChip: '0 mph · Park' },
      climate: { insideTempF: 88, outsideTempF: 91 },
      security: { locked: true, sentryOn: true },
      ...overrides,
    },
  };
}

test('the tesla dashboard matches the spec drawing', () => {
  const frames = tesla.dashboardFrames(dashboard());

  assert.equal(frames.length, 1);
  assert.equal(frames[0].priority, 'snapshot');
  assertLayout(frames[0].rows, [
    'rr TESLA MODEL Y    rr',
    'BATT 73%  RANGE 201MI',
    'PARKED - NOT PLUGGED',
    `IN 88${DEG}  OUT 91${DEG}`,
    'LOCKED - SENTRY ON',
    'rr 2:38PM           rr',
  ], 'tesla dashboard');
});

test('a charging car reports power rather than park', () => {
  const frames = tesla.dashboardFrames(dashboard({
    battery: {
      percent: 73, rangeMiles: 201, charging: true, chargingLabel: 'Charging', chargerPowerKw: 11,
    },
  }));
  assert.match(formatLayout(frames[0].rows).split('\n')[2], /CHARGING \+11KW/);
});

test('a moving car reports speed from the driving chip', () => {
  const frames = tesla.dashboardFrames(dashboard({
    map: { drivingChip: 'Heading NW · 65 mph · Drive' },
  }));
  assert.match(formatLayout(frames[0].rows).split('\n')[2], /^DRIVING 65 MPH$/);
});

test('stale is the boolean, not a freshness threshold, and refreshing is not stale', () => {
  assert.equal(tesla.isStale({ stale: true, freshnessSec: 0 }), true);
  assert.equal(tesla.isStale({ stale: true, refreshing: true }), false);
  assert.equal(tesla.isStale({ freshnessSec: 900 }), false);

  const frames = tesla.dashboardFrames(dashboard({ stale: true, refreshing: false }));
  const footer = formatLayout(frames[0].rows).split('\n')[5];
  assert.match(footer, /^rr o 2:38PM/);
});

test('an error dashboard with no vehicle is not a blank Tesla', () => {
  assert.deepEqual(tesla.dashboardFrames({
    type: 'tesla-dashboard.query',
    dashboard: { status: 'error', error: 'offline', fetchedAt: SNAPSHOT.toISOString() },
  }), []);
});

test('the battery gauge fills 13 of 18 slots at 73 percent', () => {
  const frames = tesla.batteryFrames({
    version: 2,
    type: 'tesla-battery.query',
    timestamp: SNAPSHOT.toISOString(),
    battery: {
      percent: 73,
      rangeMiles: 201,
      chargingLabel: 'Not plugged in',
      fetchedAt: SNAPSHOT.toISOString(),
    },
  });

  assertLayout(frames[0].rows, [
    'gg TESLA BATTERY    gg',
    '',
    ' 73% - 201 MI RANGE',
    ' (ggggggggggggg     )',
    ' NOT PLUGGED IN',
    'gg AS OF 2:38PM     gg',
  ], 'tesla battery');
});

test('a known time to full replaces the as-of footer', () => {
  const frames = tesla.batteryFrames({
    type: 'tesla-battery.query',
    timestamp: SNAPSHOT.toISOString(),
    battery: {
      percent: 73,
      rangeMiles: 201,
      chargingLabel: 'Charging',
      timeToFullChargeMin: 40,
      fetchedAt: SNAPSHOT.toISOString(),
    },
  });
  assert.match(formatLayout(frames[0].rows).split('\n')[5], /FULL AT 3:18PM/);
});

test('the battery payload key is battery, not reading, but reading still works', () => {
  assert.deepEqual(tesla.batteryFrames({ type: 'tesla-battery.query', reading: { percent: 50 } }).length, 1);
  assert.deepEqual(tesla.batteryFrames({ type: 'tesla-battery.query' }), []);
});

test('framesFor dispatches the two tesla types and ignores the rest', () => {
  assert.equal(tesla.framesFor(dashboard()).length, 1);
  assert.deepEqual(tesla.framesFor({ type: 'broadcast' }), []);
});
