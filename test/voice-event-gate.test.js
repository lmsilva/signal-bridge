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
    needsSpokenResponseUpgrade({ kind: 'music', spokenResponse: '' }),
    true,
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

test('shouldMarkActivityProcessed still defers music until spoken response arrives', () => {
  assert.equal(
    shouldMarkActivityProcessed({ kind: 'music', spokenResponse: null }),
    false,
  );
  assert.equal(
    shouldMarkActivityProcessed({ kind: 'time', spokenResponse: null }),
    true,
  );
});
