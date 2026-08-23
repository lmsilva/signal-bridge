const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  refreshSession,
  getValidAccessToken,
  isRefreshTokenRejected,
  _resetRefreshLockForTests,
} = require('../src/tesla-token-refresh');
const { createTeslaSessionKeepAlive } = require('../src/tesla-session-keepalive');
const {
  markTeslaReauthRequired,
  readTeslaAuthStatus,
  clearTeslaAuthStatus,
} = require('../src/tesla-auth-status');

function tempFleet() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tesla-refresh-'));
  const sessionPath = path.join(root, 'tesla-session.json');
  const authStatusPath = path.join(root, 'tesla-auth-status.json');
  return {
    root,
    sessionPath,
    authStatusPath,
    clientId: 'cid',
    clientSecret: 'sec',
    tokenUrl: 'https://auth.tesla.example/oauth2/v3/token',
    fleetApiBase: 'https://fleet.example',
  };
}

function writeSession(fleet, session) {
  fs.writeFileSync(fleet.sessionPath, `${JSON.stringify(session, null, 2)}\n`);
}

test('isRefreshTokenRejected matches Tesla rotation errors', () => {
  assert.equal(isRefreshTokenRejected({
    status: 401,
    message: 'The refresh_token is invalid',
  }), true);
  assert.equal(isRefreshTokenRejected({
    status: 400,
    message: 'nope',
  }), false);
});

test('refreshSession is single-flight and clears sticky reauth', async () => {
  _resetRefreshLockForTests();
  const fleet = tempFleet();
  writeSession(fleet, {
    accessToken: 'old-access',
    refreshToken: 'refresh-1',
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  });
  markTeslaReauthRequired(fleet, { message: 'The refresh_token is invalid' });
  assert.ok(readTeslaAuthStatus(fleet));

  let calls = 0;
  const originalFetch = global.fetch;
  global.fetch = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 40));
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        access_token: 'new-access',
        refresh_token: 'refresh-2',
        expires_in: 3600,
        token_type: 'Bearer',
      }),
    };
  };
  try {
    const [a, b] = await Promise.all([
      refreshSession(fleet, { reason: 'a' }),
      getValidAccessToken(fleet, { forceRefresh: true }),
    ]);
    assert.equal(calls, 1);
    assert.equal(a.accessToken, 'new-access');
    assert.equal(b.accessToken, 'new-access');
    assert.equal(JSON.parse(fs.readFileSync(fleet.sessionPath, 'utf8')).refreshToken, 'refresh-2');
    assert.equal(readTeslaAuthStatus(fleet), null);
  } finally {
    global.fetch = originalFetch;
    fs.rmSync(fleet.root, { recursive: true, force: true });
    _resetRefreshLockForTests();
  }
});

test('refreshSession recovers when disk already has a rotated token', async () => {
  _resetRefreshLockForTests();
  const fleet = tempFleet();
  writeSession(fleet, {
    accessToken: 'stale',
    refreshToken: 'refresh-old',
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  });
  markTeslaReauthRequired(fleet, { message: 'The refresh_token is invalid' });

  const originalFetch = global.fetch;
  global.fetch = async () => {
    // Simulate a peer refresh winning the race and saving first.
    writeSession(fleet, {
      accessToken: 'peer-access',
      refreshToken: 'refresh-new',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    return {
      ok: false,
      status: 401,
      text: async () => JSON.stringify({
        error: 'login_required',
        error_description: 'The refresh_token is invalid',
      }),
    };
  };
  try {
    const updated = await refreshSession(fleet, { reason: 'race' });
    assert.equal(updated.accessToken, 'peer-access');
    assert.equal(readTeslaAuthStatus(fleet), null);
  } finally {
    global.fetch = originalFetch;
    fs.rmSync(fleet.root, { recursive: true, force: true });
    _resetRefreshLockForTests();
  }
});

test('keepalive clears stale reauth when access token is still valid', async () => {
  _resetRefreshLockForTests();
  const fleet = tempFleet();
  writeSession(fleet, {
    accessToken: 'good',
    refreshToken: 'refresh-1',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  markTeslaReauthRequired(fleet, { message: 'The refresh_token is invalid' });
  const keepAlive = createTeslaSessionKeepAlive({
    fleet,
    log: { info() {}, warn() {} },
    settings: { pingIntervalMs: 60_000 },
  });
  await keepAlive.refreshIfNeeded('test');
  assert.equal(readTeslaAuthStatus(fleet), null);
  clearTeslaAuthStatus(fleet);
  fs.rmSync(fleet.root, { recursive: true, force: true });
});
