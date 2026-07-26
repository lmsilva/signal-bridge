/**
 * Steam OpenID 2.0 link flow for the admin Auth tab.
 * Captures steamId only — API key stays in .env / session separately.
 */

const https = require('https');
const { URL } = require('url');
const { saveSteamSession, clearSteamAuthStatus, markSteamAuthStatus } = require('./steam-session');

const STEAM_OPENID = 'https://steamcommunity.com/openid/login';
const CLAIMED_ID_RE = /^https?:\/\/steamcommunity\.com\/openid\/id\/(\d+)$/i;

function isLoopbackHost(host) {
  const hostname = String(host || '').split(':')[0].trim().toLowerCase();
  return !hostname || hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
}

/** Prefer the browser-facing origin (LAN IP) over Docker's 127.0.0.1. */
function resolvePublicOrigin(config, steamConfig, publicOrigin = null) {
  const candidates = [
    publicOrigin,
    steamConfig?.openIdRealm,
    config.proxyOwnIp
      ? `${config.webServer?.https !== false ? 'https' : 'http'}://${config.proxyOwnIp}:${Number(config.webServer?.port) || 47810}`
      : '',
  ];
  for (const candidate of candidates) {
    const origin = String(candidate || '').trim().replace(/\/$/, '');
    if (!origin) {
      continue;
    }
    try {
      const parsed = new URL(origin.includes('://') ? origin : `https://${origin}`);
      if (!isLoopbackHost(parsed.hostname)) {
        return `${parsed.protocol}//${parsed.host}`;
      }
    } catch {
      // try next
    }
  }
  const httpsOn = config.webServer?.https !== false;
  const port = Number(config.webServer?.port) || 47810;
  const host = config.proxyOwnIp || '127.0.0.1';
  return `${httpsOn ? 'https' : 'http'}://${host}:${port}`;
}

function publicOriginFromRequest(req, config) {
  if (!req?.headers) {
    return null;
  }
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '')
    .split(',')[0]
    .trim();
  if (!host || isLoopbackHost(host)) {
    return null;
  }
  const proto = String(req.headers['x-forwarded-proto'] || (config.webServer?.https !== false ? 'https' : 'http'))
    .split(',')[0]
    .trim() || 'https';
  return `${proto}://${host}`;
}

function buildOpenIdReturnTo(config, steamConfig, publicOrigin = null) {
  const origin = resolvePublicOrigin(config, steamConfig, publicOrigin);
  return `${origin}${steamConfig.openIdReturnPath || '/api/auth/steam/callback'}`;
}

function buildSteamAuthorizeUrl(config, steamConfig, publicOrigin = null) {
  const returnTo = buildOpenIdReturnTo(config, steamConfig, publicOrigin);
  const realm = `${resolvePublicOrigin(config, steamConfig, publicOrigin)}/`;
  const params = new URLSearchParams({
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'checkid_setup',
    'openid.return_to': returnTo,
    'openid.realm': realm,
    'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
    'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
  });
  return `${STEAM_OPENID}?${params.toString()}`;
}

function extractSteamIdFromClaimedId(claimedId) {
  const match = CLAIMED_ID_RE.exec(String(claimedId || '').trim());
  return match ? match[1] : null;
}

function httpsPostForm(urlString, formBody) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const req = https.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(formBody),
      },
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.write(formBody);
    req.end();
  });
}

async function verifySteamOpenIdCallback(query) {
  const mode = String(query['openid.mode'] || '');
  if (mode !== 'id_res') {
    return { ok: false, error: 'OpenID mode was not id_res' };
  }
  const claimedId = query['openid.claimed_id'] || query['openid.identity'];
  const steamId = extractSteamIdFromClaimedId(claimedId);
  if (!steamId) {
    return { ok: false, error: 'Could not parse SteamID from OpenID response' };
  }

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query || {})) {
    if (!key.startsWith('openid.')) {
      continue;
    }
    params.set(key, String(value));
  }
  params.set('openid.mode', 'check_authentication');

  const response = await httpsPostForm(STEAM_OPENID, params.toString());
  if (!/is_valid\s*:\s*true/i.test(response.body || '')) {
    return { ok: false, error: 'Steam OpenID verification failed' };
  }
  return { ok: true, steamId };
}

function completeSteamLink(steamConfig, { steamId, personaName = null } = {}) {
  const existing = require('./steam-session').loadSteamSession(steamConfig.sessionPath) || {};
  const session = saveSteamSession(steamConfig.sessionPath, {
    ...existing,
    steamId: String(steamId),
    personaName: personaName || existing.personaName || null,
    linkedAt: new Date().toISOString(),
  });
  clearSteamAuthStatus(steamConfig);
  markSteamAuthStatus(steamConfig, {
    status: 'ok',
    message: 'Steam account linked',
    steamId: session.steamId,
  });
  return session;
}

function saveSteamApiKey(steamConfig, apiKey) {
  const existing = require('./steam-session').loadSteamSession(steamConfig.sessionPath) || {};
  return saveSteamSession(steamConfig.sessionPath, {
    ...existing,
    apiKey: String(apiKey || '').trim(),
  });
}

module.exports = {
  STEAM_OPENID,
  isLoopbackHost,
  resolvePublicOrigin,
  publicOriginFromRequest,
  buildOpenIdReturnTo,
  buildSteamAuthorizeUrl,
  extractSteamIdFromClaimedId,
  verifySteamOpenIdCallback,
  completeSteamLink,
  saveSteamApiKey,
};
