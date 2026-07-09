const fs = require('fs');
const path = require('path');

function markTeslaReauthRequired(fleet, details = {}) {
  const payload = {
    status: 'reauth_required',
    updatedAt: new Date().toISOString(),
    message: details.message || 'Tesla session expired or invalid',
    reason: details.reason || 'unknown',
    instructions: [
      'npm run tesla-auth',
      'Pair virtual key if needed: https://www.tesla.com/_ak/YOUR-DOMAIN',
    ],
    ...details,
  };

  fs.mkdirSync(path.dirname(fleet.authStatusPath), { recursive: true });
  fs.writeFileSync(fleet.authStatusPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

function markTeslaReauthRecommended(fleet, details = {}) {
  const payload = {
    status: 'reauth_recommended',
    updatedAt: new Date().toISOString(),
    message: details.message || 'Tesla token refresh failed — re-auth soon',
    reason: details.reason || 'refresh_failed',
    instructions: ['npm run tesla-auth'],
    ...details,
  };

  fs.mkdirSync(path.dirname(fleet.authStatusPath), { recursive: true });
  fs.writeFileSync(fleet.authStatusPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

function clearTeslaAuthStatus(fleet) {
  if (fleet?.authStatusPath && fs.existsSync(fleet.authStatusPath)) {
    fs.unlinkSync(fleet.authStatusPath);
  }
}

function readTeslaAuthStatus(fleet) {
  if (!fleet?.authStatusPath || !fs.existsSync(fleet.authStatusPath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(fleet.authStatusPath, 'utf8'));
}

module.exports = {
  markTeslaReauthRequired,
  markTeslaReauthRecommended,
  clearTeslaAuthStatus,
  readTeslaAuthStatus,
};
