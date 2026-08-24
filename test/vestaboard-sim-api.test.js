/**
 * The Signal-side surface of the Vestaboard simulator (04 §4).
 *
 * The board's own Local API is covered in `vestaboard-simulator.test.js`.
 * These tests pin what the admin page is written against: the one state fetch
 * it starts from, the SSE stream it renders from afterwards, and the toggle
 * that lets error paths be exercised on purpose.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const httpMod = require('node:http');

const { createWebServer } = require('../src/web-server');
const { createVestaboardSimulator, ENABLEMENT_HEADER, KEY_HEADER } = require('../src/vestaboard/simulator');
const { createVestaboardHub } = require('../src/vestaboard');
const { createDisplayRegistry } = require('../src/display-registry');
const { badgeFrame } = require('../src/vestaboard/frames');
const { identityFrame } = require('../src/vestaboard/formatters/signal');

const TEST_ADMIN_PASSWORD = 'vestaboard-admin-secret';

function request(url, { method = 'GET', body = null, cookie = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const head = { ...headers };
    if (data) {
      head['Content-Type'] = 'application/json';
      head['Content-Length'] = Buffer.byteLength(data);
    }
    if (cookie) head.Cookie = cookie;
    const req = httpMod.request(url, { method, agent: false, headers: head }, (res) => {
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

/**
 * Open an SSE stream and resolve once `wanted` event names have all arrived.
 * Mirrors what EventSource does in the page, minus the reconnect.
 */
function collectEvents(url, cookie, wanted, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const seen = [];
    const req = httpMod.request(url, { agent: false, headers: { Cookie: cookie } }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`stream refused: ${res.statusCode}`));
        return;
      }
      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let split = buffer.indexOf('\n\n');
        while (split !== -1) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const name = /^event: (.+)$/m.exec(frame)?.[1];
          const data = /^data: (.+)$/m.exec(frame)?.[1];
          if (name) {
            seen.push({ name, data: data ? JSON.parse(data) : null });
          }
          if (wanted.every((w) => seen.some((e) => e.name === w))) {
            req.destroy();
            resolve(seen);
            return;
          }
          split = buffer.indexOf('\n\n');
        }
      });
    });
    req.on('error', (error) => {
      if (error.code !== 'ECONNRESET') reject(error);
    });
    req.end();
    setTimeout(() => {
      req.destroy();
      reject(new Error(`timed out waiting for ${wanted.join(', ')}; saw ${seen.map((e) => e.name).join(', ') || 'nothing'}`));
    }, timeoutMs).unref();
  });
}

function makeWebRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-web-'));
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

async function startHarness({ withSimulator = true, withHub = false } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-api-'));
  const config = {
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
      controlAuth: { enabled: false },
      adminPassword: TEST_ADMIN_PASSWORD,
      adminSessionHours: 12,
    },
    teslaFleet: {
      enabled: false,
      sessionPath: path.join(dataDir, 'tesla-session.json'),
      authStatusPath: path.join(dataDir, 'tesla-auth-status.json'),
    },
    vestaboardSimulator: { port: 0, host: '127.0.0.1', rateWindowSeconds: 0 },
  };

  let simulator = null;
  let boardBase = null;
  let boardKey = null;
  if (withSimulator) {
    simulator = createVestaboardSimulator({
      config,
      log: { info() {}, warn() {}, error() {}, debug() {} },
    });
    await simulator.start();
    boardBase = `http://127.0.0.1:${simulator.address().port}`;
    const enabled = await request(`${boardBase}/local-api/enablement`, {
      method: 'POST',
      headers: { [ENABLEMENT_HEADER]: simulator.enablementToken() },
    });
    boardKey = enabled.body.apiKey;
  }

  let hub = null;
  let registry = null;
  if (withHub) {
    hub = createVestaboardHub({
      config,
      log: { info() {}, warn() {}, error() {}, debug() {} },
      simulator,
    });
    await hub.start();
    // Wired the way the listener wires it, so the picker sees boards.
    registry = createDisplayRegistry(
      config,
      { info() {}, warn() {}, error() {}, debug() {} },
      { staticEntries: () => hub.registryEntries() },
    );
  }

  const webServer = createWebServer({
    config,
    log: { info() {}, warn() {}, error() {}, debug() {} },
    sendUdpPayload: () => {},
    recordVoiceEvent: async () => {},
    vestaboardSimulator: simulator,
    vestaboardHub: hub,
    displayRegistry: registry,
    scheduleRestart: () => {},
    webRoot: makeWebRoot(),
  });
  const server = await webServer.start();
  const base = `http://127.0.0.1:${server.address().port}`;

  const login = await request(`${base}/api/admin/login`, {
    method: 'POST',
    body: { password: TEST_ADMIN_PASSWORD },
  });
  const raw = login.headers['set-cookie'];
  const cookie = String(Array.isArray(raw) ? raw[0] : raw || '').split(';')[0];

  return {
    base,
    cookie,
    simulator,
    hub,
    boardBase,
    /** Post a frame to the board exactly the way the transport will. */
    flip: (frame) => request(`${boardBase}/local-api/message`, {
      method: 'POST',
      body: frame,
      headers: { [KEY_HEADER]: boardKey },
    }),
    async stop() {
      await new Promise((resolve) => server.close(resolve));
      if (registry) registry.stop();
      if (hub) hub.stop();
      if (simulator) await simulator.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

test('the state fetch gives the page everything it needs to draw itself', async () => {
  const harness = await startHarness();
  try {
    const res = await request(`${harness.base}/api/vestaboard-sim`, { cookie: harness.cookie });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);

    assert.equal(res.body.state.online, true);
    assert.equal(res.body.state.current.length, 6);
    assert.equal(res.body.state.current[0].length, 22);

    // The page owns no character table of its own.
    assert.equal(res.body.glyphs['1'], 'A');
    assert.equal(res.body.glyphs['0'], ' ');
    assert.equal(res.body.chips.red, 63);
    assert.ok(Array.isArray(res.body.calls));
  } finally {
    await harness.stop();
  }
});

test('the state fetch never carries the board key or the enablement token', async () => {
  const harness = await startHarness();
  try {
    const res = await request(`${harness.base}/api/vestaboard-sim`, { cookie: harness.cookie });
    assert.ok(!res.text.includes(harness.simulator.apiKey()));
    assert.ok(!res.text.includes(harness.simulator.enablementToken()));
  } finally {
    await harness.stop();
  }
});

test('the simulator surface is admin-only', async () => {
  const harness = await startHarness();
  try {
    assert.equal((await request(`${harness.base}/api/vestaboard-sim`)).status, 401);
    assert.equal((await request(`${harness.base}/api/vestaboard-sim/events`)).status, 401);
    const toggle = await request(`${harness.base}/api/vestaboard-sim/online`, {
      method: 'POST',
      body: { online: false },
    });
    assert.equal(toggle.status, 401);
  } finally {
    await harness.stop();
  }
});

test('the stream opens with the current state', async () => {
  const harness = await startHarness();
  try {
    const events = await collectEvents(
      `${harness.base}/api/vestaboard-sim/events`,
      harness.cookie,
      ['sim.state'],
    );
    const hello = events.find((e) => e.name === 'sim.state');
    assert.equal(hello.data.online, true);
    assert.equal(hello.data.current.length, 6);
  } finally {
    await harness.stop();
  }
});

test('a flip on the board reaches the page as a flip and a call', async () => {
  const harness = await startHarness();
  try {
    const waiting = collectEvents(
      `${harness.base}/api/vestaboard-sim/events`,
      harness.cookie,
      ['sim.flip', 'sim.call'],
    );
    // Give the stream a moment to subscribe before the board moves.
    await new Promise((resolve) => setTimeout(resolve, 60));

    const frame = badgeFrame({ color: 'blue', title: 'SHOPPING LIST', rows: ['MILK'] });
    assert.equal((await harness.flip(frame)).status, 200);

    const events = await waiting;
    const flip = events.find((e) => e.name === 'sim.flip');
    assert.deepEqual(flip.data.layout, frame);

    const call = events.find((e) => e.name === 'sim.call');
    assert.equal(call.data.result, '200 flipped');
  } finally {
    await harness.stop();
  }
});

test('toggling the board off is live and pushes the new state to the page', async () => {
  const harness = await startHarness();
  try {
    const waiting = collectEvents(
      `${harness.base}/api/vestaboard-sim/events`,
      harness.cookie,
      ['sim.state', 'sim.state'],
    ).catch(() => []);
    await new Promise((resolve) => setTimeout(resolve, 60));

    const off = await request(`${harness.base}/api/vestaboard-sim/online`, {
      method: 'POST',
      body: { online: false },
      cookie: harness.cookie,
    });
    assert.equal(off.status, 200);
    assert.equal(off.body.state.online, false);

    // A board that is off refuses work, which is the point of the toggle.
    const refused = await harness.flip(badgeFrame({ color: 'red', title: 'NOPE', rows: [] }));
    assert.equal(refused.status, 503);

    const back = await request(`${harness.base}/api/vestaboard-sim/online`, {
      method: 'POST',
      body: { online: true },
      cookie: harness.cookie,
    });
    assert.equal(back.body.state.online, true);
    await waiting;
  } finally {
    await harness.stop();
  }
});

test('the toggle insists on a real boolean', async () => {
  const harness = await startHarness();
  try {
    const res = await request(`${harness.base}/api/vestaboard-sim/online`, {
      method: 'POST',
      body: { online: 'off' },
      cookie: harness.cookie,
    });
    assert.equal(res.status, 400);
  } finally {
    await harness.stop();
  }
});

test('the settings tab gets the whole board, health included, and never a key', async () => {
  const harness = await startHarness({ withHub: true });
  try {
    const res = await request(`${harness.base}/api/vestaboards`, { cookie: harness.cookie });
    assert.equal(res.status, 200);

    const [sim] = res.body.boards;
    assert.equal(sim.id, 'sim');
    assert.equal(sim.simulator, true);
    assert.equal(sim.health, 'ok');
    assert.equal(sim.hasKey, true);
    // The edit form needs these to fill itself in.
    assert.equal(typeof sim.dwellSeconds, 'number');
    assert.equal(typeof sim.quietHours.start, 'string');

    assert.ok(!res.text.includes(harness.hub.settings.keyFor('sim')));
  } finally {
    await harness.stop();
  }
});

test('a board can be added, edited and removed over the api', async () => {
  const harness = await startHarness({ withHub: true });
  try {
    const added = await request(`${harness.base}/api/vestaboards`, {
      method: 'POST',
      cookie: harness.cookie,
      body: {
        id: 'kitchen', name: 'Kitchen Board', baseUrl: 'http://127.0.0.1:1', key: 'a-key',
      },
    });
    assert.equal(added.status, 200);
    assert.equal(added.body.boards.length, 2);
    assert.ok(!added.text.includes('a-key'), 'a saved key never comes back out');

    const edited = await request(`${harness.base}/api/vestaboards`, {
      method: 'POST',
      cookie: harness.cookie,
      body: { id: 'kitchen', name: 'Kitchen', dwellSeconds: 25 },
    });
    const kitchen = edited.body.boards.find((board) => board.id === 'kitchen');
    assert.equal(kitchen.name, 'Kitchen');
    assert.equal(kitchen.dwellSeconds, 25);
    assert.equal(kitchen.hasKey, true, 'editing without a key keeps the saved one');

    const removed = await request(`${harness.base}/api/vestaboards/remove`, {
      method: 'POST',
      cookie: harness.cookie,
      body: { id: 'kitchen' },
    });
    assert.equal(removed.body.boards.length, 1);
  } finally {
    await harness.stop();
  }
});

test('a board with no id is refused rather than saved as junk', async () => {
  const harness = await startHarness({ withHub: true });
  try {
    const res = await request(`${harness.base}/api/vestaboards`, {
      method: 'POST',
      cookie: harness.cookie,
      body: { name: 'No id' },
    });
    assert.equal(res.status, 400);
  } finally {
    await harness.stop();
  }
});

test('switching a board off is live and takes it out of the picker', async () => {
  const harness = await startHarness({ withHub: true });
  try {
    const before = await request(`${harness.base}/api/displays`, { cookie: harness.cookie });
    assert.equal(before.body.displays.some((d) => d.id === 'sim'), true);
    assert.equal(before.body.displays.find((d) => d.id === 'sim').kind, 'vestaboard');

    const off = await request(`${harness.base}/api/vestaboards/enable`, {
      method: 'POST',
      cookie: harness.cookie,
      body: { id: 'sim', enabled: false },
    });
    assert.equal(off.status, 200);

    const after = await request(`${harness.base}/api/displays`, { cookie: harness.cookie });
    assert.equal(after.body.displays.some((d) => d.id === 'sim'), false);
  } finally {
    await harness.stop();
  }
});

test('a test flip puts the identity frame on the board through the api', async () => {
  const harness = await startHarness({ withHub: true });
  try {
    const res = await request(`${harness.base}/api/vestaboards/test-flip`, {
      method: 'POST',
      cookie: harness.cookie,
      body: { id: 'sim' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);

    assert.deepEqual(
      harness.simulator.state().current,
      identityFrame({ name: 'Vestaboard Simulator' }).rows,
    );
  } finally {
    await harness.stop();
  }
});

test('the board settings surface is admin-only', async () => {
  const harness = await startHarness({ withHub: true });
  try {
    assert.equal((await request(`${harness.base}/api/vestaboards`)).status, 401);
    const save = await request(`${harness.base}/api/vestaboards`, {
      method: 'POST',
      body: { id: 'sneaky', name: 'Sneaky' },
    });
    assert.equal(save.status, 401);
  } finally {
    await harness.stop();
  }
});

test('with the simulator switched off in config the page is told so plainly', async () => {
  const harness = await startHarness({ withSimulator: false });
  try {
    const res = await request(`${harness.base}/api/vestaboard-sim`, { cookie: harness.cookie });
    assert.equal(res.status, 404);
    assert.equal(res.body.ok, false);

    const toggle = await request(`${harness.base}/api/vestaboard-sim/online`, {
      method: 'POST',
      body: { online: false },
      cookie: harness.cookie,
    });
    assert.equal(toggle.status, 404);
  } finally {
    await harness.stop();
  }
});
