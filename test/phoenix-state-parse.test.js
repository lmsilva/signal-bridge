const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePhoenixState } = require('../src/air-quality-fetch');
const { parsePhoenixIndoorState } = require('../src/indoor-temperature-fetch');

test('parsePhoenixState reads range controller instances from deviceStates', () => {
  const reading = parsePhoenixState({
    deviceStates: [{
      capabilityStates: [
        { name: 'rangeValue', instance: '9', value: 88 },
        { name: 'rangeValue', instance: '4', value: 18 },
        { name: 'rangeValue', instance: '6', value: 6 },
        { name: 'rangeValue', instance: '8', value: 1 },
        { name: 'rangeValue', instance: '5', value: 220 },
        {
          name: 'temperature',
          namespace: 'Alexa.TemperatureSensor',
          value: { value: 22.5, scale: 'CELSIUS' },
        },
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
