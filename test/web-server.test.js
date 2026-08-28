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
const { COMMANDS, PUSH_CATEGORIES, pushCategoryOf } = require('../src/command-registry');

// Plain non-pooled requests: global fetch keeps pooled keep-alive sockets per
// origin, and Windows can hand a later test server the same ephemeral port a
// previous server used, making fetch reuse a dead socket (ECONNRESET).
const TEST_ADMIN_PASSWORD = 'test-admin-secret';

function request(url, {
  method = 'GET', body = null, cookie = null, extraHeaders = null,
} = {}) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const isHttps = String(url).startsWith('https:');
    const transport = isHttps ? httpsMod : httpMod;
    const headers = { ...(extraHeaders || {}) };
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    if (cookie) {
      headers.Cookie = cookie;
    }
    const req = transport.request(url, {
      method,
      agent: false,
      rejectUnauthorized: false,
      headers,
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
  fs.writeFileSync(path.join(dir, 'index.html'), '<html><body>guest booth</body></html>');
  fs.writeFileSync(path.join(dir, 'booth.js'), 'console.log("booth");');
  fs.mkdirSync(path.join(dir, 'admin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'admin', 'index.html'), '<html><body>admin</body></html>');
  fs.writeFileSync(path.join(dir, 'admin', 'login.html'), '<html><body>login</body></html>');
  fs.writeFileSync(path.join(dir, 'admin', 'app.js'), 'console.log("app");');
  fs.writeFileSync(path.join(dir, 'admin', 'styles.css'), 'body{}');
  return dir;
}

function makeConfig(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-data-'));
  const base = {
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
      adminPassword: TEST_ADMIN_PASSWORD,
      adminSessionHours: 12,
    },
    teslaFleet: {
      enabled: false,
      sessionPath: path.join(dataDir, 'tesla-session.json'),
      authStatusPath: path.join(dataDir, 'tesla-auth-status.json'),
    },
  };
  const merged = {
    ...base,
    ...overrides,
    webServer: {
      ...base.webServer,
      ...(overrides.webServer || {}),
    },
    teslaFleet: {
      ...base.teslaFleet,
      ...(overrides.teslaFleet || {}),
    },
  };
  return merged;
}

async function loginAdmin(base, password = TEST_ADMIN_PASSWORD) {
  const res = await request(`${base}/api/admin/login`, {
    method: 'POST',
    body: { password },
  });
  if (res.status !== 200) {
    throw new Error(`admin login failed: ${res.status} ${res.text}`);
  }
  const setCookie = res.headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return String(raw || '').split(';')[0];
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
  const timerPolls = [];
  const alarmPolls = [];
  const config = options.config || makeConfig();
  const webServer = createWebServer({
    config,
    log: silentLog,
    sendUdpPayload: (payload) => sent.push(payload),
    recordVoiceEvent: options.recordVoiceEvent
      || (async (event) => { recorded.push(event); }),
    displayRegistry: options.displayRegistry || null,
    deliverTargetedPayload: options.deliverTargetedPayload || null,
    requestTimerPoll: options.requestTimerPoll
      || ((device) => timerPolls.push(device)),
    requestAlarmPoll: options.requestAlarmPoll
      || ((device) => alarmPolls.push(device)),
    guestSnapsAuth: options.guestSnapsAuth || null,
    trivia: options.trivia || null,
    youtubeNowPlaying: options.youtubeNowPlaying || null,
    rollCredits: options.rollCredits || null,
    scheduleRestart: () => {},
    webRoot: options.webRoot || makeTempWebRoot(),
  });
  const server = await webServer.start();
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  let cookie = null;
  if (options.autoLogin !== false && config.webServer?.adminPassword) {
    cookie = await loginAdmin(base, config.webServer.adminPassword);
  }
  // Remember cookie for postJson(base, ...) calls in this test's server.
  baseCookies.set(base, cookie);
  return {
    webServer,
    server,
    base,
    sent,
    recorded,
    timerPolls,
    alarmPolls,
    cookie,
  };
}

/** base URL → admin session cookie from the matching startTestServer() */
const baseCookies = new Map();

function postJson(base, route, body = {}, cookie) {
  const auth = cookie !== undefined ? cookie : baseCookies.get(base);
  return request(`${base}${route}`, { method: 'POST', body, cookie: auth || null });
}

function getJson(base, route, cookie) {
  const auth = cookie !== undefined ? cookie : baseCookies.get(base);
  return request(`${base}${route}`, { cookie: auth || null });
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
  assert.equal(resolveStaticPath(root, '/admin'), path.join(root, 'admin', 'index.html'));
  assert.equal(resolveStaticPath(root, '/admin/login'), path.join(root, 'admin', 'login.html'));
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
  const html = fs.readFileSync(path.join(__dirname, '../src/web/admin/index.html'), 'utf8');
  assert.match(html, /createElement\('base'\)/);
  assert.match(html, /href="styles\.css/);
  assert.match(html, /src="app\.js/);
  assert.match(html, /src="\/logo.png"/);
  assert.match(html, /href="\/favicon.svg"/);
  assert.doesNotMatch(html, /href="\/styles\.css/);
  assert.doesNotMatch(html, /src="\/app\.js/);
});

test('control page hides Remote and Control tabs unless a single display is selected', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/web/admin/index.html'), 'utf8');
  assert.match(html, /id="tab-btn-remote"[^>]*\bhidden\b/);
  assert.match(html, /id="tab-btn-control"[^>]*\bhidden\b/);

  const js = fs.readFileSync(path.join(__dirname, '../src/web/admin/app.js'), 'utf8');
  assert.match(js, /tab-btn-remote/);
  assert.match(js, /remoteBtn\.hidden\s*=\s*!single/);
  assert.match(js, /controlBtn\.hidden\s*=\s*!single/);
  // All Displays is first and the default; new announces do not steal the picker.
  assert.match(js, /sortDisplayPickerEntries/);
  assert.match(js, /All Displays is the intentional default/);
  assert.match(js, /select\.value = ALL_DISPLAYS/);
  assert.doesNotMatch(js, /previous === ALL_DISPLAYS \|\| !previous/);
});

test('control page JS keeps /api routes root-absolute under /admin/', () => {
  const js = fs.readFileSync(path.join(__dirname, '../src/web/admin/app.js'), 'utf8');
  assert.match(js, /function appUrl\(/);
  assert.match(js, /path\.startsWith\('\/api\/'\)/);
  assert.match(js, /EventSource\(appUrl\(/);
  assert.match(js, /fetch\(appUrl\(/);
  assert.match(js, /credentials:\s*'same-origin'/);
});

test('control page has a QR generator card with url/wifi/photo modes, ordered Photo | URL | Wi-Fi', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/web/admin/index.html'), 'utf8');
  assert.match(html, /id="qr-mode-tabs"/);
  assert.match(html, /data-qr-mode="url"/);
  assert.match(html, /data-qr-mode="wifi"/);
  assert.match(html, /data-qr-mode="image"/);
  assert.match(html, /id="qr-wifi-ssid"/);
  assert.match(html, /id="qr-image-file"/);
  assert.match(html, /id="btn-qr-generate"/);

  const imageIndex = html.indexOf('data-qr-mode="image"');
  const urlIndex = html.indexOf('data-qr-mode="url"');
  const wifiIndex = html.indexOf('data-qr-mode="wifi"');
  assert.ok(imageIndex > -1 && imageIndex < urlIndex && urlIndex < wifiIndex, 'expected Photo | URL | Wi-Fi order');
});

test('control page has a Slideshow Manager tab with a camera roll grid and delete flow', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/web/admin/index.html'), 'utf8');
  assert.match(html, /data-tab="slideshow"/);
  assert.match(html, /id="tab-slideshow"/);
  assert.match(html, /id="photo-grid"/);
  assert.match(html, /id="btn-slideshow-select"/);
  assert.match(html, /id="btn-slideshow-select-all"/);
  assert.match(html, /id="btn-slideshow-delete-selected"/);
  // Whole label is one flex child so .btn gap does not render as "Delete ( 0 )".
  assert.match(html, /class="btn-label">Delete \(/);
  assert.match(html, /id="photo-lightbox"/);
  assert.match(html, /id="photo-delete-sheet"/);
  assert.match(html, /id="slideshow-order-tabs"/);
  assert.match(html, /data-order="recent"/);
  assert.match(html, /data-order="oldest"/);
  assert.match(html, /data-order="random"/);
  assert.match(html, /id="slideshow-seconds-slider"/);
  assert.match(html, /id="slideshow-seconds-value"/);
  assert.match(html, /min="5"/);
  assert.match(html, /max="60"/);
});

test('control page JS pushes QR codes via /api/qr/push and /api/qr/image-upload', () => {
  const js = fs.readFileSync(path.join(__dirname, '../src/web/admin/app.js'), 'utf8');
  assert.match(js, /apiPost\('\/api\/qr\/push'/);
  assert.match(js, /apiPost\('\/api\/qr\/image-upload'/);
  // Photo mode resolves the uploaded relative path against the page's own
  // base so the embedded QR URL still works behind a reverse-proxy prefix.
  assert.match(js, /new URL\(upload\.path, document\.baseURI\)/);
});

test('Web Browser and QR Code sections share a .push-columns wrapper for wide-screen side-by-side layout', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/web/admin/index.html'), 'utf8');
  const columnsStart = html.indexOf('<div class="push-columns">');
  const shareTilesStart = html.indexOf('<div class="push-share-tiles">');
  assert.ok(columnsStart >= 0 && shareTilesStart > columnsStart,
    'expected Web Browser / QR Code above the Share tiles heading');
  const webBrowserIndex = html.indexOf('Web Browser', columnsStart);
  const qrCodeIndex = html.indexOf('QR Code', columnsStart);
  const shareHeadingIndex = html.indexOf('Share to the display', shareTilesStart);
  assert.ok(webBrowserIndex >= 0 && qrCodeIndex >= 0 && webBrowserIndex < qrCodeIndex);
  assert.ok(shareHeadingIndex > qrCodeIndex && shareHeadingIndex > shareTilesStart,
    'Share tiles heading follows Web Browser and QR Code');
  assert.match(html.slice(columnsStart, shareTilesStart), /class="push-column"/);
  assert.match(html, /class="push-share-pane"/);
  assert.match(html, /class="card-row card-row-share" id="push-row-share"/);

  const css = fs.readFileSync(path.join(__dirname, '../src/web/admin/styles.css'), 'utf8');
  assert.match(css, /\.push-columns\s*\{/);
  assert.match(css, /\.card-row-share\s*\{/);
  // Row layout must be gated behind a min-width query, not applied unconditionally.
  assert.match(css, /@media \(min-width: \d+px\)\s*\{[\s\S]*?\.push-columns\s*\{\s*flex-direction:\s*row/);
});

test('control-lock card has top spacing so it does not crowd the sticky display bar', () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/web/admin/styles.css'), 'utf8');
  const match = css.match(/\.control-lock\s*\{([^}]*)\}/);
  assert.ok(match, 'expected a .control-lock rule');
  const margin = /margin:\s*(\d+)px/.exec(match[1]);
  assert.ok(margin, 'expected .control-lock to set an explicit top margin');
  assert.ok(Number(margin[1]) >= 20, 'expected at least 20px of breathing room above the lock card');
});

test('display bar lock/refresh icons use a larger shared icon size', () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/web/admin/styles.css'), 'utf8');
  const match = css.match(/\.btn-icon\s+svg\s*\{([^}]*)\}/);
  assert.ok(match, 'expected .btn-icon svg rule');
  const width = /width:\s*(\d+)px/.exec(match[1]);
  assert.ok(width, 'expected .btn-icon svg to set width');
  assert.ok(Number(width[1]) >= 24, 'expected refresh/lock icons at least 24px');
});

test('serves the guest booth and admin static assets', async () => {
  const { webServer, base } = await startTestServer();
  try {
    const index = await request(base + '/');
    assert.equal(index.status, 200);
    assert.match(index.text, /guest booth/);

    const boothJs = await request(base + '/booth.js');
    assert.equal(boothJs.status, 200);
    assert.match(boothJs.headers['content-type'], /javascript/);

    const adminJs = await request(base + '/admin/app.js');
    assert.equal(adminJs.status, 200);
    assert.match(adminJs.headers['content-type'], /javascript/);

    const missing = await request(base + '/nope.css');
    assert.equal(missing.status, 404);
  } finally {
    webServer.stop();
  }
});

test('serves real guest booth and admin SPA with cache-busted assets', async () => {
  const realWebRoot = path.join(__dirname, '../src/web');
  const { webServer, base, cookie } = await startTestServer({ webRoot: realWebRoot });
  try {
    const booth = await request(base + '/');
    assert.equal(booth.status, 200);
    assert.match(booth.text, /href="booth\.css\?v=\d+(?:\.\d+)?"/);
    assert.match(booth.text, /src="booth\.js\?v=\d+(?:\.\d+)?"/);

    const admin = await request(base + '/admin/', { cookie });
    assert.equal(admin.status, 200);
    assert.match(admin.text, /href="styles\.css\?v=\d+(?:\.\d+)?"/);
    assert.match(admin.text, /src="app\.js\?v=\d+(?:\.\d+)?"/);
    assert.doesNotMatch(admin.text, /href="\/styles\.css/);

    const css = await request(base + '/admin/styles.css');
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

    const status = (await getJson(base, '/api/status')).body;
    assert.equal(status.web.activeUrl, 'http://127.0.0.1:1/board');

    const close = await postJson(base, '/api/push/close-browser');
    assert.equal(close.status, 200);
    assert.equal(sent[1].type, 'web.close');

    const statusAfter = (await getJson(base, '/api/status')).body;
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
    const status = (await getJson(base, '/api/status')).body;
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

    const status = (await getJson(base, '/api/status')).body;
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

    const status = (await getJson(base, '/api/status')).body;
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

    assert.match(pin, /^\d{6}$/);

    const bad = await postJson(base, '/api/displays/auth/verify', {
      targetId: 'disp-pin',
      pin: '000000',
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
    const list = await getJson(base, '/api/displays');
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

const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const TINY_PNG_DATA_URL = `data:image/png;base64,${TINY_PNG_BASE64}`;

test('qr push sends a qr.display payload for url mode', async () => {
  const { webServer, base, sent } = await startTestServer();
  try {
    const push = await postJson(base, '/api/qr/push', { mode: 'url', url: 'https://example.com/party' });
    assert.equal(push.status, 200);
    assert.equal(push.body.ok, true);
    assert.equal(push.body.qrType, 'url');

    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'qr.display');
    assert.equal(sent[0].qr.qrType, 'url');
    assert.equal(sent[0].qr.content, 'https://example.com/party');
  } finally {
    webServer.stop();
  }
});

test('qr push rejects invalid url mode without sending', async () => {
  const { webServer, base, sent } = await startTestServer();
  try {
    const bad = await postJson(base, '/api/qr/push', { mode: 'url', url: 'notaurl' });
    assert.equal(bad.status, 400);
    assert.equal(sent.length, 0);
  } finally {
    webServer.stop();
  }
});

test('qr push photo mode with a one-item photos list stays a single qr.display', async () => {
  const { webServer, base, sent } = await startTestServer();
  try {
    const push = await postJson(base, '/api/qr/push', {
      mode: 'photo',
      photos: [{ url: 'https://example.com/qr-images/only.jpg' }],
    });
    assert.equal(push.status, 200);
    assert.equal(push.body.slideshow, undefined);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'qr.display');
    assert.equal(sent[0].qr.qrType, 'photo');
    assert.equal(sent[0].qr.content, 'https://example.com/qr-images/only.jpg');
  } finally {
    webServer.stop();
  }
});

test('qr push photo mode rejects more than 20 queued URLs', async () => {
  const { webServer, base, sent } = await startTestServer();
  try {
    const photos = Array.from({ length: 21 }, (_, i) => (
      `https://example.com/qr-images/${i}.jpg`
    ));
    const push = await postJson(base, '/api/qr/push', { mode: 'photo', photos });
    assert.equal(push.status, 400);
    assert.match(String(push.body.error || ''), /20/);
    assert.equal(sent.length, 0);
  } finally {
    webServer.stop();
  }
});

test('qr push photo mode with several URLs sends photo.slideshow in queue order', async () => {
  const { webServer, base, sent } = await startTestServer();
  try {
    const photos = [
      { url: 'https://example.com/qr-images/a.jpg', uploadedAt: '2026-01-03T00:00:00.000Z' },
      { url: 'https://example.com/qr-images/b.jpg', uploadedAt: '2026-01-01T00:00:00.000Z' },
      { url: 'https://example.com/qr-images/c.jpg', uploadedAt: '2026-01-02T00:00:00.000Z' },
    ];
    const push = await postJson(base, '/api/qr/push', { mode: 'photo', photos });
    assert.equal(push.status, 200);
    assert.equal(push.body.ok, true);
    assert.equal(push.body.slideshow, true);
    assert.equal(push.body.count, 3);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'photo.slideshow');
    assert.equal(sent[0].trigger, 'qr-photo-queue');
    assert.deepEqual(sent[0].slideshow.photos.map((p) => p.url), photos.map((p) => p.url));
  } finally {
    webServer.stop();
  }
});

test('qr push sends a qr.display photo payload for photo mode', async () => {
  const { webServer, base, sent } = await startTestServer();
  try {
    const push = await postJson(base, '/api/qr/push', {
      mode: 'photo',
      url: 'https://example.com/qr-images/abc.jpg',
      label: 'Scan to save this photo',
    });
    assert.equal(push.status, 200);
    assert.equal(push.body.ok, true);
    assert.equal(push.body.qrType, 'photo');

    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'qr.display');
    assert.equal(sent[0].qr.qrType, 'photo');
    assert.equal(sent[0].qr.content, 'https://example.com/qr-images/abc.jpg');
    assert.equal(sent[0].qr.label, 'Scan to save this photo');
  } finally {
    webServer.stop();
  }
});

test('qr push sends a qr.display payload for wifi mode', async () => {
  const { webServer, base, sent } = await startTestServer();
  try {
    const push = await postJson(base, '/api/qr/push', {
      mode: 'wifi',
      ssid: 'Home Network',
      password: 'letmein123',
    });
    assert.equal(push.status, 200);
    assert.equal(push.body.qrType, 'wifi');

    assert.equal(sent[0].type, 'qr.display');
    assert.equal(sent[0].qr.qrType, 'wifi');
    assert.match(sent[0].qr.content, /^WIFI:T:WPA;S:Home Network;P:letmein123;;$/);
    assert.equal(sent[0].qr.label, 'Wi-Fi: Home Network');
  } finally {
    webServer.stop();
  }
});

test('qr push wifi mode requires a password unless the network is open', async () => {
  const { webServer, base, sent } = await startTestServer();
  try {
    const missingPassword = await postJson(base, '/api/qr/push', { mode: 'wifi', ssid: 'Home' });
    assert.equal(missingPassword.status, 400);

    const open = await postJson(base, '/api/qr/push', {
      mode: 'wifi',
      ssid: 'Free Wifi',
      security: 'nopass',
    });
    assert.equal(open.status, 200);
    assert.match(sent[0].qr.content, /^WIFI:T:nopass;S:Free Wifi;;$/);
  } finally {
    webServer.stop();
  }
});

test('qr push rejects an unknown mode', async () => {
  const { webServer, base } = await startTestServer();
  try {
    const result = await postJson(base, '/api/qr/push', { mode: 'carrier-pigeon' });
    assert.equal(result.status, 400);
  } finally {
    webServer.stop();
  }
});

test('qr image upload stores a photo and serves it back from a relative URL', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-qr-image-'));
  const config = makeConfig({ ROOT: dataDir, qrImage: { cacheDir: 'qr-cache' } });
  const { webServer, base } = await startTestServer({ config });
  try {
    const upload = await postJson(base, '/api/qr/image-upload', { imageDataUrl: TINY_PNG_DATA_URL });
    assert.equal(upload.status, 200);
    assert.equal(upload.body.ok, true);
    assert.match(upload.body.path, /^\/qr-images\/[0-9a-f]{32}\.png$/);
    assert.ok(upload.body.token);
    assert.ok(upload.body.createdAt);

    const served = await request(base + upload.body.path);
    assert.equal(served.status, 200);
    assert.match(served.headers['content-type'], /image\/png/);
  } finally {
    webServer.stop();
  }
});

test('qr image upload rejects missing/invalid image data', async () => {
  const { webServer, base } = await startTestServer();
  try {
    const bad = await postJson(base, '/api/qr/image-upload', { imageDataUrl: 'not-a-data-url' });
    assert.equal(bad.status, 400);

    const missing = await postJson(base, '/api/qr/image-upload', {});
    assert.equal(missing.status, 400);
  } finally {
    webServer.stop();
  }
});

test('qr image route 404s for unknown or expired tokens', async () => {
  const { webServer, base } = await startTestServer();
  try {
    const missing = await request(base + '/qr-images/0000000000000000000000000000000000.png');
    assert.equal(missing.status, 404);
  } finally {
    webServer.stop();
  }
});

test('weather and shopping-list quick-push tiles feed synthetic events into the voice pipeline', async () => {
  const { webServer, base, recorded } = await startTestServer();
  try {
    const weather = await postJson(base, '/api/push/weather');
    assert.equal(weather.status, 202);
    assert.equal(weather.body.ok, true);
    assert.equal(weather.body.kind, 'weather');

    const shopping = await postJson(base, '/api/push/shopping-list', { device: 'iPhone' });
    assert.equal(shopping.status, 202);

    assert.equal(recorded.length, 2);
    assert.equal(recorded[0].kind, 'weather');
    assert.equal(recorded[0].trigger, 'weather-query');
    assert.equal(recorded[0].device, 'Signal');
    assert.equal(recorded[1].kind, 'shopping-list');
    assert.equal(recorded[1].trigger, 'shopping-list-show');
    assert.equal(recorded[1].device, 'iPhone');
  } finally {
    webServer.stop();
  }
});

test('admin control PIN sheet expects a 6-digit code', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/web/admin/index.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '../src/web/admin/app.js'), 'utf8');
  assert.match(html, /6-digit code/);
  assert.match(html, /id="pin-sheet-input"[^>]*maxlength="6"/);
  assert.match(html, /id="pin-sheet-input"[^>]*pattern="\[0-9\]\{6\}"/);
  // The cache-bust tag moves with every UI change; assert it is present and
  // consistent rather than pinning a version this test would have to chase.
  const cacheTag = html.match(/styles\.css\?v=(signal\d+)/);
  assert.ok(cacheTag, 'styles.css must carry a signal cache-bust tag');
  assert.match(html, new RegExp(`app\\.js\\?v=${cacheTag[1]}`));
  assert.match(html, /sheet-actions-lightbox/);
  assert.match(html, /id="btn-lightbox-push"/);
  assert.match(js, /CONTROL_PIN_DIGITS\s*=\s*6/);
  assert.match(js, /\.slice\(0,\s*CONTROL_PIN_DIGITS\)/);
});

test('Vestaboard simulator call log stacks time and detail, centers verb and result', () => {
  const js = fs.readFileSync(path.join(__dirname, '../src/web/admin/app.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../src/web/admin/styles.css'), 'utf8');
  assert.match(js, /vb-row-call-meta/);
  assert.match(js, /vb-row-call-target/);
  assert.match(css, /\.vb-row\.vb-row-call\s*\{[\s\S]*?align-items:\s*center/);
  assert.match(css, /\.vb-row-call-meta\s*\{[\s\S]*?flex-direction:\s*column/);
  assert.match(css, /\.vb-row-call-target\s*\{[\s\S]*?display:\s*contents/);
  assert.match(css, /\.vb-row-call \.vb-row-verb\s*\{[\s\S]*?grid-column:\s*2/);
  assert.match(css, /\.vb-row\.vb-row-call\s*\{[\s\S]*?2\.75rem\s+minmax\(0,\s*1fr\)\s+auto/);
});

test('admin Settings has a trivia card driven by the trivia API', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/web/admin/index.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '../src/web/admin/app.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../src/web/admin/styles.css'), 'utf8');

  // Containers the renderer fills; the markup itself carries no category list.
  for (const id of [
    'trivia-settings-card', 'trivia-providers', 'trivia-difficulties', 'trivia-types',
    'trivia-categories', 'trivia-status-pill', 'trivia-round-length', 'btn-trivia-refill',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);
  }
  assert.doesNotMatch(html, /data-trivia-list=/, '26 categories must be rendered, not hardcoded');

  assert.match(js, /\/api\/trivia\/pool\/status/);
  assert.match(js, /\/api\/trivia\/categories/);
  assert.match(js, /\/api\/trivia\/settings/);
  assert.match(js, /\/api\/trivia\/pool\/refill/);
  // Starvation must surface as a visible warning, not a silent air-time failure.
  assert.match(js, /trivia-starved-hint/);
  assert.match(js, /is-starved/);
  assert.match(css, /\.trivia-category-count\.is-starved/);
});

test('the wide Settings cards span the grid and column up inside', () => {
  // Half-width made these two metres tall with an empty column beside them,
  // which is what "the settings page is disorganised" was about.
  const html = fs.readFileSync(path.join(__dirname, '../src/web/admin/index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../src/web/admin/styles.css'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '../src/web/admin/app.js'), 'utf8');

  for (const card of [
    'youtube-settings-card',
    'trivia-settings-card',
    'upside-news-settings-card',
    'plex-settings-card',
  ]) {
    assert.match(
      css,
      new RegExp(`#tab-settings \\.${card}[^{]*\\{[^}]*grid-column: 1 / -1`),
      `${card} must span both columns`,
    );
  }
  assert.match(html, />Plex Configuration</);
  // Their contents run as columns, so the extra width is actually used.
  assert.match(html, /class="settings-columns settings-columns-3"/);
  assert.match(css, /\.settings-columns-3 \{ grid-template-columns: repeat\(3, 1fr\); \}/);
  // Period control sits above the three columns so Daily…Yearly never collide
  // with the Guardian column.
  assert.match(html, /upside-news-period-band/);
  assert.match(css, /\.upside-news-key-row/);

  // Settings is too long to scroll as one page — a sub-nav groups the cards,
  // and a search box filters panels across those panes with hit counts.
  assert.match(html, /id="settings-view-tabs"/);
  assert.match(html, /id="settings-search"/);
  assert.match(html, /id="settings-search-clear"/);
  for (const view of ['accounts', 'youtube', 'games', 'news', 'travel', 'media']) {
    assert.match(html, new RegExp(`data-settings-view="${view}"`));
    assert.match(html, new RegExp(`data-settings-group="${view}"`));
  }
  assert.match(js, /function showSettingsView/);
  assert.match(js, /function applySettingsFilter/);
  assert.match(js, /SETTINGS_VIEW_KEY/);
  assert.match(js, /SETTINGS_SEARCH_KEY/);
  assert.match(js, /settings-hit-count/);
  assert.match(js, /uiStorageRemove\(SETTINGS_SEARCH_KEY\)/);
  assert.match(css, /\.settings-view-tabs\b/);
  assert.match(css, /\.settings-hit-count\b/);
  assert.match(css, /\.settings-search-row\b/);
});

test('the refill button answers immediately instead of holding the request open', async () => {
  // Sources allow one call every six seconds, so a pass over every category
  // runs for minutes. Awaiting it here used to hold the HTTP request open long
  // enough for the browser to give up and report a bare failure with nothing
  // to act on.
  let settle = null;
  const refilling = new Promise((resolve) => { settle = resolve; });
  const trivia = {
    pool: { refill: () => refilling },
    statusSnapshot: () => ({ size: 0, available: 0, refilling: true }),
  };
  const { webServer, base } = await startTestServer({ trivia: () => trivia });
  try {
    const started = Date.now();
    const response = await postJson(base, '/api/trivia/pool/refill', {});
    assert.equal(response.status, 202);
    assert.equal(response.body.started, true);
    assert.ok(Date.now() - started < 1000, 'the response must not wait for the pass');
    // The card watches the pool for the outcome.
    assert.equal(response.body.status.refilling, true);
  } finally {
    settle({ ok: true, added: 0 });
    webServer.stop();
  }
});

test('a YouTube scan with no detection agent explains what to do about it', async () => {
  // The reason matters: "no TVs found" and "this container has no Python in it"
  // look identical from the settings page but need completely different fixes.
  const youtube = {
    discover: async () => ({
      ok: false,
      unavailable: true,
      error: 'The YouTube detection agent is not running.'
        + ' Python is not in this image — rebuild it (./recreate.sh --build).',
    }),
  };
  const { webServer, base } = await startTestServer({ youtubeNowPlaying: youtube });
  try {
    const response = await postJson(base, '/api/youtube/devices/discover', {});
    // 503, not 502: the bridge is not equipped for this yet, the TVs are fine.
    assert.equal(response.status, 503);
    assert.match(response.body.error, /rebuild/i);
  } finally {
    webServer.stop();
  }
});

test('admin Settings has a YouTube card for linking, keys and cache', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/web/admin/index.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '../src/web/admin/app.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../src/web/admin/styles.css'), 'utf8');

  for (const id of [
    'youtube-settings-card', 'youtube-status-pill', 'youtube-devices', 'youtube-pair-code',
    'btn-youtube-link', 'btn-youtube-discover', 'youtube-discovered', 'youtube-api-key',
    'btn-youtube-api-key', 'youtube-quota', 'btn-youtube-cache-clear', 'youtube-multi-device',
    'youtube-preferred-device', 'btn-youtube-test-push',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);
  }
  // Devices are runtime state; the markup must not enumerate them.
  assert.doesNotMatch(html, /data-device-id="/, 'devices must be rendered from the API');

  for (const route of [
    '/api/youtube/settings', '/api/youtube/devices', '/api/youtube/devices/link',
    '/api/youtube/devices/discover', '/api/youtube/api-key', '/api/youtube/cache/clear',
  ]) {
    assert.ok(
      js.includes(route) || js.includes(route.replace('/api/youtube', '${YOUTUBE_ROUTE}')),
      `admin app.js never calls ${route}`,
    );
  }
  // Re-link and remove are the two recovery paths a revoked token needs.
  assert.match(js, /relink/);
  assert.match(js, /method: 'DELETE'/);
  assert.match(css, /\.yt-dot\.is-needs-relink/);
});

test('admin has a Scheduler tab with schedule, activity, simulation and settings views', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/web/admin/index.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '../src/web/admin/app.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../src/web/admin/styles.css'), 'utf8');

  assert.match(html, /data-tab="scheduler"/);
  assert.match(html, /id="tab-scheduler"/);
  for (const id of [
    'sched-active', 'sched-nextup', 'sched-rule-list', 'sched-add-command', 'btn-sched-add',
    'sched-setup-card', 'sched-rule-search', 'sched-rule-search-clear', 'sched-rule-meta', 'sched-rule-empty',
    'sched-view-schedule', 'sched-view-activity', 'sched-view-simulation', 'sched-view-settings',
    'sched-min-gap', 'sched-tick', 'sched-quiet-enabled', 'sched-retention', 'btn-sched-simulate',
    'sched-simulation', 'sched-simulation-working', 'sched-simulation-status', 'sched-simulation-results',
    'sched-stats', 'sched-timeline', 'sched-show-skips', 'sched-inspector',
    'sched-rule-stats', 'sched-heatmap',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);
  }
  assert.match(html, /data-sched-view="schedule"/);
  assert.match(html, /data-sched-view="simulation"/);
  assert.match(html, /data-sched-view="settings"/);
  // Rules are runtime data; the markup must not enumerate them.
  assert.doesNotMatch(html, /data-rule-id="/, 'rules must be rendered from the API');
  assert.match(js, /sched-rule-group/);
  assert.match(js, /focusSchedRule/);
  assert.match(js, /signal\.schedRuleSearch/);
  assert.match(css, /\.sched-setup-card/);
  assert.match(css, /\.sched-rule\.is-new/);

  for (const route of [
    '/api/display-scheduler/settings', '/api/display-scheduler/rules',
    '/api/display-scheduler/status', '/api/display-scheduler/activity',
    '/api/display-scheduler/stats', '/api/display-scheduler/heatmap',
    '/api/display-scheduler/simulate',
  ]) {
    const tail = route.slice('/api/display-scheduler'.length);
    assert.ok(
      js.includes(route) || js.includes(`SCHED_ROUTE}${tail}`),
      `admin app never calls ${route}`,
    );
  }
  // The command picker must come from the registry, not a hardcoded list.
  assert.match(js, /renderSchedCommandPicker/);
  assert.match(js, /'\/api\/commands'/);
  // Timeline is hand-rolled SVG — no charting library is bundled.
  assert.match(js, /function renderSchedTimeline/);
  assert.match(js, /quietBands/);
  assert.match(css, /\.sched-timeline\b/);
  assert.match(css, /\.sched-heat-0/);
  // Simulate must show a spinner + status, not only disable the button.
  assert.match(js, /function showSchedSimulationWorking/);
  assert.match(js, /function renderSchedSimulation/);
  assert.match(js, /function setSchedSimulationStatus/);
  assert.match(js, /Building a 24-hour forecast/);
  assert.match(js, /Rolling 200 simulated days/);
  assert.match(js, /Simulating…/);
  assert.match(css, /\.sched-sim-working\b/);
  assert.match(css, /\.sched-sim-spinner\b/);
});

test('admin on-screen keyboard sends Space and flashes pressed keys', () => {
  const js = fs.readFileSync(path.join(__dirname, '../src/web/admin/app.js'), 'utf8');
  assert.match(js, /key:\s*'Space'/);
  assert.doesNotMatch(js, /key:\s*' '\s*,\s*label:\s*'Space'/);
  assert.match(js, /function flashPressed\(/);
  assert.match(js, /classList\.add\('pressed'\)/);

  const css = fs.readFileSync(path.join(__dirname, '../src/web/admin/styles.css'), 'utf8');
  assert.match(css, /\.key\.pressed/);
});

test('admin home logo goes to Push; Steam return opens Settings', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/web/admin/index.html'), 'utf8');
  assert.match(html, /id="btn-app-home"/);
  assert.match(html, /title="Go to Push"/);

  const js = fs.readFileSync(path.join(__dirname, '../src/web/admin/app.js'), 'utf8');
  assert.match(js, /btn-app-home/);
  assert.match(js, /activateTab\('push'\)/);
  assert.match(js, /function applySteamReturnTab\(/);
  assert.match(js, /params\.get\('steam'\)/);
  assert.match(js, /activateTab\('settings'\)/);
  // Steam return must run at end of startup — mid-script throws used to skip
  // startPolling / Authenticate handlers and leave "Checking session…".
  const applyAt = js.indexOf('function applySteamReturnTab(');
  const startPollAt = js.lastIndexOf('startPolling();');
  const applyCallAt = js.lastIndexOf('applySteamReturnTab();');
  assert.ok(applyAt > 0 && startPollAt > 0 && applyCallAt > startPollAt);

  const server = fs.readFileSync(path.join(__dirname, '../src/web-server.js'), 'utf8');
  assert.match(server, /Location:\s*'\/admin\/\?steam=ok'/);
  assert.match(server, /Location:\s*'\/admin\/\?steam=error'/);
});

test('control page Quick Push includes Guest Snaps and companion tiles', () => {
  // Tiles come from the command registry now, not static markup — the HTML only
  // supplies the rows the renderer fills.
  const html = fs.readFileSync(path.join(__dirname, '../src/web/admin/index.html'), 'utf8');
  assert.match(html, /id="push-row-home" data-push-category="home"/);
  assert.match(html, /id="push-row-games" data-push-category="games"/);
  assert.match(html, /data-skeleton-count/);
  assert.match(html, /push-card-skeleton/);
  // Skeletons reserve exactly the height the pane will need, so nothing
  // shuffles as the tiles land.
  for (const category of ['home', 'games', 'media', 'news', 'travel', 'share']) {
    const count = COMMANDS.filter(
      (c) => c.pushable && pushCategoryOf(c) === category,
    ).length;
    assert.match(html, new RegExp(
      `id="push-row-${category}"[\\s\\S]*?data-skeleton-count="${count}"`,
    ), `the ${category} pane reserves room for ${count} tiles`);
  }
  assert.doesNotMatch(html, /id="push-row-playing"/);
  assert.doesNotMatch(html, /id="btn-push-indoor-temperature"/);

  const js = fs.readFileSync(path.join(__dirname, '../src/web/admin/app.js'), 'utf8');
  assert.match(js, /apiGet\('\/api\/commands'\)/);
  assert.match(js, /function renderPushGrid\(/);

  const pushable = COMMANDS.filter((command) => command.pushable).map((c) => c.id);
  for (const id of [
    'signal.guest-snaps', 'alexa.air-quality', 'alexa.now-playing', 'alexa.alarms',
    'alexa.notifications', 'alexa.weather', 'alexa.shopping-list', 'alexa.timers', 'signal.slideshow',
    'tesla.dashboard', 'tesla.battery',
  ]) {
    assert.ok(pushable.includes(id), `${id} should be a pushable command`);
  }
});

test('the Push page files its tiles behind searchable category tabs', () => {
  // The grid passed thirty tiles, so it is organised the way Settings is: one
  // pane per category, a search that counts hits per tab, and tabs that step
  // aside when nothing in them matches.
  const html = fs.readFileSync(path.join(__dirname, '../src/web/admin/index.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '../src/web/admin/app.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../src/web/admin/styles.css'), 'utf8');

  assert.match(html, /id="push-view-tabs"/);
  assert.match(html, /id="push-search"/);
  assert.match(html, /id="push-search-clear"/);
  assert.match(html, /id="push-search-empty"/);
  for (const view of PUSH_CATEGORIES.map((entry) => entry.id)) {
    assert.match(html, new RegExp(`data-push-view="${view}"`));
    assert.match(html, new RegExp(`data-push-group="${view}"`));
  }
  // Web Browser and QR Code are hand-built, so they are searchable in their
  // own right rather than riding along invisibly under Share.
  assert.match(html, /data-push-item="web-browser"/);
  assert.match(html, /data-push-item="qr-code"/);

  assert.match(js, /function applyPushFilter/);
  assert.match(js, /function showPushView/);
  assert.match(js, /push-share-pane/);
  assert.match(js, /pushViewSession/);
  assert.match(js, /applyPushFilter\(PUSH_VIEW_ORDER\[0\]\)/);
  assert.match(js, /push-hit-count/);
  // Tiles answer to their service and command id as well as their printed copy.
  assert.match(js, /data-search-terms=/);
  // The renderer hands visibility to the filter instead of hiding rows itself.
  assert.doesNotMatch(js, /row\.hidden = mine\.length === 0/);

  assert.match(css, /\.push-view-tabs\b/);
  assert.match(css, /\.push-hit-count\b/);
  assert.match(css, /\.push-search-row\b/);
  assert.match(css, /#tab-push \[data-push-group\]\[hidden\]/);
});

test('Steam, PSN and YouTube share one auto-mode push tile each next to Trivia', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/web/admin/index.html'), 'utf8');
  const rows = [...html.matchAll(/data-push-category="([^"]+)"/g)].map((match) => match[1].trim());

  // A category rendered by two rows would show its tiles twice.
  assert.equal(new Set(rows).size, rows.length, 'each category belongs to exactly one row');

  for (const id of ['steam.now-playing', 'psn.now-playing', 'youtube.now-playing']) {
    const command = COMMANDS.find((entry) => entry.id === id);
    assert.ok(command.pushable, `${id} needs a push tile`);
    assert.ok(
      rows.includes(pushCategoryOf(command)),
      `${command.id} has no row to render into`,
    );
    // Empty body → the push handler's `auto` path (live session, else last played).
    assert.equal(command.body?.mode, undefined);
  }
  for (const id of ['steam.last-played', 'psn.last-played', 'youtube.last-played']) {
    const command = COMMANDS.find((entry) => entry.id === id);
    assert.equal(command.pushable, false, `${id} stays scheduler-only`);
    assert.equal(command.body.mode, 'last-played');
  }
});

test('the YouTube TV code input regroups digits while typing', () => {
  const js = fs.readFileSync(path.join(__dirname, '../src/web/admin/app.js'), 'utf8');
  assert.match(js, /function formatYoutubePairCode\(/);
  assert.match(js, /youtube-pair-code[\s\S]*?addEventListener\('input'/);
  assert.match(js, /\(\\d\{3\}\)\(\?=\\d\)/);
});

test('GET /api/commands returns the registry', async () => {
  const { webServer, base } = await startTestServer();
  try {
    const response = await getJson(base, '/api/commands');
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    const ids = response.body.commands.map((command) => command.id);
    assert.deepEqual(ids, COMMANDS.map((command) => command.id));

    const weather = response.body.commands.find((c) => c.id === 'alexa.weather');
    assert.equal(weather.route, '/api/push/weather');
    assert.equal(weather.title, 'Weather Forecast');
    assert.equal(weather.pushable, true);
    assert.equal(weather.estimatedDurationSeconds, 60);
    // Descriptors must be JSON-safe — no functions survive the round trip.
    assert.ok(response.body.commands.every(
      (command) => Object.values(command).every((value) => typeof value !== 'function'),
    ));
  } finally {
    await webServer.stop();
  }
});

test('Roll Credits push creates a public playlist and card', async (t) => {
  const games = [{
    id: 'rc_route',
    title: 'Route Test',
    system: 'pc',
    beatenAt: '2026-08-23',
    induction: 1,
    media: [{
      id: 'cover',
      kind: 'cover',
      path: 'rc_route/cover.jpg',
      status: 'ready',
      hidden: false,
      order: 0,
    }],
  }];
  const settings = {
    mediaPriority: ['video', 'screenshot', 'cover'],
    display: { secondsPerGame: 12, dashboardSeconds: 25, order: 'recent', scheduledGameLimit: 15 },
    limits: { maxImageBytes: 1024 },
  };
  const rollCredits = {
    store: {
      getAllGames: () => JSON.parse(JSON.stringify(games)),
      getSystemById: () => ({ id: 'pc', label: 'PC' }),
    },
    media: {
      routePrefix: '/roll-credits-media/',
      publicUrl: (value) => `/roll-credits-media/${value}`,
      absolutePath: () => path.join(os.tmpdir(), 'missing-roll-credits-test-media'),
    },
    statusSnapshot: () => ({ gameCount: games.length }),
    getSettings: () => JSON.parse(JSON.stringify(settings)),
    getStats: () => ({
      total: 1, thisYear: 1, systemsCount: 1, latest: JSON.parse(JSON.stringify(games[0])),
      months: [], bySystem: [{ id: 'pc', label: 'PC', count: 1 }], undatedCount: 0,
    }),
    getGame: (id) => JSON.parse(JSON.stringify(games.find((game) => game.id === id) || null)),
    start: () => {},
    close: () => {},
  };
  const { webServer, base, sent } = await startTestServer({ rollCredits });
  t.after(() => webServer.stop());

  const pushed = await postJson(base, '/api/push/roll-credits', { secondsPerGame: 15 });
  assert.equal(pushed.status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'roll-credits.tour');
  assert.equal(sent[0].persistent, true);

  const playlist = await getJson(base, sent[0].playlistPath, null);
  assert.equal(playlist.status, 200);
  assert.equal(playlist.body.games[0].id, 'rc_route');

  const card = await getJson(base, '/api/roll-credits/card?id=rc_route', null);
  assert.equal(card.status, 200);
  assert.equal(card.body.card.title, 'Route Test');
  assert.equal(card.body.card.media.hero.kind, 'cover');
  assert.match(card.body.card.media.hero.url, /^https?:\/\//);

  const scheduled = await webServer.airCommand('credits.show', { gameLimit: 1, secondsPerGame: 20 });
  assert.equal(scheduled.loop, false);
  assert.equal(scheduled.persistent, false);
  assert.equal(sent[1].loop, false);
  assert.equal(sent[1].displaySeconds, 25 + 20 + 4);
});

test('Roll Credits reorder endpoint forwards ids and resets to the automatic order', async (t) => {
  const calls = [];
  const rollCredits = {
    store: { getAllGames: () => [], getSystemById: () => null },
    media: {
      routePrefix: '/roll-credits-media/',
      publicUrl: (value) => `/roll-credits-media/${value}`,
      absolutePath: () => path.join(os.tmpdir(), 'missing-roll-credits-test-media'),
    },
    statusSnapshot: () => ({ gameCount: 0 }),
    getSettings: () => ({ display: {}, limits: { maxImageBytes: 1024 } }),
    reorderGames: (ids) => {
      calls.push(['reorder', ids]);
      return { manual: true, order: [...ids].reverse() };
    },
    resetInductionOrder: () => {
      calls.push(['reset']);
      return { manual: false, order: [] };
    },
    start: () => {},
    close: () => {},
  };
  const { webServer, base } = await startTestServer({ rollCredits });
  t.after(() => webServer.stop());

  const moved = await postJson(base, '/api/roll-credits/games/reorder', { ids: ['a', 'b'] });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.manual, true);
  assert.deepEqual(moved.body.order, ['b', 'a']);

  const reset = await postJson(base, '/api/roll-credits/games/reorder', { reset: true });
  assert.equal(reset.status, 200);
  assert.equal(reset.body.manual, false);
  assert.deepEqual(calls, [['reorder', ['a', 'b']], ['reset']]);

  rollCredits.reorderGames = () => { throw new Error('Unknown game zzz'); };
  const bad = await postJson(base, '/api/roll-credits/games/reorder', { ids: ['zzz'] });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /Unknown game/);
});

test('Roll Credits trim endpoint forwards the clip range to the service', async (t) => {
  const calls = [];
  const rollCredits = {
    store: { getAllGames: () => [], getSystemById: () => null },
    media: {
      routePrefix: '/roll-credits-media/',
      publicUrl: (value) => `/roll-credits-media/${value}`,
      absolutePath: () => path.join(os.tmpdir(), 'missing-roll-credits-test-media'),
    },
    statusSnapshot: () => ({ gameCount: 0 }),
    getSettings: () => ({ display: {}, limits: { maxImageBytes: 1024 } }),
    setMediaTrim: async (gameId, mediaId, range) => {
      calls.push([gameId, mediaId, range]);
      return { id: mediaId, kind: 'video', ...range, previewPath: 'rc_1/thumbs/clip.preview.webp' };
    },
    start: () => {},
    close: () => {},
  };
  const { webServer, base } = await startTestServer({ rollCredits });
  t.after(() => webServer.stop());

  const saved = await postJson(base, '/api/roll-credits/games/rc_1/media/md_1/trim', {
    trimStart: 12.5,
    trimEnd: 20,
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.media.previewPath, 'rc_1/thumbs/clip.preview.webp');
  assert.deepEqual(calls, [['rc_1', 'md_1', { trimStart: 12.5, trimEnd: 20 }]]);

  // An empty body clears the range back to the automatic window.
  const cleared = await postJson(base, '/api/roll-credits/games/rc_1/media/md_1/trim', {});
  assert.equal(cleared.status, 200);
  assert.deepEqual(calls[1][2], { trimStart: null, trimEnd: null });

  rollCredits.setMediaTrim = async () => { throw new Error('Only video media can be trimmed'); };
  const rejected = await postJson(base, '/api/roll-credits/games/rc_1/media/md_2/trim', {});
  assert.equal(rejected.status, 400);
  assert.match(rejected.body.error, /Only video media/);
});

test('Roll Credits resolution endpoint re-queues a YouTube download', async (t) => {
  const calls = [];
  const rollCredits = {
    store: { getAllGames: () => [], getSystemById: () => null },
    media: {
      routePrefix: '/roll-credits-media/',
      publicUrl: (value) => `/roll-credits-media/${value}`,
      absolutePath: () => path.join(os.tmpdir(), 'missing-roll-credits-test-media'),
    },
    statusSnapshot: () => ({ gameCount: 0 }),
    getSettings: () => ({ display: {}, limits: { maxImageBytes: 1024 } }),
    setMediaResolution: (gameId, mediaId, resolution) => {
      calls.push([gameId, mediaId, resolution]);
      return {
        media: { id: mediaId, kind: 'video', resolution, status: 'pending' },
        job: { id: 'job_1', state: 'queued' },
      };
    },
    start: () => {},
    close: () => {},
  };
  const { webServer, base } = await startTestServer({ rollCredits });
  t.after(() => webServer.stop());

  const saved = await postJson(base, '/api/roll-credits/games/rc_1/media/md_1/resolution', {
    resolution: 1080,
  });
  assert.equal(saved.status, 202);
  assert.deepEqual(calls, [['rc_1', 'md_1', 1080]]);
  assert.equal(saved.body.media.resolution, 1080);
});

test('Roll Credits media serves byte ranges so the admin can scrub a clip', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roll-credits-range-'));
  const clip = path.join(root, 'clip.mp4');
  const bytes = Buffer.from('0123456789abcdef');
  fs.writeFileSync(clip, bytes);
  const rollCredits = {
    store: { getAllGames: () => [], getSystemById: () => null },
    media: {
      routePrefix: '/roll-credits-media/',
      publicUrl: (value) => `/roll-credits-media/${value}`,
      absolutePath: (relative) => path.join(root, path.basename(relative)),
    },
    statusSnapshot: () => ({ gameCount: 0 }),
    getSettings: () => ({ display: {}, limits: { maxImageBytes: 1024 } }),
    start: () => {},
    close: () => {},
  };
  const { webServer, base } = await startTestServer({ rollCredits });
  t.after(() => webServer.stop());

  const whole = await getJson(base, '/roll-credits-media/clip.mp4', null);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers['accept-ranges'], 'bytes');
  assert.equal(whole.headers['content-length'], String(bytes.length));

  const middle = await request(`${base}/roll-credits-media/clip.mp4`, {
    extraHeaders: { Range: 'bytes=4-7' },
  });
  assert.equal(middle.status, 206);
  assert.equal(middle.headers['content-range'], `bytes 4-7/${bytes.length}`);
  assert.equal(middle.text, '4567');

  // Open-ended and suffix forms both resolve against the real size.
  const tail = await request(`${base}/roll-credits-media/clip.mp4`, {
    extraHeaders: { Range: 'bytes=12-' },
  });
  assert.equal(tail.status, 206);
  assert.equal(tail.text, 'cdef');

  const suffix = await request(`${base}/roll-credits-media/clip.mp4`, {
    extraHeaders: { Range: 'bytes=-3' },
  });
  assert.equal(suffix.status, 206);
  assert.equal(suffix.text, 'def');

  // Nonsense ranges fall back to the whole file rather than failing playback.
  const bogus = await request(`${base}/roll-credits-media/clip.mp4`, {
    extraHeaders: { Range: 'bytes=900-999' },
  });
  assert.equal(bogus.status, 200);
  assert.equal(bogus.text, bytes.toString());
});

test('air-quality and now-playing quick-push tiles feed synthetic events', async () => {
  const { webServer, base, recorded } = await startTestServer();
  try {
    const air = await postJson(base, '/api/push/air-quality');
    assert.equal(air.status, 202);
    assert.equal(air.body.kind, 'air-quality');

    const music = await postJson(base, '/api/push/now-playing', { device: 'iPhone' });
    assert.equal(music.status, 202);
    assert.equal(music.body.kind, 'music');

    assert.equal(recorded.length, 2);
    assert.equal(recorded[0].kind, 'air-quality');
    assert.equal(recorded[0].query, 'show indoor air quality');
    assert.equal(recorded[1].kind, 'music');
    assert.equal(recorded[1].trigger, 'music-query');
    assert.equal(recorded[1].device, 'iPhone');
    assert.match(recorded[1].query, /playing/i);
  } finally {
    webServer.stop();
  }
});

test('guest snaps quick-push feeds synthetic guest-photobooth event to all displays', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-guest-'));
  const { webServer, base, recorded } = await startTestServer({
    config: makeConfig({
      ROOT: dataDir,
      guestPhotoboothPath: path.join(dataDir, 'missing-guest.json'),
      guestPhotobooth: {
        wifiSsid: 'PartyNet',
        wifiPassword: 'secret',
        boothUrl: 'https://192.168.1.50:47810/',
      },
    }),
  });
  try {
    const push = await postJson(base, '/api/push/guest-photobooth');
    assert.equal(push.status, 202);
    assert.equal(push.body.ok, true);
    assert.equal(push.body.kind, 'guest-photobooth');
    assert.equal(push.body.targetId, '*');
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].kind, 'guest-photobooth');
    assert.equal(recorded[0].targetId, '*');
    assert.equal(recorded[0].query, 'open guest snaps');
  } finally {
    webServer.stop();
  }
});

test('timers quick-push tile requests an immediate timer poll', async () => {
  const { webServer, base, timerPolls } = await startTestServer();
  try {
    const push = await postJson(base, '/api/push/timers', { device: 'iPhone' });
    assert.equal(push.status, 202);
    assert.equal(push.body.ok, true);
    assert.deepEqual(timerPolls, ['iPhone']);
  } finally {
    webServer.stop();
  }
});

test('alarms quick-push tile requests an immediate alarm poll', async () => {
  const { webServer, base, alarmPolls } = await startTestServer();
  try {
    const push = await postJson(base, '/api/push/alarms', { device: 'iPhone' });
    assert.equal(push.status, 202);
    assert.equal(push.body.ok, true);
    assert.equal(push.body.kind, 'alarms');
    assert.deepEqual(alarmPolls, ['iPhone']);
  } finally {
    webServer.stop();
  }
});

test('timers quick-push tile 503s when the timer sync hook is not wired up', async () => {
  const config = makeConfig();
  const webServer = createWebServer({
    config,
    log: silentLog,
    sendUdpPayload: () => {},
    recordVoiceEvent: async () => {},
    webRoot: makeTempWebRoot(),
  });
  const server = await webServer.start();
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    const cookie = await loginAdmin(base);
    baseCookies.set(base, cookie);
    const push = await postJson(base, '/api/push/timers');
    assert.equal(push.status, 503);
    assert.equal(push.body.ok, false);
  } finally {
    webServer.stop();
  }
});

test('alarms quick-push tile 503s when the alarm sync hook is not wired up', async () => {
  const config = makeConfig();
  const webServer = createWebServer({
    config,
    log: silentLog,
    sendUdpPayload: () => {},
    recordVoiceEvent: async () => {},
    requestTimerPoll: () => {},
    webRoot: makeTempWebRoot(),
  });
  const server = await webServer.start();
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    const cookie = await loginAdmin(base);
    baseCookies.set(base, cookie);
    const push = await postJson(base, '/api/push/alarms');
    assert.equal(push.status, 503);
    assert.equal(push.body.ok, false);
  } finally {
    webServer.stop();
  }
});

test('input text sends a full-string command to a single display', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-text-'));
  const { createDisplayRegistry } = require('../src/display-registry');
  const registry = createDisplayRegistry({ ROOT: dataDir }, { warn() {}, info() {} });
  registry.upsertFromAnnounce({
    display: { id: 'disp-x', name: 'Living Room' },
  }, { address: '192.168.0.9' });

  const targeted = [];
  const { webServer, base } = await startTestServer({
    config: makeConfig({ ROOT: dataDir }),
    displayRegistry: registry,
    deliverTargetedPayload: (payload, targetId) => {
      const delivery = registry.resolveDelivery(targetId);
      targeted.push({ payload, delivery });
      return delivery;
    },
  });
  try {
    const push = await postJson(base, '/api/input/text', {
      targetId: 'disp-x',
      value: 'correct-horse-battery-staple',
      pressEnter: true,
    });
    assert.equal(push.status, 200);
    assert.equal(targeted.at(-1).payload.type, 'input.text');
    assert.equal(targeted.at(-1).payload.text.value, 'correct-horse-battery-staple');
    assert.equal(targeted.at(-1).payload.text.pressEnter, true);

    const missing = await postJson(base, '/api/input/text', { targetId: 'disp-x', value: '' });
    assert.equal(missing.status, 400);

    const allDisplays = await postJson(base, '/api/input/text', { targetId: '*', value: 'hello' });
    assert.equal(allDisplays.status, 400);
  } finally {
    webServer.stop();
    registry.stop();
  }
});

test('photo slideshow lists shared photos and pushes a photo.slideshow payload', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-slideshow-'));
  const config = makeConfig({ ROOT: dataDir, qrImage: { cacheDir: 'qr-cache' } });
  const { webServer, base, sent } = await startTestServer({ config });
  try {
    const empty = await getJson(base, '/api/photos');
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.photos, []);

    const noPhotos = await postJson(base, '/api/push/photo-slideshow', { photos: [] });
    assert.equal(noPhotos.status, 400);

    await postJson(base, '/api/qr/image-upload', { imageDataUrl: TINY_PNG_DATA_URL });
    await postJson(base, '/api/qr/image-upload', { imageDataUrl: TINY_PNG_DATA_URL });

    const listed = await getJson(base, '/api/photos');
    assert.equal(listed.status, 200);
    assert.equal(listed.body.photos.length, 2);
    assert.match(listed.body.photos[0].path, /^\/qr-images\/[0-9a-f]{32}\.png$/);
    assert.ok(listed.body.photos[0].token);

    const entries = listed.body.photos.map((p) => ({ url: `${base}${p.path}`, uploadedAt: p.createdAt }));
    const push = await postJson(base, '/api/push/photo-slideshow', { photos: entries });
    assert.equal(push.status, 200);
    assert.equal(push.body.count, 2);

    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'photo.slideshow');
    assert.deepEqual(sent[0].slideshow.photos.map((p) => p.url).sort(), entries.map((p) => p.url).sort());
    assert.equal(sent[0].slideshow.secondsPerPhoto, 5);
    assert.equal(sent[0].displaySeconds, 10);
  } finally {
    webServer.stop();
  }
});

test('photo delete removes one or more photos from the cache and slideshow', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-photo-delete-'));
  const config = makeConfig({ ROOT: dataDir, qrImage: { cacheDir: 'qr-cache' } });
  const { webServer, base } = await startTestServer({ config });
  try {
    const noTokens = await postJson(base, '/api/photos/delete', {});
    assert.equal(noTokens.status, 400);

    const first = await postJson(base, '/api/qr/image-upload', { imageDataUrl: TINY_PNG_DATA_URL });
    const second = await postJson(base, '/api/qr/image-upload', { imageDataUrl: TINY_PNG_DATA_URL });

    const single = await postJson(base, '/api/photos/delete', { token: first.body.token });
    assert.equal(single.status, 200);
    assert.deepEqual(single.body.deleted, [first.body.token]);

    const afterSingle = await getJson(base, '/api/photos');
    assert.equal(afterSingle.body.photos.length, 1);

    const bulk = await postJson(base, '/api/photos/delete', {
      tokens: [second.body.token, 'not-a-real-token'],
    });
    assert.equal(bulk.status, 200);
    assert.deepEqual(bulk.body.deleted, [second.body.token]);
    assert.deepEqual(bulk.body.failed, ['not-a-real-token']);

    const afterBulk = await getJson(base, '/api/photos');
    assert.deepEqual(afterBulk.body.photos, []);

    const gone = await request(base + first.body.path);
    assert.equal(gone.status, 404);
  } finally {
    webServer.stop();
  }
});

test('photo events SSE pushes hello then live updates on upload/delete', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-photo-events-'));
  const config = makeConfig({ ROOT: dataDir, qrImage: { cacheDir: 'qr-cache' } });
  const { webServer, base, cookie } = await startTestServer({ config });
  try {
    const events = await new Promise((resolve, reject) => {
      const url = new URL(base + '/api/photos/events');
      const lib = url.protocol === 'https:' ? require('https') : require('http');
      const chunks = [];
      const req = lib.get(url, {
        rejectUnauthorized: false,
        headers: cookie ? { Cookie: cookie } : {},
      }, (res) => {
        assert.equal(res.statusCode, 200);
        res.on('data', (c) => chunks.push(c.toString('utf8')));
        setTimeout(async () => {
          const upload = await postJson(base, '/api/qr/image-upload', { imageDataUrl: TINY_PNG_DATA_URL });
          setTimeout(async () => {
            await postJson(base, '/api/photos/delete', { token: upload.body.token });
            setTimeout(() => {
              req.destroy();
              resolve(chunks.join(''));
            }, 80);
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
    assert.match(events, /event: photos/);
    assert.match(events, /"reason":"hello"/);
    assert.match(events, /"reason":"store"/);
    assert.match(events, /"reason":"delete"/);
  } finally {
    webServer.stop();
  }
});

test('slideshow order setting persists and validates the requested value', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-slideshow-settings-'));
  const config = makeConfig({ ROOT: dataDir });
  const { webServer, base } = await startTestServer({ config });
  try {
    const initial = await getJson(base, '/api/slideshow/settings');
    assert.equal(initial.status, 200);
    assert.equal(initial.body.order, 'recent');
    assert.equal(initial.body.secondsPerPhoto, 5);
    assert.equal(initial.body.secondsPerPhotoMin, 5);
    assert.equal(initial.body.secondsPerPhotoMax, 60);

    const bad = await postJson(base, '/api/slideshow/settings', { order: 'sideways' });
    assert.equal(bad.status, 400);

    const update = await postJson(base, '/api/slideshow/settings', { order: 'oldest' });
    assert.equal(update.status, 200);
    assert.equal(update.body.order, 'oldest');
    assert.equal(update.body.secondsPerPhoto, 5);

    const after = await getJson(base, '/api/slideshow/settings');
    assert.equal(after.body.order, 'oldest');
  } finally {
    webServer.stop();
  }
});

test('slideshow seconds-per-photo setting persists and clamps to 5–60', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-slideshow-seconds-'));
  const config = makeConfig({ ROOT: dataDir });
  const { webServer, base } = await startTestServer({ config });
  try {
    const update = await postJson(base, '/api/slideshow/settings', { secondsPerPhoto: 18 });
    assert.equal(update.status, 200);
    assert.equal(update.body.secondsPerPhoto, 18);
    assert.equal(update.body.order, 'recent');

    const after = await getJson(base, '/api/slideshow/settings');
    assert.equal(after.body.secondsPerPhoto, 18);

    const clampedHigh = await postJson(base, '/api/slideshow/settings', { secondsPerPhoto: 99 });
    assert.equal(clampedHigh.status, 200);
    assert.equal(clampedHigh.body.secondsPerPhoto, 60);

    const clampedLow = await postJson(base, '/api/slideshow/settings', { secondsPerPhoto: 1 });
    assert.equal(clampedLow.status, 200);
    assert.equal(clampedLow.body.secondsPerPhoto, 5);

    const bad = await postJson(base, '/api/slideshow/settings', { secondsPerPhoto: 'slow' });
    assert.equal(bad.status, 400);
  } finally {
    webServer.stop();
  }
});

test('slideshow order setting is applied when pushing the photo slideshow', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-slideshow-order-push-'));
  const config = makeConfig({ ROOT: dataDir, qrImage: { cacheDir: 'qr-cache' } });
  const { webServer, base, sent } = await startTestServer({ config });
  try {
    await postJson(base, '/api/slideshow/settings', { order: 'oldest' });

    const entries = [
      { url: 'https://nas/a.jpg', uploadedAt: '2026-01-03T00:00:00.000Z' },
      { url: 'https://nas/b.jpg', uploadedAt: '2026-01-01T00:00:00.000Z' },
    ];
    await postJson(base, '/api/push/photo-slideshow', { photos: entries });

    assert.deepEqual(sent[0].slideshow.photos.map((p) => p.url), ['https://nas/b.jpg', 'https://nas/a.jpg']);
  } finally {
    webServer.stop();
  }
});

test('slideshow seconds-per-photo setting is applied when pushing the photo slideshow', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-slideshow-seconds-push-'));
  const config = makeConfig({ ROOT: dataDir, qrImage: { cacheDir: 'qr-cache' } });
  const { webServer, base, sent } = await startTestServer({ config });
  try {
    await postJson(base, '/api/slideshow/settings', { secondsPerPhoto: 12 });

    const entries = [
      { url: 'https://nas/a.jpg', uploadedAt: '2026-01-03T00:00:00.000Z' },
      { url: 'https://nas/b.jpg', uploadedAt: '2026-01-01T00:00:00.000Z' },
    ];
    await postJson(base, '/api/push/photo-slideshow', { photos: entries });

    assert.equal(sent[0].slideshow.secondsPerPhoto, 12);
    assert.equal(sent[0].displaySeconds, 24);
  } finally {
    webServer.stop();
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

test('guest booth is served at / and admin shell redirects without a session', async () => {
  const realWebRoot = path.join(__dirname, '../src/web');
  const { webServer, base } = await startTestServer({
    webRoot: realWebRoot,
    autoLogin: false,
  });
  try {
    const booth = await request(`${base}/`);
    assert.equal(booth.status, 200);
    assert.match(booth.text, /Share a photo/i);
    assert.match(booth.text, /id="photo-queue"/);
    assert.match(booth.text, /booth\.js/);

    const admin = await request(`${base}/admin/`);
    assert.equal(admin.status, 302);
    assert.match(String(admin.headers.location || ''), /\/admin\/login/);

    const login = await request(`${base}/admin/login.html`);
    assert.equal(login.status, 200);
    assert.match(login.text, /Sign in/);
  } finally {
    webServer.stop();
  }
});

test('admin login cookie unlocks protected APIs; photo push needs guest or admin', async () => {
  const { webServer, base, sent } = await startTestServer({ autoLogin: false });
  try {
    const denied = await request(`${base}/api/status`);
    assert.equal(denied.status, 401);

    const badLogin = await postJson(base, '/api/admin/login', { password: 'wrong' }, null);
    assert.equal(badLogin.status, 401);

    const cookie = await loginAdmin(base);
    const status = await request(`${base}/api/status`, { cookie });
    assert.equal(status.status, 200);
    assert.equal(status.body.ok, true);

    // Photo push is no longer public without a guest/admin session.
    const pushDenied = await postJson(base, '/api/qr/push', {
      mode: 'photo',
      url: 'https://example.com/party.jpg',
    }, null);
    assert.equal(pushDenied.status, 401);

    const push = await postJson(base, '/api/qr/push', {
      mode: 'photo',
      url: 'https://example.com/party.jpg',
    }, cookie);
    assert.equal(push.status, 200);
    assert.equal(sent.at(-1)?.qr?.qrType, 'photo');

    // URL QR requires admin.
    const urlDenied = await postJson(base, '/api/qr/push', {
      mode: 'url',
      url: 'https://example.com',
    }, null);
    assert.equal(urlDenied.status, 401);

    const urlOk = await postJson(base, '/api/qr/push', {
      mode: 'url',
      url: 'https://example.com',
    }, cookie);
    assert.equal(urlOk.status, 200);
  } finally {
    webServer.stop();
  }
});

test('guest snaps PIN login unlocks photo upload; request-pin pushes overlay', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-guest-pin-'));
  const config = makeConfig({
    ROOT: dataDir,
    guestSnapsPinPath: path.join(dataDir, 'guest-snaps-pin.json'),
    guestPhotobooth: {
      ssid: 'PartyWiFi',
      password: 'secret',
      boothUrl: 'https://192.168.1.10:47810/',
      displaySeconds: 90,
    },
  });
  // Seed env so resolveGuestPhotoboothSettings sees Wi-Fi + URL.
  const prev = {
    ssid: process.env.GUEST_WIFI_SSID,
    pass: process.env.GUEST_WIFI_PASSWORD,
    url: process.env.GUEST_PHOTOBOOTH_URL,
  };
  process.env.GUEST_WIFI_SSID = 'PartyWiFi';
  process.env.GUEST_WIFI_PASSWORD = 'secret';
  process.env.GUEST_PHOTOBOOTH_URL = 'https://192.168.1.10:47810/';

  const { createGuestSnapsAuth } = require('../src/guest-snaps-auth');
  const guestSnapsAuth = createGuestSnapsAuth(config, silentLog);
  const pin = guestSnapsAuth.ensureCurrentPin().pin;
  const sent = [];
  const { webServer, base } = await startTestServer({
    config,
    autoLogin: false,
    guestSnapsAuth,
    deliverTargetedPayload: (payload, targetId) => {
      sent.push({ payload, targetId });
      return { target: { id: targetId }, isAll: true };
    },
  });
  try {
    const deniedUpload = await postJson(base, '/api/qr/image-upload', {
      imageDataUrl: TINY_PNG_DATA_URL,
    }, null);
    assert.equal(deniedUpload.status, 401);

    const session = await getJson(base, '/api/guest/session');
    assert.equal(session.status, 200);
    assert.equal(session.body.authenticated, false);
    assert.equal(session.body.pinDigits, 6);

    const badPin = await postJson(base, '/api/guest/login', { pin: '000000' }, null);
    assert.equal(badPin.status, 401);

    const login = await postJson(base, '/api/guest/login', { pin }, null);
    assert.equal(login.status, 200);
    const setCookie = login.headers['set-cookie'];
    const guestCookie = String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0];
    assert.match(guestCookie, /signal_guest=/);

    const upload = await postJson(base, '/api/qr/image-upload', {
      imageDataUrl: TINY_PNG_DATA_URL,
    }, guestCookie);
    assert.equal(upload.status, 200);

    const queued = await postJson(base, '/api/qr/push', {
      mode: 'photo',
      photos: [
        { url: 'https://example.com/qr-images/one.jpg' },
        { url: 'https://example.com/qr-images/two.jpg' },
      ],
    }, guestCookie);
    assert.equal(queued.status, 200);
    const slideshow = sent.find((s) => s.payload?.type === 'photo.slideshow');
    assert.ok(slideshow);
    assert.equal(slideshow.payload.trigger, 'qr-photo-queue');
    assert.deepEqual(
      slideshow.payload.slideshow.photos.map((p) => p.url),
      ['https://example.com/qr-images/one.jpg', 'https://example.com/qr-images/two.jpg'],
    );

    const reqPin = await postJson(base, '/api/guest/request-pin', {}, null);
    assert.equal(reqPin.status, 200);
    assert.equal(reqPin.body.pin, undefined);
    assert.ok(reqPin.body.expiresAt);
    const overlay = sent.find((s) => s.payload?.type === 'guest.photobooth');
    assert.ok(overlay);
    assert.match(overlay.payload.guestPhotobooth.accessPin, /^\d{6}$/);
    assert.equal(overlay.targetId, '*');
  } finally {
    webServer.stop();
    if (prev.ssid == null) delete process.env.GUEST_WIFI_SSID;
    else process.env.GUEST_WIFI_SSID = prev.ssid;
    if (prev.pass == null) delete process.env.GUEST_WIFI_PASSWORD;
    else process.env.GUEST_WIFI_PASSWORD = prev.pass;
    if (prev.url == null) delete process.env.GUEST_PHOTOBOOTH_URL;
    else process.env.GUEST_PHOTOBOOTH_URL = prev.url;
  }
});

test('guest booth HTML/JS exist at the web root', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/web/index.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '../src/web/booth.js'), 'utf8');
  assert.match(html, /id="display-select"/);
  assert.match(html, /id="btn-send"/);
  assert.match(html, /id="booth-login"/);
  assert.match(html, /id="btn-request-pin"/);
  assert.match(html, /id="guest-pin-input"/);
  assert.match(html, /booth\.js/);
  assert.match(js, /\/api\/guest\/login/);
  assert.match(js, /\/api\/guest\/request-pin/);
  assert.match(js, /\/api\/qr\/image-upload/);
  assert.match(js, /mode:\s*'photo'/);
  assert.match(js, /photos,/);
  // Same friendly label fields as the admin picker (not displayName / raw id).
  assert.match(js, /display\.label\s*\|\|\s*display\.name/);
});

test('guest booth photo picker does not force camera capture', () => {
  // capture=environment opens the camera only on iOS/Android and skips the
  // camera-roll / Files chooser — contradicts "Take or choose photos".
  const html = fs.readFileSync(path.join(__dirname, '../src/web/index.html'), 'utf8');
  assert.match(html, /id="photo-file"[^>]*type="file"/);
  assert.match(html, /id="photo-file"[^>]*accept="image\/\*"/);
  assert.match(html, /id="photo-file"[^>]*\bmultiple\b/);
  assert.doesNotMatch(html, /id="photo-file"[^>]*\bcapture\b/);
  assert.match(html, /Take or choose photos/);
});

test('guest booth queues photos and pushes a slideshow when more than one is sent', () => {
  const js = fs.readFileSync(path.join(__dirname, '../src/web/booth.js'), 'utf8');
  assert.match(js, /MAX_QUEUE\s*=\s*20/);
  assert.match(js, /photoQueue/);
  assert.match(js, /mode:\s*'photo'/);
  assert.match(js, /photos,/);
  assert.match(js, /Add more photos/);
});

test('admin QR photo picker queues multiple files', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/web/admin/index.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '../src/web/admin/app.js'), 'utf8');
  assert.match(html, /id="qr-image-file"[^>]*accept="image\/\*"/);
  assert.match(html, /id="qr-image-file"[^>]*\bmultiple\b/);
  assert.match(html, /id="qr-photo-progress"/);
  assert.match(js, /qrPhotoQueue/);
  assert.match(js, /qr-photo-queue-remove/);
  assert.match(js, /setQrPhotoProgress/);
  assert.doesNotMatch(js, /toast\(`Uploading/);
  assert.match(js, /mode:\s*'photo'/);
  assert.match(js, /photos,/);
});

test('admin login page and logout control exist', () => {
  const login = fs.readFileSync(path.join(__dirname, '../src/web/admin/login.html'), 'utf8');
  const admin = fs.readFileSync(path.join(__dirname, '../src/web/admin/index.html'), 'utf8');
  assert.match(login, /\/api\/admin\/login/);
  assert.match(admin, /id="btn-admin-logout"/);
});

test('admin app.js parses and tab bar keeps remote/control between push and scheduler', () => {
  const { Script } = require('node:vm');
  const html = fs.readFileSync(path.join(__dirname, '../src/web/admin/index.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '../src/web/admin/app.js'), 'utf8');

  assert.doesNotThrow(() => new Script(js), 'admin/app.js must parse — a SyntaxError blanks the whole UI');

  const push = html.indexOf('data-tab="push"');
  const remote = html.indexOf('id="tab-btn-remote"');
  const control = html.indexOf('id="tab-btn-control"');
  const scheduler = html.indexOf('data-tab="scheduler"');
  assert.ok(push >= 0 && remote > push && control > remote && scheduler > control,
    'tab order must be Push → Remote → Control → Scheduler');
  assert.match(html, /id="tab-btn-remote"[^>]*\bhidden\b/);
  assert.match(html, /id="tab-btn-control"[^>]*\bhidden\b/);
  assert.match(js, /function updateControlTabVisibility/);
  assert.match(js, /remoteBtn\.hidden\s*=\s*!single/);
  assert.match(js, /controlBtn\.hidden\s*=\s*!single/);
});

test('Roll Credits edit media can reorder video across kinds and supports drag-and-drop', () => {
  const js = fs.readFileSync(path.join(__dirname, '../src/web/admin/app.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../src/web/admin/styles.css'), 'utf8');

  // Regression: arrows used to no-op when the neighbor was a different kind
  // (video sitting under screenshots could never move up).
  assert.doesNotMatch(js, /media\[next\]\.kind\s*!==\s*row\.kind/);
  assert.match(js, /function moveCreditsMediaRow\(/);
  assert.match(js, /function syncCreditsPriorityFromMediaList\(/);
  assert.match(js, /draggable="true"/);
  assert.match(js, /credits-media-handle/);
  assert.match(js, /addEventListener\('dragstart'/);
  assert.match(js, /addEventListener\('drop'/);
  assert.match(css, /select\.field-input\s*\{/);
  assert.match(css, /-webkit-appearance:\s*none/);
  assert.match(css, /\.credits-media-row\.is-drop-target/);
});

test('Roll Credits edit sheet closes on Escape or an outside click, prompting when dirty', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/web/admin/index.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '../src/web/admin/app.js'), 'utf8');

  // The old behavior refused to close and only nagged with a toast.
  assert.doesNotMatch(js, /Save the game before closing/);
  assert.match(html, /id="credits-unsaved-sheet"/);
  assert.match(html, /id="btn-credits-unsaved-save"/);
  assert.match(html, /id="btn-credits-unsaved-discard"/);
  assert.match(html, /id="btn-credits-unsaved-cancel"/);
  assert.match(js, /function requestCreditsEditClose\(/);
  assert.match(js, /function closeCreditsSheetById\(/);
  assert.match(js, /function creditsTopSheetId\(/);
  assert.match(js, /event\.key !== 'Escape'/);
  // Every credits sheet dismisses on a backdrop click, the unsaved prompt
  // included — clicking away from it cancels, the same as the Cancel button.
  for (const id of [
    'credits-add-sheet',
    'credits-edit-sheet',
    'credits-preview-sheet',
    'credits-delete-sheet',
    'credits-rescrape-sheet',
    'credits-unsaved-sheet',
  ]) {
    assert.match(js, new RegExp(`registerSheetDismiss\\('${id}'`), `${id} has no backdrop dismiss`);
  }
  // Backing out of the prompt must not also drop the edits behind it.
  assert.match(js, /registerSheetDismiss\('credits-unsaved-sheet', \(el\) => \{ el\.hidden = true; \}\)/);
});

test('Roll Credits toolbar controls share one height and the sort label sits inline', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/web/admin/index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../src/web/admin/styles.css'), 'utf8');

  // A stacked label made the sort field taller than its neighbors.
  assert.doesNotMatch(html, /class="credits-inline-field credits-sort-field"/);
  assert.match(html, /<label class="credits-sort-field">\s*<span class="credits-control-label">Sort<\/span>/);
  assert.match(css, /--credits-control-h:/);
  assert.match(css, /\.credits-toolbar-secondary\s*>\s*\.btn,/);
  assert.match(css, /\.credits-sort-field \.field-input \{[^}]*margin-top: 0;/);
});

test('Roll Credits media rows open a preview and videos expose clip trimming', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/web/admin/index.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '../src/web/admin/app.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../src/web/admin/styles.css'), 'utf8');

  assert.match(html, /id="credits-preview-sheet"/);
  assert.match(html, /id="credits-preview-img"/);
  assert.match(html, /<video class="credits-preview-video"[^>]*controls/);
  assert.match(html, /id="credits-trim-start"/);
  assert.match(html, /id="credits-trim-end"/);
  assert.match(html, /placeholder="00m00s"/);
  assert.match(html, /id="credits-trim-resolution"/);
  assert.match(html, /id="btn-credits-resolution-save"/);
  assert.match(html, /id="btn-credits-trim-save"/);
  assert.match(html, /id="btn-credits-trim-clear"/);
  assert.match(js, /function openCreditsPreview\(/);
  assert.match(js, /function parseCreditsClock\(/);
  assert.match(js, /function creditsBindPreviewLoop\(/);
  assert.match(js, /function waitForCreditsMediaReady\(/);
  assert.match(js, /function applyCreditsPreviewFile\(/);
  assert.match(js, /01m03s|00m00s/);
  assert.match(js, /data-media-action="preview"/);
  assert.match(js, /\/media\/\$\{encodeURIComponent\(creditsPreviewMedia\.id\)\}\/trim/);
  assert.match(js, /\/media\/\$\{encodeURIComponent\(mediaId\)\}\/resolution/);
  // The stored clip is released so it stops downloading once the sheet closes.
  assert.match(js, /function closeCreditsPreview\(\)[\s\S]{0,500}removeAttribute\('src'\)/);
  assert.match(css, /\.credits-media-thumb-btn \{/);
  assert.match(css, /\.credits-trim \{/);
});
