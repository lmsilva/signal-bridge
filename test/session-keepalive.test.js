const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULTS,
  isRefreshNoopFailure,
  needsStaleTokenWatchdog,
  pickRefreshReason,
} = require('../src/session-keepalive');

test('isRefreshNoopFailure detects Amazon register noop', () => {
  assert.equal(isRefreshNoopFailure('No tokens in Register response'), true);
  assert.equal(isRefreshNoopFailure('401 Unauthorized'), false);
});

test('needsStaleTokenWatchdog triggers at configured token age', () => {
  assert.equal(needsStaleTokenWatchdog({ tokenAgeHours: 17 }), false);
  assert.equal(needsStaleTokenWatchdog({ tokenAgeHours: 18 }), true);
  assert.equal(needsStaleTokenWatchdog({ tokenAgeHours: 24 }, 20), true);
});

test('pickRefreshReason prefers stale watchdog over scheduled refresh', () => {
  const settings = { staleTokenWatchdogHours: DEFAULTS.staleTokenWatchdogHours };
  const reason = pickRefreshReason({ tokenAgeHours: 20 }, settings, {
    shouldProactive: true,
    shouldScheduled: true,
  });
  assert.equal(reason, 'stale-token-watchdog');
});

test('pickRefreshReason uses proactive refresh before scheduled', () => {
  const settings = { staleTokenWatchdogHours: DEFAULTS.staleTokenWatchdogHours };
  const reason = pickRefreshReason({ tokenAgeHours: 10 }, settings, {
    shouldProactive: true,
    shouldScheduled: true,
  });
  assert.equal(reason, 'proactive-age');
});
