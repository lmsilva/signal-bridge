const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createHouseUsers,
  verifyPassword,
  DEFAULT_ADMIN_USERNAME,
} = require('../src/house-users');

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

function tempConfig(extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'house-users-'));
  return {
    ROOT: root,
    houseUsersPath: path.join(root, 'house-users.json'),
    webServer: { adminUsername: 'admin', adminPassword: 's3cret-admin' },
    env: { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 's3cret-admin' },
    ...extra,
  };
}

test('bootstrap admin is created from ADMIN_USERNAME and ADMIN_PASSWORD', () => {
  const users = createHouseUsers(tempConfig(), silentLog);
  const result = users.ensureBootstrap();
  assert.equal(result.ok, true);
  const admin = users.getByUsername('admin');
  assert.ok(admin);
  assert.equal(admin.isAdmin, true);
  assert.equal(admin.active, true);
  assert.equal(admin.username, DEFAULT_ADMIN_USERNAME);
  assert.equal(users.verifyLogin('admin', 's3cret-admin').ok, true);
});

test('env password change updates the bootstrap user', () => {
  const config = tempConfig();
  const first = createHouseUsers(config, silentLog);
  first.ensureBootstrap();
  const again = createHouseUsers({
    ...config,
    webServer: { adminUsername: 'admin', adminPassword: 'new-secret-99' },
    env: { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'new-secret-99' },
  }, silentLog);
  again.ensureBootstrap();
  assert.equal(again.verifyLogin('admin', 's3cret-admin').ok, false);
  assert.equal(again.verifyLogin('admin', 'new-secret-99').ok, true);
});

test('create user stores a scrypt hash and never returns it', () => {
  const users = createHouseUsers(tempConfig(), silentLog);
  users.ensureBootstrap();
  const created = users.create({
    username: 'luis',
    email: 'luis@example.com',
    firstName: 'Luis',
    lastName: 'S',
    password: 'household1',
    permissions: { flightPlan: true },
  });
  assert.equal(created.ok, true);
  assert.equal(created.user.username, 'luis');
  assert.equal(created.user.permissions.flightPlan, true);
  assert.equal(created.user.permissions.slideshow, false);
  assert.equal(created.user.passwordHash, undefined);
  const stored = users.getByUsername('luis');
  assert.ok(verifyPassword('household1', stored.passwordHash));
  assert.equal(users.verifyLogin('luis', 'household1').ok, true);
});

test('inactive users cannot log in', () => {
  const users = createHouseUsers(tempConfig(), silentLog);
  users.ensureBootstrap();
  const created = users.create({ username: 'kid', password: 'household1' });
  users.update(created.user.id, { active: false });
  const login = users.verifyLogin('kid', 'household1');
  assert.equal(login.ok, false);
  assert.equal(login.code, 'inactive');
});

test('bootstrap admin cannot be demoted or deactivated', () => {
  const users = createHouseUsers(tempConfig(), silentLog);
  users.ensureBootstrap();
  const admin = users.getByUsername('admin');
  assert.equal(admin.firstName, 'Admin');
  assert.equal(users.publicUser(admin).bootstrap, true);
  assert.equal(users.update(admin.id, { active: false }).ok, false);
  assert.equal(users.update(admin.id, { isAdmin: false }).ok, false);
  assert.equal(users.update(admin.id, { email: 'admin@example.com' }).ok, false);
  assert.equal(users.resetPassword(admin.id).ok, false);
  const named = users.update(admin.id, { firstName: 'House', lastName: 'Host' });
  assert.equal(named.ok, true);
  assert.equal(named.user.firstName, 'House');
  assert.equal(named.user.lastName, 'Host');
  assert.equal(named.user.bootstrap, true);
});

test('bootstrap first name defaults to Admin when blank', () => {
  const config = tempConfig();
  const first = createHouseUsers(config, silentLog);
  first.ensureBootstrap();
  const stored = first.getByUsername('admin');
  stored.firstName = '';
  first.update(stored.id, { firstName: '' });
  const again = createHouseUsers(config, silentLog);
  again.ensureBootstrap();
  assert.equal(again.getByUsername('admin').firstName, 'Admin');
});

test('isAdmin grants every feature permission', () => {
  const users = createHouseUsers(tempConfig(), silentLog);
  users.ensureBootstrap();
  const created = users.create({
    username: 'host',
    password: 'household1',
    isAdmin: true,
    permissions: { flightPlan: false },
  });
  assert.equal(created.user.permissions.flightPlan, true);
  assert.equal(created.user.permissions.redLetter, true);
  assert.equal(users.canAccess(users.getById(created.user.id), 'slideshow'), true);
});

test('password reset token works once', () => {
  const users = createHouseUsers(tempConfig(), silentLog);
  users.ensureBootstrap();
  users.create({ username: 'maya', email: 'maya@example.com', password: 'household1' });
  const reset = users.beginPasswordReset('maya@example.com');
  assert.equal(reset.ok, true);
  assert.equal(reset.sent, true);
  const consumed = users.consumePasswordReset(reset.token, 'brandnew99');
  assert.equal(consumed.ok, true);
  assert.equal(users.verifyLogin('maya', 'brandnew99').ok, true);
  assert.equal(users.consumePasswordReset(reset.token, 'anotherone').ok, false);
});
