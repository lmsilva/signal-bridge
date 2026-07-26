const test = require('node:test');
const assert = require('node:assert/strict');
const { matchesRouteQuery, extractRouteLocations } = require('../src/route-query');

const DEFAULT_LOCATION = {
  name: 'Home',
  latitude: 40.0,
  longitude: -111.0,
};

test('matchesRouteQuery detects "what is the distance between X and Y"', () => {
  assert.equal(matchesRouteQuery('what is the distance between Saratoga Springs and Moab', ''), true);
});

test('matchesRouteQuery detects "how far is Y from X"', () => {
  assert.equal(matchesRouteQuery('how far is moab from saratoga springs', ''), true);
});

test('matchesRouteQuery detects "how far is Y from here"', () => {
  assert.equal(matchesRouteQuery('how far is moab from here', ''), true);
});

test('matchesRouteQuery detects bare "how far is Y"', () => {
  assert.equal(matchesRouteQuery('how far is moab', ''), true);
});

test('matchesRouteQuery detects "how long to drive to Y"', () => {
  assert.equal(matchesRouteQuery('how long to drive to moab', ''), true);
  assert.equal(matchesRouteQuery('how long would it take to get to moab', ''), true);
});

test('matchesRouteQuery detects "directions to Y"', () => {
  assert.equal(matchesRouteQuery('directions to moab', ''), true);
});

test('matchesRouteQuery detects Alexa\'s own distance answer in the spoken response', () => {
  assert.equal(matchesRouteQuery('', "it's roughly 177 miles from Saratoga Springs to Moab"), true);
});

test('matchesRouteQuery does not mistake an unrelated "from A to B" for a distance answer', () => {
  assert.equal(matchesRouteQuery('', 'the store is open from Monday to Friday'), false);
});

test('matchesRouteQuery ignores unrelated queries', () => {
  assert.equal(matchesRouteQuery('what is the weather like outside', ''), false);
  assert.equal(matchesRouteQuery('play some music', ''), false);
});

test('extractRouteLocations parses "distance between X and Y"', () => {
  const result = extractRouteLocations('what is the distance between Saratoga Springs and Moab', DEFAULT_LOCATION);
  assert.equal(result.origin.scope, 'named');
  assert.equal(result.origin.query, 'Saratoga Springs');
  assert.equal(result.destination.scope, 'named');
  assert.equal(result.destination.query, 'Moab');
});

test('extractRouteLocations parses "how far is Y from X"', () => {
  const result = extractRouteLocations('how far is moab from saratoga springs', DEFAULT_LOCATION);
  assert.equal(result.destination.query, 'moab');
  assert.equal(result.origin.query, 'saratoga springs');
});

test('extractRouteLocations resolves "from here"/"from home" to the default location', () => {
  const fromHere = extractRouteLocations('how far is moab from here', DEFAULT_LOCATION);
  assert.equal(fromHere.origin.scope, 'local');
  assert.equal(fromHere.origin.latitude, DEFAULT_LOCATION.latitude);
  assert.equal(fromHere.destination.query, 'moab');

  const fromHome = extractRouteLocations('how far is moab from home', DEFAULT_LOCATION);
  assert.equal(fromHome.origin.scope, 'local');
});

test('extractRouteLocations resolves bare "how far is Y" origin to the default location', () => {
  const result = extractRouteLocations('how far is moab', DEFAULT_LOCATION);
  assert.equal(result.origin.scope, 'local');
  assert.equal(result.destination.query, 'moab');
});

test('extractRouteLocations parses "how long to drive to Y" with implied local origin', () => {
  const result = extractRouteLocations('how long to drive to moab', DEFAULT_LOCATION);
  assert.equal(result.origin.scope, 'local');
  assert.equal(result.destination.query, 'moab');
});

test('extractRouteLocations parses "how long to drive to Y from X"', () => {
  const result = extractRouteLocations('how long would it take to drive to moab from denver', DEFAULT_LOCATION);
  assert.equal(result.origin.query, 'denver');
  assert.equal(result.destination.query, 'moab');
});

test('extractRouteLocations parses "directions to Y"', () => {
  const result = extractRouteLocations('directions to moab', DEFAULT_LOCATION);
  assert.equal(result.origin.scope, 'local');
  assert.equal(result.destination.query, 'moab');
});

test('extractRouteLocations falls back to the spoken response when the query is blank', () => {
  const result = extractRouteLocations('', DEFAULT_LOCATION, "it's roughly 177 miles from Saratoga Springs to Moab");
  assert.equal(result.origin.query, 'Saratoga Springs');
  assert.equal(result.destination.query, 'Moab');
});

test('extractRouteLocations returns null when no place names are found', () => {
  assert.equal(extractRouteLocations('what time is it', DEFAULT_LOCATION), null);
});

test('extractRouteLocations returns null when the default location is unavailable and origin is implicit', () => {
  const result = extractRouteLocations('how far is moab', null);
  assert.equal(result.origin.scope, 'local');
  assert.equal(result.origin.latitude, null);
});
