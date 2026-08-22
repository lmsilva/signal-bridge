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
  historyPollStartMs,
} = require('../src/parser');
const { isAnnounceCompleteResponse } = require('../src/broadcast-parse');
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

test('parseBroadcastUtterance strips duplicated ASR broadcast echo', () => {
  const parsed = parseBroadcastUtterance(
    'alexa broadcast this is a test, broadcast this is a test',
  );
  assert.equal(parsed.kind, 'inline');
  assert.equal(parsed.message, 'this is a test');
});

test('parseBroadcastUtterance treats broadcast, broadcast as command-only', () => {
  const parsed = parseBroadcastUtterance('broadcast, broadcast');
  assert.equal(parsed.kind, 'command-only');
  assert.equal(parsed.message, null);
});

test('resolveBroadcastUtterance prefers a clean single ASR fragment', () => {
  const {
    resolveBroadcastUtterance,
    cleanBroadcastMessage,
  } = require('../src/broadcast-parse');
  const parsed = resolveBroadcastUtterance(
    'alexa broadcast this is a test, broadcast this is a test',
    ['alexa broadcast this is a test', 'broadcast this is a test'],
  );
  assert.equal(parsed.kind, 'inline');
  assert.equal(parsed.message, 'this is a test');
  assert.equal(cleanBroadcastMessage(', broadcast'), null);
});

test('BroadcastParser captures duplicated-ASR inline as a clean message', () => {
  const parser = new BroadcastParser();
  const record = parser.parseActivity({
    creationTimestamp: Date.now(),
    name: 'Office Echo',
    description: { summary: 'alexa broadcast this is a test' },
    alexaResponse: 'Announcing on all devices',
    data: {
      recordKey: 'dup-asr-1',
      voiceHistoryRecordItems: [
        { recordItemType: 'ASR_REPLACEMENT_TEXT', transcriptText: 'alexa broadcast this is a test' },
        { recordItemType: 'ASR_REPLACEMENT_TEXT', transcriptText: 'broadcast this is a test' },
        { recordItemType: 'TTS_REPLACEMENT_TEXT', transcriptText: 'Announcing on all devices' },
      ],
    },
  });
  assert.ok(record);
  assert.equal(record.message, 'this is a test');
  assert.equal(record.trigger, 'broadcast-inline');
});

test('BroadcastParser does not display verb-only ", broadcast" leftovers', () => {
  const parser = new BroadcastParser();
  const record = parser.parseActivity({
    creationTimestamp: Date.now(),
    name: 'Kitchen Echo',
    description: { summary: 'broadcast, broadcast' },
    alexaResponse: "what's the message?",
    data: { recordKey: 'verb-only-1' },
  });
  assert.equal(record, null);
});

test('BroadcastParser follow-up cleans joined broadcast echo in the message', () => {
  const parser = new BroadcastParser();
  const now = Date.now();
  parser.parseActivity({
    creationTimestamp: now,
    name: 'Kitchen Echo',
    description: { summary: 'broadcast' },
    alexaResponse: "what's the message?",
    data: { recordKey: 'follow-clean-1' },
  });

  const record = parser.parseActivity({
    creationTimestamp: now + 1000,
    name: 'Kitchen Echo',
    description: { summary: 'dinner is ready, broadcast dinner is ready' },
    alexaResponse: 'OK',
    data: { recordKey: 'follow-clean-2' },
  });

  assert.ok(record);
  assert.equal(record.message, 'dinner is ready');
  assert.equal(record.trigger, 'broadcast-followup');
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

test('isAnnounceCompleteResponse matches Alexa completion TTS', () => {
  assert.equal(isAnnounceCompleteResponse('Announcing on all devices'), true);
  assert.equal(isAnnounceCompleteResponse('announcing on all devices.'), true);
  assert.equal(isAnnounceCompleteResponse('heading to the garage'), false);
});

test('cleanBroadcastMessage rejects announce-complete TTS as a household message', () => {
  const { cleanBroadcastMessage } = require('../src/broadcast-parse');
  assert.equal(cleanBroadcastMessage('Announcing on all devices'), null);
  assert.equal(cleanBroadcastMessage('heading to the garage'), 'heading to the garage');
});

test('BroadcastParser does not treat announce-complete TTS as the follow-up message', () => {
  const parser = new BroadcastParser();
  const now = Date.now();
  parser.parseActivity({
    creationTimestamp: now,
    name: 'Kitchen Echo',
    description: { summary: 'alexa broadcast, broadcast' },
    alexaResponse: 'What would you like to announce?',
    data: { recordKey: 'tts-ack-prompt' },
  });

  // Logged 2026-08-22 15:26: empty customer text, TTS-only completion.
  // Falling back to allText used to record "Announcing on all devices".
  const ack = parser.parseActivity({
    creationTimestamp: now + 4000,
    name: 'Kitchen Echo',
    description: { summary: '' },
    alexaResponse: 'Announcing on all devices',
    data: {
      recordKey: 'tts-ack-only',
      voiceHistoryRecordItems: [
        { recordItemType: 'TTS_REPLACEMENT_TEXT', transcriptText: 'Announcing on all devices' },
      ],
    },
  });
  assert.equal(ack, null);

  const record = parser.parseActivity({
    creationTimestamp: now + 8000,
    name: 'Kitchen Echo',
    description: { summary: 'dinner is ready' },
    alexaResponse: 'Announcing on all devices',
    data: { recordKey: 'tts-ack-real-followup' },
  });
  assert.ok(record);
  assert.equal(record.message, 'dinner is ready');
  assert.equal(record.trigger, 'broadcast-followup');
});

test('BroadcastParser pairs a follow-up announced on a different Echo', () => {
  const parser = new BroadcastParser();
  const now = Date.now();
  parser.parseActivity({
    creationTimestamp: now,
    name: 'Movie Theater Bathroom Echo Flex',
    description: { summary: 'alexa broadcast, broadcast' },
    alexaResponse: 'What would you like to announce?',
    data: { recordKey: 'arb-prompt' },
  });

  const record = parser.parseActivity({
    creationTimestamp: now + 11000,
    name: 'Basement Bathroom Echo Flex',
    description: { summary: 'tell me my love can you get dressed lovely' },
    alexaResponse: 'Announcing on all devices',
    data: { recordKey: 'arb-followup' },
  });
  assert.ok(record);
  assert.equal(record.message, 'tell me my love can you get dressed lovely');
  assert.equal(record.trigger, 'broadcast-followup');
});

test('BroadcastParser captures a two-step follow-up after a later one-shot was recorded', () => {
  const parser = new BroadcastParser();
  const tPrompt = 1_787_417_414_882;
  const tOneShot = 1_787_417_426_537;
  const tFollowUp = 1_787_417_420_000;

  parser.parseActivity({
    creationTimestamp: tPrompt,
    name: 'Movie Theater Bathroom Echo Flex',
    description: { summary: 'alexa broadcast, broadcast' },
    alexaResponse: 'What would you like to announce?',
    data: { recordKey: 'seq-prompt' },
  });

  const oneShot = parser.parseActivity({
    creationTimestamp: tOneShot,
    name: 'Basement Bathroom Echo Flex',
    description: { summary: 'alexa broadcast heading to the garage, broadcast heading to the garage' },
    alexaResponse: 'Announcing on all devices',
    data: { recordKey: 'seq-oneshot' },
  });
  assert.ok(oneShot);
  assert.equal(oneShot.message, 'heading to the garage');
  parser.markRecorded('seq-oneshot', oneShot);
  assert.ok(parser.lastRecordedTimestamp >= tOneShot);

  // Same household sequence as 2026-08-22 16:50: lights off (voice query)
  // then two two-step announces, then this one-shot. The earlier follow-up
  // is older than lastRecorded and must still display.
  const followUp = parser.parseActivity({
    creationTimestamp: tFollowUp,
    name: 'Movie Theater Bathroom Echo Flex',
    description: { summary: 'we are heading out' },
    alexaResponse: 'Announcing on all devices',
    data: { recordKey: 'seq-followup' },
  });
  assert.ok(followUp);
  assert.equal(followUp.message, 'we are heading out');
});

test('BroadcastParser captures announce-complete customer text without pending', () => {
  const parser = new BroadcastParser();
  const record = parser.parseActivity({
    creationTimestamp: Date.now(),
    name: 'Bedroom Echo',
    description: { summary: 'tell me my love can you get dressed lovely' },
    alexaResponse: 'Announcing on all devices',
    data: { recordKey: 'ooo-followup' },
  });
  assert.ok(record);
  assert.equal(record.message, 'tell me my love can you get dressed lovely');
  assert.equal(record.trigger, 'broadcast-complete');
});

test('historyPollStartMs keeps a two-minute overlap after last recorded', () => {
  const now = 1_787_417_427_000;
  const lastRecorded = now - 1000;
  const lookbackMs = 2 * 60 * 1000;
  const start = historyPollStartMs(now, lookbackMs, lastRecorded);
  // Previously lastRecorded+1 (~now) hid anything spoken a few seconds earlier.
  // A just-recorded one-shot still fetches the full lookback window.
  assert.equal(start, now - lookbackMs);
  assert.ok(start < lastRecorded);
  assert.ok(start < lastRecorded + 1);
  assert.equal(historyPollStartMs(now, lookbackMs, 0), now - lookbackMs);
  // Periodic 15-min lookback after a capture 37 minutes ago still uses lookback.
  const oldRecorded = now - 37 * 60 * 1000;
  assert.equal(historyPollStartMs(now, 15 * 60 * 1000, oldRecorded), now - 15 * 60 * 1000);
  // After a capture 5 minutes ago, a 15-min poll starts at lastRecorded-2min
  // (overlap), not lastRecorded+1.
  const midRecorded = now - 5 * 60 * 1000;
  assert.equal(historyPollStartMs(now, 15 * 60 * 1000, midRecorded), midRecorded - lookbackMs);
});
