const { postForm } = require('./tesla-http');
const { loadTeslaSession, saveTeslaSession, sessionFromTokenResponse } = require('./tesla-session');

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

async function getValidAccessToken(fleet, { log } = {}) {
  const session = loadTeslaSession(fleet.sessionPath);
  if (!session?.accessToken) {
    throw new Error('No Tesla session — run npm run tesla-auth');
  }
  const { accessTokenExpiresWithin } = require('./tesla-session');
  if (!accessTokenExpiresWithin(session)) {
    return { accessToken: session.accessToken, session };
  }
  if (!refreshInFlight) {
    refreshInFlight = refreshAccessToken(fleet, session)
      .then((updated) => {
        saveTeslaSession(fleet.sessionPath, updated);
        log?.info?.('Tesla access token refreshed');
        return updated;
      })
      .finally(() => {
        refreshInFlight = null;
      });
  }
  const updated = await refreshInFlight;
  return { accessToken: updated.accessToken, session: updated };
}

module.exports = {
  exchangeAuthorizationCode,
  fetchPartnerToken,
  refreshAccessToken,
  getValidAccessToken,
};
