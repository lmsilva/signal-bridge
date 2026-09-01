/**
 * Autodarts auth: device-link (preferred) + email/password fallback.
 * Tokens are encrypted at rest; passwords are never persisted.
 *
 * Uses api.autodarts.io/auth/v1 (Keycloak at login.autodarts.io is shut down).
 *
 * Access tokens last ~15 minutes. Refresh tokens last a few days and Autodarts
 * rotates them on each refresh — so an idle bridge that never calls the API
 * will eventually hold a dead refresh token and need a manual re-link. The
 * keep-alive below refreshes on a timer so the refresh token stays alive for
 * as long as the container is running.
 */

const {
  DEFAULT_CLIENT_ID,
  DEFAULT_DEVICE_LINK_URI,
  normalizeClientId,
} = require('./autodarts-api');

/** How far ahead of access-token expiry to refresh (seconds). */
const ACCESS_REFRESH_SKEW_SECONDS = 90;
/**
 * Fallback keep-alive when Autodarts does not report refresh_expires_in.
 * Access tokens are ~15 minutes; refreshing every 10 minutes rotates the
 * refresh token well before a multi-day idle expiry.
 */
const DEFAULT_KEEPALIVE_MS = 10 * 60 * 1000;
/** Never poll more often than this even if the access token is short-lived. */
const MIN_KEEPALIVE_MS = 60 * 1000;
/** Cap so a very long refresh_expires_in still gets periodic rotation. */
const MAX_KEEPALIVE_MS = 6 * 60 * 60 * 1000;

function tokenSource(json) {
  if (!json || typeof json !== 'object') return {};
  if (json.access_token || json.refresh_token || json.accessToken || json.refreshToken) {
    return json;
  }
  if (json.data && typeof json.data === 'object') return tokenSource(json.data);
  if (json.tokens && typeof json.tokens === 'object') return tokenSource(json.tokens);
  return json;
}

function pickTokenFields(json = {}) {
  const src = tokenSource(json);
  return {
    accessToken: src.access_token || src.accessToken || '',
    refreshToken: src.refresh_token || src.refreshToken || '',
    expiresIn: Number(src.expires_in || src.expiresIn || 0) || 0,
    refreshExpiresIn: Number(src.refresh_expires_in || src.refreshExpiresIn || 0) || 0,
  };
}

function authErrorDetail(json, text, fallback = 'Request failed') {
  if (!json || typeof json !== 'object') {
    return fallback;
  }
  if (typeof json.error === 'string') {
    return json.error_description || json.error || fallback;
  }
  if (json.error && typeof json.error === 'object') {
    return json.error.message || json.error.code || fallback;
  }
  if (json.message) return String(json.message);
  if (text && /timed out|timeout|522/i.test(text)) {
    return 'Autodarts login is unreachable right now (connection timed out). Try again later.';
  }
  return fallback;
}

function isInvalidRefreshError(json, text, status) {
  if (Number(status) === 401) return true;
  const detail = authErrorDetail(json, text, '').toLowerCase();
  const code = String(
    typeof json?.error === 'string'
      ? json.error
      : (json?.error?.code || ''),
  ).toLowerCase();
  // `invalid_client` contains "invalid" but is a config problem, not a dead token.
  if (code === 'invalid_client' || /\binvalid_client\b/.test(detail)) return false;
  return /invalid_grant|invalid_token/.test(code)
    || /invalid_grant|invalid_token/.test(detail)
    || /invalid or expired refresh/.test(detail)
    || /refresh token.*(invalid|expired|revoked)/.test(detail)
    || /token.*(revoked|expired)/.test(detail);
}

function createAutodartsAuth({
  credentials,
  api,
  rateLimit = null,
  env = process.env,
  now = () => Date.now(),
  log = console,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let memoryAccessToken = null;
  let accessExpiresAt = 0;
  let devicePoll = null;
  let keepAliveTimer = null;
  let keepAliveStarted = false;
  let refreshInFlight = null;

  function clientConfig() {
    const resolved = credentials.resolveOauthClient
      ? credentials.resolveOauthClient()
      : {
        clientId: env.AUTODARTS_CLIENT_ID || DEFAULT_CLIENT_ID,
        clientSecret: env.AUTODARTS_CLIENT_SECRET || '',
      };
    return {
      clientId: normalizeClientId(resolved.clientId || DEFAULT_CLIENT_ID),
      clientSecret: resolved.clientSecret || '',
    };
  }

  function statusSnapshot() {
    const stored = credentials.load();
    const envCreds = credentials.envPasswordCredentials();
    const oauth = credentials.oauthStatus ? credentials.oauthStatus() : null;
    // A refresh token that Autodarts has already rejected is not a working
    // link — treating it as linked hid the device-code UI and made Re-link
    // toast "Autodarts linked" without ever showing the approval code.
    const hasSession = Boolean(stored.refreshToken) || (envCreds.present && Boolean(stored.userId));
    const needsRelink = stored.needsRelink === true;
    return {
      linked: hasSession && !needsRelink,
      hasCredentials: hasSession,
      source: envCreds.present ? 'env' : (stored.refreshToken ? 'session' : null),
      userId: stored.userId || null,
      userName: stored.userName || null,
      boardId: stored.boardId || null,
      boardName: stored.boardName || null,
      linkedAt: stored.linkedAt || null,
      refreshExpiresAt: stored.refreshExpiresAt || null,
      needsRelink,
      unavailableReason: stored.unavailableReason || null,
      deviceLinkPending: Boolean(devicePoll),
      deviceUserCode: devicePoll?.userCode || null,
      deviceVerificationUri: devicePoll?.verificationUri || null,
      envBlocksOverwrite: envCreds.present,
      keepAlive: keepAliveStarted,
      oauth,
    };
  }

  async function persistTokens(tokenJson, extra = {}) {
    const tokens = pickTokenFields(tokenJson);
    const existing = credentials.load();
    // Autodarts often returns only a new access token on refresh. Throwing here
    // used to discard a still-valid session, and — if they had already rotated
    // server-side — the next keep-alive then died with invalid_grant.
    const refreshToken = tokens.refreshToken || existing.refreshToken;
    if (!refreshToken) {
      throw new Error('Autodarts did not return a refresh token');
    }
    if (!tokens.refreshToken && existing.refreshToken) {
      log?.debug?.('Autodarts refresh omitted a new refresh token — keeping the current one');
    }
    memoryAccessToken = tokens.accessToken || memoryAccessToken;
    if (tokens.expiresIn > 0) {
      accessExpiresAt = now() + Math.max(30, tokens.expiresIn - ACCESS_REFRESH_SKEW_SECONDS) * 1000;
    }
    let refreshExpiresAt = extra.refreshExpiresAt || null;
    if (tokens.refreshExpiresIn > 0) {
      refreshExpiresAt = new Date(now() + tokens.refreshExpiresIn * 1000).toISOString();
    }
    let userId = extra.userId || '';
    let userName = extra.userName || '';
    if (tokens.accessToken && (!userId || !userName)) {
      try {
        const info = await api.userInfo(tokens.accessToken);
        if (info.ok && info.json) {
          userId = userId || info.json.sub || info.json.userId || '';
          userName = userName
            || info.json.preferred_username
            || info.json.name
            || info.json.email
            || '';
        }
      } catch (error) {
        log?.warn?.('Autodarts userinfo failed', error?.message || error);
      }
    }
    credentials.save({
      refreshToken,
      accessToken: tokens.accessToken || existing.accessToken,
      userId: userId || existing.userId,
      userName: userName || existing.userName,
      boardId: existing.boardId,
      boardName: existing.boardName,
      linkedAt: existing.linkedAt || new Date(now()).toISOString(),
      refreshExpiresAt: refreshExpiresAt || existing.refreshExpiresAt || null,
      needsRelink: false,
      unavailableReason: null,
    });
    // A failed refresh used to stop keep-alive forever. Device-link / password
    // persist then called scheduleKeepAlive(), which no-ops when the flag is
    // off — so every re-link without a container restart died again in a few days.
    ensureKeepAlive();
    return statusSnapshot();
  }

  async function tryPasswordRecovery(reason) {
    const envCreds = credentials.envPasswordCredentials();
    if (!envCreds.present) return false;
    const oauth = clientConfig();
    const login = api.passwordLogin || api.keycloakPasswordGrant;
    log?.info?.('Autodarts refresh failed — trying env email/password recovery');
    let result;
    try {
      result = await login.call(api, {
        email: envCreds.email,
        password: envCreds.password,
        ...oauth,
      });
    } catch (error) {
      log?.warn?.('Autodarts password recovery failed', error?.message || error);
      return false;
    }
    if (!result.ok) {
      log?.warn?.(
        'Autodarts password recovery rejected',
        authErrorDetail(result.json, result.text, reason || 'login failed'),
      );
      return false;
    }
    await persistTokens(result.json);
    log?.info?.('Autodarts recovered via env email/password');
    return true;
  }

  async function refreshAccessToken() {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      const stored = credentials.load();
      const envCreds = credentials.envPasswordCredentials();
      const oauth = clientConfig();
      if (!stored.refreshToken && envCreds.present) {
        const login = api.passwordLogin || api.keycloakPasswordGrant;
        const result = await login.call(api, {
          email: envCreds.email,
          password: envCreds.password,
          ...oauth,
        });
        if (!result.ok) {
          credentials.markNeedsRelink(authErrorDetail(result.json, result.text, 'Password login failed'));
          throw new Error(authErrorDetail(result.json, result.text, 'Autodarts password login failed'));
        }
        await persistTokens(result.json);
        return memoryAccessToken;
      }
      if (!stored.refreshToken) {
        throw new Error('Autodarts is not linked');
      }
      const result = await api.refreshWithAutodarts(stored.refreshToken, oauth);
      if (!result.ok) {
        const rateLimited = result.rateLimited
          || rateLimit?.isRateLimitedStatus?.(result.status, result.json, result.text);
        if (rateLimited) {
          rateLimit?.noteResponse?.(result);
          memoryAccessToken = null;
          accessExpiresAt = 0;
          throw new Error(
            rateLimit?.snapshot?.()?.reason
            || authErrorDetail(result.json, result.text, 'Too many requests — try again later'),
          );
        }
        // Transient network / 5xx: keep the session and retry later.
        if (result.status >= 500 || result.status === 0 || result.status === 408 || result.status === 522) {
          memoryAccessToken = null;
          accessExpiresAt = 0;
          scheduleKeepAlive(Math.min(MAX_KEEPALIVE_MS, 60_000));
          throw new Error(authErrorDetail(result.json, result.text, 'Autodarts token refresh failed'));
        }
        if (isInvalidRefreshError(result.json, result.text, result.status)) {
          if (await tryPasswordRecovery(authErrorDetail(result.json, result.text))) {
            return memoryAccessToken;
          }
          credentials.markNeedsRelink(
            authErrorDetail(result.json, result.text, 'Refresh failed — re-link Autodarts'),
          );
          memoryAccessToken = null;
          accessExpiresAt = 0;
          stopKeepAlive();
          throw new Error(authErrorDetail(result.json, result.text, 'Autodarts token refresh failed — re-link in Settings'));
        }
        // Other 4xx (invalid_client, 403, empty 400): keep the session and retry.
        // Treating every 4xx as a dead token stopped keep-alive and forced a
        // phone approval even when the refresh token was still good.
        memoryAccessToken = null;
        accessExpiresAt = 0;
        scheduleKeepAlive(Math.min(MAX_KEEPALIVE_MS, 60_000));
        throw new Error(authErrorDetail(result.json, result.text, 'Autodarts token refresh failed'));
      }
      await persistTokens(result.json, {
        userId: stored.userId,
        userName: stored.userName,
      });
      return memoryAccessToken;
    })();
    try {
      return await refreshInFlight;
    } finally {
      refreshInFlight = null;
    }
  }

  async function getAccessToken() {
    const stored = credentials.load();
    if (stored.needsRelink) {
      throw new Error(stored.unavailableReason || 'Autodarts needs re-linking');
    }
    if (memoryAccessToken && now() < accessExpiresAt) {
      return memoryAccessToken;
    }
    if (stored.accessToken && now() < accessExpiresAt) {
      memoryAccessToken = stored.accessToken;
      return memoryAccessToken;
    }
    return refreshAccessToken();
  }

  function nextKeepAliveDelayMs() {
    const stored = credentials.load();
    if (stored.needsRelink || !stored.refreshToken) return null;
    const candidates = [DEFAULT_KEEPALIVE_MS];
    if (accessExpiresAt > now()) {
      candidates.push(Math.max(MIN_KEEPALIVE_MS, accessExpiresAt - now()));
    }
    if (stored.refreshExpiresAt) {
      const refreshMs = Date.parse(stored.refreshExpiresAt);
      if (Number.isFinite(refreshMs)) {
        // Refresh at 60% of remaining refresh lifetime, never later than MAX.
        const remaining = refreshMs - now();
        if (remaining > 0) {
          candidates.push(Math.min(MAX_KEEPALIVE_MS, Math.max(MIN_KEEPALIVE_MS, Math.floor(remaining * 0.4))));
        }
      }
    }
    return Math.min(...candidates);
  }

  function stopKeepAlive() {
    if (keepAliveTimer) clearTimer(keepAliveTimer);
    keepAliveTimer = null;
    keepAliveStarted = false;
  }

  function scheduleKeepAlive(overrideMs = null) {
    if (!keepAliveStarted) return;
    if (keepAliveTimer) clearTimer(keepAliveTimer);
    const delay = overrideMs != null ? overrideMs : nextKeepAliveDelayMs();
    if (delay == null) {
      keepAliveTimer = null;
      return;
    }
    // Boot / recovery overrides may be shorter than MIN_KEEPALIVE_MS (15s kick).
    const waitMs = overrideMs != null
      ? Math.max(1_000, overrideMs)
      : Math.max(MIN_KEEPALIVE_MS, delay);
    keepAliveTimer = setTimer(async () => {
      keepAliveTimer = null;
      try {
        await refreshAccessToken();
        log?.debug?.('Autodarts token keep-alive refreshed');
      } catch (error) {
        log?.warn?.('Autodarts token keep-alive failed', error?.message || error);
      } finally {
        if (keepAliveStarted && !credentials.load().needsRelink) {
          scheduleKeepAlive();
        }
      }
    }, waitMs);
    keepAliveTimer?.unref?.();
  }

  function ensureKeepAlive() {
    const resuming = !keepAliveStarted;
    keepAliveStarted = true;
    scheduleKeepAlive();
    if (resuming) {
      log?.info?.('Autodarts token keep-alive resumed');
    }
  }

  function startKeepAlive() {
    keepAliveStarted = true;
    const stored = credentials.load();
    if (stored.refreshToken && !stored.needsRelink) {
      // Kick a refresh soon after boot so a multi-day idle container does not
      // sit on a refresh token that is already hours from expiry.
      log?.info?.('Autodarts token keep-alive started');
      scheduleKeepAlive(Math.min(DEFAULT_KEEPALIVE_MS, 15_000));
    }
  }

  async function loginWithPassword({ email, password } = {}) {
    const envCreds = credentials.envPasswordCredentials();
    if (envCreds.present) {
      return {
        ok: false,
        status: 409,
        error: 'Autodarts email/password are set by environment variables and cannot be changed here',
      };
    }
    const user = String(email || '').trim();
    const pass = String(password || '');
    if (!user || !pass) {
      return { ok: false, error: 'Email and password are required' };
    }
    const oauth = clientConfig();
    const login = api.passwordLogin || api.keycloakPasswordGrant;
    let result;
    try {
      result = await login.call(api, {
        email: user,
        password: pass,
        clientId: oauth.clientId,
        clientSecret: oauth.clientSecret,
      });
    } catch (error) {
      return {
        ok: false,
        error: error?.message || 'Could not reach Autodarts login (timed out or offline)',
      };
    }
    if (!result.ok) {
      let message = authErrorDetail(result.json, result.text, 'Login failed');
      if (result.status === 522 || /522|timed out|timeout/i.test(String(result.text || ''))) {
        message = 'Autodarts login is unreachable right now (connection timed out). Try again later.';
      } else if (
        result.status === 401
        || result.json?.error === 'invalid_grant'
        || result.json?.error?.code === 'invalid_credentials'
      ) {
        message = authErrorDetail(result.json, result.text, 'Wrong email or password');
      } else if (result.json?.error?.code === 'invalid_client' || result.json?.error === 'invalid_client') {
        message = 'Unknown OAuth client id — use darts-caller (secret optional) or clear the saved client.';
      } else if (!result.json && result.status) {
        message = `Login failed (HTTP ${result.status})`;
      }
      return { ok: false, error: message, status: result.status };
    }
    await persistTokens(result.json);
    return { ok: true, ...statusSnapshot() };
  }

  async function beginDeviceLink() {
    stopDevicePoll();
    const oauth = clientConfig();
    let result;
    try {
      result = await api.startDeviceCode({
        clientId: oauth.clientId,
        clientSecret: oauth.clientSecret,
      });
    } catch (error) {
      return {
        ok: false,
        error: error?.message || 'Could not reach Autodarts login (timed out or offline)',
      };
    }
    if (!result.ok) {
      let message = authErrorDetail(
        result.json,
        result.text,
        'Device link is unavailable — try email and password',
      );
      if (result.status === 522 || /522|timed out|timeout/i.test(String(result.text || ''))) {
        message = 'Autodarts login is unreachable right now (connection timed out). Try email sign-in later, or retry.';
      } else if (result.json?.error === 'invalid_client' || result.json?.error?.code === 'invalid_client') {
        message = 'Unknown OAuth client id — use darts-caller (no secret required) instead of developer-darts-caller.';
      }
      return { ok: false, error: message, status: result.status };
    }
    const json = result.json || {};
    devicePoll = {
      deviceCode: json.device_code,
      userCode: json.user_code,
      verificationUri: json.verification_uri_complete
        || json.verification_uri
        || DEFAULT_DEVICE_LINK_URI,
      intervalMs: Math.max(50, (Number(json.interval) || 5) * 1000),
      expiresAt: now() + Math.max(60, Number(json.expires_in) || 600) * 1000,
      timer: null,
    };
    await tickDevicePoll();
    // Never claim "linked" from a stale refresh token still on disk — only
    // report linked after THIS device poll actually persisted fresh tokens.
    const snap = statusSnapshot();
    return {
      ok: true,
      userCode: devicePoll?.userCode || json.user_code,
      verificationUri: devicePoll?.verificationUri
        || json.verification_uri_complete
        || json.verification_uri
        || DEFAULT_DEVICE_LINK_URI,
      expiresIn: devicePoll
        ? Math.round((devicePoll.expiresAt - now()) / 1000)
        : Math.max(60, Number(json.expires_in) || 600),
      linked: snap.linked && !snap.needsRelink && !devicePoll,
      deviceLinkPending: Boolean(devicePoll),
    };
  }

  function scheduleDevicePoll() {
    if (!devicePoll) return;
    if (devicePoll.timer) clearTimer(devicePoll.timer);
    devicePoll.timer = setTimer(async () => {
      try {
        await tickDevicePoll();
      } catch (error) {
        log?.warn?.('Autodarts device poll failed', error?.message || error);
        scheduleDevicePoll();
      }
    }, devicePoll.intervalMs);
  }

  async function tickDevicePoll() {
    if (!devicePoll) return;
    if (now() > devicePoll.expiresAt) {
      stopDevicePoll();
      return;
    }
    const result = await api.pollDeviceToken(devicePoll.deviceCode, clientConfig());
    if (result.ok && (result.json?.access_token || result.json?.accessToken)) {
      await persistTokens(result.json);
      stopDevicePoll();
      return;
    }
    const err = typeof result.json?.error === 'string'
      ? result.json.error
      : result.json?.error?.code;
    if (err === 'authorization_pending' || err === 'slow_down') {
      if (err === 'slow_down') {
        devicePoll.intervalMs = Math.min(30_000, devicePoll.intervalMs + 2000);
      }
      scheduleDevicePoll();
      return;
    }
    stopDevicePoll();
    log?.warn?.('Autodarts device link ended', err || result.status);
  }

  function stopDevicePoll() {
    if (devicePoll?.timer) clearTimer(devicePoll.timer);
    devicePoll = null;
  }

  async function unlink() {
    stopDevicePoll();
    stopKeepAlive();
    memoryAccessToken = null;
    accessExpiresAt = 0;
    if (credentials.envPasswordCredentials().present) {
      return {
        ok: false,
        status: 409,
        error: 'Autodarts credentials are set by environment variables and cannot be cleared here',
      };
    }
    credentials.clear();
    return { ok: true, ...statusSnapshot() };
  }

  return {
    statusSnapshot,
    getAccessToken,
    refreshAccessToken,
    loginWithPassword,
    beginDeviceLink,
    stopDevicePoll,
    unlink,
    persistTokens,
    startKeepAlive,
    stopKeepAlive,
    ensureKeepAlive,
  };
}

module.exports = {
  createAutodartsAuth,
  pickTokenFields,
  authErrorDetail,
  isInvalidRefreshError,
  DEFAULT_KEEPALIVE_MS,
  ACCESS_REFRESH_SKEW_SECONDS,
};
