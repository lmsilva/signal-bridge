const test = require('node:test');
const assert = require('node:assert/strict');
const { createPendingVoiceResponses } = require('../src/pending-voice-responses');

test('tryComplete attaches orphan battery response to pending tesla query', () => {
  const pending = createPendingVoiceResponses();
  pending.remember({
    kind: 'tesla-battery',
    device: 'Office Echo',
    query: 'show my tesla battery',
    spokenResponse: null,
    trigger: 'tesla-battery-query',
  });

  const activity = { creationTimestamp: Date.now() };
  const completed = pending.tryComplete(
    activity,
    'Your battery is 80 percent',
    {
      getDeviceName: () => 'Office Echo',
      getActivityId: () => 'response-1',
      matchesShoppingListSpeech: () => false,
    },
  );

  assert.equal(completed?.spokenResponse, 'Your battery is 80 percent');
  assert.equal(completed?.trigger, 'tesla-battery-response');
});

test('tryComplete attaches orphan Vivint arm response to pending query', () => {
  const pending = createPendingVoiceResponses();
  pending.remember({
    kind: 'vivint-alarm',
    device: 'Kitchen Echo',
    query: 'ask Vivint to arm',
    spokenResponse: null,
    trigger: 'vivint-alarm-query',
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
});
