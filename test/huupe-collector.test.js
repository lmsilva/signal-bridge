const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const { EventEmitter } = require('node:events');

const { createHuupeCollector, backoffFor, BACKOFF_MS } = require('../src/huupe-adb');

const CLOCK = Date.UTC(2026, 7, 27, 9, 0, 0);

const HUUPE = {
  model: 'Huupe Mini',
  manufacturer: 'Huupe',
  tcpPort: '5555',
  packages: ['com.huupe.justhuupe', 'com.acdetorres.huuplauncher'],
};

const NOT_A_HUUPE = {
  model: 'Living Room TV',
  manufacturer: 'Acme',
  tcpPort: '',
  packages: ['com.acme.tv'],
};

function silentLog() {
  return {
    info() {},
    warn() {},
    debug() {},
    error() {},
  };
}

function fakeSettings(device = {}) {
  const state = {
    device: { host: '', autoDiscover: true, port: 5555, ...device },
  };
  const updates = [];
  return {
    updates,
    get: () => JSON.parse(JSON.stringify(state)),
    update(patch = {}) {
      updates.push(JSON.parse(JSON.stringify(patch)));
      Object.assign(state.device, patch.device || {});
      return JSON.parse(JSON.stringify(state));
    },
  };
}

function getpropText(device) {
  return [
    '[ro.build.version.release]: [11]',
    `[ro.product.manufacturer]: [${device.manufacturer}]`,
    `[ro.product.model]: [${device.model}]`,
    `[persist.adb.tcp.port]: [${device.tcpPort}]`,
  ].join('\n');
}

/** Stands in for `adb` itself: routes argv to a canned reply, records every call. */
function createAdbFake(hosts = {}) {
  const calls = [];

  function impl(file, args, options, callback) {
    calls.push({ file, args: [...args] });
    const reply = (stdout, stderr = '') => callback(null, stdout, stderr);
    const fail = (message) => callback(new Error(message), '', '');

    if (args[0] === 'version') return reply('Android Debug Bridge version 1.0.41');
    if (args[0] === 'disconnect') return reply(`disconnected ${args[1]}`);

    if (args[0] === 'connect') {
      const target = String(args[1] || '');
      if (!hosts[target.split(':')[0]]) {
        return fail(`failed to connect to '${target}': Connection refused`);
      }
      return reply(`connected to ${target}`);
    }

    if (args[0] === '-s') {
      const device = hosts[String(args[1] || '').split(':')[0]];
      const rest = args.slice(2);
      if (!device) return fail('device offline');
      if (rest[0] === 'shell' && rest[1] === 'getprop') return reply(getpropText(device));
      if (rest[0] === 'shell' && rest[1] === 'pm') {
        return reply(device.packages.map((name) => `package:${name}`).join('\n'));
      }
    }
    return fail(`unexpected adb invocation: ${args.join(' ')}`);
  }

  const argvFor = (verb) => calls.filter((call) => call.args[0] === verb).map((call) => call.args[1]);
  return {
    impl,
    calls,
    hosts,
    connectTargets: () => argvFor('connect'),
    disconnectTargets: () => argvFor('disconnect'),
  };
}

function createSpawnFake() {
  const spawns = [];
  function impl(file, args) {
    const child = new EventEmitter();
    for (const name of ['stdout', 'stderr']) {
      child[name] = new EventEmitter();
      child[name].setEncoding = () => {};
    }
    child.killed = false;
    child.kill = () => {
      child.killed = true;
    };
    spawns.push({ file, args: [...args], child });
    return child;
  }
  return {
    impl,
    spawns,
    last: () => spawns[spawns.length - 1],
  };
}

function createTimerFake() {
  const scheduled = [];
  return {
    scheduled,
    delays: () => scheduled.map((timer) => timer.delay),
    set(fn, delay) {
      const timer = { fn, delay, cleared: false };
      scheduled.push(timer);
      return timer;
    },
    clear(timer) {
      if (timer) timer.cleared = true;
    },
    fire(index) {
      scheduled[index].fn();
    },
  };
}

function buildCollector({ settings, adb, spawner, timers, streamStates = [], events = [] }) {
  return createHuupeCollector({
    settings,
    log: silentLog(),
    onEvent: (event) => events.push(event),
    onStreamState: (state) => streamStates.push(state),
    execFileImpl: adb.impl,
    spawnImpl: spawner.impl,
    now: () => CLOCK,
    setTimerImpl: timers.set.bind(timers),
    clearTimerImpl: timers.clear.bind(timers),
  });
}

/** Fake adb replies land synchronously, so a few macrotasks drain every await. */
async function settle(rounds = 4) {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function shotLine(streamTs, zone = 'three_point_shot', event = 'make_detected') {
  return `08-27 01:25:47.347 I/ShotTracker( 2736): Get EVENT: {"stream_ts": ${streamTs}, "events": ["${event}"], "shot_zone": "${zone}", "shot_range": 3.15 }`;
}

const LAN = {
  eth0: [
    { address: '192.168.50.10', netmask: '255.255.255.0', family: 'IPv4', internal: false },
    { address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true },
  ],
};

async function withFakeLan(run) {
  const original = os.networkInterfaces;
  os.networkInterfaces = () => LAN;
  try {
    return await run();
  } finally {
    os.networkInterfaces = original;
  }
}

test('a cold start with no hoop configured waits instead of sweeping the LAN', async () => {
  // The product rule: an uninvited /24 scan on first boot is not an acceptable
  // first move, so with no saved host the collector parks and waits for an
  // explicit Discover. Auto-discovery is a recovery path, never a cold start.
  const adb = createAdbFake({ '192.168.50.7': HUUPE });
  const spawner = createSpawnFake();
  const timers = createTimerFake();
  const collector = buildCollector({
    settings: fakeSettings({ host: '' }),
    adb,
    spawner,
    timers,
  });

  collector.start();
  await settle();

  assert.deepEqual(adb.calls, []);
  assert.equal(spawner.spawns.length, 0);
  assert.deepEqual(timers.delays(), []);

  const status = collector.statusSnapshot();
  assert.equal(status.state, 'unconfigured');
  assert.equal(status.configured, false);
  assert.equal(status.connected, false);
  assert.match(status.lastError, /Discover/);

  collector.close();
});

test('a configured hoop is dialled, identified and then tailed', async () => {
  const adb = createAdbFake({ '192.168.50.7': HUUPE });
  const spawner = createSpawnFake();
  const timers = createTimerFake();
  const streamStates = [];
  const collector = buildCollector({
    settings: fakeSettings({ host: '192.168.50.7' }),
    adb,
    spawner,
    timers,
    streamStates,
  });

  collector.start();
  await settle();

  assert.deepEqual(adb.connectTargets(), ['192.168.50.7:5555']);
  assert.ok(adb.calls.some((call) => call.args.join(' ').includes('shell getprop')));
  assert.ok(adb.calls.some((call) => call.args.join(' ').includes('pm list packages')));

  const spawned = spawner.last();
  assert.equal(spawner.spawns.length, 1);
  assert.deepEqual(spawned.args.slice(0, 7), [
    '-s', '192.168.50.7:5555', 'logcat', '-v', 'threadtime', '-T', '1',
  ]);
  // Everything outside the tag allowlist is silenced so profile dumps never arrive.
  assert.equal(spawned.args.at(-1), '*:S');

  const status = collector.statusSnapshot();
  assert.equal(status.state, 'streaming');
  assert.equal(status.connected, true);
  assert.equal(status.configured, true);
  assert.equal(status.serial, '192.168.50.7:5555');
  assert.equal(status.device.model, 'Huupe Mini');
  assert.equal(status.device.persistentAdbPort, '5555');
  assert.deepEqual(streamStates.at(-1), {
    connected: true,
    reason: null,
    state: 'streaming',
    serial: '192.168.50.7:5555',
  });

  collector.close();
});

test('logcat lines split across chunk boundaries are reassembled before parsing', async () => {
  const adb = createAdbFake({ '192.168.50.7': HUUPE });
  const spawner = createSpawnFake();
  const timers = createTimerFake();
  const events = [];
  const collector = buildCollector({
    settings: fakeSettings({ host: '192.168.50.7' }),
    adb,
    spawner,
    timers,
    events,
  });

  collector.start();
  await settle();
  const { stdout } = spawner.last().child;

  const first = shotLine(101.5);
  const second = shotLine(102.75, 'layup');
  const third = shotLine(103.25, 'one_point_shot', 'miss_detected');

  // A read boundary lands mid-JSON, then a later read carries a whole line plus
  // the head of the next one.
  stdout.emit('data', first.slice(0, 40));
  assert.deepEqual(events, []);
  stdout.emit('data', `${first.slice(40)}\n${second}\n${third.slice(0, 30)}`);
  assert.equal(events.length, 2);
  stdout.emit('data', `${third.slice(30)}\n`);

  assert.deepEqual(
    events.map((event) => [event.kind, event.zone, event.made]),
    [
      ['shot', 'three', true],
      ['shot', 'layup', true],
      ['shot', 'one', false],
    ],
  );
  assert.equal(collector.statusSnapshot().counters.lines, 3);

  collector.close();
});

test('a dropped logcat stream reconnects with a growing backoff', async () => {
  const adb = createAdbFake({ '192.168.50.7': HUUPE });
  const spawner = createSpawnFake();
  const timers = createTimerFake();
  const collector = buildCollector({
    settings: fakeSettings({ host: '192.168.50.7', autoDiscover: false }),
    adb,
    spawner,
    timers,
  });

  collector.start();
  await settle();
  assert.equal(collector.statusSnapshot().state, 'streaming');

  spawner.last().child.emit('close', 1);
  assert.equal(collector.statusSnapshot().state, 'disconnected');
  assert.match(collector.statusSnapshot().lastError, /logcat exited \(1\)/);
  assert.deepEqual(timers.delays(), [3000]);

  // The hoop is now off, so every retry from here fails on the dial.
  delete adb.hosts['192.168.50.7'];
  timers.fire(0);
  await settle();
  timers.fire(1);
  await settle();

  assert.deepEqual(timers.delays(), [3000, 5000, 10000]);
  assert.equal(collector.statusSnapshot().retryInSeconds, 10);
  assert.equal(spawner.spawns.length, 1);
  // The tail is capped, so a hoop that is off all night retries hourly, not forever faster.
  assert.equal(backoffFor(99), BACKOFF_MS.at(-1));

  collector.close();
});

test('a hoop that moved is found again by a sweep and its new address is saved', async () => {
  await withFakeLan(async () => {
    const adb = createAdbFake({ '192.168.50.3': NOT_A_HUUPE, '192.168.50.7': HUUPE });
    const spawner = createSpawnFake();
    const timers = createTimerFake();
    const settings = fakeSettings({ host: '192.168.50.99', autoDiscover: true });
    const collector = buildCollector({ settings, adb, spawner, timers });

    collector.start();
    await settle(6);

    // The saved address is always tried first; the sweep is the fallback.
    assert.equal(adb.connectTargets()[0], '192.168.50.99:5555');
    assert.ok(adb.connectTargets().length > 1);
    // Something else answered on 5555 and was let go once getprop disowned it.
    assert.deepEqual(adb.disconnectTargets(), ['192.168.50.3:5555']);

    assert.deepEqual(settings.updates, [{ device: { host: '192.168.50.7' } }]);
    assert.equal(collector.statusSnapshot().state, 'streaming');
    assert.equal(collector.statusSnapshot().serial, '192.168.50.7:5555');
    assert.equal(spawner.last().args[1], '192.168.50.7:5555');

    collector.close();
  });
});

test('with auto-discovery off an unreachable hoop fails without touching other addresses', async () => {
  await withFakeLan(async () => {
    const adb = createAdbFake({ '192.168.50.7': HUUPE });
    const spawner = createSpawnFake();
    const timers = createTimerFake();
    const settings = fakeSettings({ host: '192.168.50.99', autoDiscover: false });
    const collector = buildCollector({ settings, adb, spawner, timers });

    collector.start();
    await settle();

    assert.deepEqual(adb.connectTargets(), ['192.168.50.99:5555']);
    assert.deepEqual(settings.updates, []);
    assert.equal(spawner.spawns.length, 0);
    assert.equal(collector.statusSnapshot().state, 'disconnected');
    assert.deepEqual(timers.delays(), [3000]);

    collector.close();
  });
});

test('the status snapshot reports state, whether a hoop is configured and the last error', async () => {
  const adb = createAdbFake({});
  const spawner = createSpawnFake();
  const timers = createTimerFake();
  const collector = buildCollector({
    settings: fakeSettings({ host: '192.168.50.99', autoDiscover: false }),
    adb,
    spawner,
    timers,
  });

  const cold = collector.statusSnapshot();
  assert.equal(cold.state, 'idle');
  assert.equal(cold.configured, true);
  assert.equal(cold.lastError, null);
  assert.equal(cold.serial, null);
  assert.equal(cold.retryInSeconds, null);

  collector.start();
  await settle();

  const failing = collector.statusSnapshot();
  assert.equal(failing.state, 'disconnected');
  assert.equal(failing.connected, false);
  assert.equal(failing.configured, true);
  assert.match(failing.lastError, /Connection refused/);
  assert.equal(failing.retryInSeconds, 3);
  assert.equal(failing.discovering, false);
  assert.equal(failing.counters.lines, 0);

  collector.close();
});

test('closing the collector kills the logcat child and parks the state at idle', async () => {
  const adb = createAdbFake({ '192.168.50.7': HUUPE });
  const spawner = createSpawnFake();
  const timers = createTimerFake();
  const collector = buildCollector({
    settings: fakeSettings({ host: '192.168.50.7' }),
    adb,
    spawner,
    timers,
  });

  collector.start();
  await settle();
  const { child } = spawner.last();
  assert.equal(child.killed, false);

  collector.close();

  assert.equal(child.killed, true);
  assert.equal(collector.statusSnapshot().state, 'idle');
  assert.equal(collector.statusSnapshot().connected, false);

  // A kill that arrives after the close must not restart the dial loop.
  child.emit('close', 143);
  await settle();
  assert.deepEqual(timers.delays(), []);
  assert.equal(spawner.spawns.length, 1);
});

test('closing the collector cancels a reconnect that was already pending', async () => {
  const adb = createAdbFake({});
  const spawner = createSpawnFake();
  const timers = createTimerFake();
  const collector = buildCollector({
    settings: fakeSettings({ host: '192.168.50.99', autoDiscover: false }),
    adb,
    spawner,
    timers,
  });

  collector.start();
  await settle();
  assert.equal(timers.scheduled.length, 1);
  assert.equal(timers.scheduled[0].cleared, false);

  collector.close();

  assert.equal(timers.scheduled[0].cleared, true);
  assert.equal(collector.statusSnapshot().retryInSeconds, null);

  // Even if the cancelled timer somehow fired, a closed collector stays closed.
  timers.fire(0);
  await settle();
  assert.equal(timers.scheduled.length, 1);
  assert.equal(spawner.spawns.length, 0);
});
