const test = require('node:test');
const assert = require('node:assert/strict');
const {
  needsSpokenResponseUpgrade,
  shouldMarkActivityProcessed,
} = require('../src/voice-event-gate');

test('needsSpokenResponseUpgrade for music, vivint, notifications, and shopping show without speech', () => {
  assert.equal(
    needsSpokenResponseUpgrade({ kind: 'tesla-battery', spokenResponse: null }),
    false,
  );
  assert.equal(
    needsSpokenResponseUpgrade({ kind: 'music', trigger: 'music-play', spokenResponse: '' }),
    true,
  );
  assert.equal(
    needsSpokenResponseUpgrade({ kind: 'music', trigger: 'music-query', spokenResponse: '' }),
    false,
  );
  assert.equal(
    needsSpokenResponseUpgrade({ kind: 'vivint-alarm', spokenResponse: null }),
    true,
  );
  assert.equal(
    needsSpokenResponseUpgrade({ kind: 'alexa-notifications', spokenResponse: null }),
    true,
  );
  assert.equal(
    needsSpokenResponseUpgrade({
      kind: 'shopping-list',
      trigger: 'shopping-list-show',
      spokenResponse: null,
    }),
    true,
  );
});

test('tesla dashboard processes immediately without Alexa spoken response', () => {
  assert.equal(
    shouldMarkActivityProcessed({ kind: 'tesla-dashboard', spokenResponse: null }),
    true,
  );
});

test('indoor query with unmatched location waits for the spoken response', () => {
  assert.equal(
    needsSpokenResponseUpgrade({
      kind: 'indoor-temperature',
      query: "what's the temperature in palmyra",
      spokenResponse: null,
    }),
    true,
  );
});

test('indoor query with a known room processes immediately', () => {
  assert.equal(
    needsSpokenResponseUpgrade({
      kind: 'indoor-temperature',
      query: "what's the temperature in guest bedroom",
      spokenResponse: null,
    }),
    false,
  );
});

test('shouldMarkActivityProcessed still defers music-play until spoken response arrives', () => {
  assert.equal(
    shouldMarkActivityProcessed({ kind: 'music', trigger: 'music-play', spokenResponse: null }),
    false,
  );
  assert.equal(
    shouldMarkActivityProcessed({ kind: 'music', trigger: 'music-query', spokenResponse: null }),
    true,
  );
  assert.equal(
    shouldMarkActivityProcessed({ kind: 'time', spokenResponse: null }),
    true,
  );
});
