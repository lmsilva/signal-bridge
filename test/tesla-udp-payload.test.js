const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildTeslaBatteryPayload } = require('../src/udp-payload');

test('buildTeslaBatteryPayload includes fleet-api battery fields', () => {
  const event = {
    device: 'Kitchen Echo',
    query: 'show tesla battery',
    trigger: 'tesla-battery-query',
    timestamp: '2026-07-08T21:00:00.000Z',
  };
  const battery = {
    percent: 78,
    model: 'Model Y',
    label: 'Battery',
    source: 'fleet-api',
    status: 'ok',
    chargingState: 'Charging',
    chargingLabel: 'Charging',
    batteryRange: 210,
    rangeMiles: 210,
  };

  const payload = buildTeslaBatteryPayload(event, {}, { battery });

  assert.equal(payload.type, 'tesla-battery.query');
  assert.equal(payload.version, 2);
  assert.equal(payload.battery.percent, 78);
  assert.equal(payload.battery.source, 'fleet-api');
  assert.equal(payload.battery.chargingLabel, 'Charging');
  // Display clients need remaining range — both keys for older/newer readers.
  assert.equal(payload.battery.batteryRange, 210);
  assert.equal(payload.battery.rangeMiles, 210);
});

test('buildTeslaBatteryPayload forwards rate-limit error metadata', () => {
  const payload = buildTeslaBatteryPayload(
    { device: 'Office Echo', query: 'show tesla battery' },
    {},
    {
      battery: {
        percent: null,
        model: 'Model Y',
        source: 'fleet-api',
        status: 'rate_limited',
        error: 'Tesla rate limit reached',
        limitResetAt: '2026-07-08T20:30:00-06:00',
      },
    },
  );

  assert.equal(payload.battery.percent, null);
  assert.equal(payload.battery.status, 'rate_limited');
  assert.ok(payload.battery.limitResetAt);
});
