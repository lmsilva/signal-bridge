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
    instructions: [
      'docker compose stop alexa-broadcast-bridge',
      'PROXY_OWN_IP=YOUR_NAS_IP docker compose -f docker-compose.auth.yml up',
      'Open http://YOUR_NAS_IP:3456/ in your browser and log in',
      'Press Ctrl+C when you see Authentication complete',
      'docker compose up -d',
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
  clearAuthStatus,
  readAuthStatus,
};
