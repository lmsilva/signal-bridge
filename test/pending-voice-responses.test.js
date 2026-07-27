const test = require('node:test');
const assert = require('node:assert/strict');
const { createPendingVoiceResponses } = require('../src/pending-voice-responses');

test('tesla battery queries are not tracked as pending responses', () => {
  const pending = createPendingVoiceResponses();
  pending.remember({
    kind: 'tesla-battery',
    device: 'Office Echo',
    query: 'show tesla battery',
    spokenResponse: null,
    trigger: 'tesla-battery-query',
  });

  const completed = pending.tryComplete(
    { creationTimestamp: Date.now() },
    'Your battery is 80 percent',
    {
      getDeviceName: () => 'Office Echo',
      getActivityId: () => 'response-1',
      matchesShoppingListSpeech: () => false,
    },
  );

  assert.equal(completed, null);
});

test('air-quality asks stay pending so companion weather TTS can be suppressed', () => {
  const pending = createPendingVoiceResponses();
  assert.equal(pending.hasPending('Office Echo', 'air-quality'), false);
  pending.remember({
    kind: 'air-quality',
    device: 'Office Echo',
    query: "what's the indoor air quality",
    trigger: 'air-quality-query',
  });
  assert.equal(pending.hasPending('Office Echo', 'air-quality'), true);
  pending.forget('Office Echo', 'air-quality');
  assert.equal(pending.hasPending('Office Echo', 'air-quality'), false);
});

test('tryComplete attaches orphan Vivint arm response to pending query', () => {
  const pending = createPendingVoiceResponses();
  pending.remember({
    kind: 'vivint-alarm',
    device: 'Kitchen Echo',
    query: 'ask Vivint to arm',
    spokenResponse: null,
    trigger: 'vivint-alarm-query',
    activityId: 'query-vivint',
  });

  const completed = pending.tryComplete(
    { creationTimestamp: Date.now() },
    'your system has been armed stay',
    {
      getDeviceName: () => 'Kitchen Echo',
      getActivityId: () => 'response-vivint',
      matchesShoppingListSpeech: () => false,
    },
  );

  assert.equal(completed?.spokenResponse, 'your system has been armed stay');
  assert.equal(completed?.trigger, 'vivint-alarm-response');
  assert.equal(completed?.activityId, 'response-vivint');
  assert.equal(completed?.sourceActivityId, 'query-vivint');
});

test('tryComplete attaches orphan route miles TTS to pending distance query', () => {
  const pending = createPendingVoiceResponses();
  const defaultLocation = { name: 'Home', latitude: 40.35, longitude: -111.9 };
  pending.remember({
    kind: 'route',
    device: 'Office Echo',
    query: "what's the distance from saratoga springs utah",
    spokenResponse: null,
    trigger: 'route-query',
    activityId: 'query-route',
  });

  const spoken = 'Los Angeles is about 564 miles from Saratoga Springs, Utah as the crow flies.';
  const completed = pending.tryComplete(
    { creationTimestamp: Date.now() },
    spoken,
    {
      getDeviceName: () => 'Office Echo',
      getActivityId: () => 'response-route',
      matchesShoppingListSpeech: () => false,
      defaultLocation,
    },
  );

  assert.equal(completed?.spokenResponse, spoken);
  assert.equal(completed?.trigger, 'route-response');
  assert.equal(completed?.activityId, 'response-route');
  assert.equal(completed?.sourceActivityId, 'query-route');
});
