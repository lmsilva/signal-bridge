const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMessageDetails } = require('../src/message-details');
const { buildBroadcastPayload } = require('../src/udp-payload');

const config = {
  udpBroadcast: { defaultDisplaySeconds: 120 },
};

test('parseMessageDetails extracts destination and message', () => {
  const details = parseMessageDetails({
    message: 'to living room please hurry',
    device: 'Kitchen Echo',
  });
  assert.equal(details.sender, 'Kitchen Echo');
  assert.equal(details.destination, 'living room');
  assert.equal(details.message, 'please hurry');
});

test('buildBroadcastPayload keeps backward-compatible message field and adds type', () => {
  const payload = buildBroadcastPayload({
    message: 'to everywhere hello family',
    device: 'Office Echo',
    timestamp: Date.parse('2026-06-27T12:00:00.000Z'),
    trigger: 'broadcast-inline',
  }, config);

  assert.equal(payload.version, 2);
  assert.equal(payload.type, 'broadcast');
  assert.equal(payload.message, 'hello family');
  assert.equal(payload.sender, 'Office Echo');
  assert.equal(payload.destination, 'All devices');
  assert.equal(payload.displaySeconds, 120);
});
