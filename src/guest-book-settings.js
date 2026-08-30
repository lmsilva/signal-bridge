/**
 * Guest Book settings — alias, send mode, rates, pause.
 *
 * Token lives in tinyurl-credentials.js. Link state lives in shortlinks.js.
 * Password is stored as scrypt (no bcrypt in this repo).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FALLBACK = {
  enabled: true,
  paused: false,
  preferredAlias: '',
  whoCanSend: 'anyone',
  passwordHash: '',
  rateLimitEnabled: true,
  ratePerGuest: 3,
  rateWindowMinutes: 10,
  dailyCap: 100,
  blockedWordsEnabled: false,
  blockedWords: [],
  approval: false,
  inviteFooter: 'whenRoom',
  guestsMayWake: false,
};

const ALIAS_RE = /^[A-Za-z0-9]{5,10}$/;
const WHO = new Set(['anyone', 'password', 'code']);
const INVITE_FOOTER_MODES = new Set(['always', 'whenRoom']);

/** Legacy boolean true → whenRoom; false/off kept as off for older settings files. */
function normaliseInviteFooter(value) {
  if (value === 'always') return 'always';
  if (value === false || value === 'off') return 'off';
  return 'whenRoom';
}

function sanitiseAlias(value, { required = false } = {}) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) {
    if (required) {
      throw new Error('Preferred alias is required');
    }
    return '';
  }
  if (!ALIAS_RE.test(raw)) {
    throw new Error('Preferred alias must be 5–10 letters or digits');
  }
  return raw.toUpperCase();
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(n)));
}

function hashPassword(password) {
  const secret = String(password || '');
  if (!secret) {
    return '';
  }
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(secret, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const raw = String(stored || '');
  const parts = raw.split('$');
  if (parts[0] !== 'scrypt' || parts.length < 3) {
    return false;
  }
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  if (!salt.length || expected.length !== 64) {
    return false;
  }
  const actual = crypto.scryptSync(String(password || ''), salt, 64);
  return crypto.timingSafeEqual(actual, expected);
}

function sanitiseSettings(raw = {}, base = FALLBACK) {
  const merged = { ...base, ...(raw || {}) };
  const who = String(merged.whoCanSend || 'anyone').trim().toLowerCase();
  const words = Array.isArray(merged.blockedWords)
    ? merged.blockedWords.map((word) => String(word || '').trim()).filter(Boolean)
    : [];
  return {
    enabled: merged.enabled !== false,
    paused: Boolean(merged.paused),
    preferredAlias: sanitiseAlias(merged.preferredAlias),
    whoCanSend: WHO.has(who) ? who : 'anyone',
    passwordHash: String(merged.passwordHash || ''),
    rateLimitEnabled: merged.rateLimitEnabled !== false,
    ratePerGuest: clampInt(merged.ratePerGuest, 1, 20, FALLBACK.ratePerGuest),
    rateWindowMinutes: clampInt(merged.rateWindowMinutes, 1, 60, FALLBACK.rateWindowMinutes),
    dailyCap: clampInt(merged.dailyCap, 1, 1000, FALLBACK.dailyCap),
    blockedWordsEnabled: Boolean(merged.blockedWordsEnabled),
    blockedWords: words.slice(0, 200),
    approval: Boolean(merged.approval),
    inviteFooter: normaliseInviteFooter(merged.inviteFooter),
    guestsMayWake: Boolean(merged.guestsMayWake),
  };
}

function publicSettings(settings = {}) {
  const next = { ...settings };
  delete next.passwordHash;
  next.hasPassword = Boolean(settings.passwordHash);
  return next;
}

function createGuestBookSettings(config = {}, log = console) {
  const settingsPath = config.guestBookSettingsPath
    || path.resolve(config.ROOT || path.resolve(__dirname, '..'), 'data', 'guest-book-settings.json');
  let current = { ...FALLBACK };

  function load() {
    try {
      if (!fs.existsSync(settingsPath)) {
        current = { ...FALLBACK };
        return current;
      }
      current = sanitiseSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8')));
    } catch (error) {
      log?.warn?.('Could not read Guest Book settings', error?.message || error);
      current = { ...FALLBACK };
    }
    return current;
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
    } catch (error) {
      log?.warn?.('Could not save Guest Book settings', error?.message || error);
    }
  }

  load();

  return {
    get() {
      load();
      return { ...current };
    },
    public() {
      return publicSettings(this.get());
    },
    update(patch = {}) {
      const next = { ...current, ...patch };
      if (Object.prototype.hasOwnProperty.call(patch, 'password')) {
        const password = String(patch.password || '');
        next.passwordHash = password ? hashPassword(password) : current.passwordHash;
        delete next.password;
      }
      if (patch.clearPassword) {
        next.passwordHash = '';
      }
      current = sanitiseSettings(next, current);
      save();
      return { ...current };
    },
    reload: load,
    path: settingsPath,
  };
}

module.exports = {
  FALLBACK,
  ALIAS_RE,
  INVITE_FOOTER_MODES,
  normaliseInviteFooter,
  sanitiseAlias,
  sanitiseSettings,
  hashPassword,
  verifyPassword,
  publicSettings,
  createGuestBookSettings,
};
