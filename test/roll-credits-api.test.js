const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createWebServer } = require('../src/web-server');

const PASSWORD = 'roll-credits-test-password';
const silentLog = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

function makeWebRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roll-credits-web-'));
  fs.writeFileSync(path.join(root, 'index.html'), 'test');
  fs.mkdirSync(path.join(root, 'admin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'admin', 'index.html'), 'admin');
  fs.writeFileSync(path.join(root, 'admin', 'login.html'), 'login');
  return root;
}

function request(base, route, {
  method = 'GET',
  body,
  rawBody,
  cookie,
  omitContentLength = false,
  headers = {},
} = {}) {
  return new Promise((resolve, reject) => {
    const data = rawBody === undefined
      ? (body === undefined ? null : Buffer.from(JSON.stringify(body)))
      : Buffer.from(rawBody);
    const req = http.request(`${base}${route}`, {
      method,
      agent: false,
      headers: {
        ...(data ? {
          'Content-Type': rawBody === undefined ? 'application/json' : 'application/octet-stream',
          ...(!omitContentLength ? { 'Content-Length': data.length } : {}),
        } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          // Non-JSON responses are asserted through text.
        }
        resolve({ status: res.statusCode, headers: res.headers, text, body: parsed });
      });
    });
    req.once('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function startServer({ env = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roll-credits-api-'));
  const config = {
    ROOT: root,
    env,
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
  });
  const server = await webServer.start();
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await request(base, '/api/admin/login', {
    method: 'POST',
    body: { password: PASSWORD },
  });
  const rawCookie = Array.isArray(login.headers['set-cookie'])
    ? login.headers['set-cookie'][0]
    : login.headers['set-cookie'];
  return {
    root,
    webServer,
    base,
    cookie: String(rawCookie).split(';')[0],
  };
}

function readSseHello(base, cookie) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}/api/roll-credits/events`, {
      agent: false,
      headers: { Cookie: cookie },
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => {
        text += chunk.toString('utf8');
        if (text.includes('data: {"reason":"hello"}')) {
          req.destroy();
          resolve({ status: res.statusCode, text });
        }
      });
    });
    req.once('error', (error) => {
      if (error.code !== 'ECONNRESET') reject(error);
    });
    req.end();
  });
}

test('Roll Credits admin APIs create, list, configure, stream, and bulk delete', async (t) => {
  const app = await startServer();
  t.after(() => app.webServer.stop());

  const unauthorised = await request(app.base, '/api/roll-credits/games', {
    method: 'POST',
    body: { title: 'Nope', system: 'pc' },
  });
  assert.equal(unauthorised.status, 401);

  const first = await request(app.base, '/api/roll-credits/games', {
    method: 'POST',
    cookie: app.cookie,
    body: { title: 'Chrono Trigger', system: 'snes', beatenDateUnknown: true },
  });
  assert.equal(first.status, 201);
  assert.equal(first.body.game.title, 'Chrono Trigger');

  const second = await request(app.base, '/api/roll-credits/games', {
    method: 'POST',
    cookie: app.cookie,
    body: { title: 'Portal 2', system: 'pc', beatenAt: '2026-08-22' },
  });
  assert.equal(second.status, 201);

  const update = await request(
    app.base,
    `/api/roll-credits/games/${first.body.game.id}`,
    {
      method: 'PUT',
      cookie: app.cookie,
      body: { beatenWith: 'a friend' },
    },
  );
  assert.equal(update.status, 200);
  assert.equal(update.body.game.beatenWith, 'a friend');

  const videoBytes = Buffer.from('test-video');
  const upload = await request(
    app.base,
    `/api/roll-credits/games/${first.body.game.id}/media/video-upload`,
    {
      method: 'PUT',
      cookie: app.cookie,
      rawBody: videoBytes,
      headers: { 'Content-Type': 'video/mp4' },
    },
  );
  assert.equal(upload.status, 201);
  assert.equal(upload.body.media.status, 'ready');

  const served = await request(app.base, `/roll-credits-media/${upload.body.media.path}`);
  assert.equal(served.status, 200);
  assert.equal(served.text, videoBytes.toString());
  assert.match(served.headers['cache-control'], /immutable/);

  const mediaDelete = await request(
    app.base,
    `/api/roll-credits/games/${first.body.game.id}/media/${upload.body.media.id}`,
    { method: 'DELETE', cookie: app.cookie },
  );
  assert.equal(mediaDelete.status, 200);
  assert.equal(
    fs.existsSync(path.join(app.root, 'data', 'roll-credits-media', upload.body.media.path)),
    false,
  );

  const list = await request(app.base, '/api/roll-credits/games?sort=title&dir=asc', {
    cookie: app.cookie,
  });
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.games.map((game) => game.title), ['Chrono Trigger', 'Portal 2']);

  const settings = await request(app.base, '/api/roll-credits/settings', {
    method: 'POST',
    cookie: app.cookie,
    body: {
      display: { secondsPerGame: 20 },
      limits: { maxVideoBytes: 3 },
    },
  });
  assert.equal(settings.status, 200);
  assert.equal(settings.body.settings.display.secondsPerGame, 20);

  const oversized = await request(
    app.base,
    `/api/roll-credits/games/${first.body.game.id}/media/video-upload`,
    {
      method: 'PUT',
      cookie: app.cookie,
      rawBody: Buffer.from('four'),
      omitContentLength: true,
      headers: { 'Content-Type': 'video/mp4' },
    },
  );
  assert.equal(oversized.status, 413);

  const settingsGet = await request(app.base, '/api/roll-credits/settings', {
    cookie: app.cookie,
  });
  assert.equal(settingsGet.body.credentials.hasCredentials, false);
  assert.equal(settingsGet.body.diskUsage.totalBytes, 0);

  const systems = await request(app.base, '/api/roll-credits/systems', {
    cookie: app.cookie,
  });
  assert.equal(systems.status, 200);
  assert.ok(systems.body.systems.some((system) => system.id === 'snes'));
  assert.ok(Array.isArray(systems.body.usedSystems));
  assert.ok(systems.body.usedSystems.every((system) => system.count > 0));
  assert.ok(systems.body.usedSystems.some((system) => system.id === first.body.game.system));

  const hello = await readSseHello(app.base, app.cookie);
  assert.equal(hello.status, 200);
  assert.match(hello.text, /event: roll-credits/);

  const missingMedia = await request(app.base, '/roll-credits-media/rc_missing/nope.jpg');
  assert.equal(missingMedia.status, 404);

  const bulk = await request(app.base, '/api/roll-credits/games/bulk-delete', {
    method: 'POST',
    cookie: app.cookie,
    body: {
      ids: [first.body.game.id, second.body.game.id, 'rc_missing'],
    },
  });
  assert.equal(bulk.status, 200);
  assert.deepEqual(new Set(bulk.body.deleted), new Set([
    first.body.game.id,
    second.body.game.id,
  ]));
  assert.deepEqual(bulk.body.failed, ['rc_missing']);
});

test('Roll Credits credentials endpoint returns 409 when environment owns credentials', async (t) => {
  const app = await startServer({
    env: {
      IGDB_CLIENT_ID: 'environment-client',
      IGDB_CLIENT_SECRET: 'environment-secret',
    },
  });
  t.after(() => app.webServer.stop());

  const status = await request(app.base, '/api/roll-credits/settings', {
    cookie: app.cookie,
  });
  assert.deepEqual(status.body.credentials, {
    hasCredentials: true,
    configured: true,
    source: 'env',
  });

  const save = await request(app.base, '/api/roll-credits/credentials', {
    method: 'POST',
    cookie: app.cookie,
    body: { clientId: 'new-client', clientSecret: 'new-secret' },
  });
  assert.equal(save.status, 409);
  assert.match(save.body.error, /environment variables/i);
});
