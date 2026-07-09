const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  markTeslaReauthRequired,
  markTeslaReauthRecommended,
  clearTeslaAuthStatus,
  readTeslaAuthStatus,
} = require('../src/tesla-auth-status');

let tempDir = null;

afterEach(() => {
  if (tempDir && fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  tempDir = null;
});

function fleetConfig() {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tesla-auth-status-'));
  const authStatusPath = path.join(tempDir, 'tesla-auth-status.json');
  return { authStatusPath };
}

test('markTeslaReauthRequired writes reauth_required status', () => {
  const fleet = fleetConfig();
  const payload = markTeslaReauthRequired(fleet, { reason: 'token_invalid' });
  assert.equal(payload.status, 'reauth_required');
  assert.equal(readTeslaAuthStatus(fleet).reason, 'token_invalid');
});

test('clearTeslaAuthStatus removes status file', () => {
  const fleet = fleetConfig();
  markTeslaReauthRecommended(fleet, { reason: 'refresh_failed' });
  assert.ok(fs.existsSync(fleet.authStatusPath));
  clearTeslaAuthStatus(fleet);
  assert.equal(readTeslaAuthStatus(fleet), null);
});
