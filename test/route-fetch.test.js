const test = require('node:test');
const assert = require('node:assert/strict');
const {
  fetchDrivingRoute,
  greatCircleEstimate,
  haversineMiles,
} = require('../src/route-fetch');

const EXAMPLE_ORIGIN = { latitude: 40.39, longitude: -111.85 }; // public placeholder near Lehi, UT
const MOAB = { latitude: 38.5733, longitude: -109.5498 };

function withMockedFetch(implementation, fn) {
  const original = global.fetch;
  global.fetch = implementation;
  return Promise.resolve(fn()).finally(() => {
    global.fetch = original;
  });
}

test('haversineMiles computes a plausible great-circle distance', () => {
  const miles = haversineMiles(
    EXAMPLE_ORIGIN.latitude,
    EXAMPLE_ORIGIN.longitude,
    MOAB.latitude,
    MOAB.longitude,
  );
  // Straight-line distance is close to (slightly under) the ~177 mile driving route.
  assert.ok(miles > 160 && miles < 185, `expected ~175mi, got ${miles}`);
});

test('greatCircleEstimate returns distance, duration and a two-point line', () => {
  const result = greatCircleEstimate(EXAMPLE_ORIGIN, MOAB);
  assert.ok(result.distanceMiles > 160 && result.distanceMiles < 185);
  assert.ok(result.durationMin > 0);
  assert.deepEqual(result.geometry, [
    [EXAMPLE_ORIGIN.latitude, EXAMPLE_ORIGIN.longitude],
    [MOAB.latitude, MOAB.longitude],
  ]);
});

test('greatCircleEstimate returns null when coordinates are missing', () => {
  assert.equal(greatCircleEstimate({ latitude: 1 }, MOAB), null);
  assert.equal(greatCircleEstimate(null, MOAB), null);
});

test('fetchDrivingRoute returns ok:false without calling fetch when coordinates are missing', async () => {
  let called = false;
  const result = await withMockedFetch(() => {
    called = true;
    throw new Error('should not be called');
  }, () => fetchDrivingRoute({ latitude: 1 }, MOAB));
  assert.equal(called, false);
  assert.equal(result.ok, false);
});

test('fetchDrivingRoute parses a successful OSRM response', async () => {
  const result = await withMockedFetch(
    async (url) => {
      assert.match(url, /router\.project-osrm\.org\/route\/v1\/driving/);
      return {
        ok: true,
        json: async () => ({
          code: 'Ok',
          routes: [{
            distance: 285000, // meters
            duration: 10800, // seconds (3h)
            geometry: { coordinates: [[-111.0, 40.0], [-109.5498, 38.5733]] },
          }],
        }),
      };
    },
    () => fetchDrivingRoute(EXAMPLE_ORIGIN, MOAB),
  );

  assert.equal(result.ok, true);
  assert.ok(Math.abs(result.distanceMiles - 177.1) < 1);
  assert.equal(result.durationMin, 180);
  assert.deepEqual(result.geometry, [[40.0, -111.0], [38.5733, -109.5498]]);
});

test('fetchDrivingRoute returns ok:false when OSRM reports NoRoute', async () => {
  const result = await withMockedFetch(
    async () => ({ ok: true, json: async () => ({ code: 'NoRoute', routes: [] }) }),
    () => fetchDrivingRoute(EXAMPLE_ORIGIN, MOAB),
  );
  assert.equal(result.ok, false);
});

test('fetchDrivingRoute returns ok:false on an HTTP error', async () => {
  const result = await withMockedFetch(
    async () => ({ ok: false, status: 500 }),
    () => fetchDrivingRoute(EXAMPLE_ORIGIN, MOAB),
  );
  assert.equal(result.ok, false);
});

test('fetchDrivingRoute returns ok:false when the request throws', async () => {
  const result = await withMockedFetch(
    async () => {
      throw new Error('network down');
    },
    () => fetchDrivingRoute(EXAMPLE_ORIGIN, MOAB),
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /network down/);
});
