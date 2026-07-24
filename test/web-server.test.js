const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const httpMod = require('node:http');
const httpsMod = require('node:https');
const {
  createWebServer,
  validatePushUrl,
  resolveStaticPath,
  computeWebBasePath,
} = require('../src/web-server');

// Plain non-pooled requests: global fetch keeps pooled keep-alive sockets per
// origin, and Windows can hand a later test server the same ephemeral port a
// previous server used, making fetch reuse a dead socket (ECONNRESET).
function request(url, { method = 'GET', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const isHttps = String(url).startsWith('https:');
    const transport = isHttps ? httpsMod : httpMod;
    const req = transport.request(url, {
      method,
      agent: false,
      rejectUnauthorized: false,
      headers: data
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
        : {},
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let parsed = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
        resolve({ status: res.statusCode, text, headers: res.headers, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) {
      req.write(data);
    }
    req.end();
  });
}

function makeTempWebRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-root-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<html><body>control page</body></html>');
  fs.writeFileSync(path.join(dir, 'app.js'), 'console.log("app");');
  return dir;
}

function makeConfig(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-data-'));
  return {
    ROOT: dataDir,
    sessionPath: path.join(dataDir, 'alexa-session.json'),
    proxyPort: 3456,
    proxyOwnIp: '127.0.0.1',
    udpBroadcast: { defaultDisplaySeconds: 120 },
    webServer: {
      enabled: true,
      port: 0,
      https: false,
      httpRedirectPort: 0,
      certDir: 'certs',
      // Existing route tests disable PIN unlock; dedicated tests cover controlAuth.
      controlAuth: { enabled: false },
    },
    teslaFleet: {
      enabled: false,
      sessionPath: path.join(dataDir, 'tesla-session.json'),
      authStatusPath: path.join(dataDir, 'tesla-auth-status.json'),
    },
    ...overrides,
  };
}

const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

async function startTestServer(options = {}) {
  const sent = [];
  const recorded = [];
  const webServer = createWebServer({
    config: options.config || makeConfig(),
    log: silentLog,
    sendUdpPayload: (payload) => sent.push(payload),
    recordVoiceEvent: options.recordVoiceEvent
      || (async (event) => { recorded.push(event); }),
    displayRegistry: options.displayRegistry || null,
    deliverTargetedPayload: options.deliverTargetedPayload || null,
    scheduleRestart: () => {},
    webRoot: options.webRoot || makeTempWebRoot(),
  });
  const server = await webServer.start();
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  return { webServer, server, base, sent, recorded };
}

function postJson(base, route, body = {}) {
  return request(`${base}${route}`, { method: 'POST', body });
}

test('validatePushUrl accepts http/https and rejects everything else', () => {
  assert.equal(validatePushUrl('https://example.com/page').ok, true);
  assert.equal(validatePushUrl('  http://example.com  ').url, 'http://example.com');
  assert.equal(validatePushUrl('ftp://example.com').ok, false);
  assert.equal(validatePushUrl('javascript:alert(1)').ok, false);
  assert.equal(validatePushUrl('').ok, false);
  assert.equal(validatePushUrl('http://').ok, false);
});

test('resolveStaticPath blocks path traversal', () => {
  const root = path.join(os.tmpdir(), 'static-root');
  assert.equal(resolveStaticPath(root, '/../secrets.txt'), null);
  assert.equal(resolveStaticPath(root, '/%2e%2e/%2e%2e/etc/passwd'), null);
  assert.equal(resolveStaticPath(root, '/index.html'), path.join(root, 'index.html'));
  assert.equal(resolveStaticPath(root, '/'), path.join(root, 'index.html'));
});

test('computeWebBasePath preserves reverse-proxy mount directories', () => {
  assert.equal(computeWebBasePath('/'), '/');
  assert.equal(computeWebBasePath('/index.html'), '/');
  assert.equal(computeWebBasePath('/signal'), '/signal/');
  assert.equal(computeWebBasePath('/signal/'), '/signal/');
  assert.equal(computeWebBasePath('/signal/index.html'), '/signal/');
  assert.equal(computeWebBasePath('signal'), '/signal/');
});

test('control page HTML uses relative asset URLs for subpath proxies', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/web/index.html'), 'utf8');
  assert.match(html, /createElement\('base'\)/);
  assert.match(html, /href="styles\.css/);
  assert.match(html, /src="app\.js/);
  assert.match(html, /src="logo\.png"/);
  assert.match(html, /href="favicon\.svg"/);
  assert.doesNotMatch(html, /href="\/styles\.css/);
  assert.doesNotMatch(html, /src="\/app\.js/);
  assert.doesNotMatch(html, /src="\/logo\.png"/);
});

test('control page JS resolves API routes against the document base', () => {
  const js = fs.readFileSync(path.join(__dirname, '../src/web/app.js'), 'utf8');
  assert.match(js, /function appUrl\(/);
  assert.match(js, /EventSource\(appUrl\(/);
  assert.match(js, /fetch\(appUrl\(/);
});

test('serves the control page and static assets', async () => {
  const { webServer, base } = await startTestServer();
  try {
    const index = await request(base + '/');
    assert.equal(index.status, 200);
    assert.match(index.text, /control page/);

    const js = await request(base + '/app.js');
    assert.equal(js.status, 200);
    assert.match(js.headers['content-type'], /javascript/);

    const missing = await request(base + '/nope.css');
    assert.equal(missing.status, 404);
  } finally {
    webServer.stop();
  }
});

test('serves real SPA shell with cache-busted relative assets', async () => {
  const realWebRoot = path.join(__dirname, '../src/web');
  const { webServer, base } = await startTestServer({ webRoot: realWebRoot });
  try {
    const index = await request(base + '/');
    assert.equal(index.status, 200);
    assert.match(index.text, /href="styles\.css\?v=\d+(?:\.\d+)?"/);
    assert.match(index.text, /src="app\.js\?v=\d+(?:\.\d+)?"/);
    assert.doesNotMatch(index.text, /href="\/styles\.css/);

    const css = await request(base + '/styles.css');
    assert.equal(css.status, 200);
    assert.match(css.headers['content-type'], /css/);
  } finally {
    webServer.stop();
  }
});

test('tesla push endpoints feed synthetic events into the voice pipeline', async () => {
  const { webServer, base, recorded } = await startTestServer();
  try {
    const dash = await postJson(base, '/api/push/tesla-dashboard');
    assert.equal(dash.status, 202);
    assert.equal(dash.body.ok, true);

    const battery = await postJson(base, '/api/push/tesla-battery', { device: 'iPhone' });
    assert.equal(battery.status, 202);

    assert.equal(recorded.length, 2);
    assert.equal(recorded[0].kind, 'tesla-dashboard');
    assert.equal(recorded[0].trigger, 'web-api');
    assert.equal(recorded[0].device, 'Signal');
    assert.equal(recorded[1].kind, 'tesla-battery');
    assert.equal(recorded[1].device, 'iPhone');
  } finally {
    webServer.stop();
  }
});

test('url push sends web.open payload and tracks browser state', async () => {
  const { webServer, base, sent } = await startTestServer();
  try {
    // Connection-refused local address: payload still sent, reachable false.
    const push = await postJson(base, '/api/push/url', { url: 'http://127.0.0.1:1/board' });
    assert.equal(push.status, 200);
    assert.equal(push.body.sent, true);
    assert.equal(push.body.reachable, false);

    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'web.open');
    assert.equal(sent[0].persistent, true);
    assert.equal(sent[0].web.url, 'http://127.0.0.1:1/board');

    const status = (await request(base + '/api/status')).body;
    assert.equal(status.web.activeUrl, 'http://127.0.0.1:1/board');

    const close = await postJson(base, '/api/push/close-browser');
    assert.equal(close.status, 200);
    assert.equal(sent[1].type, 'web.close');

    const statusAfter = (await request(base + '/api/status')).body;
    assert.equal(statusAfter.web.activeUrl, null);
  } finally {
    webServer.stop();
  }
});

test('url push rejects invalid urls without sending', async () => {
  const { webServer, base, sent } = await startTestServer();
  try {
    const bad = await postJson(base, '/api/push/url', { url: 'notaurl' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.ok, false);
    assert.equal(sent.length, 0);
  } finally {
    webServer.stop();
  }
});

test('system endpoints send reboot and poweroff commands', async () => {
  const { webServer, base, sent } = await startTestServer();
  try {
    const reboot = await postJson(base, '/api/system/reboot');
    assert.equal(reboot.status, 200);
    assert.equal(sent[0].type, 'system.command');
    assert.equal(sent[0].system.action, 'reboot');

    const poweroff = await postJson(base, '/api/system/poweroff');
    assert.equal(poweroff.status, 200);
    assert.equal(sent[1].system.action, 'poweroff');
  } finally {
    webServer.stop();
  }
});

test('status reports alexa and tesla auth state', async () => {
  const { webServer, base } = await startTestServer();
  try {
    const status = (await request(base + '/api/status')).body;
    assert.equal(status.ok, true);
    assert.equal(status.alexa.status, 'ok');
    assert.equal(status.tesla.configured, false);
    assert.equal(status.tesla.hasSession, false);
    assert.equal(status.tesla.status, 'no_session');
  } finally {
    webServer.stop();
  }
});

test('tesla auth start requires configured credentials', async () => {
  const { webServer, base } = await startTestServer();
  try {
    const result = await postJson(base, '/api/auth/tesla/start');
    assert.equal(result.status, 400);
    assert.match(result.body.error, /not configured/);
  } finally {
    webServer.stop();
  }
});

function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = httpMod.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

test('tesla phone oauth flow exchanges callback code and saves session', async () => {
  // Mock Tesla token endpoint.
  const tokenServer = httpMod.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        access_token: 'test-access',
        refresh_token: 'test-refresh',
        expires_in: 3600,
      }));
    });
  });
  await new Promise((resolve) => tokenServer.listen(0, '127.0.0.1', resolve));
  const tokenPort = tokenServer.address().port;

  const callbackPort = await getFreePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tesla-auth-'));
  const sessionPath = path.join(dataDir, 'tesla-session.json');

  // Phone flow uses https:// LAN redirect (Tesla rejects http:// for non-localhost).
  const config = makeConfig({
    ROOT: dataDir,
    teslaFleet: {
      enabled: true,
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: `https://127.0.0.1:${callbackPort}/callback`,
      authorizeUrl: 'https://auth.tesla.com/oauth2/v3/authorize',
      tokenUrl: `http://127.0.0.1:${tokenPort}/token`,
      fleetApiBase: 'https://fleet-api.example.com',
      scopes: 'openid offline_access vehicle_device_data',
      sessionPath,
      authStatusPath: path.join(dataDir, 'tesla-auth-status.json'),
    },
  });

  const { webServer, base } = await startTestServer({ config });
  try {
    const start = await postJson(base, '/api/auth/tesla/start');
    assert.equal(start.status, 200);
    assert.equal(start.body.ok, true);
    assert.match(start.body.authorizeUrl, /^https:\/\/auth\.tesla\.com/);
    assert.match(start.body.redirectUri, /^https:\/\//);

    const state = new URL(start.body.authorizeUrl).searchParams.get('state');
    assert.ok(state);

    // Simulate Tesla redirecting the phone browser to the NAS HTTPS callback.
    const callback = await request(
      `https://127.0.0.1:${callbackPort}/callback?code=auth-code-123&state=${state}`,
    );
    assert.equal(callback.status, 200);
    assert.match(callback.text, /Tesla login complete/);

    const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    assert.equal(session.accessToken, 'test-access');
    assert.equal(session.refreshToken, 'test-refresh');

    const status = (await request(base + '/api/status')).body;
    assert.equal(status.tesla.auth.status, 'success');
    assert.equal(status.tesla.auth.running, false);
  } finally {
    webServer.stop();
    tokenServer.close();
  }
});

test('persistent tesla callback answers before auth starts (proxy-ready)', async () => {
  const callbackPort = await getFreePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tesla-proxy-'));
  const config = makeConfig({
    ROOT: dataDir,
    teslaFleet: {
      enabled: true,
      clientId: 'client-id',
      clientSecret: 'client-secret',
      // Public domain → auto local bind would be :4381; override for the test.
      redirectUri: 'https://fleetapi.example.com/callback',
      callbackListenUri: `http://127.0.0.1:${callbackPort}/callback`,
      authorizeUrl: 'https://auth.tesla.com/oauth2/v3/authorize',
      tokenUrl: 'http://127.0.0.1:1/token',
      fleetApiBase: 'https://fleet-api.example.com',
      scopes: 'openid',
      sessionPath: path.join(dataDir, 'tesla-session.json'),
      authStatusPath: path.join(dataDir, 'tesla-auth-status.json'),
    },
  });

  const { webServer } = await startTestServer({ config });
  try {
    const idle = await request(`http://127.0.0.1:${callbackPort}/callback`);
    assert.equal(idle.status, 200);
    assert.match(idle.text, /No Tesla login in progress/);
  } finally {
    webServer.stop();
  }
});

test('tesla callback rejects state mismatch', async () => {
  const callbackPort = await getFreePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tesla-auth-'));
  const config = makeConfig({
    teslaFleet: {
      enabled: true,
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: `http://127.0.0.1:${callbackPort}/callback`,
      authorizeUrl: 'https://auth.tesla.com/oauth2/v3/authorize',
      tokenUrl: 'http://127.0.0.1:1/token',
      fleetApiBase: 'https://fleet-api.example.com',
      scopes: 'openid',
      sessionPath: path.join(dataDir, 'tesla-session.json'),
      authStatusPath: path.join(dataDir, 'tesla-auth-status.json'),
    },
  });

  const { webServer, base } = await startTestServer({ config });
  try {
    const start = await postJson(base, '/api/auth/tesla/start');
    assert.equal(start.status, 200);

    const callback = await request(
      `http://127.0.0.1:${callbackPort}/callback?code=auth-code-123&state=wrong-state`,
    );
    assert.equal(callback.status, 400);
    assert.match(callback.text, /State mismatch/);

    const status = (await request(base + '/api/status')).body;
    assert.equal(status.tesla.auth.status, 'error');
  } finally {
    webServer.stop();
  }
});

test('control PIN unlock gates input and power', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-pin-'));
  const { createDisplayRegistry } = require('../src/display-registry');
  const registry = createDisplayRegistry({ ROOT: dataDir }, { warn() {}, info() {} });
  registry.upsertFromAnnounce({
    display: { id: 'disp-pin', name: 'Poster', shortId: 'pin1' },
  }, { address: '192.168.0.20' });

  const targeted = [];
  const { webServer, base } = await startTestServer({
    config: makeConfig({
      ROOT: dataDir,
      webServer: {
        enabled: true,
        port: 0,
        https: false,
        httpRedirectPort: 0,
        certDir: 'certs',
        controlAuth: { enabled: true, pinDisplaySeconds: 45, sessionMinutes: 5 },
      },
    }),
    displayRegistry: registry,
    deliverTargetedPayload: (payload, targetId) => {
      const delivery = registry.resolveDelivery(targetId);
      targeted.push({ payload, delivery });
      return delivery;
    },
  });
  try {
    const denied = await postJson(base, '/api/input/key', {
      targetId: 'disp-pin',
      key: 'a',
    });
    assert.equal(denied.status, 401);
    assert.equal(denied.body.code, 'control_auth_required');

    const started = await postJson(base, '/api/displays/auth/start', {
      targetId: 'disp-pin',
    });
    assert.equal(started.status, 200);
    assert.equal(started.body.ok, true);
    assert.equal(started.body.pin, undefined);
    const pinPayload = targeted.find((t) => t.payload.type === 'display.auth');
    assert.ok(pinPayload);
    const pin = pinPayload.payload.auth.pin;

    const bad = await postJson(base, '/api/displays/auth/verify', {
      targetId: 'disp-pin',
      pin: '0000',
    });
    assert.equal(bad.status, 403);
    assert.equal(bad.body.code, 'control_auth_incorrect_pin');
    assert.match(bad.body.error, /Incorrect PIN/);

    const verified = await postJson(base, '/api/displays/auth/verify', {
      targetId: 'disp-pin',
      pin,
    });
    assert.equal(verified.status, 200);
    assert.ok(verified.body.token);

    const okFlash = targeted.filter((t) => t.payload.type === 'display.auth'
      && t.payload.auth?.status === 'ok');
    assert.equal(okFlash.length, 1);
    assert.equal(okFlash[0].payload.displaySeconds, 1);

    const okKey = await postJson(base, '/api/input/key', {
      targetId: 'disp-pin',
      key: 'a',
      controlToken: verified.body.token,
    });
    assert.equal(okKey.status, 200);

    const reboot = await postJson(base, '/api/system/reboot', {
      targetId: 'disp-pin',
      controlToken: verified.body.token,
    });
    assert.equal(reboot.status, 200);
  } finally {
    webServer.stop();
    registry.stop();
  }
});

test('displays list and discover endpoints', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-disp-'));
  const { createDisplayRegistry } = require('../src/display-registry');
  const registry = createDisplayRegistry(
    { ROOT: dataDir, discoverSweepMs: 30 },
    { warn() {}, info() {} },
  );
  registry.upsertFromAnnounce({
    display: { id: 'disp-x', name: 'Living Room' },
  }, { address: '192.168.0.9' });
  registry.upsertFromAnnounce({
    display: { id: 'disp-y', name: 'Offline Room' },
  }, { address: '192.168.0.10' });

  const targeted = [];
  const { webServer, base, sent } = await startTestServer({
    config: makeConfig({ ROOT: dataDir }),
    displayRegistry: registry,
    deliverTargetedPayload: (payload, targetId) => {
      const delivery = registry.resolveDelivery(targetId);
      targeted.push({ payload, delivery });
      return delivery;
    },
  });
  try {
    const list = await request(base + '/api/displays');
    assert.equal(list.status, 200);
    assert.equal(list.body.displays.length, 2);

    // Live client re-announces during the discover sweep window.
    setTimeout(() => {
      registry.upsertFromAnnounce({
        display: { id: 'disp-x', name: 'Living Room' },
      }, { address: '192.168.0.9' });
    }, 5);

    const discover = await postJson(base, '/api/displays/discover');
    assert.equal(discover.status, 200);
    assert.equal(sent.some((p) => p.type === 'display.discover'), true);
    assert.deepEqual(discover.body.removedIds, ['disp-y']);
    assert.equal(discover.body.displays.length, 1);
    assert.equal(discover.body.displays[0].id, 'disp-x');
    assert.equal(registry.list().length, 1);

    const badInput = await postJson(base, '/api/input/pointer', {
      targetId: '*',
      dx: 1,
      dy: 1,
    });
    assert.equal(badInput.status, 400);

    const okInput = await postJson(base, '/api/input/key', {
      targetId: 'disp-x',
      key: 'Tab',
    });
    assert.equal(okInput.status, 200);
    assert.equal(okInput.body.target.id, 'disp-x');
    assert.equal(targeted.at(-1).payload.type, 'input.key');

    // Live list: SSE should emit hello, then announce when registry changes.
    const events = await new Promise((resolve, reject) => {
      const url = new URL(base + '/api/displays/events');
      const lib = url.protocol === 'https:' ? require('https') : require('http');
      const chunks = [];
      const req = lib.get(url, { rejectUnauthorized: false }, (res) => {
        assert.equal(res.statusCode, 200);
        res.on('data', (c) => chunks.push(c.toString('utf8')));
        setTimeout(() => {
          registry.upsertFromAnnounce({
            display: { id: 'disp-y', name: 'Kitchen' },
          }, { address: '192.168.0.10' });
          setTimeout(() => {
            req.destroy();
            resolve(chunks.join(''));
          }, 80);
        }, 40);
      });
      req.on('error', (err) => {
        if (err?.code === 'ECONNRESET') {
          resolve(chunks.join(''));
          return;
        }
        reject(err);
      });
      setTimeout(() => reject(new Error('SSE timeout')), 2000);
    });
    assert.match(events, /event: displays/);
    assert.match(events, /disp-x/);
    assert.match(events, /disp-y|Kitchen/);
  } finally {
    webServer.stop();
    registry.stop();
  }
});

test('unknown api endpoint returns 404 json', async () => {
  const { webServer, base } = await startTestServer();
  try {
    const result = await postJson(base, '/api/nope');
    assert.equal(result.status, 404);
    assert.equal(result.body.ok, false);
  } finally {
    webServer.stop();
  }
});

test('web server can be disabled via config', async () => {
  const config = makeConfig({ webServer: { enabled: false } });
  const webServer = createWebServer({
    config,
    log: silentLog,
    sendUdpPayload: () => {},
    recordVoiceEvent: async () => {},
  });
  const server = await webServer.start();
  assert.equal(server, null);
});
