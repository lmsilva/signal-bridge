const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('node:events');

const adbModule = require('../src/huupe-adb');

const SERVICE_PATH = require.resolve('../src/huupe-service');
const realCreateCollector = adbModule.createHuupeCollector;

const CLOCK = Date.UTC(2026, 7, 27, 9, 0, 0);

const HUUPE_PROPS = [
  '[ro.build.version.release]: [11]',
  '[ro.product.manufacturer]: [Huupe]',
  '[ro.product.model]: [Huupe Mini]',
  '[persist.adb.tcp.port]: [5555]',
].join('\n');

function silentLog() {
  return {
    info() {},
    warn() {},
    debug() {},
    error() {},
  };
}

/**
 * Swap the collector factory the service reaches for, so every test drives a
 * collector that can never touch a real adb, socket or LAN.
 */
function loadServiceWith(createCollector, run) {
  adbModule.createHuupeCollector = createCollector;
  delete require.cache[SERVICE_PATH];
  const { createHuupeService } = require(SERVICE_PATH);
  return Promise.resolve()
    .then(() => run(createHuupeService))
    .finally(() => {
      adbModule.createHuupeCollector = realCreateCollector;
      delete require.cache[SERVICE_PATH];
      require(SERVICE_PATH);
    });
}

function fakeCollector(overrides = {}) {
  const calls = { start: 0, close: 0, reconnectNow: 0, discover: 0 };
  const snapshot = {
    adbPath: 'adb',
    state: 'streaming',
    configured: true,
    serial: '192.168.50.7:5555',
    connected: true,
    lastError: null,
    lastConnectedAt: '2026-08-27T09:00:00.000Z',
    lastLineAt: null,
    secondsSinceLine: null,
    retryInSeconds: null,
    discovering: false,
    device: {
      serial: '192.168.50.7:5555',
      model: 'Huupe Mini',
      manufacturer: 'Huupe',
      androidRelease: '11',
      persistentAdbPort: '5555',
      packages: ['com.huupe.justhuupe'],
    },
    counters: { lines: 4210, interference: 3 },
    ...(overrides.snapshot || {}),
  };
  return {
    calls,
    snapshot,
    start() {
      calls.start += 1;
    },
    close() {
      calls.close += 1;
    },
    reconnectNow() {
      calls.reconnectNow += 1;
    },
    async discover() {
      calls.discover += 1;
      return { ok: false, error: 'No Huupe found on the local network' };
    },
    async testConnection() {
      return { ok: true, message: 'Reached the hoop' };
    },
    statusSnapshot: () => snapshot,
    unmatched: () => [],
    resetCounters() {},
    ...(overrides.methods || {}),
  };
}

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'huupe-service-'));
}

function writeSettings(root, device = {}) {
  const dir = path.join(root, 'data');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'huupe-settings.json'),
    JSON.stringify({
      device: { host: '192.168.50.7', autoDiscover: false, port: 5555, ...device },
    }),
    'utf8',
  );
}

function zones() {
  return {
    layup: { made: 1, attempts: 2, pct: 50 },
    one: { made: 2, attempts: 6, pct: 33 },
    two: { made: 3, attempts: 8, pct: 38 },
    three: { made: 9, attempts: 28, pct: 32 },
  };
}

function archivedGame(overrides = {}) {
  return {
    sessionId: 'huupe-20260826T200000-aa11bb',
    mode: 'family',
    startedAt: '2026-08-26T20:00:00.000Z',
    endedAt: '2026-08-26T20:12:00.000Z',
    durationSec: 720,
    aborted: false,
    endReason: 'final-screen',
    winner: 'trashpanda',
    players: [
      {
        name: 'trashpanda',
        score: 17.1,
        position: 0,
        isWinner: true,
        made: 9,
        attempts: 19,
        fgPct: 47,
        threes: 4,
        bestStreak: 3,
        byZone: zones(),
      },
      {
        name: 'Player 2',
        score: 10.1,
        position: 1,
        isWinner: false,
        made: 6,
        attempts: 25,
        fgPct: 24,
        threes: 3,
        bestStreak: 2,
        byZone: zones(),
      },
    ],
    stats: {
      made: 15,
      attempts: 44,
      points: 27.2,
      fgPct: 34,
      threes: 7,
      bestStreak: 3,
      byZone: zones(),
    },
    ...overrides,
  };
}

function seedArchive(root, rows) {
  const dir = path.join(root, 'data', 'huupe-games');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, '2026-08.jsonl'),
    `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
    'utf8',
  );
}

async function settle(rounds = 4) {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Enough of adb/logcat to walk the real collector from dial to a live tail. */
function createAdbHarness(hosts = { '192.168.50.7': true }) {
  const execCalls = [];
  const spawns = [];

  function execFileImpl(file, args, options, callback) {
    execCalls.push({ file, args: [...args] });
    const target = String(args[1] || '');
    if (args[0] === 'connect') {
      return hosts[target.split(':')[0]]
        ? callback(null, `connected to ${target}`, '')
        : callback(new Error(`failed to connect to '${target}'`), '', '');
    }
    if (args[0] === '-s' && args[2] === 'shell' && args[3] === 'getprop') {
      return callback(null, HUUPE_PROPS, '');
    }
    if (args[0] === '-s' && args[2] === 'shell' && args[3] === 'pm') {
      return callback(null, 'package:com.huupe.justhuupe', '');
    }
    return callback(null, '', '');
  }

  function spawnImpl(file, args) {
    const child = new EventEmitter();
    for (const name of ['stdout', 'stderr']) {
      child[name] = new EventEmitter();
      child[name].setEncoding = () => {};
    }
    child.kill = () => {
      child.killed = true;
    };
    spawns.push({ file, args: [...args], child });
    return child;
  }

  return {
    execCalls,
    spawns,
    /** Wrap the real collector so the service still owns the event wiring. */
    factory: (options) => realCreateCollector({
      ...options,
      execFileImpl,
      spawnImpl,
      now: () => CLOCK,
      setTimerImpl: () => ({}),
      clearTimerImpl: () => {},
    }),
  };
}

function shotLine(streamTs) {
  return `08-27 01:25:47.347 I/ShotTracker( 2736): Get EVENT: {"stream_ts": ${streamTs}, "events": ["make_detected"], "shot_zone": "three_point_shot", "shot_range": 3.15 }`;
}

test('starting with no hoop configured comes up idle instead of scanning the network', async () => {
  // The whole integration has to boot cleanly on a machine that has never seen
  // a hoop, and it must not go looking for one on its own.
  const root = makeRoot();
  const harness = createAdbHarness();

  await loadServiceWith(harness.factory, async (createHuupeService) => {
    const service = createHuupeService({
      config: { ROOT: root },
      log: silentLog(),
      sendUdpPayload: () => {},
    });

    service.start();
    await settle();

    assert.deepEqual(harness.execCalls, []);
    assert.equal(harness.spawns.length, 0);

    const status = service.statusSnapshot();
    assert.equal(status.configured, false);
    assert.equal(status.connected, false);
    assert.equal(status.collector.state, 'unconfigured');
    assert.match(status.unavailableReason, /No hoop configured/);
    assert.equal(status.hasArchive, false);
    assert.equal(status.hasLiveSession, false);

    service.close();
  });
});

test('the status snapshot folds the collector, the live machine and the archive into one view', async () => {
  const root = makeRoot();
  writeSettings(root);
  seedArchive(root, [archivedGame()]);
  const collector = fakeCollector();

  await loadServiceWith(() => collector, async (createHuupeService) => {
    const service = createHuupeService({
      config: { ROOT: root },
      log: silentLog(),
      sendUdpPayload: () => {},
    });

    service.start();
    const status = service.statusSnapshot();

    assert.equal(collector.calls.start, 1);
    assert.equal(status.configured, true);
    assert.equal(status.connected, true);
    assert.equal(status.collector.state, 'streaming');
    assert.equal(status.live.phase, 'idle');
    assert.equal(status.live.session, null);
    assert.equal(status.archive.count, 1);
    assert.equal(path.basename(status.archive.root), 'huupe-games');
    assert.equal(status.hasArchive, true);
    assert.equal(status.hasLiveSession, false);
    assert.equal(status.players, 2);
    assert.equal(status.settings.device.host, '192.168.50.7');
    assert.deepEqual(status.device, {
      name: 'Huupe Mini',
      serial: '192.168.50.7:5555',
      online: true,
      statusLabel: 'Online',
      androidRelease: '11',
      lastConnectedAt: '2026-08-27T09:00:00.000Z',
      linesSeen: 4210,
      sensorInterference: 3,
    });
    assert.equal(status.unavailableReason, null);

    service.close();
    assert.equal(collector.calls.close, 1);
  });
});

test('saving a new hoop address is sanitised, persisted and pushed to the collector', async () => {
  const root = makeRoot();
  const collector = fakeCollector();

  await loadServiceWith(() => collector, async (createHuupeService) => {
    const service = createHuupeService({
      config: { ROOT: root },
      log: silentLog(),
      sendUdpPayload: () => {},
    });

    service.start();
    assert.equal(collector.calls.reconnectNow, 0);

    const saved = service.updateSettings({ device: { host: 'adb://192.168.50.7:5555' } });
    assert.equal(saved.ok, true);
    assert.equal(saved.settings.device.host, '192.168.50.7');
    // A new address has to take effect now, not after the current backoff.
    assert.equal(collector.calls.reconnectNow, 1);
    assert.ok(fs.existsSync(path.join(root, 'data', 'huupe-settings.json')));
    assert.equal(service.settings.get().device.host, '192.168.50.7');

    const clamped = service.updateSettings({
      device: { port: 70000 },
      live: { inactivityMinutes: 7 },
    });
    assert.equal(clamped.settings.device.port, 65535);
    // The inactivity timeout is a fixed menu of choices; anything else reverts.
    assert.equal(clamped.settings.live.inactivityMinutes, 5);
    assert.equal(collector.calls.reconnectNow, 2);

    // A display-only change cannot affect the device, so it must not reconnect.
    service.updateSettings({ dashboard: { leaderboardSize: 99 } });
    assert.equal(collector.calls.reconnectNow, 2);
    assert.equal(service.settings.get().dashboard.leaderboardSize, 16);

    // The Settings card posts the whole form on every slider drag, so a patch
    // that carries the device section unchanged must leave the stream — and any
    // game running on it — alone.
    service.updateSettings({
      device: { host: '192.168.50.7', port: 65535, autoDiscover: false },
      dashboard: { leaderboardSize: 8 },
    });
    assert.equal(collector.calls.reconnectNow, 2);
    assert.equal(service.settings.get().device.autoDiscover, false);

    service.close();
  });
});

test('discovering a hoop remembers the address and dials it straight away', async () => {
  const root = makeRoot();
  const collector = fakeCollector({
    methods: {
      async discover() {
        return { ok: true, host: '192.168.50.7', serial: '192.168.50.7:5555' };
      },
    },
  });

  await loadServiceWith(() => collector, async (createHuupeService) => {
    const service = createHuupeService({
      config: { ROOT: root },
      log: silentLog(),
      sendUdpPayload: () => {},
    });

    service.start();
    const found = await service.discover();

    assert.equal(found.ok, true);
    assert.equal(service.settings.get().device.host, '192.168.50.7');
    assert.equal(collector.calls.reconnectNow, 1);

    service.close();
  });
});

test('pushing the hoop with nothing live falls back to the last archived game', async () => {
  const root = makeRoot();
  writeSettings(root);
  seedArchive(root, [
    archivedGame({ sessionId: 'huupe-older', endedAt: '2026-08-20T18:00:00.000Z' }),
    archivedGame(),
  ]);
  const sent = [];

  await loadServiceWith(() => fakeCollector(), async (createHuupeService) => {
    const service = createHuupeService({
      config: { ROOT: root },
      log: silentLog(),
      sendUdpPayload: (body, meta) => sent.push({ body, meta }),
    });

    service.start();
    const result = service.pushNow();

    assert.equal(result.ok, true);
    assert.equal(result.pushed, 'huupe.session');
    assert.equal(result.sessionId, 'huupe-20260826T200000-aa11bb');
    assert.equal(result.status, 'finished');
    // A recap is a timed card, unlike a live session which holds the wall.
    assert.equal(result.displaySeconds, 90);

    assert.equal(sent.length, 1);
    assert.equal(sent[0].meta.source, 'push');
    assert.equal(sent[0].body.type, 'huupe.session');
    assert.equal(sent[0].body.persistent, false);
    assert.equal(sent[0].body.session.status, 'finished');
    assert.equal(sent[0].body.session.winner, 'trashpanda');
    assert.deepEqual(sent[0].body.session.headline, { primary: 'trashpanda', secondary: 'WINS' });
    assert.equal(sent[0].body.session.stats.shotLine, '15/44');

    service.close();
  });
});

test('pushing the hoop before anyone has played says so instead of sending an empty card', async () => {
  const root = makeRoot();
  writeSettings(root);
  const sent = [];

  await loadServiceWith(() => fakeCollector(), async (createHuupeService) => {
    const service = createHuupeService({
      config: { ROOT: root },
      log: silentLog(),
      sendUdpPayload: (body) => sent.push(body),
    });

    service.start();

    assert.deepEqual(service.pushNow(), { ok: false, error: 'No Huupe games recorded yet' });
    assert.deepEqual(service.pushLastGame(), { ok: false, error: 'No Huupe games recorded yet' });
    assert.deepEqual(service.pushNow({ mode: 'live' }), { ok: false, error: 'No live Huupe session' });
    assert.deepEqual(service.pushDashboard(), { ok: false, error: 'No Huupe games recorded yet' });
    assert.deepEqual(sent, []);

    service.close();
  });
});

test('the dashboard push carries the career leaderboard to the wall', async () => {
  const root = makeRoot();
  writeSettings(root);
  seedArchive(root, [archivedGame()]);
  const sent = [];

  await loadServiceWith(() => fakeCollector(), async (createHuupeService) => {
    const service = createHuupeService({
      config: { ROOT: root },
      log: silentLog(),
      sendUdpPayload: (body, meta) => sent.push({ body, meta }),
    });

    service.start();
    const result = service.pushDashboard();

    assert.equal(result.ok, true);
    assert.equal(result.pushed, 'huupe.dashboard');
    assert.equal(result.players, 2);
    assert.equal(result.displaySeconds, 120);

    assert.equal(sent.length, 1);
    const { body } = sent[0];
    assert.equal(body.type, 'huupe.dashboard');
    assert.equal(body.totals.sessions, 1);
    assert.equal(body.totals.games, 1);
    assert.equal(body.leaderboard.length, 2);
    assert.equal(body.leaderboard[0].name, 'trashpanda');
    assert.equal(body.leaderboard[0].crown, true);
    assert.equal(body.device.name, 'Huupe Mini');

    service.close();
  });
});

test('shots read off the log stream reach the wall as a live session payload', async () => {
  const root = makeRoot();
  writeSettings(root);
  const harness = createAdbHarness();
  const sent = [];

  await loadServiceWith(harness.factory, async (createHuupeService) => {
    const service = createHuupeService({
      config: { ROOT: root },
      log: silentLog(),
      sendUdpPayload: (body, meta) => sent.push({ body, meta }),
    });

    service.start();
    await settle();

    assert.equal(harness.spawns.length, 1);
    assert.equal(service.statusSnapshot().live.streamConnected, true);

    const { stdout } = harness.spawns[0].child;
    // One shot is a stray bounce; the session only opens on the second.
    stdout.emit('data', `${shotLine(101.5)}\n`);
    assert.deepEqual(sent, []);
    stdout.emit('data', `${shotLine(102.75)}\n`);

    const live = sent.filter((entry) => entry.body.type === 'huupe.session');
    assert.equal(live.length, 1);
    assert.equal(live[0].meta.source, 'event');
    assert.equal(live[0].body.persistent, true);
    assert.equal(live[0].body.session.status, 'live');
    assert.equal(live[0].body.session.stats.made, 2);
    assert.equal(live[0].body.session.stats.attempts, 2);
    assert.equal(live[0].body.session.stats.shotLine, '2/2');
    assert.equal(live[0].body.session.stats.points, 6);
    assert.equal(live[0].body.session.lastShot.zoneLabel, 'Deep Range');

    const status = service.statusSnapshot();
    assert.equal(status.hasLiveSession, true);
    assert.equal(status.live.phase, 'live');
    assert.equal(status.live.counters.opened, 1);

    service.close();
    // Shutting down must not leave a live card holding the display.
    assert.ok(sent.some((entry) => entry.body.type === 'huupe.session.close'));
  });
});
