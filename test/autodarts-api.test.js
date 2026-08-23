const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { COMMANDS, assertValid, createCommandRegistry } = require('../src/command-registry');
const { createWebServer } = require('../src/web-server');
const { createAutodartsService } = require('../src/autodarts-service');

const PASSWORD = 'autodarts-test-password';
const silentLog = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

function makeWebRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autodarts-web-'));
  fs.writeFileSync(path.join(root, 'index.html'), 'test');
  fs.mkdirSync(path.join(root, 'admin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'admin', 'index.html'), 'admin');
  fs.writeFileSync(path.join(root, 'admin', 'login.html'), 'login');
  return root;
}

function request(base, route, { method = 'GET', body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(`${base}${route}`, {
      method,
      agent: false,
      headers: {
        ...(data ? {
          'Content-Type': 'application/json',
          'Content-Length': data.length,
        } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
        resolve({ status: res.statusCode, body: parsed, headers: res.headers, text });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('Autodarts command descriptors are valid and unique', () => {
  assertValid(COMMANDS);
  const ids = COMMANDS.filter((row) => row.id.startsWith('autodarts.')).map((row) => row.id);
  assert.deepEqual(ids.sort(), ['autodarts.dashboard', 'autodarts.last-match', 'autodarts.now'].sort());
  assert.equal(COMMANDS.find((row) => row.id === 'autodarts.now').group, 'Autodarts');
});

test('content checks and duration estimators', () => {
  const registry = createCommandRegistry({
    getAutodartsStatus: () => ({
      hasLiveMatch: true,
      hasArchive: true,
      settings: {
        lastMatch: { displaySeconds: 90 },
        dashboard: { displaySeconds: 120 },
      },
    }),
  });
  assert.equal(registry.hasContent('autodarts.now'), true);
  assert.equal(registry.hasContent('autodarts.last-match'), true);
  assert.equal(registry.estimateDuration('autodarts.dashboard'), 120);

  const empty = createCommandRegistry({
    getAutodartsStatus: () => ({ hasLiveMatch: false, hasArchive: false }),
  });
  assert.equal(empty.hasContent('autodarts.now'), false);
  assert.equal(empty.hasContent('autodarts.dashboard'), false);
});

test('Autodarts admin routes are gated; no public media routes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autodarts-api-'));
  const autodarts = createAutodartsService({
    config: {
      ROOT: root,
      autodartsSettingsPath: path.join(root, 's.json'),
      autodartsCredentialsPath: path.join(root, 'c.json'),
      autodartsArchivePath: path.join(root, 'm'),
      autodartsPlayersPath: path.join(root, 'p.json'),
    },
    log: silentLog,
    sendUdpPayload: () => {},
    dependencies: {
      WebSocketImpl: null,
      fetchImpl: async () => ({
        ok: false,
        status: 500,
        text: async () => '',
        headers: new Map(),
      }),
    },
  });
  const config = {
    ROOT: root,
    udpBroadcast: { defaultDisplaySeconds: 120 },
    webServer: {
      enabled: true,
      port: 0,
      https: false,
      httpRedirectPort: 0,
      adminPassword: PASSWORD,
      controlAuth: { enabled: false },
    },
    teslaFleet: { enabled: false },
  };
  const webServer = createWebServer({
    config,
    log: silentLog,
    sendUdpPayload() {},
    recordVoiceEvent: async () => {},
    scheduleRestart() {},
    webRoot: makeWebRoot(),
    autodarts,
    getAutodartsStatus: () => autodarts.statusSnapshot(),
  });
  const server = await webServer.start();
  t.after(() => {
    webServer.stop();
    autodarts.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const unauthorized = await request(base, '/api/autodarts/status');
  assert.equal(unauthorized.status, 401);

  const login = await request(base, '/api/admin/login', {
    method: 'POST',
    body: { password: PASSWORD },
  });
  assert.equal(login.status, 200);
  const rawCookie = Array.isArray(login.headers['set-cookie'])
    ? login.headers['set-cookie'][0]
    : login.headers['set-cookie'];
  const cookie = String(rawCookie).split(';')[0];

  const status = await request(base, '/api/autodarts/status', { cookie });
  assert.equal(status.status, 200);
  assert.equal(status.body.ok, true);

  const commands = await request(base, '/api/commands', { cookie });
  const ids = commands.body.commands.map((row) => row.id);
  assert.ok(ids.includes('autodarts.now'));
  assert.ok(ids.includes('autodarts.dashboard'));

  const media = await request(base, '/api/autodarts-images/foo');
  assert.ok([404, 401, 405].includes(media.status));
});
