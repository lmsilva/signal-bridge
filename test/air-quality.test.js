const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveAirQualityLocation } = require('../src/air-quality-locations');
const { iaqBand, parseSpokenAirQuality, parseMonitorSummaries, resolveAirQualityLocationFromTexts, summarizeMonitorReadings } = require('../src/air-quality-parse');
const { mapDeviceReading } = require('../src/air-quality-fetch');
const { matchesAirQualityQuery } = require('../src/air-quality');
const { buildAirQualityPayload } = require('../src/udp-payload');
const { createVoiceQueryParser } = require('../src/voice-query-parser');

function activity(summary, response = '') {
  return {
    creationTimestamp: Date.now(),
    name: 'Kitchen Echo',
    description: { summary },
    alexaResponse: response,
    data: { recordKey: `aq-${summary}-${response}` },
  };
}

test('parseSpokenAirQuality extracts score and location', () => {
  const generic = parseSpokenAirQuality('Air quality is at 90 out of 100 right now');
  assert.equal(generic.iaqScore, 90);
  assert.equal(generic.band, 'good');

  const named = parseSpokenAirQuality('The main floor airquality is 40 out of 100');
  assert.equal(named.iaqScore, 40);
  assert.equal(named.band, 'moderate');
  assert.equal(named.locationPhrase, 'main floor');
});

test('parseSpokenAirQuality handles qualitative overall response', () => {
  const parsed = parseSpokenAirQuality("Well, the air quality's pretty good across your home.");
  assert.equal(parsed.iaqScore, null);
  assert.equal(parsed.band, 'good');
  assert.equal(parsed.locationPhrase, null);
});

test('parseMonitorSummaries extracts multiple monitors from spoken response', () => {
  const spoken = [
    "Well, the air quality's pretty good.",
    'On the main floor, air quality is 88 out of 100.',
    'The dome is fair at 62 out of 100.',
    'The machine room air quality is good.',
  ].join(' ');

  const monitors = parseMonitorSummaries(spoken, {});
  assert.ok(monitors.length >= 2);
  assert.equal(monitors.find((entry) => entry.id === 'main-floor')?.iaqScore, 88);
  assert.equal(monitors.find((entry) => entry.id === 'dome')?.band, 'fair');
});

test('resolveAirQualityLocationFromTexts uses indoor label for show indoor air quality', () => {
  const location = resolveAirQualityLocationFromTexts(
    'show indoor air quality',
    "Well, the air quality's pretty good. On the main floor, air quality is 88 out of 100.",
    {},
  );
  assert.equal(location.label, 'Indoor Air Quality');
  assert.equal(location.multiMonitor, true);
});

test('resolveAirQualityLocation maps main floor monitor', () => {
  const resolved = resolveAirQualityLocation('main floor');
  assert.equal(resolved.label, 'Main Floor');
  assert.equal(resolved.matched, true);
});

test('resolveAirQualityLocationFromTexts prefers query location then spoken', () => {
  const fromQuery = resolveAirQualityLocationFromTexts(
    'what is the air quality on top floor',
    'Air quality is at 75 out of 100 right now',
    {},
  );
  assert.equal(fromQuery.entity, 'top floor');

  const fromSpoken = resolveAirQualityLocationFromTexts(
    'what is the air quality',
    'The main floor airquality is 40 out of 100',
    {},
  );
  assert.equal(fromSpoken.label, 'Main Floor');
});

test('iaqBand uses good, fair, moderate, and poor thresholds', () => {
  assert.equal(iaqBand(90), 'good');
  assert.equal(iaqBand(70), 'fair');
  assert.equal(iaqBand(50), 'moderate');
  assert.equal(iaqBand(30), 'poor');
});

test('mapDeviceReading maps smarthome properties', () => {
  const reading = mapDeviceReading({
    friendlyName: 'Main Floor Air Quality Monitor',
    properties: [
      { name: 'airQuality', value: 88 },
      { name: 'temperature', value: 72 },
      { name: 'humidity', value: 18 },
      { name: 'PM2.5', value: 6 },
      { name: 'carbonMonoxide', value: 1 },
      { name: 'VOC', value: 220 },
    ],
  });
  assert.equal(reading.iaqScore, 88);
  assert.equal(reading.temperatureF, 72);
  assert.equal(reading.humidity, 18);
  assert.equal(reading.pm25, 6);
  assert.equal(reading.co, 1);
  assert.equal(reading.voc, 220);
});

test('summarizeMonitorReadings averages scores and keeps sensor metrics', () => {
  const summary = summarizeMonitorReadings([
    {
      iaqScore: 88,
      band: 'good',
      reading: { temperatureF: 72, humidity: 18, pm25: 6, co: 1, voc: 220 },
    },
    { iaqScore: 62, band: 'fair', reading: { temperatureF: 68 } },
  ]);

  assert.equal(summary.iaqScore, 75);
  assert.equal(summary.band, 'fair');
  assert.equal(summary.temperatureF, 72);
  assert.equal(summary.humidity, 18);
  assert.equal(summary.pm25, 6);
  assert.equal(summary.co, 1);
  assert.equal(summary.voc, 220);
});

test('buildAirQualityPayload includes location and reading', () => {
  const payload = buildAirQualityPayload({
    device: 'Kitchen Echo',
    timestamp: Date.now(),
    query: 'what is the air quality',
    spokenResponse: 'Air quality is at 90 out of 100 right now',
    trigger: 'air-quality-query',
  }, {
    udpBroadcast: { defaultDisplaySeconds: 120 },
    airQuality: { defaultMonitor: 'main floor' },
  }, {
    location: { label: 'Main Floor', entity: 'main floor', scope: 'indoor-air-quality', matched: true },
    reading: { iaqScore: 90, band: 'good', iaqMax: 100 },
  });

  assert.equal(payload.type, 'air-quality.query');
  assert.equal(payload.reading.iaqScore, 90);
  assert.equal(payload.location.label, 'Main Floor');
});

test('voice query parser routes air quality queries', () => {
  const parser = createVoiceQueryParser();
  const event = parser.parse(activity('what is the air quality', 'Air quality is at 90 out of 100 right now'));
  assert.equal(event.kind, 'air-quality');
  assert.equal(event.trigger, 'air-quality-query');
});

test('matchesAirQualityQuery accepts named and generic air quality questions', () => {
  assert.equal(matchesAirQualityQuery('what is the air quality', 'Air quality is at 90 out of 100 right now'), true);
  assert.equal(
    matchesAirQualityQuery('what is the air quality on main floor', 'The main floor airquality is 40 out of 100'),
    true,
  );
  assert.equal(matchesAirQualityQuery('show indoor air quality', "Well, the air quality's pretty good."), true);
});

test('voice query parser routes show indoor air quality', () => {
  const parser = createVoiceQueryParser();
  const event = parser.parse(activity(
    'show indoor air quality',
    "Well, the air quality's pretty good. On the main floor, air quality is 88 out of 100.",
  ));
  assert.equal(event?.kind, 'air-quality');
});
