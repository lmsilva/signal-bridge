const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSpokenTime } = require('../src/time-parse');
const { extractWeatherLocation } = require('../src/weather-location');
const {
  buildTimeQueryPayload,
  buildWeatherQueryPayload,
  buildTimerSnapshotPayload,
  timerDisplaySeconds,
} = require('../src/udp-payload');

const config = {
  udpBroadcast: { defaultDisplaySeconds: 120 },
  voiceEvents: {
    defaultLocation: {
      name: 'Seattle',
      latitude: 47.6062,
      longitude: -122.3321,
    },
  },
};

test('parseSpokenTime parses clock-style Alexa response', () => {
  const parsed = parseSpokenTime("It's 3:45 PM", new Date('2026-06-27T10:00:00Z'));
  assert.ok(parsed);
  assert.equal(parsed.hour, 15);
  assert.equal(parsed.minute, 45);
  assert.match(parsed.timeLabel, /3:45/);
});

test('parseSpokenTime builds ISO in configured local timezone', () => {
  const parsed = parseSpokenTime(
    "It's 10:15 PM",
    new Date('2026-07-10T04:15:00.000Z'),
    { timeZone: 'America/Denver' },
  );
  assert.ok(parsed);
  assert.equal(parsed.hour, 22);
  assert.equal(parsed.minute, 15);
  assert.equal(parsed.iso, '2026-07-10T04:15:00.000Z');
});

test('extractWeatherLocation resolves local weather to configured default', () => {
  const location = extractWeatherLocation('what is the weather like outside', config.voiceEvents.defaultLocation);
  assert.equal(location.scope, 'local');
  assert.equal(location.latitude, 47.6062);
});

test('extractWeatherLocation geocodes default name when coordinates are missing', () => {
  const location = extractWeatherLocation('what is the weather like outside', {
    name: 'Home',
  });
  assert.equal(location.scope, 'named');
  assert.equal(location.query, 'Home');
  assert.equal(location.resolvedName, 'Home');
});

test('extractWeatherLocation extracts named city', () => {
  const location = extractWeatherLocation('what is the weather in Portland Oregon');
  assert.equal(location.scope, 'named');
  assert.match(location.query, /Portland/i);
});

test('extractWeatherLocation uses spoken response when query is generic', () => {
  const location = extractWeatherLocation(
    'what is the weather',
    config.voiceEvents.defaultLocation,
    "Currently in New York it's 65 degrees and sunny",
  );
  assert.equal(location.scope, 'named');
  assert.match(location.query, /New York/i);
});

test('extractWeatherLocation prefers explicit query city over spoken default', () => {
  const location = extractWeatherLocation(
    'what is the weather in Chicago',
    config.voiceEvents.defaultLocation,
    "Currently in New York it's 65 degrees and sunny",
  );
  assert.equal(location.scope, 'named');
  assert.match(location.query, /Chicago/i);
});

test('extractWeatherLocation ignores weather-warning idioms in spoken response', () => {
  // "weather outside" is local scope, and Alexa's answer mentions a warning
  // "in effect until Tuesday morning" — must default, not parse a fake city.
  const location = extractWeatherLocation(
    "what's the weather outside",
    config.voiceEvents.defaultLocation,
    'There is a wind advisory in effect until Tuesday morning. It is 99 degrees and sunny.',
  );
  assert.equal(location.scope, 'local');
  assert.equal(location.latitude, 47.6062);
  assert.doesNotMatch(location.query, /effect|tuesday/i);
});

test('extractWeatherLocation does not treat warning idioms as a city for generic query', () => {
  // Even a generic query (no local marker) must reject non-place phrases.
  const location = extractWeatherLocation(
    "what's the weather",
    config.voiceEvents.defaultLocation,
    'A flood warning is in effect until Tuesday morning.',
  );
  assert.equal(location.scope, 'local');
  assert.equal(location.latitude, 47.6062);
});

test('buildTimeQueryPayload uses protocol v2', () => {
  const payload = buildTimeQueryPayload({
    device: 'Kitchen Echo',
    timestamp: Date.parse('2026-06-27T12:00:00.000Z'),
    query: 'what time is it',
    spokenResponse: "It's 1:15 PM",
    trigger: 'time-query',
  }, config);

  assert.equal(payload.type, 'time.query');
  assert.equal(payload.version, 2);
  assert.ok(payload.parsedTime);
});

test('buildTimerSnapshotPayload includes active timer list', () => {
  const payload = buildTimerSnapshotPayload({
    timers: [{
      amazonId: 'abc',
      device: 'Kitchen Echo',
      remainingSec: 120,
      durationSec: 300,
      status: 'ON',
    }],
    trigger: 'timer-set-voice',
    event: { kind: 'list' },
  }, config);

  assert.equal(payload.type, 'timer.snapshot');
  assert.equal(payload.timers.length, 1);
  assert.equal(payload.event.kind, 'list');
});

test('buildTimerSnapshotPayload shortens display time when timer is shorter than default', () => {
  const payload = buildTimerSnapshotPayload({
    timers: [{
      amazonId: 'abc',
      device: 'Kitchen Echo',
      remainingSec: 90,
      durationSec: 300,
      status: 'ON',
    }],
    trigger: 'timer-set-voice',
    event: { kind: 'started' },
  }, config);

  assert.equal(payload.displaySeconds, 90);
});

test('buildTimerSnapshotPayload keeps default display time for long timers', () => {
  const payload = buildTimerSnapshotPayload({
    timers: [{
      amazonId: 'abc',
      device: 'Kitchen Echo',
      remainingSec: 254,
      durationSec: 300,
      status: 'ON',
    }],
    trigger: 'timer-set-voice',
    event: { kind: 'started' },
  }, config);

  assert.equal(payload.displaySeconds, 120);
});

test('buildTimerSnapshotPayload extends display time when timer fires', () => {
  const payload = buildTimerSnapshotPayload({
    timers: [{
      amazonId: 'abc',
      device: 'Kitchen Echo',
      remainingSec: 0,
      durationSec: 300,
      status: 'OFF',
      label: 'Pizza',
    }],
    trigger: 'fire-verify',
    event: { kind: 'fired', timer: { label: 'Pizza', device: 'Kitchen Echo' } },
  }, config);

  assert.equal(payload.displaySeconds, 120);
  assert.equal(payload.event.kind, 'fired');
});

test('buildWeatherQueryPayload includes location block', () => {
  const payload = buildWeatherQueryPayload({
    device: 'Kitchen Echo',
    timestamp: Date.now(),
    query: 'weather in Seattle',
    spokenResponse: 'It is cloudy',
    trigger: 'weather-query',
  }, config, {
    location: {
      scope: 'named',
      query: 'Seattle',
      resolvedName: 'Seattle, WA',
      latitude: 47.6,
      longitude: -122.3,
    },
    weather: null,
  });

  assert.equal(payload.type, 'weather.query');
  assert.equal(payload.location.resolvedName, 'Seattle, WA');
});
