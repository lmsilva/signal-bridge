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
