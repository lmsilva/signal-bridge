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
    vestaboardHub: options.vestaboardHub || null,
    gameSessions: options.gameSessions || null,
    trivia: options.trivia || null,
    youtubeNowPlaying: options.youtubeNowPlaying || null,
    rollCredits: options.rollCredits || null,
    shortlinksFetch: options.shortlinksFetch || null,
    shortlinksHealthIntervalMs: options.shortlinksHealthIntervalMs,
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
    dataDir: config.ROOT,
    config,
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
  assert.equal(resolveStaticPath(root, '/guestbook'), path.join(root, 'guestbook', 'index.html'));
  assert.equal(resolveStaticPath(root, '/guestbook/'), path.join(root, 'guestbook', 'index.html'));
  assert.equal(resolveStaticPath(root, '/guestsnaps'), path.join(root, 'guestsnaps', 'index.html'));
  assert.equal(resolveStaticPath(root, '/guestsnaps/'), path.join(root, 'guestsnaps', 'index.html'));
  assert.equal(resolveStaticPath(root, '/games'), path.join(root, 'games', 'index.html'));
  assert.equal(resolveStaticPath(root, '/games/'), path.join(root, 'games', 'index.html'));
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
    const booth = await request(base + '/guestsnaps/');
    assert.equal(booth.status, 200);
    assert.match(booth.text, /href="booth\.css\?v=\d+(?:\.\d+)?"/);
    assert.match(booth.text, /src="booth\.js\?v=\d+(?:\.\d+)?"/);

    const admin = await request(base + '/admin/', { cookie });
    assert.equal(admin.status, 200);
    assert.match(admin.text, /href="styles\.css\?v=\d+(?:\.\d+)?"/);
    assert.match(admin.text, /src="app\.js\?v=\d+(?:\.\d+)?"/);
    assert.doesNotMatch(admin.text, /href="\/styles\.css/);

    // The Push grid must not wait on /api/commands, so the tile catalog ships
    // inside the page. An unsubstituted placeholder would mean an empty grid.
    assert.doesNotMatch(admin.text, /__PUSH_CATALOG__/);
    const catalogJson = admin.text.match(
      /<script type="application\/json" id="push-catalog">([\s\S]*?)<\/script>/,
    );
    assert.ok(catalogJson, 'admin HTML carries an inline push catalog');
    const catalog = JSON.parse(catalogJson[1]);
    assert.ok(Array.isArray(catalog) && catalog.length > 10);
    const { COMMANDS, pushCategoryOf } = require('../src/command-registry');
    const shipped = COMMANDS.find((command) => command.id === 'chuck.facts');
    const chuck = catalog.find((command) => command.id === 'chuck.facts');
    assert.equal(chuck.title, shipped.title);
    assert.equal(chuck.pushCategory, pushCategoryOf(shipped));
    // Readiness probes are the slow part and the grid does not use them.
    assert.equal(chuck.hasContent, true);

    const css = await request(base + '/admin/styles.css');
    assert.equal(css.status, 200);
    assert.match(css.headers['content-type'], /css/);

    const guestBook = await request(base + '/guestbook/');
    assert.equal(guestBook.status, 200);
    assert.match(guestBook.text, /Guest Book/);
    assert.match(guestBook.text, /id="gb-keys"/);
    assert.match(guestBook.text, /Select a flap/);
    assert.match(guestBook.text, /btn-gb-clear-footer/);
    assert.match(guestBook.text, /btn-gb-restore-footer/);
    assert.match(guestBook.text, /guestbook\.css\?v=/);
    assert.match(guestBook.text, /guestbook\.js\?v=/);
    assert.match(guestBook.text, /flap-grid\.js\?v=/);
    assert.match(guestBook.text, /vestaboard-bezel\.css\?v=/);
    assert.match(guestBook.text, /vb-bezel/);
    assert.match(guestBook.text, /id="gb-preview"/);
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

test('shopping-list quick-push tiles feed synthetic events into the voice pipeline', async () => {
  const { webServer, base, recorded } = await startTestServer();
  try {
    const shopping = await postJson(base, '/api/push/shopping-list', { device: 'iPhone' });
    assert.equal(shopping.status, 202);

    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].kind, 'shopping-list');
    assert.equal(recorded[0].trigger, 'shopping-list-show');
    assert.equal(recorded[0].device, 'iPhone');
  } finally {
    webServer.stop();
  }
});

test('weather forecast push needs a house pin or a cached forecast', async () => {
  const { webServer, base, sent } = await startTestServer();
  try {
    const weather = await postJson(base, '/api/push/weather');
    assert.equal(weather.status, 400);
    assert.match(weather.body.error, /Settings → Global/);
    assert.equal(sent.length, 0);
  } finally {
    webServer.stop();
  }
});

test('weather forecast push delivers weather.query from the cache', async () => {
  const { saveWeatherCache } = require('../src/weather-cache');
  const config = makeConfig();
  saveWeatherCache(config, {
    location: { latitude: 40.41, longitude: -111.85, name: 'Lehi' },
    weather: {
      current: { temperatureF: 93, condition: 'sunny' },
      next7Days: [{ date: '2026-08-28', highF: 96, lowF: 66, condition: 'sunny' }],
    },
  });
  const { webServer, base, sent, recorded } = await startTestServer({ config });
  try {
    const weather = await postJson(base, '/api/push/weather');
    assert.equal(weather.status, 200);
    assert.equal(weather.body.ok, true);
    assert.equal(weather.body.type, 'weather.query');
    assert.equal(recorded.length, 0);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'weather.query');
    assert.equal(sent[0].weather.current.temperatureF, 93);
  } finally {
    webServer.stop();
  }
});

test('learn japanese push delivers a romaji word to the Vestaboard', async () => {
  const { webServer, base, sent } = await startTestServer();
  try {
    const settings = await getJson(base, '/api/learn-japanese/settings');
    assert.equal(settings.status, 200);
    assert.ok(settings.body.available > 0);

    const pushed = await postJson(base, '/api/push/learn-japanese');
    assert.equal(pushed.status, 200);
    assert.equal(pushed.body.type, 'japanese.learn');
    assert.ok(pushed.body.word.romaji);
    assert.ok(pushed.body.word.english);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'japanese.learn');

    const empty = await postJson(base, '/api/learn-japanese/settings', {
      partsOfSpeech: ['other'],
    });
    assert.equal(empty.status, 200);
    assert.equal(empty.body.available, 0);
    const refused = await postJson(base, '/api/push/learn-japanese');
    assert.equal(refused.status, 409);
  } finally {
    webServer.stop();
  }
});

test('learn spanish push delivers a shipped word and keeps japanese.learn separate', async () => {
  const { webServer, base, sent } = await startTestServer();
  try {
    const settings = await getJson(base, '/api/learn-spanish/settings');
    assert.equal(settings.status, 200);
    assert.ok(settings.body.available > 200);
    assert.equal(settings.body.language, 'spanish');

    const pushed = await postJson(base, '/api/push/learn-spanish');
    assert.equal(pushed.status, 200);
    assert.equal(pushed.body.type, 'spanish.learn');
    assert.ok(pushed.body.word.word);
    assert.ok(pushed.body.word.english);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'spanish.learn');

    const japanese = await getJson(base, '/api/learn-japanese/settings');
    assert.equal(japanese.body.available > 0, true);
  } finally {
    webServer.stop();
  }
});

test('word riddles push delivers a riddle then settings can add one', async () => {
  const { webServer, base, sent } = await startTestServer();
  try {
    const listed = await getJson(base, '/api/word-riddles/riddles?pageSize=5');
    assert.equal(listed.status, 200);
    assert.ok(listed.body.available > 0);
    assert.ok(listed.body.riddles.length > 0);
    assert.ok(listed.body.revealDelaySeconds >= 10);

    const pushed = await postJson(base, '/api/push/word-riddles');
    assert.equal(pushed.status, 200);
    assert.equal(pushed.body.type, 'word.riddles');
    assert.ok(pushed.body.riddle.riddle);
    assert.ok(pushed.body.riddle.answer);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'word.riddles');

    const saved = await postJson(base, '/api/word-riddles/settings', {
      revealDelaySeconds: 45,
      showIntro: false,
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.revealDelaySeconds, 45);
    assert.equal(saved.body.showIntro, false);

    const added = await postJson(base, '/api/word-riddles/riddles', {
      riddle: 'What has keys but cannot open locks?',
      answer: 'A piano',
    });
    assert.equal(added.status, 200);
    assert.ok(added.body.customCount >= 1);
  } finally {
    webServer.stop();
  }
});

test('family quotes push delivers an attributed quote and settings can add one', async () => {
  const { webServer, base, sent } = await startTestServer();
  try {
    const listed = await getJson(base, '/api/family-quotes/quotes?pageSize=5');
    assert.equal(listed.status, 200);
    assert.ok(listed.body.available > 0);
    assert.equal(listed.body.quotes.length, 5);
    assert.ok(listed.body.quotes.every((quote) => quote.author));
    assert.ok(listed.body.quotes.every((quote) => quote.rows >= 1 && quote.rows <= 6));

    const pushed = await postJson(base, '/api/push/family-quotes');
    assert.equal(pushed.status, 200);
    assert.equal(pushed.body.type, 'family.quotes');
    assert.ok(pushed.body.quote.text);
    assert.ok(pushed.body.quote.author);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'family.quotes');

    const added = await postJson(base, '/api/family-quotes/quotes', {
      text: 'A tested house is a happy house.',
      author: 'The Bridge',
    });
    assert.equal(added.status, 200);
    assert.equal(added.body.customCount, 1);

    const blank = await postJson(base, '/api/family-quotes/quotes', { text: '  ' });
    assert.equal(blank.status, 400);
  } finally {
    webServer.stop();
  }
});

test('warm fuzzies push delivers a compliment and settings can add one', async () => {
  const { webServer, base, sent } = await startTestServer();
  try {
    const listed = await getJson(base, '/api/warm-fuzzies/fuzzies?pageSize=5');
    assert.equal(listed.status, 200);
    assert.ok(listed.body.available > 0);
    assert.equal(listed.body.fuzzies.length, 5);
    assert.ok(listed.body.fuzzies.every((fuzzy) => fuzzy.rows >= 1 && fuzzy.rows <= 6));

    const pushed = await postJson(base, '/api/push/warm-fuzzies');
    assert.equal(pushed.status, 200);
    assert.equal(pushed.body.type, 'warm.fuzzies');
    assert.ok(pushed.body.fuzzy.text);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'warm.fuzzies');

    const added = await postJson(base, '/api/warm-fuzzies/fuzzies', {
      text: 'You make test kitchens feel like home.',
    });
    assert.equal(added.status, 200);
    assert.equal(added.body.customCount, 1);

    const blank = await postJson(base, '/api/warm-fuzzies/fuzzies', { text: '  ' });
    assert.equal(blank.status, 400);
  } finally {
    webServer.stop();
  }
});

test('daily bucket fillers push delivers a challenge and settings can add one', async () => {
  const { webServer, base, sent } = await startTestServer();
  try {
    const listed = await getJson(base, '/api/daily-bucket-fillers/fillers?pageSize=5');
    assert.equal(listed.status, 200);
    assert.ok(listed.body.available > 0);
    assert.equal(listed.body.fillers.length, 5);
    assert.ok(listed.body.fillers.every((filler) => filler.rows >= 1 && filler.rows <= 6));

    const pushed = await postJson(base, '/api/push/daily-bucket-fillers');
    assert.equal(pushed.status, 200);
    assert.equal(pushed.body.type, 'bucket.fillers');
    assert.ok(pushed.body.filler.text);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'bucket.fillers');

    const added = await postJson(base, '/api/daily-bucket-fillers/fillers', {
      text: 'Leave a kind note on a neighbor porch.',
    });
    assert.equal(added.status, 200);
    assert.equal(added.body.customCount, 1);

    const blank = await postJson(base, '/api/daily-bucket-fillers/fillers', { text: '  ' });
    assert.equal(blank.status, 400);
  } finally {
    webServer.stop();
  }
});

test('misheard lyrics push delivers an attributed lyric and settings can add one', async () => {
  const { webServer, base, sent } = await startTestServer();
  try {
    const listed = await getJson(base, '/api/misheard-lyrics/lyrics?pageSize=5');
    assert.equal(listed.status, 200);
    assert.ok(listed.body.available > 0);
    assert.equal(listed.body.lyrics.length, 5);
    assert.ok(listed.body.lyrics.every((lyric) => lyric.artist));
    assert.ok(listed.body.lyrics.every((lyric) => lyric.rows >= 1 && lyric.rows <= 6));

    const pushed = await postJson(base, '/api/push/misheard-lyrics');
    assert.equal(pushed.status, 200);
    assert.equal(pushed.body.type, 'misheard.lyrics');
    assert.ok(pushed.body.lyric.text);
    assert.ok(pushed.body.lyric.artist);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'misheard.lyrics');

    const added = await postJson(base, '/api/misheard-lyrics/lyrics', {
      text: 'Hold me closer, Tony Danza',
      artist: 'The Bridge',
    });
    assert.equal(added.status, 200);
    assert.equal(added.body.customCount, 1);

    const blank = await postJson(base, '/api/misheard-lyrics/lyrics', { text: '  ' });
    assert.equal(blank.status, 400);
  } finally {
    webServer.stop();
  }
});

test('periodic table push delivers an element and settings can filter categories', async () => {
  const { webServer, base, sent } = await startTestServer();
  try {
    const listed = await getJson(base, '/api/periodic-table/settings');
    assert.equal(listed.status, 200);
    assert.equal(listed.body.total, 118);
    assert.ok(listed.body.available >= 118);
    assert.equal(listed.body.elements.length, 118);
    assert.ok(listed.body.elements.every((element) => element.lines?.length === 6));

    const pushed = await postJson(base, '/api/push/periodic-table', { number: 1 });
    assert.equal(pushed.status, 200);
    assert.equal(pushed.body.type, 'periodic.table');
    assert.equal(pushed.body.element.number, 1);
    assert.ok(pushed.body.element.name);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'periodic.table');

    const filtered = await postJson(base, '/api/periodic-table/settings', {
      categories: ['halogen'],
    });
    assert.ok(filtered.body.available >= 5);
    assert.ok(filtered.body.available < 118);

    const reset = await postJson(base, '/api/periodic-table/settings', { reset: true });
    assert.equal(reset.body.available, 118);
  } finally {
    webServer.stop();
  }
});

test('word of the day push delivers an entry and settings can filter parts of speech', async () => {
  const { webServer, base, sent } = await startTestServer();
  try {
    const listed = await getJson(base, '/api/word-of-the-day/settings');
    assert.equal(listed.status, 200);
    assert.ok(listed.body.total >= 1200);
    assert.ok(listed.body.available >= 1200);
    assert.ok(listed.body.words.length >= 3);
    assert.ok(listed.body.words.every((entry) => entry.lines?.length === 6));

    const pushed = await postJson(base, '/api/push/word-of-the-day', { word: 'oracy' });
    assert.equal(pushed.status, 200);
    assert.equal(pushed.body.type, 'word.day');
    assert.equal(pushed.body.entry.word, 'oracy');
    assert.ok(pushed.body.entry.definition);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'word.day');

    const filtered = await postJson(base, '/api/word-of-the-day/settings', {
      partsOfSpeech: ['noun'],
    });
    assert.ok(filtered.body.available >= 1000);
    assert.ok(filtered.body.available < filtered.body.total);

    const reset = await postJson(base, '/api/word-of-the-day/settings', { reset: true });
    assert.equal(reset.body.available, reset.body.total);
  } finally {
    webServer.stop();
  }
});

test('dad jokes push delivers a two-part joke and settings can add one', async () => {
  const { webServer, base, sent } = await startTestServer();
  try {
    const listed = await getJson(base, '/api/dad-jokes/jokes?pageSize=5');
    assert.equal(listed.status, 200);
    assert.ok(listed.body.available > 0);
    assert.equal(listed.body.jokes.length, 5);
    assert.ok(listed.body.jokes.every((joke) => joke.punchline));
    assert.ok(listed.body.jokes.every((joke) => joke.rows >= 1 && joke.rows <= 6));

    const pushed = await postJson(base, '/api/push/dad-jokes');
    assert.equal(pushed.status, 200);
    assert.equal(pushed.body.type, 'dad.jokes');
    assert.ok(pushed.body.joke.setup);
    assert.ok(pushed.body.joke.punchline);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'dad.jokes');

    const added = await postJson(base, '/api/dad-jokes/jokes', {
      setup: 'Why did the test suite cross the road?',
      punchline: 'To get to the other side effects.',
    });
    assert.equal(added.status, 200);
    assert.equal(added.body.customCount, 1);

    const blank = await postJson(base, '/api/dad-jokes/jokes', { setup: '  ' });
    assert.equal(blank.status, 400);
  } finally {
    webServer.stop();
  }
});

test('roast me push delivers a board-fit roast and settings can add one', async () => {
  const { webServer, base, sent } = await startTestServer();
  try {
    const listed = await getJson(base, '/api/roast-me/roasts?pageSize=5');
    assert.equal(listed.status, 200);
    assert.ok(listed.body.available > 0);
    assert.equal(listed.body.roasts.length, 5);
    assert.ok(listed.body.roasts.every((roast) => roast.rows >= 1 && roast.rows <= 6));

    const pushed = await postJson(base, '/api/push/roast-me');
    assert.equal(pushed.status, 200);
    assert.equal(pushed.body.type, 'roast.me');
    assert.ok(pushed.body.roast.text);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'roast.me');

    const added = await postJson(base, '/api/roast-me/roasts', {
      text: 'You are the only unit test this bridge cannot pass.',
    });
    assert.equal(added.status, 200);
    assert.equal(added.body.customCount, 1);

    const blank = await postJson(base, '/api/roast-me/roasts', { text: '  ' });
    assert.equal(blank.status, 400);
  } finally {
    webServer.stop();
  }
});

test('chuck norris push delivers a board-fit fact and settings can add one', async () => {
  const { webServer, base, sent } = await startTestServer();
  try {
    const listed = await getJson(base, '/api/chuck-norris/facts?pageSize=5');
    assert.equal(listed.status, 200);
    assert.ok(listed.body.available > 0);
    assert.ok(listed.body.facts.length > 0);

    const pushed = await postJson(base, '/api/push/chuck-norris');
    assert.equal(pushed.status, 200);
    assert.equal(pushed.body.type, 'chuck.facts');
    assert.match(pushed.body.fact.text, /Chuck Norris/i);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'chuck.facts');

    const added = await postJson(base, '/api/chuck-norris/facts', {
      text: 'Chuck Norris can unit test the bridge.',
    });
    assert.equal(added.status, 200);
    assert.ok(added.body.customCount >= 1);
  } finally {
    webServer.stop();
  }
});

test('amazing facts push delivers a board-fit fact and settings can add one', async () => {
  const { webServer, base, sent } = await startTestServer();
  try {
    const listed = await getJson(base, '/api/amazing-facts/facts?pageSize=5');
    assert.equal(listed.status, 200);
    assert.ok(listed.body.available > 0);
    assert.ok(listed.body.facts.length > 0);

    const pushed = await postJson(base, '/api/push/amazing-facts');
    assert.equal(pushed.status, 200);
    assert.equal(pushed.body.type, 'amazing.facts');
    assert.match(String(pushed.body.fact?.text || ''), /./);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'amazing.facts');

    const added = await postJson(base, '/api/amazing-facts/facts', {
      text: 'Signal Bridge can flip amazing facts onto a Vestaboard without an API key.',
      category: 'technology',
    });
    assert.equal(added.status, 200);
    assert.ok(added.body.customCount >= 1);
  } finally {
    webServer.stop();
  }
});

test('world geography facts push delivers a board-fit fact and settings can add one', async () => {
  const { webServer, base, sent } = await startTestServer();
  try {
    const listed = await getJson(base, '/api/world-geography-facts/facts?pageSize=5');
    assert.equal(listed.status, 200);
    assert.ok(listed.body.available > 0);
    assert.ok(listed.body.facts.length > 0);

    const pushed = await postJson(base, '/api/push/world-geography-facts');
    assert.equal(pushed.status, 200);
    assert.equal(pushed.body.type, 'geo.facts');
    assert.match(String(pushed.body.fact?.text || ''), /./);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'geo.facts');

    const added = await postJson(base, '/api/world-geography-facts/facts', {
      text: 'Signal Bridge can flip world geography facts onto a Vestaboard without an API key.',
      category: 'trivia',
    });
    assert.equal(added.status, 200);
    assert.ok(added.body.customCount >= 1);
  } finally {
    webServer.stop();
  }
});

test('conversation starters push delivers a prompt and settings can add one', async () => {
  const { webServer, base, sent } = await startTestServer();
  try {
    const listed = await getJson(base, '/api/conversation-starters/prompts?pageSize=5');
    assert.equal(listed.status, 200);
    assert.ok(listed.body.available > 0);
    assert.ok(listed.body.prompts.length > 0);

    const pushed = await postJson(base, '/api/push/conversation-starters');
    assert.equal(pushed.status, 200);
    assert.equal(pushed.body.type, 'talk.starters');
    assert.match(String(pushed.body.prompt?.text || ''), /./);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'talk.starters');

    const added = await postJson(base, '/api/conversation-starters/prompts', {
      text: 'What should we put on the Vestaboard next?',
    });
    assert.equal(added.status, 200);
    assert.ok(added.body.customCount >= 1);
  } finally {
    webServer.stop();
  }
});

test('stoic quotes push delivers a quote and settings can add one', async () => {
  const { webServer, base, sent } = await startTestServer();
  try {
    const listed = await getJson(base, '/api/stoic-quotes/quotes?pageSize=5');
    assert.equal(listed.status, 200);
    assert.ok(listed.body.available > 0);
    assert.ok(listed.body.quotes.length > 0);

    const pushed = await postJson(base, '/api/push/stoic-quotes');
    assert.equal(pushed.status, 200);
    assert.equal(pushed.body.type, 'stoic.quotes');
    assert.match(String(pushed.body.quote?.text || ''), /./);
    assert.match(String(pushed.body.quote?.author || ''), /./);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'stoic.quotes');

    const added = await postJson(base, '/api/stoic-quotes/quotes', {
      text: 'The obstacle is the way.',
      author: 'Marcus Aurelius',
    });
    assert.equal(added.status, 200);
    assert.ok(added.body.customCount >= 1);
  } finally {
    webServer.stop();
  }
});

test('on this day push delivers a history fact and settings can add one', async () => {
  const { webServer, base, sent } = await startTestServer();
  try {
    const listed = await getJson(base, '/api/on-this-day/events?pageSize=5&month=8&day=29');
    assert.equal(listed.status, 200);
    assert.ok(listed.body.total > 0);
    assert.ok(listed.body.events.length > 0);

    const pushed = await postJson(base, '/api/push/on-this-day', { month: 8, day: 29 });
    assert.equal(pushed.status, 200);
    assert.equal(pushed.body.type, 'history.day');
    assert.match(String(pushed.body.event?.text || ''), /./);
    assert.match(String(pushed.body.event?.dateLine || ''), /AUG 29/);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'history.day');

    const added = await postJson(base, '/api/on-this-day/events', {
      month: 8,
      day: 29,
      year: 2099,
      text: 'Signal Bridge ships On This Day for the Vestaboard flaps.',
    });
    assert.equal(added.status, 200);
    assert.ok(added.body.customCount >= 1);
  } finally {
    webServer.stop();
  }
});

test('calendar clock push delivers a monthly grid and settings can change week start', async () => {
  const { webServer, base, sent } = await startTestServer();
  try {
    const status = await getJson(base, '/api/calendar-clock/settings');
    assert.equal(status.status, 200);
    assert.equal(status.body.settings.weekStartsOn, 'sunday');
    assert.equal(status.body.payload?.type, 'calendar.clock');
    assert.ok(status.body.payload?.cells?.length >= 28);
    assert.match(String(status.body.payload?.weekdayName || ''), /DAY$/);

    const pushed = await postJson(base, '/api/push/calendar-clock');
    assert.equal(pushed.status, 200);
    assert.equal(pushed.body.type, 'calendar.clock');
    assert.match(String(pushed.body.weekdayName || ''), /DAY$/);
    assert.match(String(pushed.body.timeLabel || ''), /AM|PM/);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'calendar.clock');
    assert.ok(Array.isArray(sent[0].cells));

    const saved = await postJson(base, '/api/calendar-clock/settings', {
      weekStartsOn: 'monday',
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.settings.weekStartsOn, 'monday');
    assert.equal(saved.body.payload.weekStartsOn, 'monday');

    const reset = await postJson(base, '/api/calendar-clock/settings', { reset: true });
    assert.equal(reset.status, 200);
    assert.equal(reset.body.settings.weekStartsOn, 'sunday');
  } finally {
    webServer.stop();
  }
});

test('word clock push spells the time out and the reading is a setting', async () => {
  const { webServer, base, sent } = await startTestServer();
  try {
    const status = await getJson(base, '/api/word-clock/settings');
    assert.equal(status.status, 200);
    assert.deepEqual(status.body.settings, { rounding: 'five', dayPart: true });
    assert.equal(status.body.payload?.type, 'word.clock');
    assert.match(String(status.body.payload?.text || ''), /^IT'S .*\.$/);
    // The card paints these rows, so they have to be a real 6x22 board.
    assert.equal(status.body.boardRows?.length, 6);
    assert.equal(status.body.boardRows[0].length, 22);

    const pushed = await postJson(base, '/api/push/word-clock');
    assert.equal(pushed.status, 200);
    assert.equal(pushed.body.type, 'word.clock');
    assert.match(String(pushed.body.text || ''), /^IT'S /);
    assert.ok(Array.isArray(pushed.body.lines) && pushed.body.lines.length);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'word.clock');

    const saved = await postJson(base, '/api/word-clock/settings', {
      rounding: 'exact',
      dayPart: false,
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.settings, { rounding: 'exact', dayPart: false });
    assert.equal(saved.body.payload.rounding, 'exact');
    assert.doesNotMatch(String(saved.body.payload.text || ''), /IN THE|AT NIGHT/);

    const reset = await postJson(base, '/api/word-clock/settings', { reset: true });
    assert.equal(reset.status, 200);
    assert.deepEqual(reset.body.settings, { rounding: 'five', dayPart: true });
  } finally {
    webServer.stop();
  }
});

test('plex top 10 settings round-trip and the push needs a linked Plex', async () => {
  const { webServer, base, sent } = await startTestServer();
  try {
    const status = await getJson(base, '/api/plex-top10/settings');
    assert.equal(status.status, 200);
    assert.equal(status.body.settings.source, 'library');
    assert.deepEqual(status.body.settings.genres, []);
    assert.deepEqual(status.body.genres, []);
    assert.equal(status.body.linked, false);

    const saved = await postJson(base, '/api/plex-top10/settings', {
      source: 'global',
      genres: ['Action', 'Comedy'],
      cacheMinutes: 60,
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.settings.source, 'global');
    assert.deepEqual(saved.body.settings.genres, ['Action', 'Comedy']);
    assert.equal(saved.body.settings.cacheMinutes, 60);

    // No token on the test rig, so the board must refuse rather than flip a
    // half-built chart — and nothing may reach the display.
    const pushed = await postJson(base, '/api/push/plex-top10');
    assert.equal(pushed.status, 409);
    assert.match(String(pushed.body.error || ''), /not linked/i);
    assert.equal(sent.length, 0);

    const reset = await postJson(base, '/api/plex-top10/settings', { reset: true });
    assert.equal(reset.status, 200);
    assert.equal(reset.body.settings.source, 'library');
  } finally {
    webServer.stop();
  }
});

test('admin Settings has a Plex Top 10 card under Media with a genre picker', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/web/admin/index.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '../src/web/admin/app.js'), 'utf8');

  assert.match(html, /id="plex-top10-settings-card"[^>]*data-settings-group="media"/);
  assert.match(html, /data-plex-top10-source="library"/);
  assert.match(html, /data-plex-top10-source="global"/);
  // Genre and part-of-speech ticks sit on a column grid, not a ragged flex row.
  assert.match(html, /class="check-columns check-columns-wide" id="plex-top10-genres"/);
  assert.match(html, /class="check-columns" id="learn-japanese-pos"/);
  assert.equal((html.match(/class="check-columns"/g) || []).length, 12);
  assert.match(js, /\/api\/plex-top10\/settings/);
  assert.match(js, /\/api\/push\/plex-top10/);
  // The board is two frames of five, so the Media pane gained a tile.
  assert.match(html, /id="push-row-media"[^>]*data-push-category="media"[\s\S]{0,120}data-skeleton-count="5"/);
});

test('the Date Book is a CRUD collection and Red Letter will not push an empty one', async () => {
  const { webServer, base, sent } = await startTestServer();
  const cookie = baseCookies.get(base) || null;
  const send = (method, route, body) => request(`${base}${route}`, { method, body, cookie });
  try {
    const empty = await getJson(base, '/api/red-letter/settings');
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.events, []);
    assert.equal(empty.body.upcoming, 0);
    assert.equal(empty.body.settings.pushSelection, 'next');
    assert.equal(empty.body.boardPreview, null);

    // Nothing to count down to must be a refusal, not a blank board.
    const refused = await postJson(base, '/api/push/red-letter');
    assert.equal(refused.status, 409);
    assert.equal(sent.length, 0);

    const bad = await postJson(base, '/api/date-book/events', { name: 'No date' });
    assert.equal(bad.status, 400);
    assert.match(String(bad.body.error || ''), /name and a YYYY-MM-DD date/);

    const added = await postJson(base, '/api/date-book/events', {
      name: 'Amanda visits',
      date: '2099-11-27',
      message: 'Welcome home, Amanda',
    });
    assert.equal(added.status, 200);
    const id = added.body.event.id;
    assert.equal(id, 'amanda-visits-1127');
    assert.equal(added.body.upcoming, 1);
    assert.equal(added.body.events[0].next.date, '2099-11-27');
    assert.equal(added.body.boardPreview.event.name, 'Amanda visits');
    assert.equal(added.body.boardPreview.card, 'countdown');

    const edited = await send('PUT', `/api/date-book/events/${id}`, { recurring: true, message: 'See you soon', time: '18:00' });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.event.recurring, true);
    assert.equal(edited.body.event.message, 'See you soon');
    assert.equal(edited.body.event.time, '18:00');
    assert.equal(edited.body.event.name, 'Amanda visits', 'a patch keeps the fields it did not mention');

    const missing = await send('PUT', '/api/date-book/events/nope', { message: 'x' });
    assert.equal(missing.status, 404);

    // Both previews come from the bridge so the sheet cannot drift from the board.
    const preview = await postJson(base, '/api/date-book/preview', { eventId: id });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.countdown.card, 'countdown');
    assert.equal(preview.body.dayOf.card, 'day-of');
    assert.equal(preview.body.countdown.rows.length, 6);
    assert.equal(preview.body.countdown.rows[0].length, 22);

    const draft = await postJson(base, '/api/date-book/preview', {
      event: { name: 'Unsaved', date: '2099-01-02', message: 'Draft message' },
    });
    assert.equal(draft.status, 200);
    assert.equal(draft.body.dayOf.event.name, 'Unsaved');
    assert.equal((await postJson(base, '/api/date-book/preview', {})).status, 400);

    const pushed = await postJson(base, '/api/push/red-letter');
    assert.equal(pushed.status, 200);
    assert.equal(pushed.body.card, 'countdown');
    assert.equal(pushed.body.event.name, 'Amanda visits');

    // Artwork rides on the event, and clearing it falls back to the house card.
    const cells = Array.from({ length: 6 }, (_, row) => (
      Array.from({ length: 22 }, (_, col) => {
        if (row === 0) return 63;
        return col >= 12 ? -1 : 0;
      })
    ));
    const painted = await send('PUT', `/api/date-book/events/${id}`, { layout: { cells } });
    assert.equal(painted.status, 200);
    assert.equal(painted.body.event.layout.cells.length, 6);
    assert.equal(
      (await postJson(base, '/api/date-book/preview', { eventId: id })).body.dayOf.custom,
      true,
    );
    await send('PUT', `/api/date-book/events/${id}`, { layout: null });
    assert.equal(
      (await postJson(base, '/api/date-book/preview', { eventId: id })).body.dayOf.custom,
      false,
    );

    const settings = await postJson(base, '/api/red-letter/settings', {
      pushSelection: 'random',
      scheduleSelection: 'next',
      showTime: false,
    });
    assert.equal(settings.status, 200);
    assert.equal(settings.body.settings.pushSelection, 'random');
    assert.equal(settings.body.settings.showTime, false);

    // One control at a time, the way the Settings card posts. The other
    // selection (and showTime) must stay put.
    const onlySchedule = await postJson(base, '/api/red-letter/settings', {
      scheduleSelection: 'random',
    });
    assert.equal(onlySchedule.body.settings.pushSelection, 'random');
    assert.equal(onlySchedule.body.settings.scheduleSelection, 'random');
    assert.equal(onlySchedule.body.settings.showTime, false);

    const holiday = await postJson(base, '/api/date-book/events', {
      name: 'Thanksgiving',
      schedule: 'weekday',
      ordinal: 'last',
      weekday: 4,
      month: 11,
      message: 'Pass the rolls',
    });
    assert.equal(holiday.status, 200);
    assert.equal(holiday.body.event.schedule, 'weekday');
    assert.equal(holiday.body.event.recurring, true);
    assert.equal(holiday.body.event.id, 'thanksgiving-last-thu-nov');
    const thanksNext = holiday.body.events.find((row) => row.id === 'thanksgiving-last-thu-nov')?.next;
    assert.match(String(thanksNext?.date || ''), /^20\d\d-11-/);

    await send('DELETE', `/api/date-book/events/${holiday.body.event.id}`);
    const removed = await send('DELETE', `/api/date-book/events/${id}`);
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.body.events, []);
    assert.equal((await send('DELETE', `/api/date-book/events/${id}`)).status, 404);
  } finally {
    webServer.stop();
  }
});

test('admin Settings has a Red Letter card, a Date Book sheet and the layout designer', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/web/admin/index.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '../src/web/admin/app.js'), 'utf8');

  assert.match(html, /id="red-letter-settings-card"[^>]*data-settings-group="global"/);
  assert.match(html, /data-red-letter-push="next"/);
  assert.match(html, /data-red-letter-push="random"/);
  assert.match(html, /data-red-letter-schedule="next"/);
  assert.match(html, /data-red-letter-schedule="random"/);

  // The Date Book sheet: compose form, both previews, and the event list.
  assert.match(html, /id="date-book-manage-sheet"[\s\S]{0,400}class="sheet cn-manage-sheet date-book-sheet"/);
  assert.match(html, /id="date-book-name"/);
  assert.match(html, /id="date-book-message"/);
  assert.match(html, /id="date-book-date"/);
  assert.match(html, /id="date-book-schedule"/);
  assert.match(html, /id="date-book-ordinal"/);
  assert.match(html, /id="date-book-weekday"/);
  assert.match(html, /id="date-book-month"/);
  assert.match(html, /id="date-book-time"/);
  assert.match(html, /id="date-book-recurring"/);
  assert.match(html, /placeholder="Love you always &amp; forever, Ponpon"/);
  assert.match(html, /data-date-book-preview="countdown"/);
  assert.match(html, /data-date-book-preview="dayOf"/);
  assert.match(html, /id="date-book-list"/);

  // The designer: a paint palette, a message tool, the grid and the presets.
  assert.match(html, /id="red-letter-designer-sheet"/);
  assert.match(html, /id="red-letter-grid"[^>]*tabindex="0"/);
  assert.match(html, /class="vb-bezel rl-designer-bezel"/);
  assert.match(html, /id="red-letter-chars"/);
  assert.match(html, /id="red-letter-quick-type"/);
  assert.match(html, /id="btn-red-letter-designer-blank"/);
  assert.match(html, /data-rl-tool="message"/);
  assert.match(html, /data-rl-tool="erase"/);
  for (const chip of ['red', 'orange', 'yellow', 'green', 'blue', 'violet', 'white', 'black', 'filled']) {
    assert.match(html, new RegExp(`data-rl-chip="${chip}"`), `the palette needs a ${chip} chip`);
  }
  // The two chips this feature added must be the simulator's flap colours, not
  // a third set of hexes — the designer is where someone picks a chip.
  const css = fs.readFileSync(path.join(__dirname, '../src/web/admin/styles.css'), 'utf8');
  assert.match(css, /\.cn-preview-row span\.is-chip-black \{\s*background: #101013;/);
  assert.match(css, /\.cn-preview-row span\.is-chip-filled \{\s*background: #6e6e6e;/);
  assert.match(css, /\.red-letter-settings-columns/);
  assert.match(css, /\.rl-designer-bezel/);
  for (const preset of [
    'heart', 'confetti', 'border', 'blank',
    'halloween', 'summer', 'beach', 'christmas', 'autumn',
  ]) {
    assert.match(html, new RegExp(`data-rl-preset="${preset}"`));
  }
  assert.match(html, /data-rl-preset="confetti">Day of</);
  assert.match(html, /data-rl-preset="halloween">Halloween</);
  assert.match(html, /data-rl-preset="christmas">Christmas</);
  assert.match(js, /halloween:\s*\[/);
  assert.match(js, /summer:\s*\[/);
  assert.match(js, /beach:\s*\[/);
  assert.match(js, /christmas:\s*\[/);
  assert.match(js, /autumn:\s*\[/);
  // Every preset line is a full 22-column board row.
  for (const name of ['halloween', 'summer', 'beach', 'christmas', 'autumn']) {
    const block = js.match(new RegExp(`${name}:\\s*\\[([\\s\\S]*?)\\]`));
    assert.ok(block, `${name} preset is defined`);
    const lines = [...block[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
    assert.equal(lines.length, 6, `${name} has six rows`);
    for (const line of lines) {
      assert.equal(line.length, 22, `${name} row is 22 wide: ${line}`);
    }
  }

  assert.match(js, /\/api\/red-letter\/settings/);
  assert.match(js, /\/api\/push\/red-letter/);
  assert.match(js, /\/api\/date-book\/events/);
  assert.match(js, /\/api\/date-book\/preview/);
  assert.match(js, /'red-letter-settings-card': \['vestaboard'\]/);
  // Previews render server-built rows rather than a second copy of the layout code.
  assert.match(js, /function renderFlapGrid\(/);
  assert.match(js, /function renderVbGrid\(/);
  assert.match(js, /presetCells\('confetti'\)/);
  assert.match(js, /writeCharsFromCaret/);
  assert.match(js, /designerBoardIsClear/);
});

test('world population push delivers an estimate and settings can retune the model', async () => {
  const { webServer, base, sent } = await startTestServer();
  try {
    const status = await getJson(base, '/api/world-population/settings');
    assert.equal(status.status, 200);
    assert.ok(status.body.estimate?.population > 0);
    assert.match(String(status.body.formatted || ''), /,/);

    const pushed = await postJson(base, '/api/push/world-population');
    assert.equal(pushed.status, 200);
    assert.equal(pushed.body.type, 'world.population');
    assert.ok(pushed.body.population?.total > 0);
    assert.match(String(pushed.body.population?.formatted || ''), /,/);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'world.population');

    const saved = await postJson(base, '/api/world-population/settings', {
      basePopulation: 9_000_000_000,
      baseAt: '2026-01-01T00:00:00.000Z',
      birthsPerYear: 100_000_000,
      deathsPerYear: 40_000_000,
      sourceLabel: 'TEST MODEL',
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.settings.basePopulation, 9_000_000_000);
    assert.equal(saved.body.settings.sourceLabel, 'TEST MODEL');

    const reset = await postJson(base, '/api/world-population/settings', { reset: true });
    assert.equal(reset.status, 200);
    assert.ok(reset.body.settings.basePopulation < 9_000_000_000);
  } finally {
    webServer.stop();
  }
});

test('baking inspiration push delivers an idea and settings can add one', async () => {
  const { webServer, base, sent } = await startTestServer();
  try {
    const listed = await getJson(base, '/api/baking-inspiration/ideas?pageSize=5');
    assert.equal(listed.status, 200);
    assert.ok(listed.body.available > 0);
    assert.ok(listed.body.ideas.length > 0);

    const pushed = await postJson(base, '/api/push/baking-inspiration');
    assert.equal(pushed.status, 200);
    assert.equal(pushed.body.type, 'bake.inspire');
    assert.match(String(pushed.body.idea?.title || ''), /./);
    assert.ok(Array.isArray(pushed.body.idea?.ingredients));
    assert.ok(pushed.body.idea.ingredients.length >= 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'bake.inspire');

    const added = await postJson(base, '/api/baking-inspiration/ideas', {
      title: 'TEST HOUSE COOKIES',
      ingredients: 'FLOUR, BUTTER, SUGAR',
    });
    assert.equal(added.status, 200);
    assert.ok(added.body.customCount >= 1);
  } finally {
    webServer.stop();
  }
});

test('quiet hours reminder push delivers a random night card to the Vestaboard', async () => {
  const { webServer, base, sent } = await startTestServer();
  try {
    const pushed = await postJson(base, '/api/push/quiet-hours-reminder');
    assert.equal(pushed.status, 200);
    assert.equal(pushed.body.type, 'quiet-hours.reminder');
    assert.match(String(pushed.body.variant || ''), /./);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'quiet-hours.reminder');
    assert.equal(sent[0].variant, pushed.body.variant);
  } finally {
    webServer.stop();
  }
});

test('public base URL settings live-reload and reject http', async () => {
  const { webServer, base } = await startTestServer();
  try {
    const empty = await getJson(base, '/api/public-url/settings');
    assert.equal(empty.status, 200);
    assert.equal(empty.body.settings.publicBaseUrl, '');

    const bad = await postJson(base, '/api/public-url/settings', {
      publicBaseUrl: 'http://signal.wittydigital.com',
    });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /https/);

    const saved = await postJson(base, '/api/public-url/settings', {
      publicBaseUrl: 'https://signal.wittydigital.com/',
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.settings.publicBaseUrl, 'https://signal.wittydigital.com');
    assert.equal(saved.body.origin, 'https://signal.wittydigital.com');
    assert.equal(saved.body.shortLinkReady, true);

    const put = await request(`${base}/api/public-url/settings`, {
      method: 'PUT',
      body: { publicBaseUrl: 'https://other.wittydigital.com' },
      cookie: baseCookies.get(base),
    });
    assert.equal(put.status, 200);
    assert.equal(put.body.settings.publicBaseUrl, 'https://other.wittydigital.com');
  } finally {
    webServer.stop();
  }
});

test('guest book token is 409 when TINYURL_API_TOKEN is in the environment', async () => {
  const prev = process.env.TINYURL_API_TOKEN;
  process.env.TINYURL_API_TOKEN = 'env-token-value';
  const { webServer, base } = await startTestServer();
  try {
    const got = await getJson(base, '/api/guest-book/settings');
    assert.equal(got.status, 200);
    assert.equal(got.body.credentials.envBlocksOverwrite, true);
    assert.equal(got.body.credentials.hasToken, true);

    const blocked = await postJson(base, '/api/guest-book/settings', {
      apiToken: 'session-token',
    });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.source, 'env');
    assert.match(blocked.body.error, /TINYURL_API_TOKEN/);

    const badAlias = await postJson(base, '/api/guest-book/settings', {
      preferredAlias: 'ab',
    });
    assert.equal(badAlias.status, 400);
    assert.match(badAlias.body.error, /5–10|5-10/);
  } finally {
    webServer.stop();
    if (prev == null) delete process.env.TINYURL_API_TOKEN;
    else process.env.TINYURL_API_TOKEN = prev;
  }
});

test('guest snaps token is 409 when TINYURL_API_TOKEN is in the environment', async () => {
  const prev = process.env.TINYURL_API_TOKEN;
  process.env.TINYURL_API_TOKEN = 'env-token-value';
  const { webServer, base } = await startTestServer();
  try {
    const got = await getJson(base, '/api/guest-snaps/settings');
    assert.equal(got.status, 200);
    assert.equal(got.body.credentials.envBlocksOverwrite, true);

    const blocked = await postJson(base, '/api/guest-snaps/settings', {
      apiToken: 'session-token',
    });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.source, 'env');
  } finally {
    webServer.stop();
    if (prev == null) delete process.env.TINYURL_API_TOKEN;
    else process.env.TINYURL_API_TOKEN = prev;
  }
});

test('global TinyURL settings are 409 when TINYURL_API_TOKEN is in the environment', async () => {
  const prev = process.env.TINYURL_API_TOKEN;
  process.env.TINYURL_API_TOKEN = 'env-token-value';
  const { webServer, base } = await startTestServer();
  try {
    const blocked = await postJson(base, '/api/tinyurl/settings', {
      apiToken: 'session-token',
    });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.source, 'env');
  } finally {
    webServer.stop();
    if (prev == null) delete process.env.TINYURL_API_TOKEN;
    else process.env.TINYURL_API_TOKEN = prev;
  }
});

test('public games APIs work without an admin session and the push route does not', async () => {
  const { webServer, base } = await startTestServer({ autoLogin: false });
  try {
    const missing = await request(`${base}/api/games/session?code=XXXX`);
    assert.equal(missing.status, 404);

    const created = await request(`${base}/api/push/word-scramble`, {
      method: 'POST',
      body: {},
    });
    assert.equal(created.status, 401);

    const join = await request(`${base}/api/games/join`, {
      method: 'POST',
      body: { code: 'XXXX', name: 'Luis' },
    });
    assert.equal(join.status, 400);
  } finally {
    webServer.stop();
  }
});

test('games page and a live session join without an admin session', async () => {
  const realRoot = path.join(__dirname, '../src/web');
  const { webServer, base, cookie } = await startTestServer({
    webRoot: realRoot,
  });
  try {
    const page = await request(`${base}/games/`);
    assert.equal(page.status, 200);
    assert.match(page.text, /Word Scramble/);
    assert.match(page.text, /games\.css\?v=/);
    assert.match(page.text, /games\.js\?v=/);
    assert.match(page.text, /scramble\.js\?v=/);

    const pushed = await postJson(base, '/api/push/word-scramble', {}, cookie);
    assert.equal(pushed.status, 200);
    const code = pushed.body.session?.code;
    assert.match(String(code || ''), /^[A-HJ-NP-Z]{4}$/);

    const resolved = await request(`${base}/api/games/session?code=${code}`);
    assert.equal(resolved.status, 200);
    assert.equal(resolved.body.session.code, code);

    const joined = await request(`${base}/api/games/join`, {
      method: 'POST',
      body: { code, name: 'Luis' },
    });
    assert.equal(joined.status, 200);
    assert.equal(joined.body.player.name, 'Luis');
    assert.match(String(joined.headers['set-cookie'] || ''), /signal_games=/);
    assert.equal(joined.body.session.allowLateJoin, true);
    assert.deepEqual(joined.body.session.you.words, []);

    // One standings list, or the same player shows up twice on the phone.
    const js = fs.readFileSync(path.join(realRoot, 'games', 'games.js'), 'utf8');
    assert.match(page.text, /id="gm-list"/);
    assert.doesNotMatch(page.text, /id="gm-roster"/);
    assert.doesNotMatch(page.text, /id="gm-scores"/);
    assert.match(page.text, /id="gm-found"/);
    assert.match(page.text, /id="gm-recap"/);
    assert.match(page.text, /id="gm-code-line"/);
    assert.match(js, /Friends can still join/);

    // Phone first, but the board and the lists sit side by side on a tablet
    // or a laptop, and the tiles size off their column rather than the window.
    const css = fs.readFileSync(path.join(realRoot, 'games', 'games.css'), 'utf8');
    assert.match(page.text, /class="gm-stage"/);
    assert.match(page.text, /class="gm-side"/);
    assert.match(css, /@media \(min-width: 760px\)/);
    assert.match(css, /@media \(min-width: 1080px\)/);
    assert.match(css, /container-type: inline-size/);
    assert.match(css, /font-size: clamp\([^)]*cqi/);
    assert.match(css, /\[hidden\] \{ display: none !important; \}/,
      'grid and flex panels would otherwise ignore the hidden attribute');

    // Tap the letters instead of typing them: buttons, any unused tile, and
    // spent tiles greyed so nobody spends one twice.
    const scramble = fs.readFileSync(path.join(realRoot, 'games', 'scramble.js'), 'utf8');
    assert.match(scramble, /createElement\('button'\)/);
    assert.match(scramble, /function pathFor/);
    assert.match(scramble, /is-used/);
    assert.match(css, /\.gm-cell\.is-used/);
    assert.match(page.text, /id="btn-gm-clear"/);

    // The keyboard must not bury the board it is there to spell from.
    assert.match(scramble, /visualViewport/);
    assert.match(scramble, /--gm-vh/);
    assert.match(scramble, /keepBoardInView/);
    assert.match(scramble, /setSelectionRange/);
    assert.match(scramble, /--gm-board-max/);
    assert.match(scramble, /leaveKeyboardMode/);
    assert.match(scramble, /gm-keyboard/);
    assert.match(css, /body\.gm-keyboard/);
    assert.match(css, /position:\s*fixed/);
    assert.match(page.text, /interactive-widget=resizes-content/);

    // And the name they typed last time is waiting for them.
    assert.match(js, /localStorage\.getItem\(NAME_KEY\)/);
    assert.match(js, /localStorage\.setItem\(NAME_KEY/);
  } finally {
    webServer.stop();
  }
});

test('Word Scramble settings carry the mid-game join rule', async () => {
  const { webServer, base } = await startTestServer();
  try {
    const initial = await getJson(base, '/api/word-scramble/settings');
    assert.equal(initial.status, 200);
    assert.equal(initial.body.settings.allowLateJoin, true);

    const off = await postJson(base, '/api/word-scramble/settings', { allowLateJoin: false });
    assert.equal(off.status, 200);
    assert.equal(off.body.settings.allowLateJoin, false);

    // A save that does not mention the rule leaves it alone.
    const other = await postJson(base, '/api/word-scramble/settings', { rounds: 4 });
    assert.equal(other.body.settings.rounds, 4);
    assert.equal(other.body.settings.allowLateJoin, false);

    const on = await postJson(base, '/api/word-scramble/settings', { allowLateJoin: true });
    assert.equal(on.body.settings.allowLateJoin, true);
  } finally {
    webServer.stop();
  }
});

test('guest snaps settings round-trip preferred alias and share the TinyURL token', async () => {
  const prev = process.env.TINYURL_API_TOKEN;
  delete process.env.TINYURL_API_TOKEN;
  const calls = [];
  const { webServer, base, dataDir } = await startTestServer({
    shortlinksFetch: async (url, options = {}) => {
      calls.push({ url: String(url), method: options.method || 'GET', body: options.body });
      if (String(url).includes('/create')) {
        const body = JSON.parse(options.body || '{}');
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              domain: 'tinyurl.com',
              alias: String(body.alias || 'GUESTS').toUpperCase(),
              tiny_url: `https://tinyurl.com/${String(body.alias || 'GUESTS').toUpperCase()}`,
            },
          }),
          text: async () => JSON.stringify({
            data: {
              domain: 'tinyurl.com',
              alias: String(body.alias || 'GUESTS').toUpperCase(),
              tiny_url: `https://tinyurl.com/${String(body.alias || 'GUESTS').toUpperCase()}`,
            },
          }),
          headers: { get: () => '' },
        };
      }
      return {
        ok: false,
        status: 301,
        headers: {
          get(name) {
            return String(name).toLowerCase() === 'location'
              ? 'https://signal.wittydigital.com/'
              : '';
          },
        },
        text: async () => '',
      };
    },
  });
  try {
    const origin = await postJson(base, '/api/public-url/settings', {
      publicBaseUrl: 'https://signal.wittydigital.com/',
    });
    assert.equal(origin.status, 200);

    const got = await getJson(base, '/api/guest-snaps/settings');
    assert.equal(got.status, 200);
    assert.equal(got.body.targetPath, '/guestsnaps/');
    assert.equal(got.body.targetUrl, 'https://signal.wittydigital.com/guestsnaps/');
    assert.equal(got.body.shortLinkReady, true);

    const saved = await postJson(base, '/api/guest-snaps/settings', {
      preferredAlias: 'guests',
      apiToken: 'test-token-guest-snaps',
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.settings.preferredAlias, 'GUESTS');
    assert.equal(saved.body.shortlink.alias, 'GUESTS');
    assert.equal(saved.body.shortlink.flapLabel, 'TINYURL.COM/GUESTS');
    assert.equal(saved.body.credentials.hasToken, true);
    assert.ok(calls.some((call) => String(call.url).includes('/create')));

    const bad = await postJson(base, '/api/guest-snaps/settings', {
      preferredAlias: 'ab',
    });
    assert.equal(bad.status, 400);

    const settingsFile = path.join(dataDir, 'data', 'guest-snaps-settings.json');
    assert.equal(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).preferredAlias, 'GUESTS');
  } finally {
    webServer.stop();
    if (prev == null) delete process.env.TINYURL_API_TOKEN;
    else process.env.TINYURL_API_TOKEN = prev;
  }
});

test('guest book page APIs send without an admin session', async () => {
  const pushed = [];
  const { webServer, base } = await startTestServer({
    autoLogin: false,
    vestaboardHub: {
      pushEvent(payload, options) {
        pushed.push({ payload, options });
        return { boards: [{ boardId: 'vestaboard', accepted: 1, pending: 0 }] };
      },
      boards() {
        return [{ quietHours: { enabled: false } }];
      },
    },
  });
  try {
    const status = await request(`${base}/api/guestbook/status`);
    assert.equal(status.status, 200);
    assert.equal(status.body.enabled, true);
    assert.equal(status.body.closed, false);
    assert.ok(!status.body.passwordHash);

    const sent = await request(`${base}/api/guestbook/send`, {
      method: 'POST',
      body: { text: 'Hello from the guest book', name: 'Luis' },
    });
    assert.equal(sent.status, 200);
    assert.equal(sent.body.ok, true);
    assert.equal(sent.body.status, 'shown');
    assert.equal(pushed.length, 1);
    assert.equal(pushed[0].payload.type, 'guest.book');
    assert.equal(pushed[0].options.targetId, 'vestaboard');

    const rows = Array.from({ length: 6 }, () => new Array(22).fill(0));
    rows[0][0] = 65;
    rows[2][10] = 8;
    const painted = await request(`${base}/api/guestbook/send`, {
      method: 'POST',
      body: { rows, name: 'Luis' },
    });
    assert.equal(painted.status, 200);
    assert.equal(painted.body.ok, true);
    assert.equal(pushed[1].payload.rows[0][0], 65);
    assert.equal(pushed[1].payload.rows[2][10], 8);

    const invite = await request(`${base}/api/push/guest-book-invite`, {
      method: 'POST',
      body: {},
    });
    assert.equal(invite.status, 401);
  } finally {
    webServer.stop();
  }
});

test('guest book invite push needs a short link', async () => {
  const pushed = [];
  const { webServer, base } = await startTestServer({
    vestaboardHub: {
      pushEvent(payload, options) {
        pushed.push({ payload, options });
        return { boards: [{ boardId: 'vestaboard', accepted: 1, pending: 0 }] };
      },
      boards() {
        return [{ quietHours: { enabled: false } }];
      },
    },
  });
  try {
    const invite = await postJson(base, '/api/push/guest-book-invite', {});
    assert.equal(invite.status, 409);
    assert.match(invite.body.error, /short link/i);
    assert.equal(pushed.length, 0);
  } finally {
    webServer.stop();
  }
});

test('weekly weather push needs a house pin from Settings → Global', async () => {
  const { webServer, base } = await startTestServer();
  try {
    const locale = await getJson(base, '/api/locale/settings');
    assert.equal(locale.status, 200);
    assert.equal(locale.body.ok, true);
    assert.equal(locale.body.settings.latitude, null);

    const push = await postJson(base, '/api/push/weekly-weather');
    assert.equal(push.status, 400);
    assert.match(push.body.error, /Settings → Global/);
  } finally {
    webServer.stop();
  }
});

test('weather alerts push needs a house pin and can deliver a mocked NWS alert', async () => {
  const { webServer, base } = await startTestServer();
  try {
    const missing = await postJson(base, '/api/push/weather-alerts');
    assert.equal(missing.status, 400);
    assert.match(missing.body.error, /Settings → Global/);
  } finally {
    webServer.stop();
  }

  const config = makeConfig({
    weatherAlertsFetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          features: [{
            id: 'alert-1',
            properties: {
              id: 'alert-1',
              event: 'Tornado Warning',
              headline: 'Tornado Warning for Utah County',
              severity: 'Extreme',
              urgency: 'Immediate',
              certainty: 'Observed',
              ends: '2026-08-28T20:45:00-06:00',
              areaDesc: 'Utah, UT',
            },
          }],
        };
      },
    }),
  });
  fs.mkdirSync(path.join(config.ROOT, 'data'), { recursive: true });
  fs.writeFileSync(path.join(config.ROOT, 'data', 'locale-settings.json'), `${JSON.stringify({
    city: 'Lehi',
    label: 'Lehi, UT',
    postalCode: '84043',
    country: 'US',
    latitude: 40.41,
    longitude: -111.85,
    timeZone: 'America/Denver',
    temperatureUnit: 'F',
  }, null, 2)}\n`);

  const { webServer: server2, base: base2, sent } = await startTestServer({ config });
  try {
    const settings = await getJson(base2, '/api/weather-alerts/settings');
    assert.equal(settings.status, 200);
    assert.equal(settings.body.hasLocation, true);
    assert.equal(settings.body.source, 'NWS');

    const pushed = await postJson(base2, '/api/push/weather-alerts');
    assert.equal(pushed.status, 200);
    assert.equal(pushed.body.type, 'weather.alerts');
    assert.equal(pushed.body.mode, 'alerts');
    assert.equal(pushed.body.alerts.length, 1);
    assert.match(String(pushed.body.alerts[0].event || ''), /TORNADO/);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'weather.alerts');

    const saved = await postJson(base2, '/api/weather-alerts/settings', {
      minSeverity: 'Severe',
      maxAlerts: 2,
      includeWatches: false,
      includeAdvisories: false,
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.settings.minSeverity, 'Severe');
  } finally {
    server2.stop();
  }
});

test('stock market push delivers quotes and settings can retune the watchlist', async () => {
  const config = makeConfig({
    stockMarketFetchImpl: async (url) => {
      const symbol = String(url).includes('/MSFT') ? 'MSFT' : 'AAPL';
      const price = symbol === 'MSFT' ? 513.53 : 319.7;
      const previous = symbol === 'MSFT' ? 483.24 : 309.35;
      return {
        ok: true,
        async json() {
          return {
            chart: {
              result: [{
                meta: {
                  symbol,
                  regularMarketPrice: price,
                  chartPreviousClose: previous,
                  currency: 'USD',
                },
              }],
            },
          };
        },
      };
    },
  });
  const { webServer, base, sent } = await startTestServer({ config });
  try {
    const saved = await postJson(base, '/api/stock-market/settings', {
      tickers: 'AAPL, MSFT',
      changeMode: 'percent',
      provider: 'yahoo',
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.settings.tickers, ['AAPL', 'MSFT']);

    const pushed = await postJson(base, '/api/push/stock-market');
    assert.equal(pushed.status, 200);
    assert.equal(pushed.body.type, 'stocks.market');
    assert.equal(pushed.body.quotes.length, 2);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'stocks.market');
  } finally {
    webServer.stop();
  }
});

test('us weather map push paints the country from one upstream call', async () => {
  const calls = [];
  const config = makeConfig({
    usWeatherMapFetchImpl: async (url) => {
      calls.push(url);
      const lats = new URL(url).searchParams.get('latitude').split(',').map(Number);
      return {
        ok: true,
        async json() {
          // Cold up north, hot down south, so the board has a real gradient.
          return lats.map((lat) => ({
            current: { temperature_2m: 110 - lat, weather_code: 0 },
          }));
        },
      };
    },
  });
  const { webServer, base, sent } = await startTestServer({ config });
  try {
    const settings = await getJson(base, '/api/us-weather-map/settings');
    assert.equal(settings.status, 200);
    assert.equal(settings.body.cellCount, 89);
    assert.equal(settings.body.settings.mode, 'temperature');
    assert.equal(settings.body.hasMap, false);
    assert.ok(settings.body.legend.length >= 5);

    const pushed = await postJson(base, '/api/push/us-weather-map');
    assert.equal(pushed.status, 200);
    assert.equal(pushed.body.type, 'us.weather-map');
    assert.equal(pushed.body.cells.length, 89);
    assert.ok(pushed.body.range.maxF > pushed.body.range.minF);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'us.weather-map');
    assert.equal(calls.length, 1, 'the whole map should cost one upstream call');

    // A second push inside the refresh window reuses the readings.
    await postJson(base, '/api/push/us-weather-map');
    assert.equal(calls.length, 1);

    const saved = await postJson(base, '/api/us-weather-map/settings', {
      mode: 'conditions',
      refreshMinutes: 45,
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.settings.mode, 'conditions');
    assert.equal(saved.body.settings.refreshMinutes, 45);
    assert.equal(saved.body.hasMap, true);
    assert.equal(saved.body.legend[0].label, 'Clear');

    const reset = await postJson(base, '/api/us-weather-map/settings', { reset: true });
    assert.equal(reset.body.settings.mode, 'temperature');
  } finally {
    webServer.stop();
  }
});

test('currency rates push delivers FX quotes against the locale base', async () => {
  const config = makeConfig({
    currencyRatesFetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          result: 'success',
          base_code: 'USD',
          rates: {
            EUR: 0.86,
            GBP: 0.74,
            JPY: 160,
            CAD: 1.39,
          },
        };
      },
    }),
  });
  fs.mkdirSync(path.join(config.ROOT, 'data'), { recursive: true });
  fs.writeFileSync(path.join(config.ROOT, 'data', 'locale-settings.json'), `${JSON.stringify({
    city: 'Lehi',
    label: 'Lehi, UT',
    postalCode: '84043',
    country: 'US',
    latitude: 40.41,
    longitude: -111.85,
    timeZone: 'America/Denver',
    temperatureUnit: 'F',
    currencyCode: 'USD',
  }, null, 2)}\n`);

  const { webServer, base, sent } = await startTestServer({ config });
  try {
    const saved = await postJson(base, '/api/currency-rates/settings', {
      quotes: 'EUR, GBP, JPY, CAD',
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.settings.quotes, ['EUR', 'GBP', 'JPY', 'CAD']);
    assert.equal(saved.body.baseCurrency, 'USD');

    const pushed = await postJson(base, '/api/push/currency-rates');
    assert.equal(pushed.status, 200);
    assert.equal(pushed.body.type, 'fx.rates');
    assert.equal(pushed.body.base, 'USD');
    assert.equal(pushed.body.quotes.length, 4);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'fx.rates');
  } finally {
    webServer.stop();
  }
});

test('ISS tracker push delivers position relative to the house pin', async () => {
  const config = makeConfig({
    issTrackerFetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          name: 'iss',
          id: 25544,
          latitude: 41.2,
          longitude: -112.0,
          altitude: 420,
          velocity: 27600,
          visibility: 'daylight',
          units: 'kilometers',
          timestamp: Math.floor(Date.now() / 1000),
        };
      },
    }),
  });
  fs.mkdirSync(path.join(config.ROOT, 'data'), { recursive: true });
  fs.writeFileSync(path.join(config.ROOT, 'data', 'locale-settings.json'), `${JSON.stringify({
    city: 'Lehi',
    label: 'Lehi, UT',
    postalCode: '84043',
    country: 'US',
    latitude: 40.41,
    longitude: -111.85,
    timeZone: 'America/Denver',
    temperatureUnit: 'F',
  }, null, 2)}\n`);

  const { webServer, base, sent } = await startTestServer({ config });
  try {
    const saved = await postJson(base, '/api/iss-tracker/settings', {
      distanceUnit: 'miles',
      showAltitude: true,
      showCoordinates: true,
      showVisibility: true,
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.settings.distanceUnit, 'miles');
    assert.equal(saved.body.hasLocation, true);

    const pushed = await postJson(base, '/api/push/iss-tracker');
    assert.equal(pushed.status, 200);
    assert.equal(pushed.body.type, 'iss.track');
    assert.ok(pushed.body.relativeLabel);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'iss.track');
  } finally {
    webServer.stop();
  }
});

test('Starlink tracker push delivers the next pass over the house pin', async () => {
  const nowMs = Date.now();
  const config = makeConfig({
    starlinkTrackerFetchImpl: async (url) => {
      const href = String(url);
      if (href.includes('/satellites')) {
        return {
          ok: true,
          async json() {
            return {
              results: [
                { name: 'STARLINK-A', norad_id: '90001', category: 'STARLINK' },
                { name: 'STARLINK-B', norad_id: '90002', category: 'STARLINK' },
              ],
            };
          },
        };
      }
      return {
        ok: true,
        async json() {
          return {
            passes: [{
              start_utc: new Date(nowMs + 2 * 3600_000).toISOString(),
              end_utc: new Date(nowMs + 2 * 3600_000 + 240_000).toISOString(),
              max_elevation_deg: 44,
              direction: 'NE',
              sky_condition: 'Night',
              visibility_score: 75,
              visibility_label: 'Good',
              satellite_illuminated: true,
            }],
          };
        },
      };
    },
  });
  fs.mkdirSync(path.join(config.ROOT, 'data'), { recursive: true });
  fs.writeFileSync(path.join(config.ROOT, 'data', 'locale-settings.json'), `${JSON.stringify({
    city: 'Lehi',
    label: 'Lehi, UT',
    postalCode: '84043',
    country: 'US',
    latitude: 40.41,
    longitude: -111.85,
    timeZone: 'America/Denver',
    temperatureUnit: 'F',
  }, null, 2)}\n`);

  const { webServer, base, sent } = await startTestServer({ config });
  try {
    const saved = await postJson(base, '/api/starlink-tracker/settings', {
      hoursAhead: 48,
      minElevation: 20,
      preferVisible: true,
      showWeather: false,
      showVisibility: true,
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.settings.hoursAhead, 48);
    assert.equal(saved.body.hasLocation, true);

    const pushed = await postJson(base, '/api/push/starlink-tracker');
    assert.equal(pushed.status, 200);
    assert.equal(pushed.body.type, 'starlink.track');
    assert.ok(pushed.body.whenLabel);
    assert.ok(pushed.body.directionLabel);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'starlink.track');
  } finally {
    webServer.stop();
  }
});

test('space launch alerts push delivers a cached launch and settings can refresh', async () => {
  const future = new Date(Date.now() + 3 * 3600000).toISOString();
  const config = makeConfig({
    spaceLaunchAlertsFetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          results: [{
            id: 'launch-test-1',
            name: 'Falcon 9 | Starlink 6-56',
            net: future,
            status: { abbrev: 'Go' },
            launch_service_provider: { name: 'SpaceX' },
            rocket: { configuration: { full_name: 'Falcon 9' } },
            mission: { name: 'Starlink 6-56' },
          }],
        };
      },
    }),
  });

  const { webServer, base, sent } = await startTestServer({ config });
  try {
    const listed = await getJson(base, '/api/space-launch-alerts/settings');
    assert.equal(listed.status, 200);
    assert.ok(listed.body.available >= 1);
    assert.ok(listed.body.launches.length >= 1);

    const pushed = await postJson(base, '/api/push/space-launch-alerts', {
      launchId: 'launch-test-1',
    });
    assert.equal(pushed.status, 200);
    assert.equal(pushed.body.type, 'launch.alert');
    assert.ok(pushed.body.launch.sentence);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'launch.alert');

    const refreshed = await postJson(base, '/api/space-launch-alerts/settings', { refresh: true });
    assert.equal(refreshed.status, 200);
    assert.ok(refreshed.body.total >= 1);
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
    'locale-settings-card',
    'public-url-settings-card',
    'guest-snaps-settings-card',
    'guest-book-settings-card',
    'ring-doorbell-settings-card',
    'learn-japanese-settings-card',
    'learn-language-settings-card',
  ]) {
    assert.match(
      css,
      new RegExp(`#tab-settings \\.${card}[^{]*\\{[^}]*grid-column: 1 / -1`),
      `${card} must span both columns`,
    );
  }
  // Headings sit on the cards unless they get the same air as Push's
  // `.push-block` gap (GAME NIGHT → tiles).
  assert.match(css, /#tab-settings \.section-label \{[^}]*margin: 16px 4px 12px;/);

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
  assert.match(html, /id="settings-kind-filter"/);
  assert.match(html, /Applies to/);
  for (const view of ['global', 'accounts', 'youtube', 'games', 'news', 'language', 'travel', 'media']) {
    assert.match(html, new RegExp(`data-settings-view="${view}"`));
    assert.match(html, new RegExp(`data-settings-group="${view}"`));
  }
  assert.match(js, /SETTINGS_VIEW_ORDER = \['global'/);
  assert.match(html, /id="locale-settings-card"/);
  assert.match(html, /id="btn-locale-save"/);
  assert.match(js, /\/api\/locale\/settings/);
  assert.match(html, /id="public-url-settings-card"/);
  assert.match(html, /id="btn-public-url-save"/);
  assert.match(js, /\/api\/public-url\/settings/);
  assert.match(html, /id="guest-snaps-settings-card"/);
  assert.match(html, /id="guest-snaps-alias"/);
  assert.match(html, /id="btn-guest-snaps-save"/);
  assert.match(html, /id="guest-book-settings-card"/);
  assert.match(html, /id="ring-doorbell-settings-card"/);
  assert.match(html, /id="ring-preview"/);
  assert.match(html, /id="btn-guest-book-check"/);
  assert.match(html, /id="guest-book-enabled"/);
  assert.match(html, /id="btn-guest-book-open"/);
  assert.match(html, /id="btn-guest-book-invite"/);
  assert.match(html, /id="guest-book-sheet"/);
  assert.match(html, /id="guest-book-bulk"/);
  assert.match(html, /id="btn-guest-book-release-selected"/);
  assert.match(html, /id="btn-guest-book-push-selected"/);
  assert.match(html, /id="guest-book-delete-sheet"/);
  assert.match(html, /id="btn-guest-book-delete-selected"/);
  assert.doesNotMatch(html, /id="guest-book-select-page"/);
  assert.match(html, /id="btn-guest-book-prev"/);
  assert.match(html, /id="btn-guest-book-next"/);
  assert.match(html, /data-book-filter="waiting"/);
  assert.match(html, /data-book-filter="released"/);
  assert.match(html, /class="cn-fact-list gb-book-list"/);
  assert.doesNotMatch(html, /id="guest-book-dwell"/);
  assert.match(js, /From: /);
  assert.match(js, /previewRows/);
  assert.match(js, /guestBookSelected/);
  assert.match(js, /data-book-release/);
  assert.match(js, /\/api\/guest-book\/release/);
  assert.match(js, /btn-guest-book-release-selected/);
  assert.match(js, /btn-guest-book-push-selected/);
  assert.match(js, /openGuestBookDeleteConfirm/);
  assert.match(js, /guest-book-delete-sheet/);
  assert.doesNotMatch(js, /Delete this message from The Book\?/);
  assert.match(js, /\/api\/guest-book\/settings/);
  assert.match(js, /\/api\/guest-book\/check/);
  assert.match(js, /\/api\/guest-book\/book\?page=/);
  assert.match(js, /\/api\/push\/guest-book-invite/);
  assert.match(html, /id="learn-japanese-settings-card"/);
  assert.match(html, /id="btn-learn-japanese-push"/);
  assert.match(html, /id="learn-spanish-settings-card"/);
  assert.match(html, /id="btn-learn-portuguese-push"/);
  assert.match(html, /data-settings-group="language"/);
  assert.match(js, /\/api\/learn-japanese\/settings/);
  assert.match(js, /\/api\/push\/learn-japanese/);
  assert.match(js, /\/api\/learn-\$\{language\}\/settings/);
  assert.match(js, /\/api\/push\/learn-\$\{language\}/);
  assert.match(html, /id="guest-book-rate-on"/);
  assert.match(html, /id="guest-book-invite-footer"/);
  assert.match(html, /value="always"/);
  assert.match(html, /value="whenRoom"/);
  assert.match(html, /styles\.css\?v=signal215/);
  assert.match(html, /settings-filter\.js\?v=signal215/);
  assert.match(html, /app\.js\?v=signal215/);
  assert.match(html, /id="tinyurl-settings-card"/);
  assert.match(html, /id="word-scramble-settings-card"/);
  assert.match(html, /id="word-scramble-sessions-sheet"/);
  assert.match(html, /id="word-scramble-late-join"/);
  assert.match(js, /allowLateJoin/);
  assert.match(html, /id="guest-book-clear-override"/);
  assert.match(html, /id="guest-snaps-clear-override"/);
  assert.match(js, /\/api\/tinyurl\/settings/);
  assert.match(js, /\/api\/word-scramble\/settings/);
  assert.match(js, /\/api\/game-sessions\/end/);
  assert.match(js, /word-scramble-end-sheet/);
  assert.doesNotMatch(js, /openWordScrambleEnd[\s\S]*window\.confirm/);
  assert.match(html, /id="btn-ring-login"/);
  assert.match(html, /id="ring-2fa-block"/);
  assert.match(html, /id="ring-show-time"/);
  assert.match(js, /function dateBookPreviewEvent\(/);
  assert.match(js, /setHours\(24, 0, 0, 0\)/);
  assert.match(js, /dateBookPreviewEvent\(draft\)/);
  assert.match(js, /Mirror stockMarketFrames/);
  assert.match(js, /STOCKS 1\/\$\{pages\}/);
  assert.match(js, /flapChipCode\('white'\)/);
  assert.match(js, /sample\.dir === 'down' \? 'red'/);
  assert.match(html, /id="btn-red-letter-designer-undo"/);
  assert.match(html, /id="btn-red-letter-designer-reset"/);
  assert.match(html, /id="red-letter-unsaved-sheet"/);
  assert.match(html, /class="rl-preset-block"/);
  assert.match(js, /function requestCloseRedLetterDesigner\(/);
  assert.match(js, /function undoDesigner\(/);
  assert.match(js, /function resetDesigner\(/);
  assert.match(js, /designerIsDirty\(/);
  assert.match(css, /\.rl-preset-block \{/);
  assert.match(js, /ggyoyoyoyggg/);
  assert.match(js, /fgg\.bwbwbw/);
  assert.match(js, /royyoyr\.\./);
  assert.match(css, /\.date-book-sheet,\s*\.rl-designer-sheet \{[^}]*max-height: min\(92dvh, 980px\)/);
  assert.match(css, /\.cn-manage-sheet\.date-book-sheet,\s*\.cn-manage-sheet\.rl-designer-sheet \{[^}]*overflow-y:\s*auto/);
  assert.match(css, /\.date-book-sheet > \.cn-fact-list \{[^}]*min-height:\s*0/);
  assert.match(css, /\.date-book-sheet \.cn-compose \{[^}]*flex:\s*0\s+0\s+auto/);
  assert.match(css, /\.rl-designer-actions \{[^}]*position:\s*sticky/);
  assert.match(css, /@media \(max-height: 900px\)/);
  assert.match(css, /\.rl-tools \{[^}]*margin-bottom: 16px/);
  assert.match(css, /\.rl-char-row \{[^}]*margin: 0 0 16px/);
  assert.match(css, /\.rl-designer-hint \{[^}]*margin: 0 0 16px/);
  assert.match(html, /vestaboard-bezel\.css/);
  assert.match(html, /flap-grid\.js/);
  assert.match(css, /\.vb-bezel \{/);
  assert.match(css, /\.board-preview-col \.vb-bezel\.preview-bezel \{[^}]*max-width: none/);
  for (const id of [
    'stock-market-preview',
    'currency-rates-preview',
    'starlink-tracker-preview',
    'iss-tracker-preview',
    'periodic-table-preview',
    'word-of-the-day-preview',
  ]) {
    assert.match(
      html,
      new RegExp(`class="settings-col board-preview-col"[\\s\\S]*?id="${id}"`),
      `${id} sits in a full-width board-preview-col`,
    );
    assert.match(
      html,
      new RegExp(`vb-bezel preview-bezel[\\s\\S]*?id="${id}"`),
      `${id} uses the Flagship bezel preview`,
    );
  }
  assert.match(js, /\/api\/guest-snaps\/settings/);
  assert.match(js, /\/api\/guest-snaps\/check/);
  assert.doesNotMatch(html, /document\.write/);
  assert.match(js, /function confirmCorpusRemove\(/);
  assert.match(js, /data-cn-remove/);
  assert.match(js, /tabId === 'settings'[\s\S]*applySettingsFilter\(currentSettingsView\(\)\)/);
  assert.match(html, /id="vb-form-quiet-remind"/);
  assert.match(html, /id="btn-vb-quiet-hours-push"/);
  assert.match(js, /vbSetRemindOnStart/);
  assert.match(js, /\/api\/push\/quiet-hours-reminder/);
  assert.match(css, /\.learn-japanese-settings-card/);
  assert.match(html, /id="word-riddles-settings-card"/);
  assert.match(html, /id="btn-word-riddles-manage"/);
  assert.match(html, /id="btn-word-riddles-push"/);
  assert.match(html, /id="word-riddles-manage-sheet"/);
  assert.match(html, /id="word-riddles-reveal-delay"/);
  assert.match(html, /id="chuck-norris-settings-card"/);
  assert.match(html, /id="btn-chuck-norris-manage"/);
  assert.match(html, /id="btn-chuck-norris-push"/);
  assert.match(html, /id="chuck-norris-manage-sheet"/);
  assert.match(html, /id="roast-me-settings-card"/);
  assert.match(html, /id="btn-roast-me-manage"/);
  assert.match(html, /id="btn-roast-me-push"/);
  assert.match(html, /id="roast-me-manage-sheet"/);
  assert.match(html, /id="family-quotes-settings-card"/);
  assert.match(html, /id="btn-family-quotes-manage"/);
  assert.match(html, /id="btn-family-quotes-push"/);
  assert.match(html, /id="family-quotes-manage-sheet"/);
  assert.match(html, /id="family-quotes-new-author"/);
  assert.match(html, /id="warm-fuzzies-settings-card"/);
  assert.match(html, /id="daily-bucket-fillers-settings-card"/);
  assert.match(html, /id="btn-daily-bucket-fillers-push"/);
  assert.match(html, /id="daily-bucket-fillers-preview"/);
  assert.match(html, /id="btn-warm-fuzzies-manage"/);
  assert.match(html, /id="btn-warm-fuzzies-push"/);
  assert.match(html, /id="warm-fuzzies-manage-sheet"/);
  assert.match(html, /id="misheard-lyrics-settings-card"/);
  assert.match(html, /id="btn-misheard-lyrics-manage"/);
  assert.match(html, /id="btn-misheard-lyrics-push"/);
  assert.match(html, /id="misheard-lyrics-manage-sheet"/);
  assert.match(html, /id="misheard-lyrics-new-artist"/);
  assert.match(html, /id="periodic-table-settings-card"/);
  assert.match(html, /id="btn-periodic-table-push-selected"/);
  assert.match(html, /id="btn-periodic-table-push-random"/);
  assert.match(html, /id="periodic-table-element"/);
  assert.match(html, /id="word-of-the-day-settings-card"/);
  assert.match(html, /id="btn-word-of-the-day-push-selected"/);
  assert.match(html, /id="btn-word-of-the-day-push-random"/);
  assert.match(html, /id="word-of-the-day-search"/);
  assert.match(html, /id="dad-jokes-settings-card"/);
  assert.match(html, /id="btn-dad-jokes-manage"/);
  assert.match(html, /id="btn-dad-jokes-push"/);
  assert.match(html, /id="dad-jokes-manage-sheet"/);
  assert.match(html, /id="dad-jokes-new-punchline"/);
  assert.match(html, /id="us-weather-map-settings-card"/);
  assert.match(html, /id="btn-us-weather-map-push"/);
  assert.match(html, /id="us-weather-map-legend"/);
  assert.match(html, /id="us-weather-map-preview"/);
  assert.match(html, /id="amazing-facts-settings-card"/);
  assert.match(html, /id="btn-amazing-facts-manage"/);
  assert.match(html, /id="btn-amazing-facts-push"/);
  assert.match(html, /id="amazing-facts-manage-sheet"/);
  // Topic pool lives on the settings card, not buried in Manage facts.
  assert.match(html, /id="amazing-facts-pool-panel"/);
  assert.match(html, /id="amazing-facts-pool-categories"/);
  assert.match(html, /id="btn-amazing-facts-pool-all"/);
  assert.doesNotMatch(html, /id="btn-amazing-facts-save-pool"/);
  assert.doesNotMatch(html, /id="btn-amazing-facts-clear-pool"/);
  // Manage sheet no longer hosts the pool chips.
  const afSheet = html.slice(
    html.indexOf('id="amazing-facts-manage-sheet"'),
    html.indexOf('id="world-geography-facts-manage-sheet"'),
  );
  assert.doesNotMatch(afSheet, /amazing-facts-pool-categories/);
  assert.doesNotMatch(afSheet, /Push pool/);
  assert.match(js, /function amazingFactsPoolIsAll/);
  assert.match(js, /function readAmazingFactsPoolCategories/);
  assert.match(js, /queueAmazingFactsPoolSave/);
  assert.match(css, /\.af-pool-panel/);
  assert.match(css, /\.amazing-facts-settings-card \.af-pool-chips/);
  assert.match(html, /id="world-geography-facts-settings-card"/);
  assert.match(html, /id="btn-world-geography-facts-manage"/);
  assert.match(html, /id="btn-world-geography-facts-push"/);
  assert.match(html, /id="world-geography-facts-manage-sheet"/);
  assert.match(html, /id="conversation-starters-settings-card"/);
  assert.match(html, /id="btn-conversation-starters-manage"/);
  assert.match(html, /id="btn-conversation-starters-push"/);
  assert.match(html, /id="conversation-starters-manage-sheet"/);
  assert.match(html, /id="stoic-quotes-settings-card"/);
  assert.match(html, /id="btn-stoic-quotes-manage"/);
  assert.match(html, /id="btn-stoic-quotes-push"/);
  assert.match(html, /id="stoic-quotes-manage-sheet"/);
  assert.match(html, /id="on-this-day-settings-card"/);
  assert.match(html, /id="btn-on-this-day-manage"/);
  assert.match(html, /id="btn-on-this-day-push"/);
  assert.match(html, /id="on-this-day-manage-sheet"/);
  assert.match(html, /id="baking-inspiration-settings-card"/);
  assert.match(html, /id="btn-baking-inspiration-manage"/);
  assert.match(html, /id="btn-baking-inspiration-push"/);
  assert.match(html, /id="baking-inspiration-manage-sheet"/);
  assert.match(html, /id="stock-market-settings-card"/);
  assert.match(html, /id="btn-stock-market-push"/);
  assert.match(html, /id="currency-rates-settings-card"/);
  assert.match(html, /id="btn-currency-rates-push"/);
  assert.match(html, /id="iss-tracker-settings-card"/);
  assert.match(html, /id="btn-iss-tracker-push"/);
  assert.match(html, /id="starlink-tracker-settings-card"/);
  assert.match(html, /id="space-launch-alerts-settings-card"/);
  assert.match(html, /id="btn-space-launch-alerts-push-selected"/);
  assert.match(html, /id="space-launch-alerts-preview"/);
  assert.match(html, /id="btn-starlink-tracker-push"/);
  assert.match(html, /id="locale-currency"/);
  assert.match(html, /id="world-population-settings-card"/);
  assert.match(html, /id="btn-world-population-push"/);
  assert.match(html, /id="calendar-clock-settings-card"/);
  assert.match(html, /id="btn-calendar-clock-push"/);
  assert.match(html, /id="calendar-clock-week-start"/);
  assert.match(html, /id="word-clock-settings-card"/);
  assert.match(html, /id="btn-word-clock-push"/);
  assert.match(html, /id="word-clock-rounding"/);
  assert.match(html, /id="word-clock-day-part"/);
  assert.match(html, /id="weather-alerts-settings-card"/);
  assert.match(html, /id="btn-weather-alerts-push"/);
  assert.match(js, /quiet-hours/);
  assert.match(js, /\/api\/chuck-norris\/facts/);
  assert.match(js, /\/api\/push\/chuck-norris/);
  assert.match(js, /\/api\/roast-me\/roasts/);
  assert.match(js, /\/api\/push\/roast-me/);
  assert.match(js, /\/api\/family-quotes\/quotes/);
  assert.match(js, /\/api\/push\/family-quotes/);
  assert.match(js, /\/api\/warm-fuzzies\/fuzzies/);
  assert.match(js, /\/api\/push\/warm-fuzzies/);
  assert.match(js, /\/api\/daily-bucket-fillers\/fillers/);
  assert.match(js, /\/api\/push\/daily-bucket-fillers/);
  assert.match(js, /\/api\/space-launch-alerts\/settings/);
  assert.match(js, /\/api\/push\/space-launch-alerts/);
  assert.match(js, /\/api\/misheard-lyrics\/lyrics/);
  assert.match(js, /\/api\/push\/misheard-lyrics/);
  assert.match(js, /\/api\/periodic-table\/settings/);
  assert.match(js, /\/api\/push\/periodic-table/);
  assert.match(js, /\/api\/word-of-the-day\/settings/);
  assert.match(js, /\/api\/push\/word-of-the-day/);
  assert.match(js, /\/api\/dad-jokes\/jokes/);
  assert.match(js, /\/api\/push\/dad-jokes/);
  assert.match(js, /\/api\/us-weather-map\/settings/);
  assert.match(js, /\/api\/push\/us-weather-map/);
  assert.match(js, /\/api\/amazing-facts\/facts/);
  assert.match(js, /\/api\/push\/amazing-facts/);
  assert.match(js, /\/api\/world-geography-facts\/facts/);
  assert.match(js, /\/api\/push\/world-geography-facts/);
  assert.match(js, /\/api\/conversation-starters\/prompts/);
  // Displays refresh must not wipe Push skeletons before /api/commands lands
  // (that blanked Home and flashed Share).
  assert.match(js, /else if \(!allPushCommands\.length\) \{\s*return;/);
  assert.match(js, /btn\.hidden = !loading && count === 0 && !on/);
  assert.match(css, /\.display-kind-filter\s*\{[^}]*margin:\s*0/s);
  assert.match(js, /\/api\/stoic-quotes\/quotes/);
  assert.match(js, /\/api\/on-this-day\/events/);
  assert.match(js, /\/api\/push\/on-this-day/);
  assert.match(js, /\/api\/baking-inspiration\/ideas/);
  assert.match(js, /\/api\/push\/baking-inspiration/);
  assert.match(js, /\/api\/stock-market\/settings/);
  assert.match(js, /\/api\/push\/stock-market/);
  assert.match(js, /\/api\/currency-rates\/settings/);
  assert.match(js, /\/api\/push\/currency-rates/);
  assert.match(js, /\/api\/iss-tracker\/settings/);
  assert.match(js, /\/api\/push\/iss-tracker/);
  assert.match(js, /\/api\/starlink-tracker\/settings/);
  assert.match(js, /\/api\/push\/starlink-tracker/);
  assert.match(js, /\/api\/world-population\/settings/);
  assert.match(js, /\/api\/push\/world-population/);
  assert.match(js, /\/api\/calendar-clock\/settings/);
  assert.match(js, /\/api\/push\/calendar-clock/);
  assert.match(js, /\/api\/word-clock\/settings/);
  assert.match(js, /\/api\/push\/word-clock/);
  assert.match(js, /\/api\/weather-alerts\/settings/);
  assert.match(js, /\/api\/push\/weather-alerts/);
  assert.match(css, /\.conversation-starters-settings-card/);
  assert.match(css, /\.amazing-facts-settings-card/);
  assert.match(css, /\.world-geography-facts-settings-card/);
  assert.match(css, /\.stoic-quotes-settings-card/);
  assert.match(css, /\.on-this-day-settings-card/);
  assert.match(css, /\.baking-inspiration-settings-card/);
  assert.match(css, /\.stock-market-settings-card/);
  assert.match(css, /\.currency-rates-settings-card/);
  assert.match(css, /\.iss-tracker-settings-card/);
  assert.match(css, /\.starlink-tracker-settings-card/);
  assert.match(css, /\.world-population-settings-card/);
  assert.match(css, /\.calendar-clock-settings-card/);
  assert.match(css, /\.is-chip-violet/);
  assert.match(css, /\.is-chip-blue/);
  assert.match(css, /\.is-chip-orange/);
  assert.match(css, /\.is-chip-yellow/);
  assert.match(css, /\.weather-alerts-settings-card/);
  assert.match(js, /function showSettingsView/);
  assert.match(js, /function applySettingsFilter/);
  assert.match(js, /function setKindFilter/);
  assert.match(js, /SETTINGS_CARD_KINDS/);
  assert.match(js, /SETTINGS_VIEW_KEY/);
  assert.match(js, /SETTINGS_SEARCH_KEY/);
  assert.match(js, /KIND_FILTER_KEY/);
  assert.match(js, /settings-hit-count/);
  assert.match(js, /uiStorageRemove\(SETTINGS_SEARCH_KEY\)/);
  assert.match(css, /\.settings-view-tabs\b/);
  assert.match(css, /\.settings-hit-count\b/);
  assert.match(css, /\.settings-search-row\b/);
  assert.match(css, /\.display-kind-filter\b/);
});

test('Plex settings save on an explicit button, not while typing the URL', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/web/admin/index.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '../src/web/admin/app.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../src/web/admin/styles.css'), 'utf8');
  assert.match(html, /id="btn-plex-settings-save"/);
  assert.match(js, /btn-plex-settings-save/);
  assert.doesNotMatch(js, /queuePlexSave/);
  assert.doesNotMatch(js, /plex-server-url'\)\?\.addEventListener\('input'/);
  assert.match(css, /\.plex-preview-hint/);
  assert.match(html, /id="btn-plex-token-help"/);
  assert.match(html, /X-Plex-Token/);
  assert.match(html, /support\.plex\.tv\/articles\/204059436/);
  assert.match(js, /body: \{ token, serverUrl \}/);
  assert.doesNotMatch(js, /await loadPlexSettings\(\)/);
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
    'sched-active', 'sched-nextup', 'sched-rule-list', 'sched-add-command', 'sched-add-command-search',
    'sched-add-command-list', 'btn-sched-add',
    'sched-setup-card', 'sched-rule-search', 'sched-rule-search-clear', 'sched-rule-meta', 'sched-rule-empty',
    'sched-view-schedule', 'sched-view-activity', 'sched-view-simulation', 'sched-view-settings',
    'sched-min-gap', 'sched-tick', 'sched-quiet-enabled', 'sched-retention', 'btn-sched-simulate',
    'sched-simulation', 'sched-simulation-working', 'sched-simulation-status', 'sched-simulation-results',
    'sched-stats', 'sched-timeline', 'sched-show-skips', 'sched-inspector',
    'sched-rule-stats', 'sched-heatmap',
    'page-jump', 'btn-jump-top', 'btn-jump-bottom',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);
  }
  assert.match(html, /tab-sticky-head/);
  assert.match(html, /Type to find an event/);
  assert.match(html, /data-sched-view="schedule"/);
  assert.match(html, /data-sched-view="simulation"/);
  assert.match(html, /data-sched-view="settings"/);
  // Rules are runtime data; the markup must not enumerate them.
  assert.doesNotMatch(html, /data-rule-id="/, 'rules must be rendered from the API');
  assert.match(js, /sched-rule-group/);
  assert.match(js, /focusSchedRule/);
  assert.match(js, /signal\.schedRuleSearch/);
  assert.match(js, /function updateStickyOffsets/);
  assert.match(js, /function updatePageJump/);
  assert.match(js, /function updateSchedSetupCompact/);
  assert.match(js, /function bindSchedCommandPicker/);
  // Compact mode used a single scroll threshold; collapsing the Add row then
  // yanked scrollY back under it and the page jumped to the top in a loop.
  assert.match(js, /const leaveAt = 16/);
  assert.match(js, /function restoreSchedScroll/);
  assert.match(js, /const tabScrollY = Object\.create\(null\)/);
  assert.match(js, /function rememberTabScroll/);
  assert.match(js, /function restoreTabScroll/);
  assert.match(js, /activateTab\('push', \{ scroll: 'top' \}\)/);
  // Add-a-rule must start blank — defaulting to catalog[0] forced erasing
  // "Tesla Dashboard" before every other search.
  assert.match(js, /setSchedAddCommand\(current \|\| null\)/);
  assert.doesNotMatch(js, /schedCommandCatalog\[0\]/);
  assert.match(js, /is-compact/);
  assert.match(css, /\.sched-setup-card/);
  assert.match(css, /\.tab-sticky-head/);
  assert.match(css, /\.page-jump\b/);
  assert.match(css, /\.sched-setup-card\.is-compact/);
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
  assert.match(js, /activateTab\('push', \{ scroll: 'top' \}\)/);
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
  for (const category of ['home', 'games', 'media', 'news', 'language', 'travel', 'share']) {
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
  assert.match(js, /apiGet\('\/api\/commands'/);
  assert.match(js, /function bootAdminChrome\(/);
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
  assert.match(html, /id="push-kind-filter"/);
  assert.match(html, /data-kind-filter="all"/);
  assert.match(html, /data-kind-filter="vestaboard"/);
  assert.match(html, /data-kind-filter="full"/);
  assert.match(html, /data-display-kinds="full"/);
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
  assert.match(js, /function setKindFilter/);
  assert.match(js, /function commandMatchesKindFilter/);
  assert.match(js, /KIND_FILTER_KEY/);
  assert.match(js, /push-share-pane/);
  assert.match(js, /pushViewSession/);
  assert.match(js, /applyPushFilter\(PUSH_VIEW_ORDER\[0\]\)/);
  assert.match(js, /push-hit-count/);
  // Tiles answer to their service and command id as well as their printed copy.
  assert.match(js, /data-search-terms=/);
  assert.match(js, /data-display-kinds=/);
  // The renderer hands visibility to the filter instead of hiding rows itself.
  assert.doesNotMatch(js, /row\.hidden = mine\.length === 0/);

  assert.match(css, /\.push-view-tabs\b/);
  assert.match(css, /\.push-hit-count\b/);
  assert.match(css, /\.push-search-row\b/);
  assert.match(css, /\.display-kind-filter\b/);
  assert.match(css, /#tab-push \[data-push-group\]\[hidden\]/);
});

test('Steam, PSN, YouTube and Feature Presentation share one auto-mode push tile each next to Trivia', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/web/admin/index.html'), 'utf8');
  const rows = [...html.matchAll(/data-push-category="([^"]+)"/g)].map((match) => match[1].trim());

  // A category rendered by two rows would show its tiles twice.
  assert.equal(new Set(rows).size, rows.length, 'each category belongs to exactly one row');

  for (const id of ['steam.now-playing', 'psn.now-playing', 'youtube.now-playing', 'plex.now-playing']) {
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
  assert.equal(COMMANDS.some((entry) => entry.id === 'plex.last-played'), false);
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

test('the landing page and booth are public; the admin shell redirects', async () => {
  const realWebRoot = path.join(__dirname, '../src/web');
  const { webServer, base } = await startTestServer({
    webRoot: realWebRoot,
    autoLogin: false,
  });
  try {
    // The bare domain is now a front door, not the booth.
    const landing = await request(`${base}/`);
    assert.equal(landing.status, 200);
    assert.match(landing.text, /href="\/games\/"/);
    assert.match(landing.text, /href="\/guestsnaps\/"/);
    assert.match(landing.text, /href="\/guestbook\/"/);
    assert.match(landing.text, /href="\/admin\/"/);
    assert.match(landing.text, /href="landing\.css\?v=\d+(?:\.\d+)?"/);
    assert.doesNotMatch(landing.text, /booth\.js/);

    const booth = await request(`${base}/guestsnaps/`);
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

test('guest booth HTML/JS live under /guestsnaps/', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/web/guestsnaps/index.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '../src/web/guestsnaps/booth.js'), 'utf8');
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
  const html = fs.readFileSync(path.join(__dirname, '../src/web/guestsnaps/index.html'), 'utf8');
  assert.match(html, /id="photo-file"[^>]*type="file"/);
  assert.match(html, /id="photo-file"[^>]*accept="image\/\*"/);
  assert.match(html, /id="photo-file"[^>]*\bmultiple\b/);
  assert.doesNotMatch(html, /id="photo-file"[^>]*\bcapture\b/);
  assert.match(html, /Take or choose photos/);
});

test('guest booth queues photos and pushes a slideshow when more than one is sent', () => {
  const js = fs.readFileSync(path.join(__dirname, '../src/web/guestsnaps/booth.js'), 'utf8');
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

test('Settings search matches a card by its section heading, and headings follow their card', () => {
  // "starter" missed Conversation Starters and "world" missed World Currency
  // Rates: those words are only in the heading, which is a sibling of the card
  // rather than part of it, so the haystack never saw them.
  const html = fs.readFileSync(path.join(__dirname, '../src/web/admin/index.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '../src/web/admin/app.js'), 'utf8');

  assert.match(js, /function settingsSectionLabel\(/);
  assert.match(js, /matchesSearch\(el, query, extra = ''\)/);
  assert.match(js, /matchesSearch\(card, query, heading\?\.textContent \|\| ''\)/);
  // A heading is shown for its own card, not for any hit anywhere in the pane.
  assert.match(js, /shownHeadings\.add\(heading\)/);
  assert.match(js, /shownHeadings\.has\(el\)/);

  // Every settings card is introduced by a heading in the same pane, which is
  // what makes the heading safe to search and to hide alongside the card.
  const grid = html.slice(html.indexOf('id="settings-card-grid"'));
  const blocks = [...grid.matchAll(
    /<div class="section-label" data-settings-group="([a-z]+)">([^<]+)<\/div>\s*<div class="card[^"]*" id="([a-z0-9-]+)" data-settings-group="([a-z]+)"/g,
  )];
  const headingFor = new Map(blocks.map((m) => [m[3], { text: m[2], group: m[1], cardGroup: m[4] }]));
  for (const [id, entry] of headingFor) {
    assert.equal(entry.group, entry.cardGroup, `${id} heading sits in the same pane as its card`);
  }

  // The two the user could not find.
  assert.match(headingFor.get('conversation-starters-settings-card').text, /Starters/i);
  assert.match(headingFor.get('currency-rates-settings-card').text, /^World Currency Rates$/i);
});

test('the admin currency preview uses the same columns as the board', () => {
  // The Settings preview draws the frame by hand, so it drifts from the real
  // formatter unless both are changed together.
  const js = fs.readFileSync(path.join(__dirname, '../src/web/admin/app.js'), 'utf8');
  const feeds = fs.readFileSync(path.join(__dirname, '../src/vestaboard/formatters/feeds.js'), 'utf8');

  assert.match(feeds, /const FX_RATE_COL = 7;/);
  assert.match(feeds, /const FX_CHANGE_HEADER = '\+\/-%';/);

  // Preview header: `$` at column 7, `+/-%` right-aligned to column 20.
  const header = js.match(/const header = `\$\{' '\.repeat\((\d+)\)\}\$\$\{' '\.repeat\((\d+)\)\}\+\/-%`/);
  assert.ok(header, 'preview builds its header from explicit column padding');
  assert.equal(Number(header[1]), 7);
  assert.equal(Number(header[1]) + 1 + Number(header[2]), 17);

  // Preview rows: code(3) + gap(4) + rate(7) + change(7) + chip = 22.
  assert.match(js, /String\(sample\.change\)\.padStart\(7, ' '\)\.slice\(-7\)/);
  assert.match(js, /`\$\{symbol\} {4}\$\{rate\}\$\{change\}#`/);
  // Samples carry no space after the sign, same as formatChangePercent.
  assert.doesNotMatch(js, /change: '[+-] \d/);
});

test('every corpus manage sheet shares one layout, preview column and scrollbar', () => {
  // Seven sheets (facts, quotes, prompts, ideas) had drifted apart: an
  // unlabelled preview sitting above the input beside it, the whole sheet
  // scrolling so search and paging left the screen, and the OS scrollbar in
  // some places against the styled one everywhere else.
  const html = fs.readFileSync(path.join(__dirname, '../src/web/admin/index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../src/web/admin/styles.css'), 'utf8');

  const sheets = [
    'chuck-norris', 'roast-me', 'family-quotes', 'warm-fuzzies', 'misheard-lyrics', 'dad-jokes', 'amazing-facts', 'world-geography-facts',
    'conversation-starters', 'stoic-quotes', 'baking-inspiration',
    'date-book',
  ];
  for (const name of sheets) {
    assert.match(html, new RegExp(`id="${name}-manage-sheet"`));
    // The preview is a labelled column, so its top lines up with the textarea
    // next to it instead of with that textarea's label.
    assert.match(html, new RegExp(
      `<div class="cn-preview-col">\\s*<span class="field-label">Board preview</span>\\s*`
      + `<div class="vb-bezel preview-bezel"[\\s\\S]*?id="${name}-preview"`,
    ), `${name} preview sits in a labelled Flagship bezel column`);
  }
  // On This Day already labels its preview in a settings column.
  assert.match(html, /id="on-this-day-manage-sheet"/);
  // Word Riddles puts Intro / Riddle / Answer on the same row as the label
  // so the board lines up with the riddle textarea instead of sitting lower.
  assert.match(html, /id="word-riddles-manage-sheet"/);
  assert.match(html, /class="cn-preview-head"/);
  assert.match(html, /id="word-riddles-preview-phase"/);
  assert.match(css, /\.cn-preview-head \{/);
  assert.match(css, /align-items: stretch;/);

  // Only the list scrolls; the head, compose block and pager stay put.
  assert.match(css, /\.cn-manage-sheet \{[^}]*display: flex;[^}]*flex-direction: column;[^}]*overflow: hidden;/);
  assert.match(css, /\.cn-manage-sheet > \.cn-fact-list \{[^}]*overflow-y: auto;/);
  assert.match(css, /\.cn-preview-col \{/);

  // Manage dialogs grow the board past the 200px settings-card thumbnail —
  // the postage-stamp preview in Chuck Norris (and the other corpus sheets)
  // was unreadable. Previews use the Flagship bezel (shared with Red Letter).
  assert.match(css, /\.cn-manage-sheet \.vb-bezel\.preview-bezel \{[^}]*max-width: 320px;/);
  assert.match(css, /@media \(min-width: 820px\) \{\s*\.cn-manage-sheet \.cn-compose \{[^}]*minmax\(260px, 320px\)/);

  // One scrollbar treatment for the whole admin.
  assert.match(css, /\*\{?[\s\S]{0,120}scrollbar-width: thin;/);
  assert.match(css, /\*::-webkit-scrollbar \{/);
});

test('admin chrome boots ahead of the panel wiring and survives a throw in it', () => {
  // A single exception in the thousands of lines of panel wiring used to
  // strand the page: header stuck on "connecting…", empty Push grid, dead
  // Log out button, nothing said about why.
  const js = fs.readFileSync(path.join(__dirname, '../src/web/admin/app.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../src/web/admin/styles.css'), 'utf8');

  const bootIndex = js.indexOf('window.setTimeout(bootAdminChrome, 0)');
  const logoutIndex = js.indexOf("$('btn-admin-logout')");
  const pollerIndex = js.indexOf('async function pollStatus(');
  assert.ok(bootIndex > 0, 'boot is queued as a macrotask, not only called inline');
  assert.ok(logoutIndex > 0 && logoutIndex < bootIndex, 'Log out is bound before the boot');
  assert.ok(bootIndex < pollerIndex, 'the boot is queued above the panel wiring');

  // startPolling() runs from the boot, so its state cannot sit in a temporal
  // dead zone down beside the poller.
  const declIndex = js.indexOf('const POLL_MS = 5000;');
  assert.ok(declIndex > 0 && declIndex < bootIndex);

  assert.match(js, /function inlinePushCommands\(/);
  assert.match(js, /getElementById\('push-catalog'\)/);
  assert.match(js, /function reportBootFailure\(/);
  assert.match(js, /addEventListener\('unhandledrejection'/);
  assert.match(css, /\.boot-error \{/);

  // The banner only speaks up while the page is still being built; the flag is
  // cleared on the last line, so a throw anywhere above leaves it set.
  assert.match(js, /bootWindowOpen = false;\s*\}\)\(\);\s*$/);

  // The old name is gone from every call site — one stale call was itself a
  // ReferenceError that took out the tail of the init.
  assert.doesNotMatch(js, /startAdminChrome/);
});

test('admin login page and logout control exist', () => {
  const login = fs.readFileSync(path.join(__dirname, '../src/web/admin/login.html'), 'utf8');
  const admin = fs.readFileSync(path.join(__dirname, '../src/web/admin/index.html'), 'utf8');
  assert.match(login, /\/api\/admin\/login/);
  assert.match(login, /id="guest-book-quicklink"/);
  assert.match(login, /\/guestbook\//);
  assert.match(login, /class="login-note-links"/);
  assert.match(login, />Photo booth</);
  assert.match(login, />Guest book</);
  assert.match(admin, /id="btn-admin-logout"/);
});

/**
 * Enough of a browser for `admin/app.js` to bind itself against. Elements are
 * inert stubs and every lookup succeeds, so the only thing that can fail is the
 * script's own top-level code — which is exactly what we want to catch.
 */
function stubDom() {
  const noop = () => {};
  const style = { setProperty: noop, removeProperty: noop, getPropertyValue: () => '' };
  const byId = new Map();

  const makeEl = (tag = 'div') => ({
    tagName: String(tag).toUpperCase(),
    style,
    dataset: {},
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    children: [],
    options: [],
    files: [],
    hidden: false,
    checked: false,
    disabled: false,
    selectedIndex: -1,
    value: '',
    src: '',
    href: '',
    type: '',
    placeholder: '',
    textContent: '',
    innerHTML: '',
    offsetHeight: 0,
    offsetWidth: 0,
    scrollHeight: 0,
    scrollTop: 0,
    clientHeight: 0,
    previousElementSibling: null,
    nextElementSibling: null,
    parentElement: null,
    addEventListener: noop,
    removeEventListener: noop,
    appendChild: (child) => child,
    removeChild: (child) => child,
    insertBefore: (node) => node,
    remove: noop,
    setAttribute: noop,
    getAttribute: () => null,
    removeAttribute: noop,
    querySelector: () => makeEl(),
    querySelectorAll: () => [],
    closest: () => null,
    focus: noop,
    blur: noop,
    click: noop,
    scrollTo: noop,
  });

  const document = {
    documentElement: makeEl('html'),
    head: makeEl('head'),
    body: makeEl('body'),
    scrollingElement: makeEl('html'),
    baseURI: 'https://bridge.test/admin/',
    hidden: false,
    createElement: (tag) => makeEl(tag),
    getElementById: (id) => {
      if (!byId.has(id)) byId.set(id, makeEl());
      return byId.get(id);
    },
    querySelector: () => makeEl(),
    querySelectorAll: () => [],
    addEventListener: noop,
    removeEventListener: noop,
  };

  const storage = { getItem: () => null, setItem: noop, removeItem: noop, clear: noop };

  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    document,
    localStorage: storage,
    sessionStorage: storage,
    location: {
      pathname: '/admin/',
      search: '',
      href: 'https://bridge.test/admin/',
      origin: 'https://bridge.test',
      protocol: 'https:',
      hostname: 'bridge.test',
      reload: noop,
    },
    navigator: { userAgent: 'node', maxTouchPoints: 0, clipboard: { writeText: async () => {} } },
    // Never resolves: this test is about binding, not about request handling.
    fetch: () => new Promise(() => {}),
    setTimeout: () => 0,
    clearTimeout: noop,
    setInterval: () => 0,
    clearInterval: noop,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: noop,
    performance: { now: () => 0 },
    matchMedia: () => ({ matches: false, addEventListener: noop, addListener: noop }),
    EventSource: function EventSource() { return { addEventListener: noop, close: noop }; },
    Image: function Image() { return makeEl('img'); },
    FileReader: function FileReader() { return { readAsDataURL: noop, addEventListener: noop }; },
    AbortController: globalThis.AbortController,
    URLSearchParams: globalThis.URLSearchParams,
    URL: globalThis.URL,
    FormData: globalThis.FormData,
    Blob: globalThis.Blob,
    HTMLElement: function HTMLElement() {},
    Element: function Element() {},
    Node: function Node() {},
    jsQR: () => null,
    scrollTo: noop,
    scrollY: 0,
    innerWidth: 1280,
    innerHeight: 900,
    addEventListener: noop,
    removeEventListener: noop,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  return sandbox;
}

test('admin app.js runs top to bottom, not just parses', () => {
  // Twice now a single bad identifier at the top level (`windowStickyOffsets()`
  // for `updateStickyOffsets()`) threw on load and took the whole admin with
  // it: header stuck on "connecting…", no tiles, dead Log out. Parsing the file
  // never caught it, so run it.
  const { Script, createContext } = require('node:vm');
  const js = fs.readFileSync(path.join(__dirname, '../src/web/admin/app.js'), 'utf8');
  const sandbox = stubDom();
  createContext(sandbox);
  assert.doesNotThrow(
    () => new Script(js, { filename: 'app.js' }).runInContext(sandbox),
    'admin/app.js must bind cleanly — a throw here strands the whole page',
  );
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
