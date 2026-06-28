const test = require('node:test');
const assert = require('node:assert/strict');
const {
  BroadcastParser,
  extractInlineBroadcastMessage,
  isBroadcastCommandOnly,
  isBroadcastPrompt,
} = require('../src/parser');

function activity(summary, response = '', overrides = {}) {
  return {
    creationTimestamp: Date.now(),
    name: 'Kitchen Echo',
    description: { summary },
    alexaResponse: response,
    data: { recordKey: `test-${summary}-${Date.now()}-${Math.random()}` },
    ...overrides,
  };
}

test('extractInlineBroadcastMessage parses inline announce text', () => {
  assert.equal(
    extractInlineBroadcastMessage('announce dinner is ready'),
    'dinner is ready',
  );
});

test('BroadcastParser captures inline broadcast', () => {
  const parser = new BroadcastParser();
  const record = parser.parseActivity(activity('announce dinner is ready', 'OK'));
  assert.ok(record);
  assert.equal(record.message, 'dinner is ready');
  assert.equal(record.trigger, 'broadcast-inline');
});

test('BroadcastParser handles two-step broadcast follow-up', () => {
  const parser = new BroadcastParser();
  const now = Date.now();
  parser.parseActivity({
    creationTimestamp: now,
    name: 'Kitchen Echo',
    description: { summary: 'broadcast' },
    alexaResponse: "what's the message?",
    data: { recordKey: 'step-1' },
  });

  const record = parser.parseActivity({
    creationTimestamp: now + 1000,
    name: 'Kitchen Echo',
    description: { summary: 'dinner is ready' },
    alexaResponse: 'OK',
    data: { recordKey: 'step-2' },
  });

  assert.ok(record);
  assert.equal(record.message, 'dinner is ready');
  assert.equal(record.trigger, 'broadcast-followup');
});

test('BroadcastParser ignores non-broadcast utterances', () => {
  const parser = new BroadcastParser();
  const record = parser.parseActivity(activity('what time is it', "It's 3 PM"));
  assert.equal(record, null);
});

test('BroadcastParser deduplicates by activity id', () => {
  const parser = new BroadcastParser();
  const item = {
    creationTimestamp: Date.now(),
    name: 'Kitchen Echo',
    description: { summary: 'announce hello world' },
    alexaResponse: 'OK',
    data: { recordKey: 'dup-1' },
  };
  assert.ok(parser.parseActivity(item));
  assert.equal(parser.parseActivity(item), null);
});

test('isBroadcastCommandOnly and isBroadcastPrompt helpers', () => {
  assert.equal(isBroadcastCommandOnly('broadcast'), true);
  assert.equal(isBroadcastPrompt("what's the message?"), true);
});
