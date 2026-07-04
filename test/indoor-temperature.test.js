const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveIndoorLocation } = require('../src/indoor-locations');
const { comfortBand, parseIndoorReading } = require('../src/indoor-reading-parse');
const {
  extractIndoorLocationPhrase,
  isIndoorTemperatureQuery,
  matchesIndoorQuery,
  resolveIndoorQueryLocation,
} = require('../src/indoor-temperature');
const { buildIndoorTemperaturePayload } = require('../src/udp-payload');
const { createVoiceQueryParser } = require('../src/voice-query-parser');

function activity(summary, response = '') {
  return {
    creationTimestamp: Date.now(),
    name: 'Kitchen Echo',
    description: { summary },
    alexaResponse: response,
    data: { recordKey: `indoor-${summary}-${response}` },
  };
}

test('extractIndoorLocationPhrase reads top floor and bedroom echo aliases', () => {
  assert.equal(extractIndoorLocationPhrase("what's the temperature on top floor"), 'top floor');
  assert.equal(extractIndoorLocationPhrase("what's the temperature at main floor"), 'main floor');
  assert.equal(extractIndoorLocationPhrase("what's the temperature in the bedroom echo"), 'bedroom echo');
  assert.equal(extractIndoorLocationPhrase('what is the humidity of top floor'), 'top floor');
});

test('generic temperature query is not treated as indoor', () => {
  assert.equal(isIndoorTemperatureQuery("what's the temperature"), false);
  assert.equal(isIndoorTemperatureQuery("what's the temperature outside"), false);
});

test('resolveIndoorLocation maps bedroom echo and Room 14', () => {
  const master = resolveIndoorLocation('bedroom echo');
  assert.equal(master.entity, 'Bedroom 4');
  assert.equal(master.matched, true);

  const Room 16 = resolveIndoorLocation('Room 14');
  assert.equal(Room 16.entity, 'Room 10');
  assert.equal(Room 16.matched, true);
});

test('parseIndoorReading extracts temperature and humidity from Alexa responses', () => {
  const temp = parseIndoorReading("It's 76 degrees on the top floor");
  assert.equal(temp.temperatureF, 76);
  assert.equal(temp.comfort, 'hot');

  const bedroom = parseIndoorReading('The bedroom echo shows 72 degrees');
  assert.equal(bedroom.temperatureF, 72);
  assert.equal(bedroom.comfort, 'comfortable');

  const humidity = parseIndoorReading('The humidity of top floor is 16%');
  assert.equal(humidity.humidity, 16);
});

test('comfortBand uses cold below 68 and hot above 74', () => {
  assert.equal(comfortBand(67), 'cold');
  assert.equal(comfortBand(70), 'comfortable');
  assert.equal(comfortBand(75), 'hot');
});

test('buildIndoorTemperaturePayload includes location and reading', () => {
  const payload = buildIndoorTemperaturePayload({
    device: 'Kitchen Echo',
    timestamp: Date.now(),
    query: "what's the temperature on top floor",
    spokenResponse: "It's 76 degrees on the top floor",
    trigger: 'indoor-temperature-query',
  }, {
    udpBroadcast: { defaultDisplaySeconds: 120 },
    indoorTemperature: { coldBelowF: 68, hotAboveF: 74 },
  });

  assert.equal(payload.type, 'indoor-temperature.query');
  assert.equal(payload.location.entity, 'top floor');
  assert.equal(payload.reading.temperatureF, 76);
  assert.equal(payload.reading.comfort, 'hot');
  assert.equal(payload.metric, 'temperature');
});

test('voice query parser routes indoor location before outdoor weather', () => {
  const parser = createVoiceQueryParser();

  const indoor = parser.parse(activity("what's the temperature on top floor", "It's 76 degrees on the top floor"));
  assert.equal(indoor.kind, 'indoor-temperature');

  const outdoor = parser.parse(activity("what's the temperature", "It's 72 degrees and sunny"));
  assert.equal(outdoor.kind, 'weather');

  const outside = parser.parse(activity("what's the temperature outside", "It's 55 degrees outside"));
  assert.equal(outside.kind, 'weather');
});

test('voice query parser routes humidity queries to indoor temperature', () => {
  const parser = createVoiceQueryParser();
  const event = parser.parse(activity('what is the humidity of top floor', 'The humidity of top floor is 16%'));
  assert.equal(event.kind, 'indoor-temperature');
  assert.equal(resolveIndoorQueryLocation(event.query).entity, 'top floor');
});

test('matchesIndoorQuery rejects outdoor weather phrasing', () => {
  assert.equal(matchesIndoorQuery("what's the weather", 'It is sunny'), false);
  assert.equal(matchesIndoorQuery("what's the temperature outside", 'It is 55 degrees outside'), false);
});
