const { postForm } = require('./tesla-http');
const {
  loadTeslaSession,
  saveTeslaSession,
  sessionFromTokenResponse,
  accessTokenExpiresWithin,
} = require('./tesla-session');
const { clearTeslaAuthStatus } = require('./tesla-auth-status');

/** One in-flight refresh per process — Tesla refresh tokens rotate and concurrent
 *  exchanges invalidate each other ("The refresh_token is invalid"). */
let refreshInFlight = null;

async function exchangeAuthorizationCode(fleet, code) {
  return postForm(fleet.tokenUrl, {
    grant_type: 'authorization_code',
    client_id: fleet.clientId,
    client_secret: fleet.clientSecret,
    code,
    audience: fleet.fleetApiBase,
    redirect_uri: fleet.redirectUri,
  });
}

async function fetchPartnerToken(fleet, scopes) {
  return postForm(fleet.tokenUrl, {
    grant_type: 'client_credentials',
    client_id: fleet.clientId,
    client_secret: fleet.clientSecret,
    audience: fleet.fleetApiBase,
    scope: scopes || fleet.scopes,
  });
}

async function refreshAccessToken(fleet, session) {
  if (!session?.refreshToken) {
    throw new Error('No Tesla refresh token — run npm run tesla-auth');
  }
  const tokenData = await postForm(fleet.tokenUrl, {
    grant_type: 'refresh_token',
    client_id: fleet.clientId,
    client_secret: fleet.clientSecret,
    refresh_token: session.refreshToken,
  });
  return sessionFromTokenResponse(tokenData, session);
}

function isRefreshTokenRejected(error) {
  const message = String(error?.message || '');
  const body = error?.body || {};
  const haystack = [
    message,
    body.error,
    body.error_description,
    body.error_message,
  ].filter(Boolean).join(' ');
  return error?.status === 401
    || /login_required|invalid_grant|refresh_token is invalid|invalid refresh/i.test(haystack);
}

/**
 * Load → refresh → save under a single-flight lock. Clears sticky reauth status
 * on success. If Tesla rejects a token that was already rotated by a peer, reuse
 * the newer on-disk session instead of marking re-auth.
 */
async function refreshSession(fleet, { log, reason = 'refresh' } = {}) {
  if (refreshInFlight) {
    return refreshInFlight;
  }

  refreshInFlight = (async () => {
    const before = loadTeslaSession(fleet.sessionPath);
    if (!before?.refreshToken) {
      throw new Error('No Tesla refresh token — run npm run tesla-auth');
    }
    try {
      const updated = await refreshAccessToken(fleet, before);
      saveTeslaSession(fleet.sessionPath, updated);
      clearTeslaAuthStatus(fleet);
      log?.info?.('Tesla access token refreshed', { reason });
      return updated;
    } catch (error) {
      const after = loadTeslaSession(fleet.sessionPath);
      if (after?.refreshToken && after.refreshToken !== before.refreshToken) {
        log?.info?.('Tesla refresh raced — using newer saved session', { reason });
        clearTeslaAuthStatus(fleet);
        return after;
      }
      if (after?.accessToken && !accessTokenExpiresWithin(after, 60_000)) {
        log?.info?.('Tesla refresh failed but access token still valid', { reason });
        clearTeslaAuthStatus(fleet);
        return after;
      }
      throw error;
    }
  })().finally(() => {
    refreshInFlight = null;
  });

  return refreshInFlight;
}

async function getValidAccessToken(fleet, { log, forceRefresh = false } = {}) {
  const session = loadTeslaSession(fleet.sessionPath);
  if (!session?.accessToken) {
    throw new Error('No Tesla session — run npm run tesla-auth');
  }
  if (!forceRefresh && !accessTokenExpiresWithin(session)) {
    return { accessToken: session.accessToken, session };
  }
  const updated = await refreshSession(fleet, { log, reason: forceRefresh ? 'force' : 'expiry' });
  return { accessToken: updated.accessToken, session: updated };
}

/** Test helper — reset single-flight between cases. */
function _resetRefreshLockForTests() {
  refreshInFlight = null;
}

module.exports = {
  exchangeAuthorizationCode,
  fetchPartnerToken,
  refreshAccessToken,
  refreshSession,
  getValidAccessToken,
  isRefreshTokenRejected,
  _resetRefreshLockForTests,
};
