const test = require('node:test');
const assert = require('node:assert/strict');
const { stateResponseQuality } = require('../src/phoenix-state-parse');
const { buildStateQueries } = require('../src/smarthome-devices');

test('stateResponseQuality ignores empty error-only responses', () => {
  assert.equal(stateResponseQuality({
    deviceStates: [],
    errors: [{ code: 'ENDPOINT_UNREACHABLE' }],
  }), 0);

  assert.equal(stateResponseQuality({
    deviceStates: [{
      capabilityStates: [
        JSON.stringify({ namespace: 'Alexa.RangeController', name: 'rangeValue', instance: '4', value: 18 }),
      ],
    }],
  }), 1);
});

test('buildStateQueries prefers appliance and entity identifiers', () => {
  const queries = buildStateQueries({
    entityId: '00000000-1111-2222-3333-444444444444',
    applianceId: 'AAA_SonarCloudService_example',
    endpointId: 'amzn1.alexa.endpoint.example',
  });

  assert.deepEqual(queries, [
    { entityId: 'AAA_SonarCloudService_example', entityType: 'APPLIANCE' },
    { entityId: '00000000-1111-2222-3333-444444444444', entityType: 'ENTITY' },
    { entityId: '00000000-1111-2222-3333-444444444444', entityType: 'APPLIANCE' },
    { entityId: 'amzn1.alexa.endpoint.example', entityType: 'ENTITY' },
  ]);
});
