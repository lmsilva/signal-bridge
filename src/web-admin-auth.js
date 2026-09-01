/**
 * Household session gate for /admin and /user.
 *
 * Username + password → HTTP-only cookies (`signal_session`, plus legacy
 * `signal_admin`). Fail closed when ADMIN_PASSWORD is unset.
 *
 * Progressive per-IP lockout on bad passwords (in-memory only — cleared by
 * container recreate / process restart).
 */

const crypto = require('crypto');
const { createHouseUsers, actorFromUser } = require('./house-users');

const COOKIE_NAME = 'signal_session';
const LEGACY_COOKIE_NAME = 'signal_admin';
const DEFAULT_SESSION_HOURS = 12;
/** Lockout seconds after N failures (index = fails after this attempt). */
const LOCKOUT_LADDER_SEC = [0, 0, 5, 15, 60, 300, 900];

function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (left.length !== right.length) {
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
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      // keep raw
    }
    if (key) out[key] = value;
  }
  return out;
}

function normalizeClientIp(raw) {
  let ip = String(raw || '').trim();
  if (!ip) return 'unknown';
  if (ip.startsWith('[')) {
    const end = ip.indexOf(']');
    if (end > 0) ip = ip.slice(1, end);
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
  if (forwarded) return normalizeClientIp(forwarded);
  return normalizeClientIp(req?.socket?.remoteAddress || req?.connection?.remoteAddress);
}

function lockoutSecondsForFails(fails) {
  const n = Math.max(0, Number(fails) || 0);
  if (n <= 0) return 0;
  const idx = Math.min(n, LOCKOUT_LADDER_SEC.length) - 1;
  return LOCKOUT_LADDER_SEC[Math.max(0, idx)];
}

function createWebAdminAuth(config = {}, log = console, deps = {}) {
  const houseUsers = deps.houseUsers || createHouseUsers(config, log);
  const sessionHours = Math.max(
    1,
    Number(config.webServer?.adminSessionHours || process.env.ADMIN_SESSION_HOURS)
      || DEFAULT_SESSION_HOURS,
  );
  const sessionMs = sessionHours * 60 * 60 * 1000;

  /** @type {Map<string, { expiresAt: number, userId: string }>} */
  const sessions = new Map();
  /** @type {Map<string, { fails: number, lockedUntil: number }>} */
  const loginAttempts = new Map();

  function isConfigured() {
    return houseUsers.isConfigured();
  }

  function purgeExpired() {
    const now = Date.now();
    for (const [token, sess] of sessions) {
      if (sess.expiresAt <= now) sessions.delete(token);
    }
  }

  function cookieParts(name, token, { secure = false, maxAge } = {}) {
    const parts = [
      `${name}=${token != null ? encodeURIComponent(token) : ''}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${maxAge != null ? maxAge : Math.floor(sessionMs / 1000)}`,
    ];
    if (secure) parts.push('Secure');
    return parts.join('; ');
  }

  function buildSetCookies(token, { secure = false } = {}) {
    return [
      cookieParts(COOKIE_NAME, token, { secure }),
      cookieParts(LEGACY_COOKIE_NAME, token, { secure }),
    ];
  }

  function buildClearCookies({ secure = false } = {}) {
    return [
      cookieParts(COOKIE_NAME, '', { secure, maxAge: 0 }),
      cookieParts(LEGACY_COOKIE_NAME, '', { secure, maxAge: 0 }),
    ];
  }

  function requestIsSecure(req) {
    if (req?.socket?.encrypted) return true;
    const forwarded = String(req?.headers?.['x-forwarded-proto'] || '').toLowerCase();
    return forwarded === 'https';
  }

  function rateLimitStatus(ip, now = Date.now()) {
    const entry = loginAttempts.get(ip);
    if (!entry || entry.lockedUntil <= now) return null;
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

  function parseCredentials(raw) {
    if (typeof raw === 'string') {
      return { username: houseUsers.adminUsername, password: raw };
    }
    return {
      username: String(raw?.username || houseUsers.adminUsername || '').trim(),
      password: String(raw?.password || ''),
    };
  }

  function login(credentials, req) {
    if (!isConfigured()) {
      return {
        ok: false,
        status: 503,
        error: 'Admin password is not configured — set ADMIN_PASSWORD in .env and restart the bridge',
        code: 'admin_password_unset',
      };
    }
    houseUsers.ensureBootstrap();
    const { username, password } = parseCredentials(credentials);
    const ip = clientIpFromRequest(req);
    const now = Date.now();
    const limited = rateLimitStatus(ip, now);
    if (limited) {
      timingSafeEqualString(password, password);
      log.warn?.('Login blocked — rate limited', { ip, retryAfterSec: limited.retryAfterSec });
      return limited;
    }
    if (!username || !password) {
      recordFailedLogin(ip, now);
      return { ok: false, status: 401, error: 'Username and password are required', code: 'bad_password' };
    }

    const result = houseUsers.verifyLogin(username, password);
    if (!result.ok) {
      const recorded = recordFailedLogin(ip, now);
      log.warn?.('Login failed', {
        ip,
        username,
        code: result.code,
        fails: recorded.fails,
        lockSec: recorded.lockSec,
      });
      const retryAfterSec = recorded.lockSec > 0 ? recorded.lockSec : undefined;
      const inactive = result.code === 'inactive';
      return {
        ok: false,
        status: recorded.lockSec > 0 ? 429 : 401,
        error: recorded.lockSec > 0
          ? `Incorrect username or password — try again in ${recorded.lockSec}s`
          : (inactive ? 'This account is inactive' : 'Incorrect username or password'),
        code: recorded.lockSec > 0 ? 'rate_limited' : (inactive ? 'inactive' : 'bad_password'),
        retryAfterSec,
      };
    }

    clearLoginAttempts(ip);
    purgeExpired();
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + sessionMs;
    sessions.set(token, { expiresAt, userId: result.user.id });
    houseUsers.markLogin(result.user.id);
    const user = houseUsers.publicUser(result.user);
    log.info?.('Session created', {
      userId: user.id,
      username: user.username,
      isAdmin: user.isAdmin,
      expiresAt: new Date(expiresAt).toISOString(),
    });
    return {
      ok: true,
      token,
      expiresAt,
      user,
      setCookie: buildSetCookies(token, { secure: requestIsSecure(req) }),
    };
  }

  function logout(req) {
    const cookies = parseCookies(req);
    const token = cookies[COOKIE_NAME] || cookies[LEGACY_COOKIE_NAME];
    if (token) sessions.delete(token);
    return {
      ok: true,
      setCookie: buildClearCookies({ secure: requestIsSecure(req) }),
    };
  }

  function dropSessionsForUser(userId) {
    const needle = String(userId || '');
    for (const [token, sess] of sessions) {
      if (sess.userId === needle) sessions.delete(token);
    }
  }

  function sessionFromRequest(req) {
    purgeExpired();
    if (!isConfigured()) {
      return { ok: false, code: 'admin_password_unset' };
    }
    const cookies = parseCookies(req);
    const token = cookies[COOKIE_NAME] || cookies[LEGACY_COOKIE_NAME];
    if (!token) return { ok: false, code: 'no_session' };
    const sess = sessions.get(token);
    if (!sess) return { ok: false, code: 'no_session' };
    if (sess.expiresAt <= Date.now()) {
      sessions.delete(token);
      return { ok: false, code: 'expired' };
    }
    const user = houseUsers.getById(sess.userId);
    if (!user || user.active === false) {
      sessions.delete(token);
      return { ok: false, code: 'inactive' };
    }
    const pub = houseUsers.publicUser(user);
    return {
      ok: true,
      expiresAt: sess.expiresAt,
      userId: pub.id,
      username: pub.username,
      firstName: pub.firstName,
      lastName: pub.lastName,
      isAdmin: pub.isAdmin,
      permissions: pub.permissions,
      user: pub,
      actor: actorFromUser(user),
    };
  }

  function deny(session, message, status = 401) {
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
      status,
      error: message,
      code: session.code || 'unauthorized',
    };
  }

  function assertAuthorized(req) {
    const session = sessionFromRequest(req);
    if (session.ok && session.isAdmin) return session;
    if (session.ok && !session.isAdmin) {
      return { ok: false, status: 403, error: 'Admin access required', code: 'not_admin' };
    }
    return deny(session, 'Admin login required');
  }

  function assertUserAuthorized(req) {
    const session = sessionFromRequest(req);
    if (session.ok) return session;
    return deny(session, 'Sign in required');
  }

  function hasPermission(req, permission) {
    const session = sessionFromRequest(req);
    if (!session.ok) return session;
    if (session.isAdmin || session.permissions?.[permission] === true) {
      return { ok: true, ...session };
    }
    return { ok: false, status: 403, error: 'You do not have access to that', code: 'forbidden' };
  }

  return {
    COOKIE_NAME,
    LEGACY_COOKIE_NAME,
    houseUsers,
    isConfigured,
    login,
    logout,
    sessionFromRequest,
    assertAuthorized,
    assertUserAuthorized,
    hasPermission,
    dropSessionsForUser,
    clientIpFromRequest,
    _sessions: sessions,
    _loginAttempts: loginAttempts,
    _lockoutSecondsForFails: lockoutSecondsForFails,
  };
}

module.exports = {
  createWebAdminAuth,
  parseCookies,
  COOKIE_NAME,
  LEGACY_COOKIE_NAME,
  timingSafeEqualString,
  clientIpFromRequest,
  normalizeClientIp,
  lockoutSecondsForFails,
  LOCKOUT_LADDER_SEC,
};
