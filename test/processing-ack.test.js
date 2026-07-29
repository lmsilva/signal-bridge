const test = require('node:test');
const assert = require('node:assert/strict');
const { buildProcessingAckPayload } = require('../src/udp-payload');

const config = { udpBroadcast: { defaultDisplaySeconds: 120 } };

test('buildProcessingAckPayload builds ack for tesla battery', () => {
  const payload = buildProcessingAckPayload({
    kind: 'tesla-battery',
    device: 'Office Echo',
    timestamp: Date.parse('2026-07-11T17:00:00.000Z'),
    query: 'show tesla battery',
  }, config);

  assert.ok(payload);
  assert.equal(payload.type, 'request.processing');
  assert.equal(payload.version, 2);
  assert.equal(payload.device, 'Office Echo');
  assert.equal(payload.kind, 'tesla-battery');
  assert.equal(payload.request.title, 'Tesla Battery');
  assert.equal(payload.request.source, 'Tesla Fleet API');
  assert.ok(payload.request.timeoutSeconds >= 30);
  assert.ok(payload.displaySeconds > payload.request.timeoutSeconds);
  assert.ok(Array.isArray(payload.request.stages));
  assert.ok(payload.request.stages.length >= 3);
  assert.equal(payload.request.stages[0].afterSec, 0);
  assert.ok(payload.request.stages[0].message);
});

test('buildProcessingAckPayload builds ack for tesla dashboard', () => {
  const payload = buildProcessingAckPayload({
    kind: 'tesla-dashboard',
    device: 'Kitchen Echo',
    timestamp: Date.now(),
    query: 'show tesla dashboard',
  }, config);

  assert.ok(payload);
  assert.equal(payload.request.title, 'Tesla Dashboard');
});

test('buildProcessingAckPayload builds ack for music', () => {
  const payload = buildProcessingAckPayload({
    kind: 'music',
    device: 'Signal',
    timestamp: Date.now(),
    query: "what's playing",
  }, config);

  assert.ok(payload);
  assert.equal(payload.type, 'request.processing');
  assert.equal(payload.kind, 'music');
  assert.equal(payload.request.title, 'Now Playing');
  assert.ok(payload.request.stages.length >= 2);
});

test('buildProcessingAckPayload route uses its own timeoutSeconds', () => {
  const payload = buildProcessingAckPayload({
    kind: 'route',
    device: 'Office Echo',
    query: 'how far is Moab from here',
  }, config);

  assert.ok(payload);
  assert.equal(payload.kind, 'route');
  assert.equal(payload.request.title, 'Route Planner');
  assert.equal(payload.request.timeoutSeconds, 90);
  assert.equal(payload.displaySeconds, 105);
});

test('buildProcessingAckPayload skips fast request kinds', () => {
  for (const kind of ['weather', 'time', 'shopping-list', 'smart-home']) {
    assert.equal(
      buildProcessingAckPayload({ kind, device: 'Echo', query: 'q' }, config),
      null,
      `expected no ack for ${kind}`,
    );
  }
});

test('processing ack stage thresholds increase monotonically', () => {
  const payload = buildProcessingAckPayload({
    kind: 'tesla-dashboard',
    device: 'Echo',
    query: 'show tesla dashboard',
  }, config);

  const thresholds = payload.request.stages.map((stage) => stage.afterSec);
  for (let i = 1; i < thresholds.length; i += 1) {
    assert.ok(thresholds[i] > thresholds[i - 1]);
  }
});
