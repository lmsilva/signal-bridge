const test = require('node:test');
const assert = require('node:assert/strict');
const {
  needsSpokenResponseUpgrade,
  shouldMarkActivityProcessed,
  hasSpokenResponse,
} = require('../src/voice-event-gate');

test('needsSpokenResponseUpgrade for tesla, music, vivint, notifications, and shopping show without speech', () => {
  assert.equal(
    needsSpokenResponseUpgrade({ kind: 'tesla-battery', spokenResponse: null }),
    true,
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

test('needsSpokenResponseUpgrade stops once Alexa has responded', () => {
  assert.equal(
    needsSpokenResponseUpgrade({
      kind: 'tesla-battery',
      spokenResponse: 'Your battery is 80 percent',
    }),
    false,
  );
});

test('shouldMarkActivityProcessed defers until spoken response arrives', () => {
  assert.equal(
    shouldMarkActivityProcessed({ kind: 'tesla-battery', spokenResponse: null }),
    false,
  );
  assert.equal(
    shouldMarkActivityProcessed({
      kind: 'tesla-battery',
      spokenResponse: 'Your battery is 80 percent',
    }),
    true,
  );
  assert.equal(
    shouldMarkActivityProcessed({ kind: 'time', spokenResponse: null }),
    true,
  );
});

test('hasSpokenResponse treats whitespace as empty', () => {
  assert.equal(hasSpokenResponse({ spokenResponse: '   ' }), false);
  assert.equal(hasSpokenResponse({ spokenResponse: 'milk added' }), true);
});
