const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeCapabilityState } = require('../src/phoenix-state-parse');
const { parsePhoenixState } = require('../src/air-quality-fetch');
const { parsePhoenixIndoorState } = require('../src/indoor-temperature-fetch');

test('normalizeCapabilityState parses JSON capability strings', () => {
  const parsed = normalizeCapabilityState(JSON.stringify({
    namespace: 'Alexa.RangeController',
    name: 'rangeValue',
    value: 18,
    instance: '4',
  }));
  assert.equal(parsed.instance, '4');
  assert.equal(parsed.value, 18);
});

test('parsePhoenixState reads range controller instances from deviceStates', () => {
  const reading = parsePhoenixState({
    deviceStates: [{
      capabilityStates: [
        JSON.stringify({ namespace: 'Alexa.RangeController', name: 'rangeValue', instance: '9', value: 88 }),
        JSON.stringify({ interface: 'Alexa.RangeController', name: 'rangeValue', instance: '4', value: 18 }),
        JSON.stringify({ namespace: 'Alexa.RangeController', name: 'rangeValue', instance: '6', value: 6 }),
        JSON.stringify({ namespace: 'Alexa.RangeController', name: 'rangeValue', instance: '8', value: 1 }),
        JSON.stringify({ namespace: 'Alexa.RangeController', name: 'rangeValue', instance: '5', value: 220 }),
        JSON.stringify({
          namespace: 'Alexa.TemperatureSensor',
          name: 'temperature',
          value: { value: 22.5, scale: 'CELSIUS' },
        }),
      ],
    }],
  });

  assert.equal(reading.iaqScore, 88);
  assert.equal(reading.humidity, 18);
  assert.equal(reading.pm25, 6);
  assert.equal(reading.co, 1);
  assert.equal(reading.voc, 220);
  assert.equal(reading.temperatureF, 72.5);
});

test('parsePhoenixIndoorState reads temperature sensor values', () => {
  const reading = parsePhoenixIndoorState({
    deviceStates: [{
      capabilityStates: [
        {
          name: 'temperature',
          namespace: 'Alexa.TemperatureSensor',
          value: { value: 72.5, scale: 'FAHRENHEIT' },
        },
      ],
    }],
  });

  assert.equal(reading.temperatureF, 72.5);
});
