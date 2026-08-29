/**
 * Display Scheduler HTTP surface (display-scheduler.md §10).
 *
 * The engine's behaviour is covered in `display-scheduler.test.js`; these tests
 * pin the REST contract the admin UI is written against, and the two properties
 * that only exist once the scheduler is wired into the real web server: that a
 * scheduled airing goes through the same push handler as a manual one, and that
 * a manual push holds the scheduler off.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const httpMod = require('node:http');

const { createWebServer } = require('../src/web-server');
const { createDisplayBusy } = require('../src/display-busy');
const { saveWeatherCache } = require('../src/weather-cache');

const TEST_ADMIN_PASSWORD = 'scheduler-admin-secret';
const TINY_PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function request(url, { method = 'GET', body = null, cookie = null } = {}) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const headers = {};
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    if (cookie) headers.Cookie = cookie;
    const req = httpMod.request(url, { method, agent: false, headers }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { parsed = null; }
        resolve({ status: res.statusCode, text, body: parsed, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function makeWebRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-web-'));
  fs.mkdirSync(path.join(dir, 'admin'), { recursive: true });
  for (const [name, content] of [
    ['index.html', '<html></html>'],
    ['admin/index.html', '<html></html>'],
    ['admin/login.html', '<html></html>'],
    ['admin/app.js', ''],
    ['admin/styles.css', ''],
  ]) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

async function startServer({ busy = createDisplayBusy(), configOverrides = {} } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-data-'));
  const sent = [];
  const recorded = [];
  const config = {
    ROOT: dataDir,
    sessionPath: path.join(dataDir, 'alexa-session.json'),
    proxyPort: 3456,
    proxyOwnIp: '127.0.0.1',
    ...configOverrides,
    udpBroadcast: { defaultDisplaySeconds: 120 },
    webServer: {
      enabled: true,
      port: 0,
      https: false,
      httpRedirectPort: 0,
      certDir: 'certs',
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
  saveWeatherCache(config, {
    location: { latitude: 40.41, longitude: -111.85, name: 'Lehi' },
    weather: {
      current: { temperatureF: 72, condition: 'sunny' },
      next7Days: [{ date: '2026-08-28', highF: 80, lowF: 55, condition: 'sunny' }],
    },
  });
  const webServer = createWebServer({
    config,
    log: { info() {}, warn() {}, error() {}, debug() {} },
    sendUdpPayload: (payload) => { sent.push(payload); },
    recordVoiceEvent: async (event) => { recorded.push(event); },
    displayBusy: busy,
    scheduleRestart: () => {},
    webRoot: makeWebRoot(),
  });
  const server = await webServer.start();
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await request(`${base}/api/admin/login`, {
    method: 'POST', body: { password: TEST_ADMIN_PASSWORD },
  });
  const setCookie = login.headers['set-cookie'];
  const cookie = String(Array.isArray(setCookie) ? setCookie[0] : setCookie || '').split(';')[0];

  const api = (route, options = {}) => request(`${base}${route}`, { cookie, ...options });
  return { webServer, base, cookie, sent, recorded, api, config };
}

const ROUTE = '/api/display-scheduler';

test('settings round-trip and reject a tick slower than the spec allows', async () => {
  const { webServer, api } = await startServer();
  try {
    const initial = await api(`${ROUTE}/settings`);
    assert.equal(initial.status, 200);
    assert.equal(initial.body.settings.active, false, 'never ships active');
    assert.deepEqual(initial.body.settings.quietHours, { start: '23:00', end: '07:00' });

    const saved = await api(`${ROUTE}/settings`, {
      method: 'PUT',
      body: { active: true, tickSeconds: 900, globalMinGapSeconds: 120 },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.settings.active, true);
    assert.equal(saved.body.settings.tickSeconds, 60, 'clamped to the 60s ceiling');
    assert.equal(saved.body.settings.globalMinGapSeconds, 120);

    const reread = await api(`${ROUTE}/settings`);
    assert.equal(reread.body.settings.active, true);
  } finally {
    webServer.stop();
  }
});

test('rules can be created, listed, edited and deleted through the API', async () => {
  const { webServer, api } = await startServer();
  try {
    const created = await api(`${ROUTE}/rules`, {
      method: 'POST',
      body: { commandId: 'signal.slideshow', intervalSeconds: 2700, probability: 90 },
    });
    assert.equal(created.status, 201);
    const rule = created.body.rule;
    assert.equal(rule.commandId, 'signal.slideshow');
    assert.equal(rule.label, 'Shared Photo Slideshow', 'defaults to the command title');
    assert.equal(rule.target, 'full', 'existing-style rules stay on the Windows overlay');
    assert.match(rule.color, /^#[0-9A-F]{6}$/i);
    // §4.5 readouts must come back with the rule so the editor can show them live.
    assert.equal(rule.expectedPerDay, 28.8);
    assert.ok(rule.gapProfile.typicalSeconds > rule.intervalSeconds);

    const list = await api(`${ROUTE}/rules`);
    assert.equal(list.body.rules.length, 1);

    const edited = await api(`${ROUTE}/rules/${rule.id}`, {
      method: 'PUT',
      body: { probability: 50, label: 'Family photos', target: 'vestaboard' },
    });
    assert.equal(edited.body.rule.probability, 50);
    assert.equal(edited.body.rule.label, 'Family photos');
    assert.equal(edited.body.rule.target, 'vestaboard');
    assert.equal(edited.body.rule.color, rule.color, 'colour is stable across edits');

    const removed = await api(`${ROUTE}/rules/${rule.id}`, { method: 'DELETE' });
    assert.equal(removed.status, 200);
    assert.equal((await api(`${ROUTE}/rules`)).body.rules.length, 0);
  } finally {
    webServer.stop();
  }
});

test('both worked examples from §2 are creatable through the API alone', async () => {
  const { webServer, api } = await startServer();
  try {
    // "Every 45 minutes, with 90% probability, show the photo slideshow"
    const slideshow = await api(`${ROUTE}/rules`, {
      method: 'POST',
      body: { commandId: 'signal.slideshow', intervalSeconds: 45 * 60, probability: 90 },
    });
    // "Every 2 hours, with 100% probability, show the Guest Snaps page"
    const guest = await api(`${ROUTE}/rules`, {
      method: 'POST',
      body: { commandId: 'signal.guest-snaps', intervalSeconds: 2 * 3600, probability: 100 },
    });
    assert.equal(slideshow.body.rule.expectedPerDay, 28.8);
    assert.equal(guest.body.rule.expectedPerDay, 12);
    assert.notEqual(slideshow.body.rule.color, guest.body.rule.color);
  } finally {
    webServer.stop();
  }
});

test('a rule pointing at an unknown command is refused at creation', async () => {
  const { webServer, api } = await startServer();
  try {
    const result = await api(`${ROUTE}/rules`, {
      method: 'POST',
      body: { commandId: 'nope.gone', intervalSeconds: 600 },
    });
    assert.equal(result.status, 400);
    assert.match(result.body.error, /Unknown commandId/);
  } finally {
    webServer.stop();
  }
});

test('missing rules 404 rather than silently succeeding', async () => {
  const { webServer, api } = await startServer();
  try {
    assert.equal((await api(`${ROUTE}/rules/nope`, { method: 'PUT', body: {} })).status, 404);
    assert.equal((await api(`${ROUTE}/rules/nope`, { method: 'DELETE' })).status, 404);
    assert.equal((await api(`${ROUTE}/rules/nope/air`, { method: 'POST' })).status, 404);
    assert.equal((await api(`${ROUTE}/rules/nope/reset`, { method: 'POST' })).status, 404);
    assert.equal((await api(`${ROUTE}/nonsense`)).status, 404);
  } finally {
    webServer.stop();
  }
});

test('air-now fires the real push handler and records an airing', async () => {
  const { webServer, api, sent } = await startServer();
  try {
    const created = await api(`${ROUTE}/rules`, {
      method: 'POST',
      body: { commandId: 'alexa.weather', intervalSeconds: 7200, probability: 0 },
    });
    const before = sent.length;
    const fired = await api(`${ROUTE}/rules/${created.body.rule.id}/air`, { method: 'POST' });
    assert.equal(fired.status, 202);
    assert.equal(fired.body.event.outcome, 'aired');
    // The point of routing through the registry: a scheduled airing takes the
    // exact same path a human pressing the tile would.
    assert.ok(sent.length > before);
    assert.equal(sent.at(-1).type, 'weather.query');
    assert.equal(sent.at(-1).weather.current.temperatureF, 72);
    assert.equal(fired.body.event.target, 'full');

    const activity = await api(`${ROUTE}/activity`);
    assert.equal(activity.body.events.filter((e) => e.outcome === 'aired').length, 1);
  } finally {
    webServer.stop();
  }
});

test('air-now for Vestaboard-only skills reaches the boards even when the rule says full', async () => {
  const { webServer, api } = await startServer();
  try {
    const stoic = await api(`${ROUTE}/rules`, {
      method: 'POST',
      body: {
        commandId: 'stoic.quotes',
        intervalSeconds: 7200,
        probability: 0,
        target: 'full',
      },
    });
    assert.equal(stoic.body.rule.target, 'full');
    const firedStoic = await api(`${ROUTE}/rules/${stoic.body.rule.id}/air`, { method: 'POST' });
    assert.equal(firedStoic.status, 202, firedStoic.body?.error || 'stoic air');
    assert.equal(firedStoic.body.event.outcome, 'aired');

    const world = await api(`${ROUTE}/rules`, {
      method: 'POST',
      body: { commandId: 'world.population', intervalSeconds: 7200, probability: 0 },
    });
    assert.equal(world.body.rule.target, 'vestaboard', 'new board-only rules default onto the flaps');
    const firedWorld = await api(`${ROUTE}/rules/${world.body.rule.id}/air`, { method: 'POST' });
    assert.equal(firedWorld.status, 202, firedWorld.body?.error || 'world air');
    assert.equal(firedWorld.body.event.outcome, 'aired');

    const history = await api(`${ROUTE}/rules`, {
      method: 'POST',
      body: { commandId: 'history.day', intervalSeconds: 7200, probability: 0 },
    });
    const firedHistory = await api(`${ROUTE}/rules/${history.body.rule.id}/air`, { method: 'POST' });
    assert.equal(firedHistory.status, 202, firedHistory.body?.error || 'history air');
    assert.equal(firedHistory.body.event.outcome, 'aired');
  } finally {
    webServer.stop();
  }
});

test('airing the slideshow pulls the shared photos itself', async () => {
  // Regression: the push handler only ever read `body.photos`, which the admin
  // UI supplies from the list already on screen. The scheduler has no such
  // list, so every airing failed with "No shared photos to show" and surfaced
  // in the UI as a bare 500.
  const { webServer, api, sent } = await startServer({
    configOverrides: { proxyOwnIp: '192.168.1.50', qrImage: { cacheDir: 'qr-cache' } },
  });
  try {
    const created = await api(`${ROUTE}/rules`, {
      method: 'POST',
      body: { commandId: 'signal.slideshow', intervalSeconds: 1800, probability: 90 },
    });
    const id = created.body.rule.id;

    // Nothing shared yet: a clear reason, not a crash or a bare status code.
    const empty = await api(`${ROUTE}/rules/${id}/air`, { method: 'POST' });
    assert.equal(empty.status, 409);
    assert.match(empty.body.error, /No shared photos/);
    assert.match(empty.body.event.detail, /No shared photos/);

    for (let i = 0; i < 2; i += 1) {
      await api('/api/qr/image-upload', {
        method: 'POST', body: { imageDataUrl: TINY_PNG_DATA_URL },
      });
    }

    const aired = await api(`${ROUTE}/rules/${id}/air`, { method: 'POST' });
    assert.equal(aired.status, 202);
    assert.equal(aired.body.event.outcome, 'aired');

    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'photo.slideshow');
    assert.equal(sent[0].slideshow.photos.length, 2);
    for (const photo of sent[0].slideshow.photos) {
      assert.match(photo.url, /^https?:\/\/192\.168\.1\.50:\d+\/qr-images\//);
    }
  } finally {
    webServer.stop();
  }
});

test('an unreachable host is reported as a config problem, not an empty cache', async () => {
  // `127.0.0.1` cannot be fetched by the display, so the URLs come back empty
  // even though photos exist. The two causes need different fixes.
  const { webServer, api } = await startServer({
    configOverrides: { qrImage: { cacheDir: 'qr-cache' } },
  });
  try {
    const created = await api(`${ROUTE}/rules`, {
      method: 'POST',
      body: { commandId: 'signal.slideshow', intervalSeconds: 1800, probability: 90 },
    });
    await api('/api/qr/image-upload', {
      method: 'POST', body: { imageDataUrl: TINY_PNG_DATA_URL },
    });

    const aired = await api(`${ROUTE}/rules/${created.body.rule.id}/air`, { method: 'POST' });
    assert.equal(aired.status, 409);
    assert.match(aired.body.error, /PROXY_OWN_IP/);
  } finally {
    webServer.stop();
  }
});

test('an explicit photo list still wins over the shared cache', async () => {
  const { webServer, api, sent, base, cookie } = await startServer({
    configOverrides: { proxyOwnIp: '192.168.1.50', qrImage: { cacheDir: 'qr-cache' } },
  });
  try {
    await api('/api/qr/image-upload', {
      method: 'POST', body: { imageDataUrl: TINY_PNG_DATA_URL },
    });
    const chosen = [{ url: 'https://192.168.1.50:47810/qr-images/chosen.png', uploadedAt: null }];
    const push = await request(`${base}/api/push/photo-slideshow`, {
      method: 'POST', cookie, body: { photos: chosen },
    });

    assert.equal(push.status, 200);
    assert.equal(sent.at(-1).slideshow.photos.length, 1);
    assert.equal(sent.at(-1).slideshow.photos[0].url, chosen[0].url);
  } finally {
    webServer.stop();
  }
});

test('reset clears the timers and counters of one rule', async () => {
  const { webServer, api } = await startServer();
  try {
    const created = await api(`${ROUTE}/rules`, {
      method: 'POST',
      body: { commandId: 'alexa.weather', intervalSeconds: 7200, probability: 100 },
    });
    const id = created.body.rule.id;
    await api(`${ROUTE}/rules/${id}/air`, { method: 'POST' });
    assert.ok((await api(`${ROUTE}/rules`)).body.rules[0].lastAiredAt);

    const reset = await api(`${ROUTE}/rules/${id}/reset`, { method: 'POST' });
    assert.equal(reset.status, 200);
    assert.equal(reset.body.rule.lastAiredAt, undefined);
    assert.equal(reset.body.rule.airingsToday, 0);
  } finally {
    webServer.stop();
  }
});

test('status reports the live gates including whether the display is busy', async () => {
  const busy = createDisplayBusy();
  const { webServer, api } = await startServer({ busy });
  try {
    await api(`${ROUTE}/rules`, {
      method: 'POST',
      body: { commandId: 'alexa.weather', intervalSeconds: 1800, probability: 100 },
    });
    const idle = await api(`${ROUTE}/status`);
    assert.equal(idle.status, 200);
    assert.equal(idle.body.displayBusy, false);
    assert.equal(idle.body.ruleCount, 1);
    assert.ok(idle.body.nextUp, 'the empty state needs a next-expected-event to explain itself');

    busy.noteSent({ type: 'trivia.round', displaySeconds: 274 });
    const occupied = await api(`${ROUTE}/status`);
    assert.equal(occupied.body.displayBusy, true);
    assert.equal(occupied.body.display.type, 'trivia.round');
    assert.ok(occupied.body.display.remainingSeconds > 200);
  } finally {
    webServer.stop();
  }
});

test('a manual push holds the scheduler off for a full global gap', async () => {
  const { webServer, api } = await startServer();
  try {
    await api(`${ROUTE}/settings`, {
      method: 'PUT', body: { active: true, globalMinGapSeconds: 600, quietHours: null },
    });
    await api(`${ROUTE}/rules`, {
      method: 'POST',
      body: { commandId: 'alexa.weather', intervalSeconds: 60, probability: 100 },
    });
    webServer.scheduler._clearBootSuppression();

    // A human presses the Guest Snaps tile.
    await api('/api/push/guest-photobooth', { method: 'POST', body: {} });

    const result = await webServer.scheduler.tick();
    assert.equal(result.reason, 'blocked-global-gap', 'do not yank away what a person just put up');
  } finally {
    webServer.stop();
  }
});

test('the tick skips while the display is busy and resumes when it frees up', async () => {
  const busy = createDisplayBusy();
  const { webServer, api, sent } = await startServer({ busy });
  try {
    await api(`${ROUTE}/settings`, {
      method: 'PUT',
      body: { active: true, globalMinGapSeconds: 0, quietHours: null },
    });
    await api(`${ROUTE}/rules`, {
      method: 'POST',
      body: { commandId: 'alexa.weather', intervalSeconds: 60, probability: 100 },
    });
    webServer.scheduler._clearBootSuppression();

    busy.noteSent({ type: 'weather.query', displaySeconds: 600 });
    assert.equal((await webServer.scheduler.tick()).reason, 'blocked-display');

    busy.release();
    const before = sent.length;
    const result = await webServer.scheduler.tick();
    assert.ok(result.aired, 'the scheduler takes the display once it is free');
    assert.ok(sent.length > before);
    assert.equal(sent.at(-1).type, 'weather.query');
  } finally {
    webServer.stop();
  }
});

test('activity, stats and heatmap return pre-aggregated data, not raw dumps', async () => {
  const { webServer, api } = await startServer();
  try {
    const created = await api(`${ROUTE}/rules`, {
      method: 'POST',
      body: { commandId: 'alexa.weather', intervalSeconds: 7200, probability: 100 },
    });
    const id = created.body.rule.id;
    await api(`${ROUTE}/rules/${id}/air`, { method: 'POST' });

    const activity = await api(`${ROUTE}/activity?window=24h`);
    assert.equal(activity.status, 200);
    assert.ok(activity.body.events.length >= 1);
    // The timeline needs rule colours and labels alongside the events.
    assert.equal(activity.body.rules[0].id, id);
    assert.ok(activity.body.rules[0].color);

    const stats = await api(`${ROUTE}/stats?window=24h`);
    assert.equal(stats.body.stats[0].ruleId, id);
    assert.equal(stats.body.stats[0].aired, 1);
    assert.equal(stats.body.stats[0].hitRate, 1);
    assert.ok(Array.isArray(stats.body.daily[id]));

    const heatmap = await api(`${ROUTE}/heatmap?days=14`);
    assert.equal(heatmap.body.rows.length, 14);
    assert.equal(heatmap.body.rows[13].hours.length, 24);
    assert.equal(heatmap.body.rows[13].hours.reduce((a, b) => a + b, 0), 1);

    const filtered = await api(`${ROUTE}/activity?outcomes=lost-dice`);
    assert.equal(filtered.body.events.length, 0);
  } finally {
    webServer.stop();
  }
});

test('simulate returns a labelled forecast without touching real state', async () => {
  const { webServer, api } = await startServer();
  try {
    await api(`${ROUTE}/rules`, {
      method: 'POST',
      body: { commandId: 'alexa.weather', intervalSeconds: 1800, probability: 100 },
    });
    const result = await api(`${ROUTE}/simulate`, {
      method: 'POST', body: { hours: 24, runs: 10 },
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.forecast, true, 'the UI must be able to label this a forecast');
    assert.equal(result.body.perRule.length, 1);
    assert.ok(result.body.representative.length > 0);
    // No side effects: nothing was written to the activity log.
    assert.equal((await api(`${ROUTE}/activity`)).body.events.length, 0);
  } finally {
    webServer.stop();
  }
});

test('every scheduler route needs an admin session', async () => {
  const { webServer, base } = await startServer();
  try {
    for (const [method, route] of [
      ['GET', `${ROUTE}/settings`],
      ['GET', `${ROUTE}/rules`],
      ['GET', `${ROUTE}/status`],
      ['GET', `${ROUTE}/activity`],
      ['PUT', `${ROUTE}/settings`],
      ['POST', `${ROUTE}/rules`],
      ['DELETE', `${ROUTE}/rules/x`],
    ]) {
      const res = await request(`${base}${route}`, { method, body: method === 'GET' ? null : {} });
      assert.equal(res.status, 401, `${method} ${route} must require a session`);
    }
  } finally {
    webServer.stop();
  }
});

test('pausing the scheduler is instant', async () => {
  const { webServer, api, recorded } = await startServer();
  try {
    await api(`${ROUTE}/settings`, {
      method: 'PUT', body: { active: true, globalMinGapSeconds: 0, quietHours: null },
    });
    await api(`${ROUTE}/rules`, {
      method: 'POST',
      body: { commandId: 'alexa.weather', intervalSeconds: 60, probability: 100 },
    });
    webServer.scheduler._clearBootSuppression();

    await api(`${ROUTE}/settings`, { method: 'PUT', body: { active: false } });
    const before = recorded.length;
    const result = await webServer.scheduler.tick();
    assert.equal(result.reason, 'paused');
    assert.equal(recorded.length, before);
  } finally {
    webServer.stop();
  }
});

test('every schedulable command in the registry has a dispatch', async () => {
  const { webServer } = await startServer();
  try {
    const { COMMANDS } = require('../src/command-registry');
    for (const command of COMMANDS.filter((c) => c.schedulable)) {
      // An unmapped command throws a distinctive error before any push runs;
      // anything else means the dispatch exists and merely failed on deps.
      let dispatchMissing = false;
      try {
        await webServer.airCommand(command.id, {});
      } catch (error) {
        dispatchMissing = /has no scheduler dispatch/.test(error.message);
      }
      assert.equal(dispatchMissing, false, `${command.id} is schedulable but has no dispatch`);
    }
  } finally {
    webServer.stop();
  }
});
