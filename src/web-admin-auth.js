/**
 * Password gate for the Signal Bridge /admin control UI.
 *
 * Login form → HTTP-only session cookie. Fail closed when ADMIN_PASSWORD
 * is unset/empty (admin APIs reject; login page explains how to configure).
 *
 * Progressive per-IP lockout on bad passwords (in-memory only — cleared by
 * container recreate / process restart).
 */

const crypto = require('crypto');

const COOKIE_NAME = 'signal_admin';
const DEFAULT_SESSION_HOURS = 12;
/** Lockout seconds after N failures (index = fails after this attempt). */
const LOCKOUT_LADDER_SEC = [0, 0, 5, 15, 60, 300, 900];

function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (left.length !== right.length) {
    // Still compare to keep timing closer for wrong-length guesses.
    crypto.timingSafeEqual(
      crypto.createHash('sha256').update(left).digest(),
      crypto.createHash('sha256').update(right).digest(),
    );
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function parseCookies(req) {
  const header = String(req?.headers?.cookie || '');
  const out = {};
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq === -1) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      // keep raw
    }
    if (key) {
      out[key] = value;
    }
  }
  return out;
}

function normalizeClientIp(raw) {
  let ip = String(raw || '').trim();
  if (!ip) {
    return 'unknown';
  }
  // "192.168.1.5:54321" or "[::1]:54321"
  if (ip.startsWith('[')) {
    const end = ip.indexOf(']');
    if (end > 0) {
      ip = ip.slice(1, end);
    }
  } else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(ip)) {
    ip = ip.replace(/:\d+$/, '');
  }
  if (ip.startsWith('::ffff:')) {
    ip = ip.slice('::ffff:'.length);
  }
  return ip || 'unknown';
}

function clientIpFromRequest(req) {
  const forwarded = String(req?.headers?.['x-forwarded-for'] || '')
    .split(',')[0]
    .trim();
  if (forwarded) {
    return normalizeClientIp(forwarded);
  }
  return normalizeClientIp(req?.socket?.remoteAddress || req?.connection?.remoteAddress);
}

function lockoutSecondsForFails(fails) {
  const n = Math.max(0, Number(fails) || 0);
  if (n <= 0) {
    return 0;
  }
  const idx = Math.min(n, LOCKOUT_LADDER_SEC.length) - 1;
  return LOCKOUT_LADDER_SEC[Math.max(0, idx)];
}

function createWebAdminAuth(config = {}, log = console) {
  const password = String(
    config.webServer?.adminPassword
    ?? process.env.ADMIN_PASSWORD
    ?? '',
  );
  const sessionHours = Math.max(
    1,
    Number(config.webServer?.adminSessionHours || process.env.ADMIN_SESSION_HOURS)
      || DEFAULT_SESSION_HOURS,
  );
  const sessionMs = sessionHours * 60 * 60 * 1000;

  /** @type {Map<string, { expiresAt: number }>} */
  const sessions = new Map();
  /** @type {Map<string, { fails: number, lockedUntil: number }>} */
  const loginAttempts = new Map();

  function isConfigured() {
    return password.length > 0;
  }

  function purgeExpired() {
    const now = Date.now();
    for (const [token, sess] of sessions) {
      if (sess.expiresAt <= now) {
        sessions.delete(token);
      }
    }
  }

  function buildSetCookie(token, { secure = false } = {}) {
    const parts = [
      `${COOKIE_NAME}=${encodeURIComponent(token)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${Math.floor(sessionMs / 1000)}`,
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

  function requestIsSecure(req) {
    if (req?.socket?.encrypted) {
      return true;
    }
    const forwarded = String(req?.headers?.['x-forwarded-proto'] || '').toLowerCase();
    return forwarded === 'https';
  }

  function rateLimitStatus(ip, now = Date.now()) {
    const entry = loginAttempts.get(ip);
    if (!entry || entry.lockedUntil <= now) {
      return null;
    }
    const retryAfterSec = Math.max(1, Math.ceil((entry.lockedUntil - now) / 1000));
    return {
      ok: false,
      status: 429,
      code: 'rate_limited',
      retryAfterSec,
      error: `Too many failed logins — try again in ${retryAfterSec}s`,
    };
  }

  function recordFailedLogin(ip, now = Date.now()) {
    const prev = loginAttempts.get(ip) || { fails: 0, lockedUntil: 0 };
    const fails = prev.fails + 1;
    const lockSec = lockoutSecondsForFails(fails);
    const lockedUntil = lockSec > 0 ? now + lockSec * 1000 : 0;
    loginAttempts.set(ip, { fails, lockedUntil });
    return { fails, lockedUntil, lockSec };
  }

  function clearLoginAttempts(ip) {
    loginAttempts.delete(ip);
  }

  function login(candidatePassword, req) {
    if (!isConfigured()) {
      return {
        ok: false,
        status: 503,
        error: 'Admin password is not configured — set ADMIN_PASSWORD in .env and restart the bridge',
        code: 'admin_password_unset',
      };
    }

    const ip = clientIpFromRequest(req);
    const now = Date.now();
    const limited = rateLimitStatus(ip, now);
    if (limited) {
      // Keep response timing closer to a real password check.
      timingSafeEqualString(candidatePassword, password);
      log.warn?.('Admin login blocked — rate limited', { ip, retryAfterSec: limited.retryAfterSec });
      return limited;
    }

    if (!timingSafeEqualString(candidatePassword, password)) {
      const recorded = recordFailedLogin(ip, now);
      log.warn?.('Admin login failed — incorrect password', {
        ip,
        fails: recorded.fails,
        lockSec: recorded.lockSec,
      });
      const retryAfterSec = recorded.lockSec > 0 ? recorded.lockSec : undefined;
      return {
        ok: false,
        status: recorded.lockSec > 0 ? 429 : 401,
        error: recorded.lockSec > 0
          ? `Incorrect password — try again in ${recorded.lockSec}s`
          : 'Incorrect password',
        code: recorded.lockSec > 0 ? 'rate_limited' : 'bad_password',
        retryAfterSec,
      };
    }

    clearLoginAttempts(ip);
    purgeExpired();
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + sessionMs;
    sessions.set(token, { expiresAt });
    log.info?.('Admin session created', { expiresAt: new Date(expiresAt).toISOString() });
    return {
      ok: true,
      token,
      expiresAt,
      setCookie: buildSetCookie(token, { secure: requestIsSecure(req) }),
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
    purgeExpired();
    if (!isConfigured()) {
      return { ok: false, code: 'admin_password_unset' };
    }
    const token = parseCookies(req)[COOKIE_NAME];
    if (!token) {
      return { ok: false, code: 'no_session' };
    }
    const sess = sessions.get(token);
    if (!sess) {
      return { ok: false, code: 'no_session' };
    }
    if (sess.expiresAt <= Date.now()) {
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
    if (session.code === 'admin_password_unset') {
      return {
        ok: false,
        status: 503,
        error: 'Admin password is not configured — set ADMIN_PASSWORD in .env and restart the bridge',
        code: session.code,
      };
    }
    return {
      ok: false,
      status: 401,
      error: 'Admin login required',
      code: session.code || 'unauthorized',
    };
  }

  return {
    COOKIE_NAME,
    isConfigured,
    login,
    logout,
    sessionFromRequest,
    assertAuthorized,
    clientIpFromRequest,
    // test helpers
    _sessions: sessions,
    _loginAttempts: loginAttempts,
    _lockoutSecondsForFails: lockoutSecondsForFails,
  };
}

module.exports = {
  createWebAdminAuth,
  parseCookies,
  COOKIE_NAME,
  timingSafeEqualString,
  clientIpFromRequest,
  normalizeClientIp,
  lockoutSecondsForFails,
  LOCKOUT_LADDER_SEC,
};
