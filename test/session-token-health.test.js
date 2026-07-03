const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isRefreshDeferralMessage,
  isCookieRenewFailure,
  tokenDateAdvanced,
} = require('../src/session-token-health');

test('isRefreshDeferralMessage ignores refresh already in flight', () => {
  assert.equal(isRefreshDeferralMessage('refresh already in flight'), true);
  assert.equal(isRefreshDeferralMessage('Cookie invalid'), false);
});

test('isCookieRenewFailure detects Alexa renew errors', () => {
  assert.equal(isCookieRenewFailure('Cookie invalid, Renew unsuccessful'), true);
});

test('tokenDateAdvanced detects newer tokenDate', () => {
  const previous = { tokenDate: '2026-07-01T05:16:08.954Z' };
  const next = { tokenDate: '2026-07-03T02:21:29.598Z' };
  assert.equal(tokenDateAdvanced(previous, next), true);
  assert.equal(tokenDateAdvanced(next, previous), false);
});
