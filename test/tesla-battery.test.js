const test = require('node:test');
const assert = require('node:assert/strict');
const {
  matchesTeslaBatteryQuery,
  parseBatteryPercentFromSpeech,
  buildTeslaBatteryReading,
  clampPercent,
} = require('../src/tesla-battery');

test('matchesTeslaBatteryQuery detects show my tesla battery', () => {
  assert.equal(matchesTeslaBatteryQuery('show my tesla battery'), true);
  assert.equal(matchesTeslaBatteryQuery('what is the weather'), false);
});

test('parseBatteryPercentFromSpeech reads common Alexa battery answers', () => {
  assert.equal(parseBatteryPercentFromSpeech('Your battery is at 78 percent'), 78);
  assert.equal(parseBatteryPercentFromSpeech('your battery is 80 percent'), 80);
  assert.equal(parseBatteryPercentFromSpeech('The Tesla battery level is 62%'), 62);
  assert.equal(parseBatteryPercentFromSpeech('Charged to 91 percent'), 91);
});

test('clampPercent bounds values to 0-100', () => {
  assert.equal(clampPercent(150), 100);
  assert.equal(clampPercent(-5), 0);
});

test('buildTeslaBatteryReading includes model and percent', () => {
  const reading = buildTeslaBatteryReading('Your battery is at 55 percent');
  assert.equal(reading.percent, 55);
  assert.equal(reading.model, 'Model Y');
});
