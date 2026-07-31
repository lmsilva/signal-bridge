/**
 * Local PIN unlock for remote control (mouse / keyboard / power).
 *
 * Flow: startChallenge → UDP pin overlay on the target display → verify PIN
 * → bearer-like session token scoped to that display id.
 */

const crypto = require('crypto');

const DEFAULT_PIN_DIGITS = 6;
// Keep in sync with CONTROL_TOKEN_TTL_MS in web/app.js — the phone locks the
// UI after 1h and the bridge rejects the token at the same age.
const DEFAULT_SESSION_MINUTES = 60;

function createDisplayControlAuth(config = {}, log = console) {
  const cfg = config.webServer?.controlAuth || {};
  const enabled = cfg.enabled !== false;
  const pinDigits = Math.min(8, Math.max(4, Number(cfg.pinDigits) || DEFAULT_PIN_DIGITS));
  const sessionMs = Math.max(
    60_000,
    (Number(cfg.sessionMinutes) || DEFAULT_SESSION_MINUTES) * 60_000,
  );

  /** @type {Map<string, { pin: string, expiresAt: number, displaySeconds: number }>} */
  const challenges = new Map();
  /** @type {Map<string, { displayId: string, expiresAt: number }>} */
  const sessions = new Map();

  function pinDisplaySeconds() {
    if (cfg.pinDisplaySeconds != null && Number(cfg.pinDisplaySeconds) > 0) {
      return Number(cfg.pinDisplaySeconds);
    }
    return Number(config.udpBroadcast?.defaultDisplaySeconds) || 120;
  }

  function generatePin() {
    const max = 10 ** pinDigits;
    const n = crypto.randomInt(0, max);
    return String(n).padStart(pinDigits, '0');
  }

  function purgeExpired() {
    const now = Date.now();
    for (const [id, ch] of challenges) {
      if (ch.expiresAt <= now) {
        challenges.delete(id);
      }
    }
    for (const [token, sess] of sessions) {
      if (sess.expiresAt <= now) {
        sessions.delete(token);
      }
    }
  }

  function startChallenge(displayId) {
    purgeExpired();
    const id = String(displayId || '').trim();
    if (!id || id === '*') {
      return { error: 'Unlock requires a single display' };
    }
    const pin = generatePin();
    const displaySeconds = pinDisplaySeconds();
    const expiresAt = Date.now() + displaySeconds * 1000;
    challenges.set(id, { pin, expiresAt, displaySeconds });
    // Drop any existing session for this display so unlock is required again.
    for (const [token, sess] of sessions) {
      if (sess.displayId === id) {
        sessions.delete(token);
      }
    }
    log.info?.('Control PIN challenge started', { displayId: id, displaySeconds });
    return {
      displayId: id,
      displaySeconds,
      expiresAt: new Date(expiresAt).toISOString(),
      pin, // only for the UDP payload builder — never returned to the web client
    };
  }

  function verifyPin(displayId, pin) {
    purgeExpired();
    const id = String(displayId || '').trim();
    const entered = String(pin || '').replace(/\D/g, '');
    const challenge = challenges.get(id);
    if (!challenge) {
      return { error: 'No active PIN on that display — tap Unlock again' };
    }
    if (challenge.expiresAt <= Date.now()) {
      challenges.delete(id);
      return { error: 'PIN expired — tap Unlock to show a new code' };
    }
    if (entered !== challenge.pin) {
      return { error: 'Incorrect PIN — try again' };
    }
    challenges.delete(id);
    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = Date.now() + sessionMs;
    sessions.set(token, { displayId: id, expiresAt });
    log.info?.('Control PIN verified', { displayId: id });
    return {
      token,
      displayId: id,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  function assertAuthorized(displayId, token) {
    if (!enabled) {
      return { ok: true, skipped: true };
    }
    purgeExpired();
    const id = String(displayId || '').trim();
    if (!id || id === '*' || id.toLowerCase() === 'all') {
      return {
        ok: false,
        status: 400,
        code: 'control_auth_requires_single_display',
        error: 'Remote control requires a single unlocked display',
      };
    }
    const sess = sessions.get(String(token || '').trim());
    if (!sess || sess.displayId !== id || sess.expiresAt <= Date.now()) {
      if (sess && sess.expiresAt <= Date.now()) {
        sessions.delete(String(token || '').trim());
      }
      return {
        ok: false,
        status: 401,
        code: 'control_auth_required',
        error: 'Unlock this display with the on-screen PIN first',
      };
    }
    return { ok: true, displayId: id };
  }

  function isUnlocked(displayId, token) {
    return assertAuthorized(displayId, token).ok === true;
  }

  function getStatus(displayId, token) {
    purgeExpired();
    const id = String(displayId || '').trim();
    const challenge = challenges.get(id);
    return {
      enabled,
      displayId: id || null,
      unlocked: isUnlocked(id, token),
      challengeActive: Boolean(challenge && challenge.expiresAt > Date.now()),
      challengeExpiresAt: challenge && challenge.expiresAt > Date.now()
        ? new Date(challenge.expiresAt).toISOString()
        : null,
      pinDisplaySeconds: pinDisplaySeconds(),
      pinDigits,
      sessionMinutes: Math.round(sessionMs / 60000),
    };
  }

  function publicChallengeView(challenge) {
    if (!challenge || challenge.error) {
      return challenge;
    }
    // Never expose the PIN to the phone — only expiry metadata.
    return {
      displayId: challenge.displayId,
      displaySeconds: challenge.displaySeconds,
      expiresAt: challenge.expiresAt,
    };
  }

  return {
    enabled,
    pinDigits,
    pinDisplaySeconds,
    startChallenge,
    verifyPin,
    assertAuthorized,
    isUnlocked,
    getStatus,
    publicChallengeView,
  };
}

module.exports = {
  createDisplayControlAuth,
};
