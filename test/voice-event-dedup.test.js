const test = require('node:test');
const assert = require('node:assert/strict');
const { createVoiceEventDedup, voiceEventFingerprint } = require('../src/voice-event-dedup');

test('voiceEventFingerprint prefers activity id', () => {
  const fp = voiceEventFingerprint({
    activityId: 'record-123',
    kind: 'tesla-battery',
    device: 'Kitchen Echo',
    query: 'show my tesla battery',
  });
  assert.equal(fp, 'record-123');
});

test('createVoiceEventDedup suppresses repeated events for same activity id', () => {
  const dedup = createVoiceEventDedup({ dedupMs: 60000 });
  const event = {
    activityId: 'a1',
    kind: 'smart-home',
    device: 'Office Echo',
    query: 'lights on',
    spokenResponse: 'Okay',
    timestamp: Date.now(),
  };

  assert.equal(dedup.shouldEmit(event, 1000), true);
  assert.equal(dedup.shouldEmit(event, 5000), false);
  assert.equal(dedup.shouldEmit(event, 70000), true);
});

test('createVoiceEventDedup allows repeat commands with new activity ids', () => {
  const dedup = createVoiceEventDedup({ dedupMs: 60000 });
  const base = {
    kind: 'shopping-list',
    device: 'Office Echo',
    query: 'show my shopping list',
    spokenResponse: 'You have milk on your shopping list',
  };

  assert.equal(dedup.shouldEmit({ ...base, activityId: 'a1' }, 1000), true);
  assert.equal(dedup.shouldEmit({ ...base, activityId: 'a2' }, 2000), true);
});

test('createVoiceEventDedup allows upgrade when spoken response arrives later', () => {
  const dedup = createVoiceEventDedup({ dedupMs: 60000 });
  const base = {
    activityId: 'tesla-1',
    kind: 'tesla-battery',
    device: 'Office Echo',
    query: 'show my tesla battery',
  };

  assert.equal(dedup.shouldEmit({ ...base, spokenResponse: null }, 1000), true);
  assert.equal(
    dedup.shouldEmit({ ...base, spokenResponse: 'Your battery is 80 percent' }, 2000),
    true,
  );
  assert.equal(
    dedup.shouldEmit({ ...base, spokenResponse: 'Your battery is 80 percent' }, 3000),
    false,
  );
});

test('createVoiceEventDedup allows percent upgrade for same activity id', () => {
  const dedup = createVoiceEventDedup({ dedupMs: 60000 });
  const base = {
    activityId: 'tesla-1',
    kind: 'tesla-battery',
    device: 'Office Echo',
    query: 'show my tesla battery',
    spokenResponse: 'Checking your battery',
  };

  assert.equal(dedup.shouldEmit(base, 1000), true);
  assert.equal(
    dedup.shouldEmit({ ...base, spokenResponse: 'Your battery is 80 percent' }, 2000),
    true,
  );
});
