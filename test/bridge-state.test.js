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
  assert.deepEqual(result.recordedFingerprints, [fingerprint('Dinner is ready', 'Kitchen Echo')]);
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

  assert.ok(state.recordedFingerprints.includes(fingerprint('Movie time', 'Office Echo')));
  assert.ok(state.recordedFingerprints.includes(fingerprint('Legacy message', 'Kitchen Echo')));
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
  assert.deepEqual(result.recordedFingerprints, [fingerprint('Hello', 'Kitchen Echo')]);
});
