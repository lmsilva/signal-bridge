const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createWebAdminAuth, parseCookies } = require('../src/web-admin-auth');
const { createHouseUsers } = require('../src/house-users');

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

function authWithUsers(password = 's3cret') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-auth-'));
  const config = {
    ROOT: root,
    houseUsersPath: path.join(root, 'users.json'),
    webServer: { adminPassword: password, adminUsername: 'admin', adminSessionHours: 1 },
    env: { ADMIN_PASSWORD: password, ADMIN_USERNAME: 'admin' },
  };
  const houseUsers = createHouseUsers(config, silentLog);
  houseUsers.ensureBootstrap();
  const auth = createWebAdminAuth(config, silentLog, { houseUsers });
  return { auth, houseUsers, config };
}

test('parseCookies reads a simple Cookie header', () => {
  assert.deepEqual(
    parseCookies({ headers: { cookie: 'a=1; signal_session=abc%20123' } }),
    { a: '1', signal_session: 'abc 123' },
  );
});

test('login fails closed when ADMIN_PASSWORD is unset', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-auth-'));
  const auth = createWebAdminAuth({
    ROOT: root,
    houseUsersPath: path.join(root, 'users.json'),
    webServer: { adminPassword: '' },
    env: { ADMIN_PASSWORD: '' },
  }, silentLog);
  assert.equal(auth.isConfigured(), false);
  const result = auth.login({ username: 'admin', password: 'anything' }, { headers: {}, socket: {} });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'admin_password_unset');
  assert.equal(auth.assertAuthorized({ headers: {} }).status, 503);
});

test('login rejects wrong password and accepts username plus password', () => {
  const { auth } = authWithUsers();
  const bad = auth.login({ username: 'admin', password: 'nope' }, { headers: {}, socket: {} });
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 401);

  const good = auth.login({ username: 'admin', password: 's3cret' }, { headers: {}, socket: {} });
  assert.equal(good.ok, true);
  assert.ok(Array.isArray(good.setCookie));
  assert.match(good.setCookie.join('\n'), /signal_session=/);
  assert.match(good.setCookie.join('\n'), /HttpOnly/);
  assert.equal(good.user.username, 'admin');
  assert.equal(good.user.isAdmin, true);

  const req = { headers: { cookie: `signal_session=${good.token}` } };
  assert.equal(auth.assertAuthorized(req).ok, true);
  assert.equal(auth.assertUserAuthorized(req).ok, true);
});

test('legacy signal_admin cookie still unlocks a session', () => {
  const { auth } = authWithUsers();
  const good = auth.login({ username: 'admin', password: 's3cret' }, { headers: {}, socket: {} });
  const req = { headers: { cookie: `signal_admin=${good.token}` } };
  assert.equal(auth.sessionFromRequest(req).ok, true);
});

test('non-admin user can open /user/ but not /admin/', () => {
  const { auth, houseUsers } = authWithUsers();
  houseUsers.create({ username: 'maya', password: 'household1', firstName: 'Maya' });
  const good = auth.login({ username: 'maya', password: 'household1' }, { headers: {}, socket: {} });
  const req = { headers: { cookie: `signal_session=${good.token}` } };
  assert.equal(auth.assertUserAuthorized(req).ok, true);
  const admin = auth.assertAuthorized(req);
  assert.equal(admin.ok, false);
  assert.equal(admin.status, 403);
});

test('inactive users lose their session', () => {
  const { auth, houseUsers } = authWithUsers();
  const created = houseUsers.create({ username: 'kid', password: 'household1' });
  const good = auth.login({ username: 'kid', password: 'household1' }, { headers: {}, socket: {} });
  houseUsers.update(created.user.id, { active: false });
  const req = { headers: { cookie: `signal_session=${good.token}` } };
  assert.equal(auth.sessionFromRequest(req).ok, false);
});

test('logout clears the session', () => {
  const { auth } = authWithUsers();
  const good = auth.login({ username: 'admin', password: 's3cret' }, { headers: {}, socket: {} });
  const req = { headers: { cookie: `signal_session=${good.token}` } };
  assert.equal(auth.sessionFromRequest(req).ok, true);
  const cleared = auth.logout(req);
  assert.match(cleared.setCookie.join('\n'), /Max-Age=0/);
  assert.equal(auth.sessionFromRequest(req).ok, false);
});

test('progressive lockout engages after repeated bad passwords from one IP', () => {
  const { auth } = authWithUsers();
  const req = { headers: {}, socket: { remoteAddress: '10.0.0.42' } };

  const first = auth.login({ username: 'admin', password: 'wrong' }, req);
  assert.equal(first.ok, false);
  assert.equal(first.status, 401);
  assert.equal(first.code, 'bad_password');

  const second = auth.login({ username: 'admin', password: 'wrong' }, req);
  assert.equal(second.status, 401);

  const third = auth.login({ username: 'admin', password: 'wrong' }, req);
  assert.equal(third.ok, false);
  assert.equal(third.status, 429);
  assert.equal(third.code, 'rate_limited');
  assert.equal(third.retryAfterSec, 5);

  const whileLocked = auth.login({ username: 'admin', password: 's3cret' }, req);
  assert.equal(whileLocked.ok, false);
  assert.equal(whileLocked.status, 429);
  assert.equal(auth._sessions.size, 0);
});

test('successful login clears lockout for that IP', () => {
  const { auth } = authWithUsers();
  const req = { headers: {}, socket: { remoteAddress: '10.0.0.99' } };
  auth.login({ username: 'admin', password: 'wrong' }, req);
  auth.login({ username: 'admin', password: 'wrong' }, req);
  const good = auth.login({ username: 'admin', password: 's3cret' }, req);
  assert.equal(good.ok, true);
  assert.equal(auth._loginAttempts.has('10.0.0.99'), false);
  const again = auth.login({ username: 'admin', password: 'wrong' }, req);
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
