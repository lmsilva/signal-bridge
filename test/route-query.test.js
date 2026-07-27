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

test('extractRouteLocations parses "distance from here to City State"', () => {
  const result = extractRouteLocations(
    'what is the distance from here to Las Vegas Nevada',
    DEFAULT_LOCATION,
  );
  assert.equal(result.origin.scope, 'local');
  assert.equal(result.origin.latitude, DEFAULT_LOCATION.latitude);
  assert.equal(result.destination.query, 'Las Vegas Nevada');
});

test('extractRouteLocations parses "distance from City State to City"', () => {
  const result = extractRouteLocations(
    'what is the distance from Saratoga Springs Utah to New York',
    DEFAULT_LOCATION,
  );
  assert.equal(result.origin.query, 'Saratoga Springs Utah');
  assert.equal(result.destination.query, 'New York');
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
  assert.equal(extractRouteLocations('how far is moab', null), null);
  assert.equal(extractRouteLocations('what is the distance from here to Las Vegas', null), null);
  assert.equal(extractRouteLocations('directions to moab', null), null);
});

test('extractRouteLocations still works for two named places without a default location', () => {
  const result = extractRouteLocations(
    "what's the distance from Saratoga Springs Utah to Los Angeles",
    null,
  );
  assert.equal(result.origin.query, 'Saratoga Springs Utah');
  assert.equal(result.destination.query, 'Los Angeles');
});

test('matchesRouteQuery normalizes curly apostrophes and whats', () => {
  assert.equal(matchesRouteQuery('what\u2019s the distance from here to Las Vegas', ''), true);
  assert.equal(matchesRouteQuery('whats the distance from here to Las Vegas', ''), true);
});

test('matchesRouteQuery treats ASR "difference" as "distance"', () => {
  assert.equal(
    matchesRouteQuery("what's the difference from here to Las Vegas", ''),
    true,
  );
  assert.equal(
    matchesRouteQuery("what's the difference from Saratoga Springs Utah to Los Angeles", ''),
    true,
  );
});

test('extractRouteLocations parses ASR "difference from here to City"', () => {
  const result = extractRouteLocations(
    "what's the difference from here to Las Vegas",
    DEFAULT_LOCATION,
  );
  assert.equal(result.origin.scope, 'local');
  assert.equal(result.destination.query, 'Las Vegas');
});

test('matchesRouteQuery detects Alexa "Y is about N miles from X" TTS with empty ASR', () => {
  const spoken = "Los Angeles is about 564 miles from Saratoga Springs, Utah as the crow flies. By road it's roughly 2,818 miles.";
  assert.equal(matchesRouteQuery('', spoken), true);
  assert.equal(matchesRouteQuery(null, spoken), true);
});

test('extractRouteLocations parses Alexa crow-flies spoken answer', () => {
  const spoken = "Los Angeles is about 564 miles from Saratoga Springs, Utah as the crow flies. By road it's roughly 2,818 miles.";
  const result = extractRouteLocations('', DEFAULT_LOCATION, spoken);
  assert.equal(result.destination.query, 'Los Angeles');
  assert.equal(result.origin.query, 'Saratoga Springs, Utah');
});

test('extractRouteLocations parses "it\'s about N miles to Y from X"', () => {
  const result = extractRouteLocations(
    '',
    DEFAULT_LOCATION,
    "It's about 380 miles to Las Vegas from here.",
  );
  assert.equal(result.destination.query, 'Las Vegas');
  assert.equal(result.origin.scope, 'local');
  assert.equal(result.origin.latitude, DEFAULT_LOCATION.latitude);
});

test('looksLikeRouteQuery catches incomplete "distance from City" ASR', () => {
  const { looksLikeRouteQuery } = require('../src/route-query');
  assert.equal(looksLikeRouteQuery("what's the distance from saratoga springs utah"), true);
  assert.equal(looksLikeRouteQuery('what is the weather like'), false);
  assert.equal(matchesRouteQuery("what's the distance from saratoga springs utah", ''), false);
});

test('extractRouteLocations does not invent a pair from incomplete "distance from PLACE"', () => {
  // ASR often cuts off before "to Los Angeles"; inventing home→PLACE would
  // flash a useless near-zero route when PLACE is the configured home.
  const result = extractRouteLocations(
    "what's the distance from saratoga springs utah",
    DEFAULT_LOCATION,
  );
  assert.equal(result, null);
});

test('extractRouteLocations prefers spoken miles answer over incomplete ASR', () => {
  const spoken = 'Los Angeles is about 564 miles from Saratoga Springs, Utah as the crow flies.';
  const result = extractRouteLocations(
    "what's the distance from saratoga springs utah",
    DEFAULT_LOCATION,
    spoken,
  );
  assert.equal(result.destination.query, 'Los Angeles');
  assert.equal(result.origin.query, 'Saratoga Springs, Utah');
});

test('spokenHasRouteAnswer detects Alexa miles TTS without place names', () => {
  const { spokenHasRouteAnswer } = require('../src/route-query');
  const spoken = 'Los Angeles is about 564 miles from Saratoga Springs, Utah as the crow flies.';
  assert.equal(spokenHasRouteAnswer(spoken), true);
  assert.equal(spokenHasRouteAnswer('the weather is sunny today'), false);
});
