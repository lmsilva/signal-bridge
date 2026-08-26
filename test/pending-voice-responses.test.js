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

test('tryComplete rejects orphan route miles TTS on a different device', () => {
  const pending = createPendingVoiceResponses();
  pending.remember({
    kind: 'route',
    device: 'Office Echo',
    query: "what's the distance from here to Los Angeles",
    spokenResponse: null,
    trigger: 'route-query',
    activityId: 'query-route',
  });

  const completed = pending.tryComplete(
    { creationTimestamp: Date.now() },
    'Los Angeles is about 564 miles from Saratoga Springs, Utah as the crow flies.',
    {
      getDeviceName: () => 'Kitchen Echo',
      getActivityId: () => 'response-other',
      matchesShoppingListSpeech: () => false,
      defaultLocation: { name: 'Home', latitude: 40.35, longitude: -111.9 },
    },
  );
  assert.equal(completed, null);
  assert.equal(pending.hasPending('Office Echo', 'route'), true);
});

test('pending route expires after TTL and is not completed', () => {
  const pending = createPendingVoiceResponses({ ttlMs: 1000 });
  const t0 = 1_700_000_000_000;
  pending.remember({
    kind: 'route',
    device: 'Office Echo',
    query: "what's the distance from here to Los Angeles",
    spokenResponse: null,
    trigger: 'route-query',
    activityId: 'query-route',
  }, t0);

  assert.equal(pending.hasPending('Office Echo', 'route', t0 + 500), true);
  assert.equal(pending.hasPending('Office Echo', 'route', t0 + 2000), false);

  const completed = pending.tryComplete(
    { creationTimestamp: t0 + 2500 },
    'Los Angeles is about 564 miles from Saratoga Springs, Utah as the crow flies.',
    {
      getDeviceName: () => 'Office Echo',
      getActivityId: () => 'response-late',
      matchesShoppingListSpeech: () => false,
      defaultLocation: { name: 'Home', latitude: 40.35, longitude: -111.9 },
    },
    t0 + 2500,
  );
  assert.equal(completed, null);
});

test('tryComplete attaches delivery detail to pending Amazon Shopping intro', () => {
  const pending = createPendingVoiceResponses();
  pending.remember({
    kind: 'alexa-notifications',
    device: 'Master Bathroom Echo',
    query: "You have one new notification from Amazon Shopping.",
    spokenResponse: "You have one new notification from Amazon Shopping.",
    trigger: 'amazon-delivery-passive',
    activityId: 'intro-delivery',
  });

  const detail = 'Your package was delivered today and left on the porch.';
  const completed = pending.tryComplete(
    { creationTimestamp: Date.now() },
    detail,
    {
      getDeviceName: () => 'Master Bathroom Echo',
      getActivityId: () => 'detail-delivery',
      matchesShoppingListSpeech: () => false,
    },
  );

  assert.equal(completed?.spokenResponse, detail);
  assert.equal(completed?.trigger, 'amazon-delivery-response');
  assert.equal(completed?.sourceActivityId, 'intro-delivery');
});

test('tryComplete clears pending delivery on dismissal TTS', () => {
  const pending = createPendingVoiceResponses();
  pending.remember({
    kind: 'alexa-notifications',
    device: 'Master Bathroom Echo',
    query: "You've got one new notification from Amazon Shopping.",
    spokenResponse: "You've got one new notification from Amazon Shopping.",
    trigger: 'amazon-delivery-passive',
    activityId: 'intro-delivery',
  });

  const completed = pending.tryComplete(
    { creationTimestamp: Date.now() },
    "Alright, no problem. That's all your notifications.",
    {
      getDeviceName: () => 'Master Bathroom Echo',
      getActivityId: () => 'dismiss-delivery',
      matchesShoppingListSpeech: () => false,
    },
  );

  assert.equal(completed, null);
  assert.equal(pending.hasPending('Master Bathroom Echo', 'amazon-delivery-passive'), false);
});
