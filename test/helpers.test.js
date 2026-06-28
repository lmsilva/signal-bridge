const test = require('node:test');
const assert = require('node:assert/strict');
const { fingerprint } = require('../src/bridge-state');
const { formatError } = require('../src/error-format');
const { weatherCodeToCondition, celsiusToFahrenheit } = require('../src/weather-fetch');

test('fingerprint normalizes device and message', () => {
  assert.equal(
    fingerprint('Hello World', 'Kitchen Echo'),
    fingerprint('hello   world', 'kitchen echo'),
  );
});

test('formatError unwraps AggregateError causes', () => {
  const err = new AggregateError([new Error('timeout'), new Error('dns failed')], 'AggregateError');
  const formatted = formatError(err);
  assert.match(formatted, /timeout/);
  assert.match(formatted, /dns failed/);
});

test('weatherCodeToCondition maps snow and rain codes', () => {
  assert.equal(weatherCodeToCondition(71), 'snowy');
  assert.equal(weatherCodeToCondition(63), 'rainy');
  assert.equal(weatherCodeToCondition(0), 'sunny');
});

test('celsiusToFahrenheit converts correctly', () => {
  assert.equal(celsiusToFahrenheit(0), 32);
  assert.equal(celsiusToFahrenheit(100), 212);
});
