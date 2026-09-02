/**
 * Household user store — accounts, scrypt passwords, avatars, dashboards.
 *
 * Bootstrap admin comes from ADMIN_USERNAME (default "admin") + ADMIN_PASSWORD.
 * The env password stays the source of truth for that user so a compose .env
 * change cannot lock the house out.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createSecretBox } = require('./secret-box');

const DEFAULT_ADMIN_USERNAME = 'admin';
const RESET_TTL_MS = 60 * 60 * 1000;
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The built-in faces, in picker order. Every `id` is also the filename in
 * `web/user/avatars/<id>.svg`, and `color` is the top of that tile's gradient
 * — the picker paints from the file, but the colour is what anything drawing
 * a user without their artwork (a chip, a placeholder) can fall back on.
 */
const AVATAR_TEMPLATES = Object.freeze([
  { id: 'cat-blue', label: 'Sky cat', animal: 'cat', color: '#5bc4f2' },
  { id: 'cat-pink', label: 'Coral cat', animal: 'cat', color: '#ff8fa0' },
  { id: 'bunny', label: 'Cloud bunny', animal: 'bunny', color: '#c9b8f5' },
  { id: 'raccoon', label: 'Meadow raccoon', animal: 'raccoon', color: '#4fd69a' },
  { id: 'panda', label: 'Ink panda', animal: 'panda', color: '#8a94a6' },
  { id: 'red-panda', label: 'Ruby red panda', animal: 'red panda', color: '#ff6e61' },
  { id: 'fox', label: 'Ember fox', animal: 'fox', color: '#ffb35c' },
  { id: 'bear', label: 'Amber bear', animal: 'bear', color: '#ffc24a' },
  { id: 'polar-bear', label: 'Frost polar bear', animal: 'polar bear', color: '#3ed6e0' },
  { id: 'mouse', label: 'Lilac mouse', animal: 'mouse', color: '#c0a6f7' },
  { id: 'hamster', label: 'Honey hamster', animal: 'hamster', color: '#ffaf54' },
  { id: 'frog', label: 'Moss frog', animal: 'frog', color: '#a6e24a' },
  { id: 'owl', label: 'Night owl', animal: 'owl', color: '#7c6cf0' },
  { id: 'chick', label: 'Sun chick', animal: 'chick', color: '#ffd43d' },
  { id: 'koala', label: 'Mint koala', animal: 'koala', color: '#7fd4c1' },
  { id: 'penguin', label: 'Ocean penguin', animal: 'penguin', color: '#5fa8f5' },
]);

/**
 * The flat icon set the sticker set replaced. Without this every household
 * member who had picked one would silently come back as whoever sits first in
 * the list, because an unknown id falls back rather than erroring. Each old id
 * points at the nearest new face; the two otters have no successor of their
 * own, so they go to the tiles that kept their colour.
 */
const LEGACY_AVATAR_IDS = Object.freeze({
  'cat-sky': 'cat-blue',
  'cat-peach': 'cat-pink',
  'raccoon-mint': 'raccoon',
  'raccoon-dusk': 'raccoon',
  'otter-sand': 'bear',
  'otter-sea': 'polar-bear',
  'mouse-lilac': 'mouse',
  'mouse-honey': 'hamster',
  'fox-ember': 'fox',
  'bunny-cloud': 'bunny',
  'panda-ink': 'panda',
  'frog-moss': 'frog',
  'owl-night': 'owl',
  'chick-sun': 'chick',
});

function defaultUsersPath(root) {
  return path.resolve(root || path.resolve(__dirname, '..'), 'data', 'house-users.json');
}

function hashPassword(password) {
  const secret = String(password || '');
  if (!secret) return '';
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(secret, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const raw = String(stored || '');
  const parts = raw.split('$');
  if (parts[0] !== 'scrypt' || parts.length < 3) return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  if (!salt.length || expected.length !== 64) return false;
  const actual = crypto.scryptSync(String(password || ''), salt, 64);
  return crypto.timingSafeEqual(actual, expected);
}

function generatePassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(12);
  let out = '';
  for (const byte of bytes) {
    out += alphabet[byte % alphabet.length];
  }
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}`;
}

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function emptyPermissions() {
  return { flightPlan: false, slideshow: false, redLetter: false };
}

function sanitisePermissions(raw = {}, { isAdmin = false } = {}) {
  if (isAdmin) {
    return { flightPlan: true, slideshow: true, redLetter: true };
  }
  return {
    flightPlan: raw.flightPlan === true,
    slideshow: raw.slideshow === true,
    redLetter: raw.redLetter === true,
  };
}

function sanitiseAvatar(raw = {}) {
  const kind = raw.kind === 'upload' ? 'upload' : 'template';
  const id = String(raw.id || '').trim();
  if (kind === 'template') {
    const wanted = LEGACY_AVATAR_IDS[id] || id;
    const known = AVATAR_TEMPLATES.some((row) => row.id === wanted);
    return { kind: 'template', id: known ? wanted : AVATAR_TEMPLATES[0].id };
  }
  return { kind: 'upload', id: id || '' };
}

function sanitiseDashboard(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const tiles = [];
  for (const row of raw) {
    const id = typeof row === 'string' ? row : String(row?.id || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    tiles.push({ id, order: tiles.length });
  }
  return tiles;
}

function publicUser(user, { adminUsername } = {}) {
  if (!user) return null;
  const bootstrap = Boolean(
    user.bootstrap === true
    || (adminUsername && user.username === adminUsername),
  );
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    active: user.active !== false,
    isAdmin: user.isAdmin === true,
    bootstrap,
    permissions: sanitisePermissions(user.permissions, { isAdmin: user.isAdmin === true }),
    avatar: sanitiseAvatar(user.avatar),
    dashboardTiles: sanitiseDashboard(user.dashboardTiles),
    createdAt: user.createdAt || null,
    updatedAt: user.updatedAt || null,
    lastLoginAt: user.lastLoginAt || null,
  };
}

function actorFromUser(user) {
  if (!user) return { kind: 'system', userId: null, name: 'System' };
  const name = String(user.firstName || user.username || 'User').trim();
  return {
    kind: 'user',
    userId: user.id,
    name,
    isAdmin: user.isAdmin === true,
  };
}

function createHouseUsers(config = {}, log = console) {
  const usersPath = path.resolve(
    config.houseUsersPath || defaultUsersPath(config.ROOT),
  );
  const env = config.env || process.env;
  const box = createSecretBox({
    keyPath: path.resolve(path.dirname(usersPath), 'secret.key'),
    env,
  });
  const adminUsername = normalizeUsername(
    config.webServer?.adminUsername || env.ADMIN_USERNAME || DEFAULT_ADMIN_USERNAME,
  ) || DEFAULT_ADMIN_USERNAME;
  const adminPassword = String(
    config.webServer?.adminPassword || env.ADMIN_PASSWORD || '',
  );

  function emptyFile() {
    return { users: [], updatedAt: null };
  }

  function readFile() {
    try {
      const raw = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
      if (!raw || typeof raw !== 'object') return emptyFile();
      const users = Array.isArray(raw.users) ? raw.users.map(decryptUser) : [];
      return { users, updatedAt: raw.updatedAt || null };
    } catch {
      return emptyFile();
    }
  }

  function decryptUser(row) {
    const next = { ...row };
    if (next.passwordHash && box.isEncrypted(next.passwordHash)) {
      next.passwordHash = box.decrypt(next.passwordHash) || '';
    }
    if (next.resetTokenHash && box.isEncrypted(next.resetTokenHash)) {
      next.resetTokenHash = box.decrypt(next.resetTokenHash) || '';
    }
    return next;
  }

  function encryptUser(row) {
    return {
      ...row,
      passwordHash: row.passwordHash ? box.encrypt(row.passwordHash) : '',
      resetTokenHash: row.resetTokenHash ? box.encrypt(row.resetTokenHash) : '',
    };
  }

  function writeFile(data) {
    fs.mkdirSync(path.dirname(usersPath), { recursive: true });
    const payload = {
      users: data.users.map(encryptUser),
      updatedAt: new Date().toISOString(),
    };
    const tmp = `${usersPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    fs.renameSync(tmp, usersPath);
  }

  function load() {
    return readFile();
  }

  function save(users) {
    writeFile({ users });
  }

  function toPublic(user) {
    return publicUser(user, { adminUsername });
  }

  function list() {
    return load().users.map(toPublic);
  }

  function getById(id) {
    const needle = String(id || '');
    return load().users.find((row) => row.id === needle) || null;
  }

  function getByUsername(username) {
    const needle = normalizeUsername(username);
    return load().users.find((row) => row.username === needle) || null;
  }

  function getByEmail(email) {
    const needle = normalizeEmail(email);
    if (!needle) return null;
    return load().users.find((row) => row.email === needle) || null;
  }

  function isBootstrap(user) {
    return Boolean(user && user.username === adminUsername);
  }

  function ensureBootstrap() {
    if (!adminPassword) {
      return { ok: false, code: 'admin_password_unset' };
    }
    const data = load();
    const existing = data.users.find((row) => row.username === adminUsername);
    const now = new Date().toISOString();
    if (!existing) {
      data.users.push({
        id: crypto.randomBytes(8).toString('hex'),
        username: adminUsername,
        email: '',
        firstName: 'Admin',
        lastName: '',
        active: true,
        isAdmin: true,
        permissions: sanitisePermissions({}, { isAdmin: true }),
        avatar: sanitiseAvatar({}),
        dashboardTiles: [],
        passwordHash: hashPassword(adminPassword),
        resetTokenHash: '',
        resetTokenExpiresAt: null,
        createdAt: now,
        updatedAt: now,
        lastLoginAt: null,
        bootstrap: true,
      });
      save(data.users);
      log?.info?.('Household admin user created', { username: adminUsername });
      return { ok: true, created: true };
    }
    let dirty = false;
    if (!String(existing.firstName || '').trim()) {
      existing.firstName = 'Admin';
      dirty = true;
    }
    if (existing.bootstrap !== true) {
      existing.bootstrap = true;
      dirty = true;
    }
    const nextHash = hashPassword(adminPassword);
    if (!verifyPassword(adminPassword, existing.passwordHash)) {
      existing.passwordHash = nextHash;
      existing.active = true;
      existing.isAdmin = true;
      existing.updatedAt = now;
      dirty = true;
      log?.info?.('Household admin password synced from environment', { username: adminUsername });
    } else if (!existing.isAdmin || existing.active === false) {
      existing.isAdmin = true;
      existing.active = true;
      existing.updatedAt = now;
      dirty = true;
    }
    if (dirty) save(data.users);
    return { ok: true, created: false };
  }

  function validateCreate(payload = {}) {
    const username = normalizeUsername(payload.username);
    if (!USERNAME_RE.test(username)) {
      return { ok: false, error: 'Username must be 2–32 letters, digits, dots, underscores or hyphens' };
    }
    if (getByUsername(username)) {
      return { ok: false, error: 'That username is already taken' };
    }
    const email = normalizeEmail(payload.email);
    if (email && !EMAIL_RE.test(email)) {
      return { ok: false, error: 'Email address looks invalid' };
    }
    if (email && getByEmail(email)) {
      return { ok: false, error: 'That email is already in use' };
    }
    return { ok: true, username, email };
  }

  function create(payload = {}) {
    const check = validateCreate(payload);
    if (!check.ok) return check;
    const password = String(payload.password || '').trim() || generatePassword();
    if (password.length < 8) {
      return { ok: false, error: 'Password must be at least 8 characters' };
    }
    const now = new Date().toISOString();
    const isAdmin = payload.isAdmin === true;
    const user = {
      id: crypto.randomBytes(8).toString('hex'),
      username: check.username,
      email: check.email,
      firstName: String(payload.firstName || '').trim().slice(0, 40),
      lastName: String(payload.lastName || '').trim().slice(0, 40),
      active: payload.active !== false,
      isAdmin,
      permissions: sanitisePermissions(payload.permissions, { isAdmin }),
      avatar: sanitiseAvatar(payload.avatar),
      dashboardTiles: sanitiseDashboard(payload.dashboardTiles),
      passwordHash: hashPassword(password),
      resetTokenHash: '',
      resetTokenExpiresAt: null,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: null,
      bootstrap: false,
    };
    const data = load();
    data.users.push(user);
    save(data.users);
    return { ok: true, user: toPublic(user), password: payload.password ? undefined : password };
  }

  function update(id, payload = {}) {
    const data = load();
    const user = data.users.find((row) => row.id === String(id || ''));
    if (!user) return { ok: false, error: 'User not found' };
    if (isBootstrap(user)) {
      if (payload.username != null && normalizeUsername(payload.username) !== user.username) {
        return { ok: false, error: 'The environment admin username is set by ADMIN_USERNAME' };
      }
      if (payload.email != null && normalizeEmail(payload.email) !== normalizeEmail(user.email)) {
        return { ok: false, error: 'The environment admin email cannot be changed here' };
      }
      if (payload.active === false) {
        return { ok: false, error: 'The environment admin cannot be deactivated' };
      }
      if (payload.isAdmin === false) {
        return { ok: false, error: 'The environment admin always stays an admin' };
      }
      if (payload.permissions && (
        payload.permissions.flightPlan === false
        || payload.permissions.slideshow === false
        || payload.permissions.redLetter === false
      )) {
        return { ok: false, error: 'The environment admin permissions cannot be changed' };
      }
      if (payload.firstName != null) user.firstName = String(payload.firstName || '').trim().slice(0, 40);
      if (payload.lastName != null) user.lastName = String(payload.lastName || '').trim().slice(0, 40);
      if (payload.avatar) user.avatar = sanitiseAvatar(payload.avatar);
      if (payload.dashboardTiles) user.dashboardTiles = sanitiseDashboard(payload.dashboardTiles);
      user.updatedAt = new Date().toISOString();
      save(data.users);
      return { ok: true, user: toPublic(user) };
    }
    if (payload.username != null) {
      const username = normalizeUsername(payload.username);
      if (!USERNAME_RE.test(username)) {
        return { ok: false, error: 'Username must be 2–32 letters, digits, dots, underscores or hyphens' };
      }
      const clash = data.users.find((row) => row.username === username && row.id !== user.id);
      if (clash) return { ok: false, error: 'That username is already taken' };
      if (isBootstrap(user) && username !== adminUsername) {
        return { ok: false, error: 'The bootstrap admin username is set by ADMIN_USERNAME' };
      }
      user.username = username;
    }
    if (payload.email != null) {
      const email = normalizeEmail(payload.email);
      if (email && !EMAIL_RE.test(email)) {
        return { ok: false, error: 'Email address looks invalid' };
      }
      const clash = email && data.users.find((row) => row.email === email && row.id !== user.id);
      if (clash) return { ok: false, error: 'That email is already in use' };
      user.email = email;
    }
    if (payload.firstName != null) user.firstName = String(payload.firstName || '').trim().slice(0, 40);
    if (payload.lastName != null) user.lastName = String(payload.lastName || '').trim().slice(0, 40);
    if (payload.active != null) {
      if (isBootstrap(user) && payload.active === false) {
        return { ok: false, error: 'The bootstrap admin cannot be deactivated' };
      }
      user.active = payload.active !== false;
    }
    if (payload.isAdmin != null) {
      if (isBootstrap(user) && payload.isAdmin === false) {
        return { ok: false, error: 'The bootstrap admin always stays an admin' };
      }
      user.isAdmin = payload.isAdmin === true;
    }
    if (payload.permissions) {
      user.permissions = sanitisePermissions(payload.permissions, { isAdmin: user.isAdmin });
    } else {
      user.permissions = sanitisePermissions(user.permissions, { isAdmin: user.isAdmin });
    }
    if (payload.avatar) user.avatar = sanitiseAvatar(payload.avatar);
    if (payload.dashboardTiles) user.dashboardTiles = sanitiseDashboard(payload.dashboardTiles);
    user.updatedAt = new Date().toISOString();
    save(data.users);
    return { ok: true, user: toPublic(user) };
  }

  function setPassword(id, password, { generated = false } = {}) {
    const secret = String(password || '');
    if (secret.length < 8) {
      return { ok: false, error: 'Password must be at least 8 characters' };
    }
    const data = load();
    const user = data.users.find((row) => row.id === String(id || ''));
    if (!user) return { ok: false, error: 'User not found' };
    if (isBootstrap(user)) {
      return { ok: false, error: 'The environment admin password is set by ADMIN_PASSWORD' };
    }
    user.passwordHash = hashPassword(secret);
    user.resetTokenHash = '';
    user.resetTokenExpiresAt = null;
    user.updatedAt = new Date().toISOString();
    save(data.users);
    return { ok: true, user: toPublic(user), password: generated ? secret : undefined };
  }

  function resetPassword(id) {
    return setPassword(id, generatePassword(), { generated: true });
  }

  function verifyLogin(username, password) {
    ensureBootstrap();
    const user = getByUsername(username);
    if (!user) return { ok: false, code: 'bad_credentials' };
    if (user.active === false) return { ok: false, code: 'inactive' };
    if (!verifyPassword(password, user.passwordHash)) {
      return { ok: false, code: 'bad_credentials' };
    }
    return { ok: true, user };
  }

  function markLogin(id) {
    const data = load();
    const user = data.users.find((row) => row.id === String(id || ''));
    if (!user) return;
    user.lastLoginAt = new Date().toISOString();
    save(data.users);
  }

  function beginPasswordReset(email) {
    const user = getByEmail(email);
    if (!user || user.active === false || isBootstrap(user)) {
      return { ok: true, sent: false };
    }
    const token = crypto.randomBytes(24).toString('hex');
    const data = load();
    const live = data.users.find((row) => row.id === user.id);
    live.resetTokenHash = crypto.createHash('sha256').update(token).digest('hex');
    live.resetTokenExpiresAt = new Date(Date.now() + RESET_TTL_MS).toISOString();
    live.updatedAt = new Date().toISOString();
    save(data.users);
    return { ok: true, sent: true, user: toPublic(live), token, expiresAt: live.resetTokenExpiresAt };
  }

  function consumePasswordReset(token, password) {
    const hash = crypto.createHash('sha256').update(String(token || '')).digest('hex');
    const data = load();
    const user = data.users.find((row) => row.resetTokenHash === hash);
    if (!user) return { ok: false, error: 'Reset link is invalid or expired' };
    if (!user.resetTokenExpiresAt || Date.parse(user.resetTokenExpiresAt) < Date.now()) {
      return { ok: false, error: 'Reset link is invalid or expired' };
    }
    return setPassword(user.id, password);
  }

  function canAccess(user, permission) {
    if (!user || user.active === false) return false;
    if (user.isAdmin) return true;
    return user.permissions?.[permission] === true;
  }

  return {
    usersPath,
    adminUsername,
    AVATAR_TEMPLATES,
    ensureBootstrap,
    isConfigured: () => Boolean(adminPassword),
    list,
    getById,
    getByUsername,
    getByEmail,
    create,
    update,
    setPassword,
    resetPassword,
    generatePassword,
    verifyLogin,
    markLogin,
    beginPasswordReset,
    consumePasswordReset,
    publicUser: toPublic,
    actorFromUser,
    canAccess,
    isBootstrap,
  };
}

module.exports = {
  createHouseUsers,
  hashPassword,
  verifyPassword,
  generatePassword,
  publicUser,
  actorFromUser,
  sanitisePermissions,
  sanitiseAvatar,
  sanitiseDashboard,
  AVATAR_TEMPLATES,
  LEGACY_AVATAR_IDS,
  DEFAULT_ADMIN_USERNAME,
  USERNAME_RE,
};
