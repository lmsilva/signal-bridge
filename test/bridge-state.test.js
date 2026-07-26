const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  fingerprint,
  loadBridgeState,
  readBroadcastLog,
  readVoiceEventsLog,
  saveBridgeState,
} = require('../src/bridge-state');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'abb-bridge-state-'));
}

test('readVoiceEventsLog rebuilds fingerprints from broadcast JSONL entries', () => {
  const dir = tempDir();
  const logPath = path.join(dir, 'voice-events.jsonl');
  const lines = [
    JSON.stringify({
      ts: '2026-07-06T12:00:00.000Z',
      type: 'weather.query',
      device: 'Kitchen Echo',
      query: 'what is the weather',
    }),
    JSON.stringify({
      ts: '2026-07-06T12:01:00.000Z',
      type: 'broadcast',
      device: 'Kitchen Echo',
      message: 'Dinner is ready',
      source: 'voice-history',
      trigger: 'history-poll',
    }),
  ];
  fs.writeFileSync(logPath, `${lines.join('\n')}\n`, 'utf8');

  const result = readVoiceEventsLog(logPath);
  assert.equal(result.lastRecordedTimestamp, Date.parse('2026-07-06T12:01:00.000Z'));
  assert.deepEqual(result.recordedFingerprints, [
    { fp: fingerprint('Dinner is ready', 'Kitchen Echo'), ts: Date.parse('2026-07-06T12:01:00.000Z') },
  ]);
});

test('loadBridgeState merges voice-events log and legacy broadcast.txt', () => {
  const dir = tempDir();
  const statePath = path.join(dir, 'bridge-state.json');
  const eventsPath = path.join(dir, 'voice-events.jsonl');
  const legacyPath = path.join(dir, 'broadcast.txt');

  fs.writeFileSync(
    eventsPath,
    `${JSON.stringify({
      ts: '2026-07-06T12:00:00.000Z',
      type: 'broadcast',
      device: 'Office Echo',
      message: 'Movie time',
    })}\n`,
    'utf8',
  );
  fs.writeFileSync(
    legacyPath,
    '2026-07-05T10:00:00.000Z\tLegacy message\tKitchen Echo\tvoice\thistory-poll\n',
    'utf8',
  );

  const state = loadBridgeState(statePath, eventsPath, {
    legacyBroadcastLogPaths: [legacyPath],
  });

  const fps = state.recordedFingerprints.map((entry) => entry.fp);
  assert.ok(fps.includes(fingerprint('Movie time', 'Office Echo')));
  assert.ok(fps.includes(fingerprint('Legacy message', 'Kitchen Echo')));
  assert.equal(state.lastRecordedTimestamp, Date.parse('2026-07-06T12:00:00.000Z'));
});

test('readBroadcastLog still parses tab-separated legacy lines', () => {
  const dir = tempDir();
  const legacyPath = path.join(dir, 'broadcast.txt');
  fs.writeFileSync(
    legacyPath,
    '2026-07-05T10:00:00.000Z\tHello\tKitchen Echo\tvoice\thistory-poll\n',
    'utf8',
  );

  const result = readBroadcastLog(legacyPath);
  assert.equal(result.lastRecordedTimestamp, Date.parse('2026-07-05T10:00:00.000Z'));
  assert.deepEqual(result.recordedFingerprints, [
    { fp: fingerprint('Hello', 'Kitchen Echo'), ts: Date.parse('2026-07-05T10:00:00.000Z') },
  ]);
});

test('saveBridgeState keeps the most recent fingerprints (sorted, capped) with their timestamps', () => {
  const dir = tempDir();
  const statePath = path.join(dir, 'bridge-state.json');
  const now = Date.now();

  saveBridgeState(statePath, {
    lastRecordedTimestamp: now,
    seenActivityIds: ['a', 'b'],
    recordedFingerprints: [
      { fp: 'old|message', ts: now - 100000 },
      { fp: 'new|message', ts: now },
    ],
  });

  const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.deepEqual(saved.recordedFingerprints, [
    { fp: 'new|message', ts: now },
    { fp: 'old|message', ts: now - 100000 },
  ]);
});

test('loadBridgeState round-trips fingerprint timestamps written by saveBridgeState', () => {
  const dir = tempDir();
  const statePath = path.join(dir, 'bridge-state.json');
  const eventsPath = path.join(dir, 'voice-events.jsonl');
  const now = Date.now();

  saveBridgeState(statePath, {
    lastRecordedTimestamp: now,
    seenActivityIds: [],
    recordedFingerprints: [{ fp: fingerprint('this is a test', 'Office Echo'), ts: now }],
  });

  const state = loadBridgeState(statePath, eventsPath, {});
  const entry = state.recordedFingerprints.find((e) => e.fp === fingerprint('this is a test', 'Office Echo'));
  assert.ok(entry);
  assert.equal(entry.ts, now);
});
