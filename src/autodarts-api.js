/**
 * Read-only Autodarts HTTP client.
 *
 * Unofficial API (api.autodarts.io). Auth moved off Keycloak (login.autodarts.io)
 * to api.autodarts.io/auth/v1 after mid-2026. Only GET plus auth POSTs are exposed
 * so a future edit cannot casually add lobby/start/throw write calls.
 */

const API_BASE = 'https://api.autodarts.io';
/** Messaging WebSocket host used by play.autodarts.io (not api.autodarts.io). */
const WS_HTTP_BASE = 'https://play.ws.autodarts.com/ms/v0';
const WS_URL = 'wss://play.ws.autodarts.com/ms/v0/subscribe';
/** @deprecated Keycloak was shut down ~2026-06-28; kept only for tests/docs. */
const KEYCLOAK_BASE = 'https://login.autodarts.io/realms/autodarts/protocol/openid-connect';
/** Device + password client used by community tools on the new auth server. */
const DEFAULT_CLIENT_ID = 'darts-caller';
const LEGACY_CLIENT_ID = 'developer-darts-caller';
const DEFAULT_DEVICE_LINK_URI = 'https://auth.autodarts.com/link';

const FORBIDDEN_WRITE_MARKERS = Object.freeze([
  '/start',
  '/undo',
  '/correct',
  '/players',
  '/next',
  '/finish',
  '/delete',
]);

function normalizeClientId(clientId) {
  const raw = String(clientId || '').trim();
  if (!raw || raw === LEGACY_CLIENT_ID) return DEFAULT_CLIENT_ID;
  return raw;
}

function assertReadOnlyPath(method, pathname) {
  const verb = String(method || 'GET').toUpperCase();
  const path = String(pathname || '');
  if (verb === 'GET') return;
  if (verb === 'POST' && (
    path.includes('/auth/v1/refresh')
    || path.includes('/auth/v1/login')
    || path.includes('/auth/v1/token')
    || path.includes('/auth/v1/exchange')
    || path.includes('/auth/v1/device')
    || path.includes('/tickets')
    || path.includes('/token')
  )) {
    return;
  }
  const lower = path.toLowerCase();
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(verb)) {
    if (FORBIDDEN_WRITE_MARKERS.some((marker) => lower.includes(marker)) || /\/gs\/v0\//.test(lower)) {
      throw new Error(`Autodarts client is read-only — blocked ${verb} ${path}`);
    }
    if (!path.includes('/auth/') && !path.includes('/token') && !path.includes('/device')) {
      throw new Error(`Autodarts client is read-only — blocked ${verb} ${path}`);
    }
  }
}

function decodeJwtPayload(accessToken) {
  try {
    const part = String(accessToken || '').split('.')[1];
    if (!part) return null;
    const padded = part.replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(padded, 'base64').toString('utf8');
    const payload = JSON.parse(json);
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

function createAutodartsApi({
  fetchImpl = global.fetch,
  accessTokenProvider = async () => null,
  clientId = DEFAULT_CLIENT_ID,
  clientSecret = '',
  timeoutMs = 15_000,
  log = console,
} = {}) {
  async function raw(method, url, { body, headers = {}, form = false, auth = true, timeout = timeoutMs } = {}) {
    const parsed = new URL(url, API_BASE);
    assertReadOnlyPath(method, parsed.pathname + parsed.search);
    const finalHeaders = { ...headers };
    if (auth) {
      const token = await accessTokenProvider();
      if (!token) {
        throw new Error('Autodarts is not linked — open Settings and link an account');
      }
      finalHeaders.Authorization = `Bearer ${token}`;
    }
    let payload = body;
    if (form && body && typeof body === 'object') {
      payload = new URLSearchParams(body).toString();
      finalHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
    } else if (body && typeof body === 'object' && !Buffer.isBuffer(body)) {
      payload = JSON.stringify(body);
      finalHeaders['Content-Type'] = finalHeaders['Content-Type'] || 'application/json';
    }
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller && timeout > 0
      ? setTimeout(() => controller.abort(), timeout)
      : null;
    let response;
    try {
      response = await fetchImpl(parsed.toString(), {
        method,
        headers: finalHeaders,
        body: payload == null ? undefined : payload,
        signal: controller?.signal,
      });
    } catch (error) {
      if (timer) clearTimeout(timer);
      if (error?.name === 'AbortError') {
        throw new Error(`Autodarts request timed out after ${Math.round(timeout / 1000)}s`);
      }
      throw error;
    }
    if (timer) clearTimeout(timer);
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { ok: response.ok, status: response.status, json, text, headers: response.headers };
  }

  async function apiGet(pathname) {
    return raw('GET', pathname.startsWith('http') ? pathname : `${API_BASE}${pathname}`);
  }

  function authClientFields({ clientId: id, clientSecret: secret } = {}) {
    const body = {
      client_id: normalizeClientId(id || clientId),
    };
    const resolvedSecret = secret || clientSecret;
    if (resolvedSecret) {
      body.client_secret = resolvedSecret;
    }
    return body;
  }

  async function refreshWithAutodarts(refreshToken, { clientId: id, clientSecret: secret } = {}) {
    return raw('POST', `${API_BASE}/auth/v1/refresh`, {
      body: {
        refresh_token: refreshToken,
        ...authClientFields({ clientId: id, clientSecret: secret }),
      },
      auth: false,
    });
  }

  async function passwordLogin({ email, password, clientId: id, clientSecret: secret }) {
    const body = {
      ...authClientFields({ clientId: id, clientSecret: secret }),
      email: String(email || '').trim(),
      password: String(password || ''),
    };
    return raw('POST', `${API_BASE}/auth/v1/login`, { body, auth: false });
  }

  async function startDeviceCode({ clientId: id, clientSecret: secret } = {}) {
    return raw('POST', `${API_BASE}/auth/v1/device/code`, {
      body: authClientFields({ clientId: id, clientSecret: secret }),
      auth: false,
    });
  }

  async function pollDeviceToken(deviceCode, { clientId: id, clientSecret: secret } = {}) {
    return raw('POST', `${API_BASE}/auth/v1/device/token`, {
      body: {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: deviceCode,
        ...authClientFields({ clientId: id, clientSecret: secret }),
      },
      auth: false,
    });
  }

  async function userInfo(accessToken) {
    const payload = decodeJwtPayload(accessToken);
    if (payload) {
      return {
        ok: true,
        status: 200,
        json: {
          sub: payload.sub || payload.user_id || payload.userId || '',
          preferred_username: payload.preferred_username
            || payload.name
            || payload.username
            || payload.email
            || '',
          email: payload.email || '',
          ...payload,
        },
        text: '',
        headers: null,
      };
    }
    return { ok: false, status: 0, json: null, text: '', headers: null };
  }

  async function createSubscribeTicket(accessToken) {
    return raw('POST', `${WS_HTTP_BASE}/tickets`, {
      body: {},
      auth: false,
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    });
  }

  return {
    API_BASE,
    WS_HTTP_BASE,
    WS_URL,
    KEYCLOAK_BASE,
    DEFAULT_CLIENT_ID,
    DEFAULT_DEVICE_LINK_URI,
    assertReadOnlyPath,
    normalizeClientId,
    decodeJwtPayload,
    getBoards: () => apiGet('/bs/v0/boards'),
    getBoard: (boardId) => apiGet(`/bs/v0/boards/${encodeURIComponent(boardId)}`),
    getBoardState: (boardId) => apiGet(`/bs/v0/boards/${encodeURIComponent(boardId)}/state`),
    getMatch: (matchId) => apiGet(`/gs/v0/matches/${encodeURIComponent(matchId)}`),
    getMatchState: (matchId) => apiGet(`/gs/v0/matches/${encodeURIComponent(matchId)}/state`),
    getMatchStats: (matchId) => apiGet(`/as/v0/matches/${encodeURIComponent(matchId)}/stats`),
    /**
     * Match history (play.autodarts.io Match History page).
     * Confirmed 2026-08-23: GET /as/v0/matches/filter?size&page&sort=-finished_at
     */
    listMatchHistory: ({ size = 25, page = 0, sort = '-finished_at', variant, types } = {}) => {
      const params = new URLSearchParams();
      params.set('size', String(Math.max(1, Math.min(100, Number(size) || 25))));
      params.set('page', String(Math.max(0, Number(page) || 0)));
      params.set('sort', String(sort || '-finished_at'));
      if (variant) params.set('variant', String(variant));
      if (types) params.set('types', String(types));
      return apiGet(`/as/v0/matches/filter?${params.toString()}`);
    },
    getUserStats: (userId, variant = 'x01', limit = 100) => apiGet(
      `/as/v0/users/${encodeURIComponent(userId)}/stats/${encodeURIComponent(variant)}?limit=${limit}`,
    ),
    refreshWithAutodarts,
    passwordLogin,
    /** @deprecated Use passwordLogin — Keycloak is gone. */
    keycloakPasswordGrant: passwordLogin,
    startDeviceCode,
    pollDeviceToken,
    userInfo,
    createSubscribeTicket,
    _forbiddenMarkers: FORBIDDEN_WRITE_MARKERS,
  };
}

module.exports = {
  createAutodartsApi,
  assertReadOnlyPath,
  FORBIDDEN_WRITE_MARKERS,
  DEFAULT_CLIENT_ID,
  LEGACY_CLIENT_ID,
  DEFAULT_DEVICE_LINK_URI,
  API_BASE,
  WS_HTTP_BASE,
  WS_URL,
  KEYCLOAK_BASE,
  normalizeClientId,
  decodeJwtPayload,
};
