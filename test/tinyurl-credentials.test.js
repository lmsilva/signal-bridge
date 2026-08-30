'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  resolveTinyurlToken,
  saveTinyurlToken,
  clearTinyurlToken,
  credentialsStatus,
  scopeEnvName,
} = require('../src/tinyurl-credentials');

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tinyurl-'));
  return path.join(dir, 'tinyurl-credentials.json');
}

test('the four-rung ladder prefers scope env, then override, then global env, then saved', () => {
  const credentialsPath = scratch();
  saveTinyurlToken(credentialsPath, 'global-saved');
  saveTinyurlToken(credentialsPath, 'games-saved', { scope: 'games' });

  assert.equal(resolveTinyurlToken({
    env: { TINYURL_API_TOKEN_GAMES: 'games-env', TINYURL_API_TOKEN: 'global-env' },
    credentialsPath,
    scope: 'games',
  }).token, 'games-env');

  assert.equal(resolveTinyurlToken({
    env: { TINYURL_API_TOKEN: 'global-env' },
    credentialsPath,
    scope: 'games',
  }).token, 'games-saved');

  assert.equal(resolveTinyurlToken({
    env: { TINYURL_API_TOKEN: 'global-env' },
    credentialsPath,
    scope: 'guestbook',
  }).token, 'global-env');

  assert.equal(resolveTinyurlToken({
    env: {},
    credentialsPath,
    scope: 'guestbook',
  }).token, 'global-saved');
});

test('a file that only has token still resolves (backward compatible)', () => {
  const credentialsPath = scratch();
  saveTinyurlToken(credentialsPath, 'legacy-token');
  const raw = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
  assert.ok(raw.token);
  assert.equal(resolveTinyurlToken({ env: {}, credentialsPath }).token, 'legacy-token');
});

test('clearing a scope override leaves the global token', () => {
  const credentialsPath = scratch();
  saveTinyurlToken(credentialsPath, 'global-saved');
  saveTinyurlToken(credentialsPath, 'snaps-saved', { scope: 'guestsnaps' });
  clearTinyurlToken(credentialsPath, { scope: 'guestsnaps' });
  assert.equal(resolveTinyurlToken({ env: {}, credentialsPath, scope: 'guestsnaps' }).token, 'global-saved');
  assert.equal(resolveTinyurlToken({ env: {}, credentialsPath, scope: 'guestsnaps' }).usingGlobal, true);
});

test('credentialsStatus reports usingGlobal and env-wins for a scope', () => {
  const credentialsPath = scratch();
  saveTinyurlToken(credentialsPath, 'global-saved');
  const open = credentialsStatus(credentialsPath, { env: {}, scope: 'games' });
  assert.equal(open.hasToken, true);
  assert.equal(open.usingGlobal, true);
  assert.equal(open.hasOverride, false);

  const blocked = credentialsStatus(credentialsPath, {
    env: { TINYURL_API_TOKEN: 'env' },
    scope: 'games',
  });
  assert.equal(blocked.envBlocksOverwrite, true);
  assert.equal(blocked.tokenSource, 'env');

  assert.equal(scopeEnvName('games'), 'TINYURL_API_TOKEN_GAMES');
});
