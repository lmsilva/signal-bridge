const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseBroadcastUtterance,
  extractInlineBroadcastMessage,
  isBroadcastCommandOnly,
} = require('../src/broadcast-parse');
const {
  BroadcastParser,
  isBroadcastPrompt,
} = require('../src/parser');
const { parseMessageDetails } = require('../src/message-details');
const { buildBroadcastPayload } = require('../src/udp-payload');
const { fingerprint } = require('../src/bridge-state');

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

test('parseBroadcastUtterance splits device target and inline message', () => {
  const parsed = parseBroadcastUtterance('broadcast to office echo this is a test');
  assert.equal(parsed.kind, 'inline');
  assert.equal(parsed.destination, 'office echo');
  assert.equal(parsed.message, 'this is a test');
});

test('parseBroadcastUtterance treats announce to device as command-only', () => {
  const parsed = parseBroadcastUtterance('announce to office echo');
  assert.equal(parsed.kind, 'command-only');
  assert.equal(parsed.destination, 'office echo');
  assert.equal(parsed.message, null);
});

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

test('BroadcastParser captures targeted inline broadcast', () => {
  const parser = new BroadcastParser();
  const record = parser.parseActivity(activity(
    'broadcast to office echo this is a test',
    'OK',
    { name: 'Office Echo' },
  ));
  assert.ok(record);
  assert.equal(record.message, 'this is a test');
  assert.equal(record.destination, 'office echo');
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

test('BroadcastParser handles targeted two-step announce follow-up', () => {
  const parser = new BroadcastParser();
  const now = Date.now();
  parser.parseActivity({
    creationTimestamp: now,
    name: 'Kitchen Echo',
    description: { summary: 'announce to office echo' },
    alexaResponse: "what's the message?",
    data: { recordKey: 'target-step-1' },
  });

  const record = parser.parseActivity({
    creationTimestamp: now + 1000,
    name: 'Kitchen Echo',
    description: { summary: 'this is a test' },
    alexaResponse: 'OK',
    data: { recordKey: 'target-step-2' },
  });

  assert.ok(record);
  assert.equal(record.message, 'this is a test');
  assert.equal(record.destination, 'office echo');
  assert.equal(record.trigger, 'broadcast-followup');
});

test('BroadcastParser does not treat announce to device as immediate message echo', () => {
  const parser = new BroadcastParser();
  const record = parser.parseActivity(activity('announce to office echo', "what's the message?"));
  assert.equal(record, null);
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

test('BroadcastParser content dedup suppresses only within the short window, not forever', () => {
  const parser = new BroadcastParser({ fingerprintFn: fingerprint });
  const now = Date.now();

  const first = parser.parseActivity({
    creationTimestamp: now,
    name: 'Office Echo',
    description: { summary: 'broadcast this is a test' },
    alexaResponse: 'OK',
    data: { recordKey: 'repeat-1' },
  });
  assert.ok(first);
  parser.markRecorded('repeat-1', first);

  // A near-immediate re-report of the *same* utterance (e.g. push event +
  // history poll both surfacing it with different activity ids) is deduped.
  const nearDuplicate = parser.parseActivity({
    creationTimestamp: now + 5000,
    name: 'Office Echo',
    description: { summary: 'broadcast this is a test' },
    alexaResponse: 'OK',
    data: { recordKey: 'repeat-2' },
  });
  assert.equal(nearDuplicate, null);

  // The exact same message from the same device, said again well after the
  // dedup window, must still display — it's a deliberate repeat, not an
  // artifact of duplicate reporting.
  const laterRepeat = parser.parseActivity({
    creationTimestamp: now + 3 * 60 * 1000,
    name: 'Office Echo',
    description: { summary: 'broadcast this is a test' },
    alexaResponse: 'OK',
    data: { recordKey: 'repeat-3' },
  });
  assert.ok(laterRepeat);
  assert.equal(laterRepeat.message, 'this is a test');
});

test('BroadcastParser restores fingerprint timestamps from getState() for later dedup checks', () => {
  const now = Date.now();
  const parser = new BroadcastParser({
    fingerprintFn: fingerprint,
    recordedFingerprints: [{ fp: fingerprint('this is a test', 'Office Echo'), ts: now }],
  });

  assert.equal(parser.isDuplicateContent('this is a test', 'Office Echo', now + 5000), true);
  assert.equal(parser.isDuplicateContent('this is a test', 'Office Echo', now + 3 * 60 * 1000), false);
});

test('BroadcastParser migrates legacy plain-string fingerprints as already expired', () => {
  const now = Date.now();
  const fp = fingerprint('this is a test', 'Office Echo');
  const parser = new BroadcastParser({
    fingerprintFn: fingerprint,
    // Old bridge-state.json stored bare strings with no timestamp.
    recordedFingerprints: [fp],
  });
  // Migrated as ts: 0 → immediately outside the 2-minute window.
  assert.equal(parser.isDuplicateContent('this is a test', 'Office Echo', now), false);
  // Fresh mark still dedupes within the window.
  parser.markRecorded('act-1', {
    message: 'this is a test',
    device: 'Office Echo',
    timestamp: now,
  });
  assert.equal(parser.isDuplicateContent('this is a test', 'Office Echo', now + 1000), true);
});

test('isBroadcastCommandOnly and isBroadcastPrompt helpers', () => {
  assert.equal(isBroadcastCommandOnly('broadcast'), true);
  assert.equal(isBroadcastCommandOnly('announce to office echo'), true);
  assert.equal(isBroadcastCommandOnly('broadcast to office echo this is a test'), false);
  assert.equal(isBroadcastPrompt("what's the message?"), true);
});

test('parseMessageDetails uses explicit destination on record', () => {
  const details = parseMessageDetails({
    message: 'this is a test',
    destination: 'office echo',
    device: 'Kitchen Echo',
  });
  assert.equal(details.destination, 'office echo');
  assert.equal(details.message, 'this is a test');
});

test('buildBroadcastPayload uses explicit destination on record', () => {
  const payload = buildBroadcastPayload({
    message: 'this is a test',
    destination: 'office echo',
    device: 'Kitchen Echo',
    timestamp: Date.parse('2026-06-27T12:00:00.000Z'),
    trigger: 'broadcast-inline',
  }, { udpBroadcast: { defaultDisplaySeconds: 120 } });

  assert.equal(payload.message, 'this is a test');
  assert.equal(payload.destination, 'office echo');
});
