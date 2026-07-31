const fs = require('fs');
const path = require('path');

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function loadPsnSession(sessionPath) {
  if (!sessionPath || !fs.existsSync(sessionPath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  } catch {
    return null;
  }
}

function savePsnSession(sessionPath, session) {
  ensureParentDir(sessionPath);
  const payload = {
    ...session,
    savedAt: new Date().toISOString(),
  };
  fs.writeFileSync(sessionPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

function clearPsnSession(sessionPath) {
  if (sessionPath && fs.existsSync(sessionPath)) {
    fs.unlinkSync(sessionPath);
  }
}

function resolvePsnCredentials(psnConfig) {
  const session = loadPsnSession(psnConfig?.sessionPath) || {};
  const accessToken = String(session.accessToken || '').trim();
  const refreshToken = String(session.refreshToken || '').trim();
  return {
    accessToken,
    refreshToken,
    expiresAt: Number(session.expiresAt) || 0,
    refreshExpiresAt: Number(session.refreshExpiresAt) || 0,
    accountId: String(session.accountId || psnConfig?.accountId || 'me').trim() || 'me',
    onlineId: session.onlineId || null,
    linkedAt: session.linkedAt || null,
    configured: Boolean(accessToken || refreshToken),
    session,
  };
}

function markPsnAuthStatus(psnConfig, details = {}) {
  if (!psnConfig?.authStatusPath) {
    return details;
  }
  const payload = {
    status: details.status || 'ok',
    updatedAt: new Date().toISOString(),
    message: details.message || null,
    reason: details.reason || null,
    ...details,
  };
  ensureParentDir(psnConfig.authStatusPath);
  fs.writeFileSync(psnConfig.authStatusPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

function clearPsnAuthStatus(psnConfig) {
  if (psnConfig?.authStatusPath && fs.existsSync(psnConfig.authStatusPath)) {
    fs.unlinkSync(psnConfig.authStatusPath);
  }
}

function readPsnAuthStatus(psnConfig) {
  if (!psnConfig?.authStatusPath || !fs.existsSync(psnConfig.authStatusPath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(psnConfig.authStatusPath, 'utf8'));
  } catch {
    return null;
  }
}

module.exports = {
  loadPsnSession,
  savePsnSession,
  clearPsnSession,
  resolvePsnCredentials,
  markPsnAuthStatus,
  clearPsnAuthStatus,
  readPsnAuthStatus,
};
