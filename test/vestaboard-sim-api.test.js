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

/** Resolve on the first SSE event that satisfies `predicate`. */
function collectUntil(url, cookie, predicate, timeoutMs = 4000) {
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
            const parsed = data ? JSON.parse(data) : null;
            seen.push({ name, data: parsed });
            if (predicate(name, parsed, seen)) {
              req.destroy();
              resolve(seen);
              return;
            }
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
      reject(new Error(`timed out; saw ${seen.map((e) => e.name).join(', ') || 'nothing'}`));
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
    // These tests pin the admin stream, not quiet hours. Default 22:00–07:00
    // would refuse a shopping/weather submit after bedtime.
    hub.queueFor('sim')?.setConfig({
      quietHours: { start: '22:00', end: '07:00', enabled: false },
    });
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
    assert.ok(Array.isArray(res.body.drum));
    assert.equal(res.body.drum[0], 0);
    assert.equal(res.body.drum.includes(1), true);
    assert.equal(res.body.drum.includes(43), false);
    assert.equal(res.body.drum.includes(63), true);
    assert.ok(Array.isArray(res.body.calls));
    assert.ok(Array.isArray(res.body.queue));
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
      ['sim.state', 'sim.queue'],
    );
    const hello = events.find((e) => e.name === 'sim.state');
    assert.equal(hello.data.online, true);
    assert.equal(hello.data.current.length, 6);
    const queued = events.find((e) => e.name === 'sim.queue');
    assert.ok(queued, 'the stream opens with the current hub queue');
    assert.ok(Array.isArray(queued.data.items));
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

test('turning the simulator off drops it from the display picker', async () => {
  const harness = await startHarness({ withHub: true });
  try {
    const before = await request(`${harness.base}/api/displays`, { cookie: harness.cookie });
    assert.equal(before.body.displays.some((d) => d.id === 'sim'), true);

    const off = await request(`${harness.base}/api/vestaboard-sim/online`, {
      method: 'POST',
      cookie: harness.cookie,
      body: { online: false },
    });
    assert.equal(off.status, 200);
    assert.equal(off.body.state.online, false);

    const hidden = await request(`${harness.base}/api/displays`, { cookie: harness.cookie });
    assert.equal(hidden.body.displays.some((d) => d.id === 'sim'), false);

    const back = await request(`${harness.base}/api/vestaboard-sim/online`, {
      method: 'POST',
      cookie: harness.cookie,
      body: { online: true },
    });
    assert.equal(back.body.state.online, true);

    const shown = await request(`${harness.base}/api/displays`, { cookie: harness.cookie });
    assert.equal(shown.body.displays.some((d) => d.id === 'sim'), true);
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

test('the state fetch includes frames waiting on the hub queue', async () => {
  const harness = await startHarness({ withHub: true });
  try {
    const layout = badgeFrame({ color: 'blue', title: 'SHOPPING LIST', rows: ['MILK'] });
    const outcome = harness.hub.submit('sim', [{
      rows: layout,
      label: 'Shopping',
      source: 'shopping-list.snapshot',
      dwellSeconds: 15,
    }]);
    assert.equal(outcome.accepted, 1);

    const res = await request(`${harness.base}/api/vestaboard-sim`, { cookie: harness.cookie });
    assert.equal(res.body.queue.length, 1);
    assert.equal(res.body.queue[0].label, 'Shopping');
    assert.ok(res.body.queue[0].id, 'the page needs an id so the simulator can cancel it');
    assert.ok(res.body.queueRevision >= 1);
  } finally {
    await harness.stop();
  }
});

test('queueing a frame on the hub reaches the page as sim.queue', async () => {
  const harness = await startHarness({ withHub: true });
  try {
    const waiting = collectUntil(
      `${harness.base}/api/vestaboard-sim/events`,
      harness.cookie,
      (name, data) => name === 'sim.queue' && Array.isArray(data?.items) && data.items.length > 0,
    );
    await new Promise((resolve) => setTimeout(resolve, 60));

    harness.hub.submit('sim', [{
      rows: badgeFrame({ color: 'blue', title: 'SHOPPING LIST', rows: ['MILK'] }),
      label: 'Shopping',
      source: 'shopping-list.snapshot',
      dwellSeconds: 15,
    }]);

    const events = await waiting;
    const queued = [...events].reverse().find((e) => e.name === 'sim.queue');
    assert.equal(queued.data.items[0].label, 'Shopping');
    assert.ok(queued.data.revision >= 1);
  } finally {
    await harness.stop();
  }
});

test('the simulator can cancel one waiting page', async () => {
  const harness = await startHarness({ withHub: true });
  try {
    harness.hub.submit('sim', [
      {
        rows: badgeFrame({ color: 'blue', title: 'SHOPPING LIST', rows: ['MILK'] }),
        label: 'Shopping',
        source: 'shopping-list.snapshot',
        dwellSeconds: 15,
      },
      {
        rows: badgeFrame({ color: 'red', title: 'WEATHER', rows: ['72F'] }),
        label: 'Weather',
        source: 'weather.query',
        dwellSeconds: 15,
      },
    ]);
    const weather = harness.hub.queueFor('sim').pending().find((row) => row.label === 'Weather');
    assert.ok(weather?.id);
    const res = await request(`${harness.base}/api/vestaboard-sim/queue/cancel`, {
      method: 'POST',
      cookie: harness.cookie,
      body: { id: weather.id },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.gone, false);
    assert.equal(res.body.queue.some((row) => row.label === 'Weather'), false);
    assert.ok(res.body.queueRevision >= 1);
  } finally {
    await harness.stop();
  }
});

test('cancelling a page that already flipped returns the current queue', async () => {
  const harness = await startHarness({ withHub: true });
  try {
    harness.hub.submit('sim', [{
      rows: badgeFrame({ color: 'blue', title: 'SHOPPING LIST', rows: ['MILK'] }),
      label: 'Shopping',
      source: 'shopping-list.snapshot',
      dwellSeconds: 15,
    }]);
    const res = await request(`${harness.base}/api/vestaboard-sim/queue/cancel`, {
      method: 'POST',
      cookie: harness.cookie,
      body: { id: 'i-missing' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.gone, true);
    assert.equal(res.body.queue.length, 1);
    assert.equal(res.body.queue[0].label, 'Shopping');
  } finally {
    await harness.stop();
  }
});

test('the simulator can reorder waiting pages', async () => {
  const harness = await startHarness({ withHub: true });
  try {
    harness.hub.submit('sim', [
      {
        rows: badgeFrame({ color: 'blue', title: 'ONE', rows: ['A'] }),
        label: 'One',
        source: 'one',
        dwellSeconds: 15,
      },
    ]);
    harness.hub.submit('sim', [
      {
        rows: badgeFrame({ color: 'red', title: 'TWO', rows: ['B'] }),
        label: 'Two',
        source: 'two',
        dwellSeconds: 15,
      },
    ]);
    const ids = harness.hub.queueFor('sim').pending().map((row) => row.id);
    const res = await request(`${harness.base}/api/vestaboard-sim/queue/reorder`, {
      method: 'POST',
      cookie: harness.cookie,
      body: { ids: [ids[1], ids[0]] },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.queue.map((row) => row.label), ['Two', 'One']);
  } finally {
    await harness.stop();
  }
});

test('a hub push flips the simulator and the page stream sees it', async () => {
  const harness = await startHarness({ withHub: true });
  try {
    const waiting = collectUntil(
      `${harness.base}/api/vestaboard-sim/events`,
      harness.cookie,
      (name) => name === 'sim.flip',
    );
    await new Promise((resolve) => setTimeout(resolve, 60));

    const outcome = harness.hub.pushEvent({
      type: 'weather.query',
      weather: {
        current: { temperatureF: 72, condition: 'sunny' },
        next7Days: [{ date: '2026-08-24', highF: 80, lowF: 60, condition: 'sunny' }],
      },
    }, { targetId: 'sim', explicit: true });
    assert.equal(outcome.boards[0].reason, 'queued');

    const events = await waiting;
    const flip = events.find((e) => e.name === 'sim.flip');
    assert.ok(Array.isArray(flip.data.layout));
    assert.equal(flip.data.layout.length, 6);
    assert.ok(
      harness.simulator.calls().some((entry) => String(entry.result).includes('200')),
      'the simulator recorded the Local API post',
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

test('the Next flip pill waits out Settings dwell, not only the flap window', async () => {
  const harness = await startHarness({ withHub: true });
  try {
    const queue = harness.hub.queueFor('sim');
    queue.setConfig({
      dwellSeconds: 60,
      rateWindowSeconds: 0,
      quietHours: { start: '22:00', end: '07:00', enabled: false },
    });
    queue.submit([identityFrame({ name: 'Vestaboard Simulator' })]);
    assert.equal(await queue.tick(), 'posted');
    const res = await request(`${harness.base}/api/vestaboard-sim`, { cookie: harness.cookie });
    assert.ok(
      res.body.state.cooldownMs >= 55_000,
      `cooldown was ${res.body.state.cooldownMs}`,
    );
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

test('the simulator page walks the drum slowly and can click', () => {
  const root = path.join(__dirname, '..', 'src', 'web', 'admin');
  const js = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(js, /AudioContext/);
  assert.match(js, /vbDrumSteps/);
  assert.match(js, /function vbSettleBoard\(/);
  assert.match(js, /function vbFaceMatches\(/);
  assert.match(js, /always clear code 0/);
  assert.match(js, /VB_FLAP_MS = 100/);
  assert.match(js, /VB_CASCADE_MS = 5616/);
  assert.match(js, /function vbCascadeMs\(/);
  assert.match(css, /vb-flap 100ms/);
  assert.equal(/vb-flap 450ms/.test(css), false);
  assert.match(js, /function vbPlayCascade\(/);
  assert.match(js, /function vbBoardWatching\(/);
  assert.match(js, /function vbOnBoardTabEnter\(/);
  assert.match(js, /function vbOnBoardTabLeave\(/);
  assert.match(js, /vbPendingReplay/);
  // Tab entry must unlock audio only — never fire the cascade with no flaps.
  assert.doesNotMatch(js, /vbHeardSample/);
  assert.match(js, /vb-flip\.wav/);
  assert.match(html, /btn-vb-sound/);
  assert.match(html, /app\.js\?v=signal\d+/);
  const wavPath = path.join(root, 'vb-flip.wav');
  assert.equal(fs.existsSync(wavPath), true);
  const wav = fs.readFileSync(wavPath);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt16LE(22), 1, 'mono');
  const seconds = wav.readUInt32LE(40) / (wav.readUInt32LE(24) * 2);
  assert.ok(seconds > 5.4 && seconds < 6, `clip is ${seconds.toFixed(3)}s`);
});
