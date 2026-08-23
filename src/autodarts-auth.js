/**
 * Autodarts auth: device-link (preferred) + email/password fallback.
 * Tokens are encrypted at rest; passwords are never persisted.
 *
 * Uses api.autodarts.io/auth/v1 (Keycloak at login.autodarts.io is shut down).
 */

const {
  DEFAULT_CLIENT_ID,
  DEFAULT_DEVICE_LINK_URI,
  normalizeClientId,
} = require('./autodarts-api');

function pickTokenFields(json = {}) {
  return {
    accessToken: json.access_token || json.accessToken || '',
    refreshToken: json.refresh_token || json.refreshToken || '',
    expiresIn: Number(json.expires_in || json.expiresIn || 0) || 0,
    refreshExpiresIn: Number(json.refresh_expires_in || json.refreshExpiresIn || 0) || 0,
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

function createAutodartsAuth({
  credentials,
  api,
  env = process.env,
  now = () => Date.now(),
  log = console,
} = {}) {
  let memoryAccessToken = null;
  let accessExpiresAt = 0;
  let devicePoll = null;

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
    return {
      linked: Boolean(stored.refreshToken || (envCreds.present && stored.userId)),
      source: envCreds.present ? 'env' : (stored.refreshToken ? 'session' : null),
      userId: stored.userId || null,
      userName: stored.userName || null,
      boardId: stored.boardId || null,
      boardName: stored.boardName || null,
      linkedAt: stored.linkedAt || null,
      needsRelink: stored.needsRelink === true,
      unavailableReason: stored.unavailableReason || null,
      deviceLinkPending: Boolean(devicePoll),
      deviceUserCode: devicePoll?.userCode || null,
      deviceVerificationUri: devicePoll?.verificationUri || null,
      envBlocksOverwrite: envCreds.present,
      oauth,
    };
  }

  async function persistTokens(tokenJson, extra = {}) {
    const tokens = pickTokenFields(tokenJson);
    if (!tokens.refreshToken) {
      throw new Error('Autodarts did not return a refresh token');
    }
    memoryAccessToken = tokens.accessToken || memoryAccessToken;
    if (tokens.expiresIn > 0) {
      accessExpiresAt = now() + Math.max(30, tokens.expiresIn - 60) * 1000;
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
    const existing = credentials.load();
    credentials.save({
      refreshToken: tokens.refreshToken,
      accessToken: tokens.accessToken || existing.accessToken,
      userId: userId || existing.userId,
      userName: userName || existing.userName,
      boardId: existing.boardId,
      boardName: existing.boardName,
      linkedAt: existing.linkedAt || new Date(now()).toISOString(),
      needsRelink: false,
      unavailableReason: null,
    });
    return statusSnapshot();
  }

  async function refreshAccessToken() {
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
      credentials.markNeedsRelink(
        authErrorDetail(result.json, result.text, 'Refresh failed — re-link Autodarts'),
      );
      memoryAccessToken = null;
      accessExpiresAt = 0;
      throw new Error(authErrorDetail(result.json, result.text, 'Autodarts token refresh failed — re-link in Settings'));
    }
    await persistTokens(result.json, {
      userId: stored.userId,
      userName: stored.userName,
    });
    return memoryAccessToken;
  }

  async function getAccessToken() {
    if (memoryAccessToken && now() < accessExpiresAt) {
      return memoryAccessToken;
    }
    const stored = credentials.load();
    if (stored.accessToken && now() < accessExpiresAt) {
      memoryAccessToken = stored.accessToken;
      return memoryAccessToken;
    }
    return refreshAccessToken();
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
      linked: Boolean(credentials.load().refreshToken),
    };
  }

  function scheduleDevicePoll() {
    if (!devicePoll) return;
    if (devicePoll.timer) clearTimeout(devicePoll.timer);
    devicePoll.timer = setTimeout(async () => {
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
    if (devicePoll?.timer) clearTimeout(devicePoll.timer);
    devicePoll = null;
  }

  async function unlink() {
    stopDevicePoll();
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
  };
}

module.exports = {
  createAutodartsAuth,
  pickTokenFields,
  authErrorDetail,
};
