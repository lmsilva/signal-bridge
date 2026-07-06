const test = require('node:test');
const assert = require('node:assert/strict');
const { parseBroadcastUtterance } = require('../src/broadcast-parse');

test('parseBroadcastUtterance handles everywhere target with message', () => {
  const parsed = parseBroadcastUtterance('announce to everywhere hello family');
  assert.equal(parsed.kind, 'inline');
  assert.equal(parsed.destination, 'All devices');
  assert.equal(parsed.message, 'hello family');
});

test('parseBroadcastUtterance handles all devices target without message', () => {
  const parsed = parseBroadcastUtterance('broadcast to all devices');
  assert.equal(parsed.kind, 'command-only');
  assert.equal(parsed.destination, 'All devices');
});
