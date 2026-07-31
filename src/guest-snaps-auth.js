/**
 * Rotating 6-digit PIN gate for the Guest Snaps booth (`/`).
 *
 * - PIN regenerated every 24h and persisted under data/guest-snaps-pin.json
 * - HttpOnly session cookie until that PIN expires (rotate → re-auth)
 * - Progressive per-IP lockout on bad PINs (same ladder as admin login)
 *
 * The PIN is shown on the display via guest.photobooth — never returned to
 * phone APIs (login/request-pin/session).
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  parseCookies,
  timingSafeEqualString,
  clientIpFromRequest,
  lockoutSecondsForFails,
  LOCKOUT_LADDER_SEC,
} = require('./web-admin-auth');

const COOKIE_NAME = 'signal_guest';
const DEFAULT_PIN_DIGITS = 6;
const DEFAULT_PIN_TTL_MS = 24 * 60 * 60 * 1000;
const ACCESS_PIN_HINT = 'Enter this PIN on your phone';

function createGuestSnapsAuth(config = {}, log = console) {
  const cfg = config.guestSnapsAuth || config.webServer?.guestSnapsAuth || {};
  const enabled = cfg.enabled !== false;
  const pinDigits = Math.min(8, Math.max(4, Number(cfg.pinDigits) || DEFAULT_PIN_DIGITS));
  const pinTtlMs = Math.max(
    60_000,
    Number(cfg.pinTtlMs) || Number(cfg.pinTtlHours) * 60 * 60 * 1000 || DEFAULT_PIN_TTL_MS,
  );
  const root = config.ROOT || path.join(__dirname, '..');
  const pinPath = path.resolve(
    cfg.pinPath
    || config.guestSnapsPinPath
    || path.join(root, 'data', 'guest-snaps-pin.json'),
  );

  /** @type {{ pin: string, issuedAt: number, expiresAt: number, generation: string } | null} */
  let current = null;
  /** @type {Map<string, { expiresAt: number, generation: string }>} */
  const sessions = new Map();
  /** @type {Map<string, { fails: number, lockedUntil: number }>} */
  const loginAttempts = new Map();
  /** Separate ladder for Request PIN spam (same shape, own map). */
  /** @type {Map<string, { fails: number, lockedUntil: number }>} */
  const requestAttempts = new Map();

  function isConfigured() {
    return enabled;
  }

  function ensurePinDir() {
    fs.mkdirSync(path.dirname(pinPath), { recursive: true });
  }

  function loadPinFromDisk() {
    try {
      const raw = JSON.parse(fs.readFileSync(pinPath, 'utf8'));
      const pin = String(raw?.pin || '').replace(/\D/g, '');
      const issuedAt = Number(raw?.issuedAt) || 0;
      const expiresAt = Number(raw?.expiresAt) || 0;
      const generation = String(raw?.generation || '').trim()
        || (issuedAt ? `gen-${issuedAt}` : '');
      if (pin.length === pinDigits && expiresAt > Date.now() && generation) {
        current = { pin, issuedAt, expiresAt, generation };
        return current;
      }
    } catch {
      // missing or corrupt — regenerate
    }
    current = null;
    return null;
  }

  function persistPin(record) {
    ensurePinDir();
    const tmp = `${pinPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, pinPath);
  }

  function generatePin() {
    const max = 10 ** pinDigits;
    const n = crypto.randomInt(0, max);
    return String(n).padStart(pinDigits, '0');
  }

  function ensureCurrentPin() {
    if (!enabled) {
      return null;
    }
    if (current && current.expiresAt > Date.now()) {
      return current;
    }
    const fromDisk = loadPinFromDisk();
    if (fromDisk) {
      return fromDisk;
    }
    const issuedAt = Date.now();
    const expiresAt = issuedAt + pinTtlMs;
    const generation = crypto.randomBytes(8).toString('hex');
    current = {
      pin: generatePin(),
      issuedAt,
      expiresAt,
      generation,
    };
    persistPin(current);
    // Drop sessions bound to a previous generation.
    for (const [token, sess] of sessions) {
      if (sess.generation !== current.generation) {
        sessions.delete(token);
      }
    }
    log.info?.('Guest Snaps PIN rotated', {
      expiresAt: new Date(expiresAt).toISOString(),
      pinDigits,
    });
    return current;
  }

  function getPublicPinInfo() {
    const record = ensureCurrentPin();
    if (!record) {
      return { pinDigits, expiresAt: null, configured: false };
    }
    return {
      pinDigits,
      expiresAt: new Date(record.expiresAt).toISOString(),
      configured: true,
    };
  }

  /** For UDP / display overlay only — never send to the phone. */
  function getPinForDisplay() {
    const record = ensureCurrentPin();
    if (!record) {
      return null;
    }
    return {
      accessPin: record.pin,
      accessPinHint: ACCESS_PIN_HINT,
      expiresAt: record.expiresAt,
      generation: record.generation,
    };
  }

  function purgeExpiredSessions() {
    const now = Date.now();
    const record = current && current.expiresAt > now ? current : loadPinFromDisk();
    for (const [token, sess] of sessions) {
      if (sess.expiresAt <= now) {
        sessions.delete(token);
        continue;
      }
      if (record && sess.generation !== record.generation) {
        sessions.delete(token);
      }
    }
  }

  function requestIsSecure(req) {
    if (req?.socket?.encrypted) {
      return true;
    }
    const forwarded = String(req?.headers?.['x-forwarded-proto'] || '').toLowerCase();
    return forwarded === 'https';
  }

  function buildSetCookie(token, expiresAt, { secure = false } = {}) {
    const maxAge = Math.max(1, Math.floor((expiresAt - Date.now()) / 1000));
    const parts = [
      `${COOKIE_NAME}=${encodeURIComponent(token)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${maxAge}`,
    ];
    if (secure) {
      parts.push('Secure');
    }
    return parts.join('; ');
  }

  function buildClearCookie({ secure = false } = {}) {
    const parts = [
      `${COOKIE_NAME}=`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      'Max-Age=0',
    ];
    if (secure) {
      parts.push('Secure');
    }
    return parts.join('; ');
  }

  function rateLimitStatus(map, ip, now = Date.now()) {
    const entry = map.get(ip);
    if (!entry || entry.lockedUntil <= now) {
      return null;
    }
    const retryAfterSec = Math.max(1, Math.ceil((entry.lockedUntil - now) / 1000));
    return {
      ok: false,
      status: 429,
      code: 'rate_limited',
      retryAfterSec,
      error: `Too many failed attempts — try again in ${retryAfterSec}s`,
    };
  }

  function recordFailedAttempt(map, ip, now = Date.now()) {
    const prev = map.get(ip) || { fails: 0, lockedUntil: 0 };
    const fails = prev.fails + 1;
    const lockSec = lockoutSecondsForFails(fails);
    const lockedUntil = lockSec > 0 ? now + lockSec * 1000 : 0;
    map.set(ip, { fails, lockedUntil });
    return { fails, lockedUntil, lockSec };
  }

  function login(candidatePin, req) {
    if (!enabled) {
      return {
        ok: false,
        status: 503,
        code: 'guest_auth_disabled',
        error: 'Guest Snaps PIN auth is disabled',
      };
    }

    const ip = clientIpFromRequest(req);
    const now = Date.now();
    const limited = rateLimitStatus(loginAttempts, ip, now);
    if (limited) {
      const record = ensureCurrentPin();
      timingSafeEqualString(candidatePin, record?.pin || '000000');
      log.warn?.('Guest Snaps login blocked — rate limited', {
        ip,
        retryAfterSec: limited.retryAfterSec,
      });
      return limited;
    }

    const record = ensureCurrentPin();
    const entered = String(candidatePin || '').replace(/\D/g, '');
    if (!record || !timingSafeEqualString(entered, record.pin)) {
      const recorded = recordFailedAttempt(loginAttempts, ip, now);
      log.warn?.('Guest Snaps login failed — incorrect PIN', {
        ip,
        fails: recorded.fails,
        lockSec: recorded.lockSec,
      });
      return {
        ok: false,
        status: recorded.lockSec > 0 ? 429 : 401,
        error: recorded.lockSec > 0
          ? `Incorrect PIN — try again in ${recorded.lockSec}s`
          : 'Incorrect PIN',
        code: recorded.lockSec > 0 ? 'rate_limited' : 'bad_pin',
        retryAfterSec: recorded.lockSec > 0 ? recorded.lockSec : undefined,
      };
    }

    loginAttempts.delete(ip);
    purgeExpiredSessions();
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = record.expiresAt;
    sessions.set(token, { expiresAt, generation: record.generation });
    log.info?.('Guest Snaps session created', {
      expiresAt: new Date(expiresAt).toISOString(),
    });
    return {
      ok: true,
      token,
      expiresAt,
      setCookie: buildSetCookie(token, expiresAt, { secure: requestIsSecure(req) }),
    };
  }

  function logout(req) {
    const cookies = parseCookies(req);
    const token = cookies[COOKIE_NAME];
    if (token) {
      sessions.delete(token);
    }
    return {
      ok: true,
      setCookie: buildClearCookie({ secure: requestIsSecure(req) }),
    };
  }

  function sessionFromRequest(req) {
    purgeExpiredSessions();
    if (!enabled) {
      return { ok: false, code: 'guest_auth_disabled' };
    }
    const token = parseCookies(req)[COOKIE_NAME];
    if (!token) {
      return { ok: false, code: 'no_session' };
    }
    const sess = sessions.get(token);
    if (!sess) {
      return { ok: false, code: 'no_session' };
    }
    const record = ensureCurrentPin();
    if (!record || sess.generation !== record.generation || sess.expiresAt <= Date.now()) {
      sessions.delete(token);
      return { ok: false, code: 'expired' };
    }
    return { ok: true, expiresAt: sess.expiresAt };
  }

  function assertAuthorized(req) {
    const session = sessionFromRequest(req);
    if (session.ok) {
      return session;
    }
    return {
      ok: false,
      status: 401,
      error: 'Guest Snaps PIN required',
      code: session.code || 'unauthorized',
    };
  }

  /**
   * Rate-limit Request PIN abuse (windowed, not the login fail ladder).
   * Returns public meta + display pin for UDP — phone JSON must omit `display`.
   */
  function beginRequestPin(req) {
    if (!enabled) {
      return {
        ok: false,
        status: 503,
        code: 'guest_auth_disabled',
        error: 'Guest Snaps PIN auth is disabled',
      };
    }
    const ip = clientIpFromRequest(req);
    const now = Date.now();
    const limited = rateLimitStatus(requestAttempts, ip, now);
    if (limited) {
      return limited;
    }
    const prev = requestAttempts.get(ip) || { fails: 0, lockedUntil: 0, windowStart: 0 };
    if (!prev.windowStart || now - prev.windowStart > 120_000) {
      prev.fails = 0;
      prev.windowStart = now;
    }
    prev.fails += 1;
    // More than 8 pushes in 2 minutes → 60s cooldown.
    if (prev.fails > 8) {
      prev.lockedUntil = now + 60_000;
      requestAttempts.set(ip, prev);
      return {
        ok: false,
        status: 429,
        code: 'rate_limited',
        retryAfterSec: 60,
        error: 'Too many PIN requests — try again in 60s',
      };
    }
    requestAttempts.set(ip, prev);
    const record = ensureCurrentPin();
    return {
      ok: true,
      expiresAt: new Date(record.expiresAt).toISOString(),
      pinDigits,
      display: getPinForDisplay(),
    };
  }

  return {
    COOKIE_NAME,
    ACCESS_PIN_HINT,
    pinDigits,
    pinPath,
    isConfigured,
    ensureCurrentPin,
    getPublicPinInfo,
    getPinForDisplay,
    login,
    logout,
    sessionFromRequest,
    assertAuthorized,
    beginRequestPin,
    clientIpFromRequest,
    // test helpers
    _sessions: sessions,
    _loginAttempts: loginAttempts,
    _requestAttempts: requestAttempts,
    _current: () => current,
    _setCurrentForTest(record) {
      current = record;
      if (record) {
        persistPin(record);
      }
    },
    _lockoutSecondsForFails: lockoutSecondsForFails,
  };
}

module.exports = {
  createGuestSnapsAuth,
  COOKIE_NAME,
  DEFAULT_PIN_DIGITS,
  DEFAULT_PIN_TTL_MS,
  ACCESS_PIN_HINT,
  LOCKOUT_LADDER_SEC,
};
