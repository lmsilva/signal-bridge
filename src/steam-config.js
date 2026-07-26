const path = require('path');

const DEFAULT_ALLOWED_HOSTS = ['MOVIETHEATERPC'];

function parseHostList(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry || '').trim()).filter(Boolean);
  }
  return String(value || '')
    .split(/[,;\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function resolveSteamConfig(config, fileConfig = {}) {
  const steam = fileConfig.steam || config.steam || {};
  const root = config.ROOT || path.resolve(__dirname, '..');
  const sessionRel = steam.sessionFile || 'data/steam-session.json';
  const authStatusRel = steam.authStatusFile || 'data/steam-auth-status.json';
  const allowedHosts = parseHostList(
    process.env.STEAM_ALLOWED_HOSTS || steam.allowedHosts || DEFAULT_ALLOWED_HOSTS,
  );

  return {
    enabled: steam.enabled !== false && process.env.STEAM_ENABLED !== '0',
    apiKey: String(process.env.STEAM_API_KEY || steam.apiKey || '').trim(),
    steamId: String(process.env.STEAM_STEAM_ID || steam.steamId || '').trim(),
    allowedHosts: allowedHosts.length ? allowedHosts : [...DEFAULT_ALLOWED_HOSTS],
    pollIntervalSeconds: Math.max(15, Number(steam.pollIntervalSeconds) || 30),
    presenceStaleSeconds: Math.max(30, Number(steam.presenceStaleSeconds) || 90),
    // Shared secret for the Windows presence reporter (optional; falls back to API key).
    presenceSecret: String(
      process.env.STEAM_PRESENCE_SECRET
      || steam.presenceSecret
      || '',
    ).trim(),
    sessionFile: sessionRel,
    sessionPath: path.resolve(root, sessionRel),
    authStatusFile: authStatusRel,
    authStatusPath: path.resolve(root, authStatusRel),
    openIdRealm: process.env.STEAM_OPENID_REALM || steam.openIdRealm || '',
    openIdReturnPath: steam.openIdReturnPath || '/api/auth/steam/callback',
  };
}

function normalizeHostname(value) {
  return String(value || '')
    .trim()
    .toUpperCase();
}

function isAllowedHost(steam, hostname) {
  const needle = normalizeHostname(hostname);
  if (!needle) {
    return false;
  }
  return (steam.allowedHosts || []).some((entry) => normalizeHostname(entry) === needle);
}

module.exports = {
  DEFAULT_ALLOWED_HOSTS,
  resolveSteamConfig,
  normalizeHostname,
  isAllowedHost,
  parseHostList,
};
