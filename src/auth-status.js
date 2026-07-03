const fs = require('fs');
const path = require('path');

function authStatusPath(config) {
  return path.join(path.dirname(config.sessionPath), 'auth-status.json');
}

function markReauthRequired(config, details = {}) {
  const payload = {
    status: 'reauth_required',
    updatedAt: new Date().toISOString(),
    message: details.message || 'Amazon session expired or invalid',
    reason: details.reason || 'unknown',
    category: details.category || null,
    likelyCause: details.likelyCause || null,
    sessionMeta: details.sessionMeta || null,
    journalPath: details.journalPath || null,
    recentJournal: details.recentJournal || null,
    instructions: [
      'PROXY_OWN_IP=YOUR_NAS_IP ./reauth.sh',
      'Open http://YOUR_NAS_IP:3456/ in your browser and log in',
      'Press Ctrl+C when you see Authentication complete',
    ],
    ...details,
  };

  fs.writeFileSync(authStatusPath(config), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

function markReauthRecommended(config, details = {}) {
  const payload = {
    status: 'reauth_recommended',
    updatedAt: new Date().toISOString(),
    message: details.message || 'Amazon access token is aging without rotation — re-auth soon to avoid outage',
    reason: details.reason || 'token_rotation_stalled',
    category: details.category || 'token_rotation_stalled',
    likelyCause: details.likelyCause || 'Automatic refresh is not issuing new tokens; full login is required before the session dies.',
    sessionMeta: details.sessionMeta || null,
    journalPath: details.journalPath || null,
    instructions: [
      'PROXY_OWN_IP=YOUR_NAS_IP ./reauth.sh',
      'Open http://YOUR_NAS_IP:3456/ in your browser and log in',
      'Press Ctrl+C when you see Authentication complete',
    ],
    ...details,
  };

  fs.writeFileSync(authStatusPath(config), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

function clearAuthStatus(config) {
  const filePath = authStatusPath(config);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function readAuthStatus(config) {
  const filePath = authStatusPath(config);
  if (!fs.existsSync(filePath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

module.exports = {
  markReauthRequired,
  markReauthRecommended,
  clearAuthStatus,
  readAuthStatus,
};
