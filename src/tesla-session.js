const fs = require('fs');
const path = require('path');

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function decodeJwtExpiry(accessToken) {
  if (!accessToken || typeof accessToken !== 'string') {
    return null;
  }
  const parts = accessToken.split('.');
  if (parts.length < 2) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (payload.exp) {
      return new Date(payload.exp * 1000).toISOString();
    }
  } catch {
    return null;
  }
  return null;
}

function sessionFromTokenResponse(tokenData, existing = {}) {
  const now = Date.now();
  const expiresAt = tokenData.expires_in
    ? new Date(now + Number(tokenData.expires_in) * 1000).toISOString()
    : decodeJwtExpiry(tokenData.access_token) || existing.expiresAt || null;

  return {
    ...existing,
    accessToken: tokenData.access_token || existing.accessToken,
    refreshToken: tokenData.refresh_token || existing.refreshToken,
    idToken: tokenData.id_token || existing.idToken || null,
    tokenType: tokenData.token_type || existing.tokenType || 'Bearer',
    expiresAt,
    tokenDate: new Date(now).toISOString(),
    savedAt: new Date(now).toISOString(),
  };
}

function loadTeslaSession(sessionPath) {
  if (!sessionPath || !fs.existsSync(sessionPath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  } catch {
    return null;
  }
}

function saveTeslaSession(sessionPath, session) {
  ensureParentDir(sessionPath);
  fs.writeFileSync(sessionPath, `${JSON.stringify(session, null, 2)}\n`, 'utf8');
}

function accessTokenExpiresWithin(session, withinMs = 60_000) {
  if (!session?.expiresAt) {
    return true;
  }
  const expiresMs = Date.parse(session.expiresAt);
  if (Number.isNaN(expiresMs)) {
    return true;
  }
  return expiresMs - Date.now() <= withinMs;
}

module.exports = {
  decodeJwtExpiry,
  sessionFromTokenResponse,
  loadTeslaSession,
  saveTeslaSession,
  accessTokenExpiresWithin,
};
