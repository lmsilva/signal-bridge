const test = require('node:test');
const assert = require('node:assert/strict');
const { createWebAdminAuth, parseCookies } = require('../src/web-admin-auth');

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

test('parseCookies reads a simple Cookie header', () => {
  assert.deepEqual(
    parseCookies({ headers: { cookie: 'a=1; signal_admin=abc%20123' } }),
    { a: '1', signal_admin: 'abc 123' },
  );
});

test('login fails closed when ADMIN_PASSWORD is unset', () => {
  const auth = createWebAdminAuth({ webServer: { adminPassword: '' } }, silentLog);
  assert.equal(auth.isConfigured(), false);
  const result = auth.login('anything', { headers: {}, socket: {} });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'admin_password_unset');
  assert.equal(auth.assertAuthorized({ headers: {} }).status, 503);
});

test('login rejects wrong password and accepts the correct one', () => {
  const auth = createWebAdminAuth({
    webServer: { adminPassword: 's3cret', adminSessionHours: 1 },
  }, silentLog);
  const bad = auth.login('nope', { headers: {}, socket: {} });
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 401);

  const good = auth.login('s3cret', { headers: {}, socket: {} });
  assert.equal(good.ok, true);
  assert.match(good.setCookie, /signal_admin=/);
  assert.match(good.setCookie, /HttpOnly/);

  const req = { headers: { cookie: `signal_admin=${good.token}` } };
  assert.equal(auth.assertAuthorized(req).ok, true);
});

test('logout clears the session', () => {
  const auth = createWebAdminAuth({
    webServer: { adminPassword: 's3cret', adminSessionHours: 1 },
  }, silentLog);
  const good = auth.login('s3cret', { headers: {}, socket: {} });
  const req = { headers: { cookie: `signal_admin=${good.token}` } };
  assert.equal(auth.sessionFromRequest(req).ok, true);

  const cleared = auth.logout(req);
  assert.match(cleared.setCookie, /Max-Age=0/);
  assert.equal(auth.sessionFromRequest(req).ok, false);
});

test('progressive lockout engages after repeated bad passwords from one IP', () => {
  const auth = createWebAdminAuth({
    webServer: { adminPassword: 's3cret', adminSessionHours: 1 },
  }, silentLog);
  const req = { headers: {}, socket: { remoteAddress: '10.0.0.42' } };

  const first = auth.login('wrong', req);
  assert.equal(first.ok, false);
  assert.equal(first.status, 401);
  assert.equal(first.code, 'bad_password');

  const second = auth.login('wrong', req);
  assert.equal(second.status, 401);

  const third = auth.login('wrong', req);
  assert.equal(third.ok, false);
  assert.equal(third.status, 429);
  assert.equal(third.code, 'rate_limited');
  assert.equal(third.retryAfterSec, 5);

  const whileLocked = auth.login('s3cret', req);
  assert.equal(whileLocked.ok, false);
  assert.equal(whileLocked.status, 429);
  assert.equal(whileLocked.code, 'rate_limited');
  assert.ok(whileLocked.retryAfterSec >= 1);
  assert.equal(auth._sessions.size, 0);
});

test('successful login clears lockout for that IP', () => {
  const auth = createWebAdminAuth({
    webServer: { adminPassword: 's3cret', adminSessionHours: 1 },
  }, silentLog);
  const req = { headers: {}, socket: { remoteAddress: '10.0.0.99' } };
  auth.login('wrong', req);
  auth.login('wrong', req);
  const good = auth.login('s3cret', req);
  assert.equal(good.ok, true);
  assert.equal(auth._loginAttempts.has('10.0.0.99'), false);

  // Fresh failures start the ladder again (not stuck at prior fail count).
  const again = auth.login('wrong', req);
  assert.equal(again.status, 401);
});

test('lockout ladder matches the documented seconds', () => {
  const { lockoutSecondsForFails, LOCKOUT_LADDER_SEC } = require('../src/web-admin-auth');
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 8].map(lockoutSecondsForFails),
    [0, 0, 5, 15, 60, 300, 900, 900],
  );
  assert.equal(LOCKOUT_LADDER_SEC[LOCKOUT_LADDER_SEC.length - 1], 900);
});

test('client IP prefers X-Forwarded-For first hop', () => {
  const { clientIpFromRequest } = require('../src/web-admin-auth');
  assert.equal(
    clientIpFromRequest({
      headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' },
      socket: { remoteAddress: '127.0.0.1' },
    }),
    '203.0.113.9',
  );
  assert.equal(
    clientIpFromRequest({ headers: {}, socket: { remoteAddress: '::ffff:192.168.1.5' } }),
    '192.168.1.5',
  );
});
