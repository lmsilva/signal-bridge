const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createHouseUsers,
  verifyPassword,
  sanitiseAvatar,
  AVATAR_TEMPLATES,
  LEGACY_AVATAR_IDS,
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

/*
 * Nothing lists the avatars directory: the template array is the only list,
 * and the picker builds `/user/avatars/<id>.svg` straight off it. So a
 * template with no file is a broken image in every picker, and a file no
 * template names is dead weight nobody can choose.
 */
test('every avatar template has its artwork, and no artwork is orphaned', () => {
  const dir = path.join(__dirname, '..', 'src', 'web', 'user', 'avatars');
  const onDisk = fs.readdirSync(dir).filter((name) => name.endsWith('.svg')).sort();
  const wanted = AVATAR_TEMPLATES.map((row) => `${row.id}.svg`).sort();
  assert.deepEqual(onDisk, wanted);

  for (const row of AVATAR_TEMPLATES) {
    const svg = fs.readFileSync(path.join(dir, `${row.id}.svg`), 'utf8');
    // Self-contained and announced: no external fetch, and a name to read out.
    assert.match(svg, /role="img"/, `${row.id} needs role="img"`);
    assert.match(svg, /aria-label="/, `${row.id} needs an aria-label`);
    assert.doesNotMatch(svg, /<script|xlink:href|<image/i, `${row.id} must be self-contained`);
  }

  const labels = AVATAR_TEMPLATES.map((row) => row.label);
  assert.equal(new Set(labels).size, labels.length, 'two templates share a label');
});

/*
 * An id the array does not know falls back rather than erroring, so dropping
 * the old flat icon set would have quietly turned everyone into the first
 * template. The old ids have to keep pointing at a face.
 */
test('an avatar picked from the retired icon set survives as its nearest match', () => {
  for (const [was, now] of Object.entries(LEGACY_AVATAR_IDS)) {
    assert.equal(
      sanitiseAvatar({ kind: 'template', id: was }).id,
      now,
      `${was} should carry over to ${now}`,
    );
    assert.ok(
      AVATAR_TEMPLATES.some((row) => row.id === now),
      `${was} maps to ${now}, which is not a template`,
    );
  }
  assert.equal(sanitiseAvatar({ kind: 'template', id: 'cat-sky' }).id, 'cat-blue');
  // Anything else still falls back, and an upload is left alone.
  assert.equal(sanitiseAvatar({ kind: 'template', id: 'wombat' }).id, AVATAR_TEMPLATES[0].id);
  assert.deepEqual(
    sanitiseAvatar({ kind: 'upload', id: 'abc123.jpg' }),
    { kind: 'upload', id: 'abc123.jpg' },
  );
});

test('a household member keeps a retired avatar through a save', () => {
  const users = createHouseUsers(tempConfig(), silentLog);
  users.ensureBootstrap();
  const created = users.create({ username: 'maya', password: 'household1' });
  const saved = users.update(created.user.id, { avatar: { kind: 'template', id: 'owl-night' } });
  assert.equal(saved.user.avatar.id, 'owl');
  assert.equal(saved.user.avatar.kind, 'template');
});
