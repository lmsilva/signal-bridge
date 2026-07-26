const fs = require('fs');

function ensureParentDir(filePath) {
  fs.mkdirSync(require('path').dirname(filePath), { recursive: true });
}

function loadSteamSession(sessionPath) {
  if (!sessionPath || !fs.existsSync(sessionPath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  } catch {
    return null;
  }
}

function saveSteamSession(sessionPath, session) {
  ensureParentDir(sessionPath);
  const payload = {
    ...session,
    savedAt: new Date().toISOString(),
  };
  fs.writeFileSync(sessionPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

function resolveSteamCredentials(steamConfig) {
  const session = loadSteamSession(steamConfig.sessionPath) || {};
  // .env always wins over a key pasted in admin (session file). Admin never
  // rewrites .env — it only stores apiKey in data/steam-session.json.
  const envKey = String(process.env.STEAM_API_KEY || '').trim();
  const sessionKey = String(session.apiKey || '').trim();
  const configKey = String(steamConfig?.apiKey || '').trim();
  const apiKey = envKey || sessionKey || configKey;
  let apiKeySource = null;
  if (envKey) {
    apiKeySource = 'env';
  } else if (sessionKey) {
    apiKeySource = 'session';
  } else if (configKey) {
    apiKeySource = 'config';
  }
  const steamId = String(session.steamId || steamConfig?.steamId || '').trim();
  return {
    apiKey,
    steamId,
    apiKeySource,
    personaName: session.personaName || null,
    linkedAt: session.linkedAt || null,
    session,
  };
}

function markSteamAuthStatus(steamConfig, details = {}) {
  if (!steamConfig?.authStatusPath) {
    return details;
  }
  const payload = {
    status: details.status || 'ok',
    updatedAt: new Date().toISOString(),
    message: details.message || null,
    reason: details.reason || null,
    ...details,
  };
  ensureParentDir(steamConfig.authStatusPath);
  fs.writeFileSync(steamConfig.authStatusPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

function clearSteamAuthStatus(steamConfig) {
  if (steamConfig?.authStatusPath && fs.existsSync(steamConfig.authStatusPath)) {
    fs.unlinkSync(steamConfig.authStatusPath);
  }
}

function readSteamAuthStatus(steamConfig) {
  if (!steamConfig?.authStatusPath || !fs.existsSync(steamConfig.authStatusPath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(steamConfig.authStatusPath, 'utf8'));
  } catch {
    return null;
  }
}

module.exports = {
  loadSteamSession,
  saveSteamSession,
  resolveSteamCredentials,
  markSteamAuthStatus,
  clearSteamAuthStatus,
  readSteamAuthStatus,
};
