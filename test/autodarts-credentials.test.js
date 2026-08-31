const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAutodartsCredentials } = require('../src/autodarts-credentials');
const {
  createAutodartsApi,
  assertReadOnlyPath,
  FORBIDDEN_WRITE_MARKERS,
  DEFAULT_CLIENT_ID,
  normalizeClientId,
} = require('../src/autodarts-api');
const { createAutodartsAuth } = require('../src/autodarts-auth');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autodarts-auth-'));
}

test('Autodarts HTTP helper blocks write verbs on game paths', () => {
  assert.doesNotThrow(() => assertReadOnlyPath('GET', '/gs/v0/matches/1'));
  assert.doesNotThrow(() => assertReadOnlyPath('POST', '/auth/v1/refresh'));
  assert.doesNotThrow(() => assertReadOnlyPath('POST', '/auth/v1/login'));
  assert.doesNotThrow(() => assertReadOnlyPath('POST', '/auth/v1/device/code'));
  assert.throws(() => assertReadOnlyPath('POST', '/gs/v0/matches/1/start'));
  assert.throws(() => assertReadOnlyPath('DELETE', '/gs/v0/matches/1'));
  assert.throws(() => assertReadOnlyPath('POST', '/bs/v0/boards/1/players'));
  const api = createAutodartsApi({ accessTokenProvider: async () => 't' });
  assert.equal(typeof api.getBoards, 'function');
  assert.equal(typeof api.startMatch, 'undefined');
  assert.equal(typeof api.undo, 'undefined');
  assert.ok(FORBIDDEN_WRITE_MARKERS.includes('/start'));
  assert.equal(DEFAULT_CLIENT_ID, 'darts-caller');
  assert.equal(normalizeClientId('developer-darts-caller'), 'darts-caller');
});

test('device-link poll stores encrypted tokens; password never persisted', async () => {
  const root = tempRoot();
  const credentials = createAutodartsCredentials({
    ROOT: root,
    autodartsCredentialsPath: path.join(root, 'creds.json'),
    env: {},
  });
  let pollCount = 0;
  const api = {
    startDeviceCode: async ({ clientId }) => {
      assert.equal(clientId, 'darts-caller');
      return {
        ok: true,
        status: 200,
        json: {
          device_code: 'dc',
          user_code: 'ABCD',
          verification_uri: 'https://auth.autodarts.com/link',
          interval: 0.05,
          expires_in: 120,
        },
      };
    },
    pollDeviceToken: async () => {
      pollCount += 1;
      if (pollCount < 2) {
        return { ok: false, status: 400, json: { error: 'authorization_pending' } };
      }
      return {
        ok: true,
        status: 200,
        json: {
          access_token: 'access-1',
          refresh_token: 'refresh-1',
          expires_in: 300,
        },
      };
    },
    userInfo: async () => ({
      ok: true,
      status: 200,
      json: { sub: 'user-1', preferred_username: 'TRASHPANDA' },
    }),
    refreshWithAutodarts: async () => ({ ok: false, status: 401, json: {} }),
    passwordLogin: async () => ({ ok: false, status: 401, json: {} }),
  };
  const auth = createAutodartsAuth({ credentials, api, env: {}, now: () => Date.now() });
  const begin = await auth.beginDeviceLink();
  assert.equal(begin.ok, true);
  assert.equal(begin.userCode, 'ABCD');
  for (let i = 0; i < 40 && !credentials.load().refreshToken; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const stored = credentials.load();
  assert.equal(stored.refreshToken, 'refresh-1');
  assert.equal(stored.userName, 'TRASHPANDA');
  assert.equal(stored.userId, 'user-1');
  assert.ok(!JSON.stringify(stored).includes('password'));
});

test('password login stores tokens; env blocks overwrite', async () => {
  const root = tempRoot();
  const credentials = createAutodartsCredentials({
    ROOT: root,
    autodartsCredentialsPath: path.join(root, 'creds.json'),
    env: {},
  });
  const api = {
    passwordLogin: async ({ email, password, clientId }) => {
      assert.equal(email, 'a@b.c');
      assert.equal(password, 'secret');
      assert.equal(clientId, 'darts-caller');
      return {
        ok: true,
        status: 200,
        json: { access_token: 'a', refresh_token: 'r', expires_in: 60 },
      };
    },
    userInfo: async () => ({ ok: true, status: 200, json: { sub: 'u', preferred_username: 'X' } }),
    startDeviceCode: async () => ({ ok: false }),
    pollDeviceToken: async () => ({ ok: false }),
    refreshWithAutodarts: async () => ({ ok: false }),
  };
  const auth = createAutodartsAuth({ credentials, api, env: {} });
  const ok = await auth.loginWithPassword({ email: 'a@b.c', password: 'secret' });
  assert.equal(ok.ok, true);
  assert.equal(credentials.load().refreshToken, 'r');

  const blocked = createAutodartsCredentials({
    ROOT: root,
    autodartsCredentialsPath: path.join(root, 'creds2.json'),
    env: { AUTODARTS_EMAIL: 'e@x.com', AUTODARTS_PASSWORD: 'p' },
  });
  const authEnv = createAutodartsAuth({
    credentials: blocked,
    api,
    env: { AUTODARTS_EMAIL: 'e@x.com', AUTODARTS_PASSWORD: 'p' },
  });
  const refused = await authEnv.loginWithPassword({ email: 'other', password: 'x' });
  assert.equal(refused.status, 409);
});

test('password login works without a saved client secret', async () => {
  const root = tempRoot();
  const credentials = createAutodartsCredentials({
    ROOT: root,
    autodartsCredentialsPath: path.join(root, 'creds.json'),
    env: {},
  });
  assert.equal(credentials.resolveOauthClient().clientId, 'darts-caller');
  assert.equal(credentials.resolveOauthClient().clientSecret, '');
  const auth = createAutodartsAuth({
    credentials,
    api: {
      passwordLogin: async () => ({
        ok: true,
        json: { access_token: 'a', refresh_token: 'r', expires_in: 60 },
      }),
      userInfo: async () => ({ ok: true, json: { sub: 'u' } }),
    },
    env: {},
  });
  const result = await auth.loginWithPassword({ email: 'a@b.c', password: 'x' });
  assert.equal(result.ok, true);
});

test('oauth client save encrypts optional secret; maps legacy client id', () => {
  const root = tempRoot();
  const credentials = createAutodartsCredentials({
    ROOT: root,
    autodartsCredentialsPath: path.join(root, 'creds.json'),
    env: {},
  });
  assert.equal(credentials.saveOauthClient({
    clientId: 'developer-darts-caller',
    clientSecret: 's3cret',
  }).ok, true);
  assert.equal(credentials.resolveOauthClient().clientId, 'darts-caller');
  assert.equal(credentials.resolveOauthClient().clientSecret, 's3cret');
  const disk = JSON.parse(fs.readFileSync(credentials.credentialsPath, 'utf8'));
  assert.notEqual(disk.clientSecret, 's3cret');
  assert.equal(credentials.oauthStatus().hasClientSecret, true);

  assert.equal(credentials.saveOauthClient({
    clientId: 'darts-caller',
    clientSecret: '',
  }).ok, true);
  assert.equal(credentials.resolveOauthClient().clientSecret, '');

  const envBlocked = createAutodartsCredentials({
    ROOT: root,
    autodartsCredentialsPath: path.join(root, 'creds-env.json'),
    env: { AUTODARTS_CLIENT_ID: 'env-id', AUTODARTS_CLIENT_SECRET: 'env-secret' },
  });
  const refused = envBlocked.saveOauthClient({ clientId: 'x', clientSecret: 'y' });
  assert.equal(refused.status, 409);
});

test('failed refresh sets re-link flag', async () => {
  const root = tempRoot();
  const credentials = createAutodartsCredentials({
    ROOT: root,
    autodartsCredentialsPath: path.join(root, 'creds.json'),
    env: {},
  });
  credentials.save({
    refreshToken: 'stale',
    userId: 'u',
    userName: 'X',
  });
  const api = {
    refreshWithAutodarts: async () => ({
      ok: false,
      status: 401,
      json: { error: { code: 'invalid_token', message: 'invalid or expired refresh token' } },
    }),
    passwordLogin: async () => ({ ok: false }),
    userInfo: async () => ({ ok: false }),
    startDeviceCode: async () => ({ ok: false }),
    pollDeviceToken: async () => ({ ok: false }),
  };
  const auth = createAutodartsAuth({ credentials, api, env: {} });
  await assert.rejects(() => auth.refreshAccessToken());
  assert.equal(credentials.load().needsRelink, true);
  assert.equal(auth.statusSnapshot().linked, false, 'a rejected refresh is not a working link');
  assert.equal(auth.statusSnapshot().hasCredentials, true);
});

test('beginDeviceLink does not claim linked from a stale refresh token', async () => {
  const root = tempRoot();
  const credentials = createAutodartsCredentials({
    ROOT: root,
    autodartsCredentialsPath: path.join(root, 'creds.json'),
    env: {},
  });
  credentials.save({
    refreshToken: 'dead',
    userId: 'u',
    userName: 'trashpanda',
    needsRelink: true,
    unavailableReason: 'invalid or expired refresh token',
  });
  const api = {
    startDeviceCode: async () => ({
      ok: true,
      status: 200,
      json: {
        device_code: 'dc',
        user_code: 'WXYZ',
        verification_uri: 'https://auth.autodarts.com/link',
        interval: 5,
        expires_in: 600,
      },
    }),
    pollDeviceToken: async () => ({
      ok: false,
      status: 400,
      json: { error: 'authorization_pending' },
    }),
    refreshWithAutodarts: async () => ({ ok: false }),
    passwordLogin: async () => ({ ok: false }),
    userInfo: async () => ({ ok: false }),
  };
  const auth = createAutodartsAuth({ credentials, api, env: {} });
  const begin = await auth.beginDeviceLink();
  assert.equal(begin.ok, true);
  assert.equal(begin.linked, false);
  assert.equal(begin.deviceLinkPending, true);
  assert.equal(begin.userCode, 'WXYZ');
  assert.equal(auth.statusSnapshot().deviceLinkPending, true);
  auth.stopDevicePoll();
});

test('token keep-alive refreshes before the access token expires', async () => {
  const root = tempRoot();
  const credentials = createAutodartsCredentials({
    ROOT: root,
    autodartsCredentialsPath: path.join(root, 'creds.json'),
    env: {},
  });
  credentials.save({
    refreshToken: 'refresh-0',
    userId: 'u',
    userName: 'X',
  });
  let clock = Date.parse('2026-08-31T02:00:00Z');
  const timers = [];
  let refreshCount = 0;
  const api = {
    refreshWithAutodarts: async (token) => {
      refreshCount += 1;
      assert.equal(token, refreshCount === 1 ? 'refresh-0' : `refresh-${refreshCount - 1}`);
      return {
        ok: true,
        status: 200,
        json: {
          access_token: `access-${refreshCount}`,
          refresh_token: `refresh-${refreshCount}`,
          expires_in: 900,
          refresh_expires_in: 3 * 24 * 60 * 60,
        },
      };
    },
    passwordLogin: async () => ({ ok: false }),
    userInfo: async () => ({ ok: false }),
    startDeviceCode: async () => ({ ok: false }),
    pollDeviceToken: async () => ({ ok: false }),
  };
  const auth = createAutodartsAuth({
    credentials,
    api,
    env: {},
    now: () => clock,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      if (timer) timer.cancelled = true;
    },
  });
  auth.startKeepAlive();
  assert.equal(timers.length, 1, 'boot schedules a keep-alive');
  await timers[0].fn();
  assert.equal(refreshCount, 1);
  assert.equal(credentials.load().refreshToken, 'refresh-1');
  assert.equal(credentials.load().needsRelink, false);
  assert.ok(credentials.load().refreshExpiresAt);
  assert.ok(timers.some((t) => !t.cancelled), 'keep-alive reschedules after a successful refresh');
  auth.stopKeepAlive();
});

test('env password recovers an expired refresh token without marking needsRelink', async () => {
  const root = tempRoot();
  const credentials = createAutodartsCredentials({
    ROOT: root,
    autodartsCredentialsPath: path.join(root, 'creds.json'),
    env: {
      AUTODARTS_EMAIL: 'a@b.c',
      AUTODARTS_PASSWORD: 'secret',
    },
  });
  credentials.save({
    refreshToken: 'stale',
    userId: 'u',
    userName: 'X',
  });
  const api = {
    refreshWithAutodarts: async () => ({
      ok: false,
      status: 401,
      json: { error: { code: 'invalid_token', message: 'invalid or expired refresh token' } },
    }),
    passwordLogin: async ({ email, password }) => {
      assert.equal(email, 'a@b.c');
      assert.equal(password, 'secret');
      return {
        ok: true,
        status: 200,
        json: {
          access_token: 'access-new',
          refresh_token: 'refresh-new',
          expires_in: 900,
        },
      };
    },
    userInfo: async () => ({
      ok: true,
      status: 200,
      json: { sub: 'u', preferred_username: 'X' },
    }),
    startDeviceCode: async () => ({ ok: false }),
    pollDeviceToken: async () => ({ ok: false }),
  };
  const auth = createAutodartsAuth({
    credentials,
    api,
    env: {
      AUTODARTS_EMAIL: 'a@b.c',
      AUTODARTS_PASSWORD: 'secret',
    },
  });
  const token = await auth.refreshAccessToken();
  assert.equal(token, 'access-new');
  assert.equal(credentials.load().refreshToken, 'refresh-new');
  assert.equal(credentials.load().needsRelink, false);
  assert.equal(auth.statusSnapshot().linked, true);
});

test('auth/v1 password + device POSTs use JSON bodies on api.autodarts.io', async () => {
  const calls = [];
  const api = createAutodartsApi({
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method, body: options.body });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          device_code: 'dc',
          user_code: 'UC',
          verification_uri: 'https://auth.autodarts.com/link',
          interval: 5,
          expires_in: 600,
          access_token: 'a',
          refresh_token: 'r',
        }),
        headers: new Map(),
      };
    },
  });
  await api.startDeviceCode({ clientId: 'developer-darts-caller' });
  await api.passwordLogin({ email: 'a@b.c', password: 'p' });
  await api.refreshWithAutodarts('refresh-x');
  assert.equal(calls.length, 3);
  assert.match(calls[0].url, /api\.autodarts\.io\/auth\/v1\/device\/code$/);
  assert.match(calls[1].url, /api\.autodarts\.io\/auth\/v1\/login$/);
  assert.match(calls[2].url, /api\.autodarts\.io\/auth\/v1\/refresh$/);
  assert.equal(JSON.parse(calls[0].body).client_id, 'darts-caller');
  assert.equal(JSON.parse(calls[1].body).email, 'a@b.c');
  assert.equal(JSON.parse(calls[2].body).refresh_token, 'refresh-x');
  assert.doesNotMatch(calls[0].url, /login\.autodarts\.io/);
});
