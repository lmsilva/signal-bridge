/**
 * Password gate for the Signal Bridge /admin control UI.
 *
 * Login form → HTTP-only session cookie. Fail closed when ADMIN_PASSWORD
 * is unset/empty (admin APIs reject; login page explains how to configure).
 */

const crypto = require('crypto');

const COOKIE_NAME = 'signal_admin';
const DEFAULT_SESSION_HOURS = 12;

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

  function login(candidatePassword, req) {
    if (!isConfigured()) {
      return {
        ok: false,
        status: 503,
        error: 'Admin password is not configured — set ADMIN_PASSWORD in .env and restart the bridge',
        code: 'admin_password_unset',
      };
    }
    if (!timingSafeEqualString(candidatePassword, password)) {
      log.warn?.('Admin login failed — incorrect password');
      return { ok: false, status: 401, error: 'Incorrect password', code: 'bad_password' };
    }
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
    // test helpers
    _sessions: sessions,
  };
}

module.exports = {
  createWebAdminAuth,
  parseCookies,
  COOKIE_NAME,
  timingSafeEqualString,
};
