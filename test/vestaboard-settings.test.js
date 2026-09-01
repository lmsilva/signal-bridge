/**
 * Board settings, the registry merge, and the hub that runs them (01 §3, §5).
 *
 * The property worth protecting here: a board is configured, not discovered.
 * It must show up in the picker with no Windows client online at all, and it
 * must never be pruned by the announce timeout that governs real displays.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createVestaboardSettings,
  normaliseBoard,
  cleanId,
} = require('../src/vestaboard/settings');
const { createVestaboardHub } = require('../src/vestaboard/index');
const { createVestaboardSimulator } = require('../src/vestaboard/simulator');
const { createTransport } = require('../src/vestaboard/transport');
const { createDisplayRegistry } = require('../src/display-registry');
const { identityFrame } = require('../src/vestaboard/formatters/signal');
const { validate, decodeCodes, CHIPS } = require('../src/vestaboard/encoder');

function silentLog() {
  const lines = [];
  const push = (level) => (message) => lines.push(`${level} ${message}`);
  return {
    lines, info: push('INFO'), warn: push('WARN'), error: push('ERROR'), debug: push('DEBUG'),
  };
}

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vb-settings-'));
}

function makeSettings(root = tempRoot()) {
  return {
    root,
    log: silentLog(),
    settings: createVestaboardSettings({ config: { ROOT: root }, log: silentLog() }),
  };
}

test('a board id is cleaned into something safe for urls and files', () => {
  assert.equal(cleanId('Kitchen Board'), 'kitchen-board');
  assert.equal(cleanId('  SIM  '), 'sim');
  assert.equal(cleanId('a//b..c'), 'a-b-c');
  assert.equal(cleanId(''), '');
});

test('a half-filled board comes back with everything a queue needs', () => {
  const board = normaliseBoard({ id: 'kitchen', name: 'Kitchen' });
  assert.equal(board.rateWindowSeconds, 15);
  assert.equal(board.minRotationGapSeconds, 600);
  assert.equal(board.enabled, true);
  assert.equal(board.dwellSeconds, undefined);
  assert.equal(board.priorities, undefined);
  assert.deepEqual(board.quietHours, {
    start: '22:00',
    end: '07:00',
    enabled: true,
    remindOnStart: true,
  });
  assert.equal(board.events, 'all');

  assert.equal(normaliseBoard({ name: 'no id' }), null);
  assert.equal(normaliseBoard({ id: 'x', events: [] }).events, 'all');
  assert.deepEqual(normaliseBoard({ id: 'x', events: ['broadcast', ' timers '] }).events, ['broadcast', 'timers']);
  assert.equal(normaliseBoard({ id: 'x', quietHours: null }).quietHours.enabled, false);
});

test('adding, editing and removing a board all persist', () => {
  const { root, settings } = makeSettings();

  const added = settings.upsert({ id: 'kitchen', name: 'Kitchen Board' });
  assert.equal(added.ok, true);
  assert.equal(added.created, true);

  const edited = settings.upsert({ id: 'kitchen', name: 'Kitchen' });
  assert.equal(edited.created, false);
  assert.equal(settings.get('kitchen').name, 'Kitchen');

  const revived = createVestaboardSettings({ config: { ROOT: root }, log: silentLog() });
  assert.equal(revived.get('kitchen').name, 'Kitchen');

  assert.equal(settings.remove('kitchen').ok, true);
  assert.equal(settings.get('kitchen'), null);
});

test('house dwell and priorities persist; a board upsert does not clobber them', () => {
  const { root, settings } = makeSettings();
  assert.equal(settings.house().dwellSeconds, 15);
  assert.ok(settings.house().priorities.some((rule) => rule.source === 'alarm.fired'));

  settings.setHouse({
    dwellSeconds: 45,
    priorities: [
      { source: 'huupe.session', jump: true, hold: true, holdMinutes: 20 },
    ],
  });
  assert.equal(settings.house().dwellSeconds, 45);
  assert.deepEqual(settings.house().priorities.map((rule) => rule.source), ['huupe.session']);

  settings.upsert({ id: 'kitchen', name: 'Kitchen' });
  assert.equal(settings.house().dwellSeconds, 45);
  assert.deepEqual(settings.house().priorities.map((rule) => rule.source), ['huupe.session']);

  settings.setHouse({ dwellSeconds: 30 });
  assert.equal(settings.house().dwellSeconds, 30);
  assert.deepEqual(settings.house().priorities.map((rule) => rule.source), ['huupe.session']);

  const revived = createVestaboardSettings({ config: { ROOT: root }, log: silentLog() });
  assert.equal(revived.house().dwellSeconds, 30);
  assert.deepEqual(revived.house().priorities.map((rule) => rule.source), ['huupe.session']);
});

test('legacy per-board dwell and priorities migrate onto the house', () => {
  const root = tempRoot();
  const filePath = path.join(root, 'data', 'vestaboard-settings.json');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify({
    boards: [{
      id: 'sim',
      name: 'Simulator',
      simulator: true,
      dwellSeconds: 40,
      priorities: [{ source: 'alarm.fired', jump: true, hold: false, holdMinutes: 15 }],
    }],
  }, null, 2)}\n`);

  const settings = createVestaboardSettings({ config: { ROOT: root }, log: silentLog() });
  assert.equal(settings.house().dwellSeconds, 40);
  assert.deepEqual(settings.house().priorities.map((rule) => rule.source), ['alarm.fired']);
  assert.equal(settings.get('sim').dwellSeconds, undefined);
});

test('a key is stored encrypted and never sits in the config in the clear', () => {
  const { root, settings } = makeSettings();
  settings.upsert({ id: 'kitchen', name: 'Kitchen', key: 'super-secret-key' });

  const onDisk = fs.readFileSync(settings.filePath, 'utf8');
  assert.ok(!onDisk.includes('super-secret-key'), 'the key must not be readable on disk');
  assert.equal(settings.keyFor('kitchen'), 'super-secret-key');
  assert.equal(settings.hasKey('kitchen'), true);

  const revived = createVestaboardSettings({ config: { ROOT: root }, log: silentLog() });
  assert.equal(revived.keyFor('kitchen'), 'super-secret-key', 'and survives a restart');
});

test('an environment variable beats the stored key', () => {
  const root = tempRoot();
  const env = { KITCHEN_BOARD_KEY: 'from-the-environment' };
  const settings = createVestaboardSettings({ config: { ROOT: root }, log: silentLog(), env });

  settings.upsert({ id: 'kitchen', name: 'Kitchen', key: 'from-the-file', tokenEnv: 'KITCHEN_BOARD_KEY' });
  assert.equal(settings.keyFor('kitchen'), 'from-the-environment');
});

test('the board list is published without any keys attached', () => {
  const { settings } = makeSettings();
  settings.upsert({ id: 'kitchen', name: 'Kitchen', key: 'secret' });

  const published = JSON.stringify(settings.list());
  assert.ok(!published.includes('secret'));
});

test('the simulator ships registered and cannot be deleted by accident', () => {
  const { settings } = makeSettings();
  settings.seedSimulator({ port: 7000 });

  const sim = settings.get('sim');
  assert.equal(sim.simulator, true);
  assert.equal(sim.enabled, true);
  assert.equal(sim.baseUrl, 'http://127.0.0.1:7000');

  const removed = settings.remove('sim');
  assert.equal(removed.ok, false);
  assert.match(removed.error, /switch it off/);

  // Switching it off is the supported way to hide it.
  assert.equal(settings.setEnabled('sim', false).ok, true);
  assert.equal(settings.get('sim').enabled, false);
});

test('the simulator address follows its configured port', () => {
  const { settings } = makeSettings();
  settings.seedSimulator({ port: 7000 });
  settings.seedSimulator({ port: 7100 });
  assert.equal(settings.get('sim').baseUrl, 'http://127.0.0.1:7100');
});

test('settings changes are announced so the queues can follow them', () => {
  const { settings } = makeSettings();
  const seen = [];
  settings.onChange((reason) => seen.push(reason));

  settings.upsert({ id: 'kitchen', name: 'Kitchen' });
  settings.upsert({ id: 'kitchen', name: 'Kitchen Two' });
  settings.setKey('kitchen', 'k');
  settings.remove('kitchen');

  assert.deepEqual(seen, ['add', 'update', 'key', 'remove']);
});

test('boards appear in the picker even when no windows client is online', () => {
  const root = tempRoot();
  const registry = createDisplayRegistry(
    { ROOT: root },
    silentLog(),
    { staticEntries: () => [{ id: 'sim', name: 'Vestaboard Simulator', enabled: true, health: 'ok' }] },
  );

  const list = registry.list();
  assert.equal(list.length, 1, 'zero full displays and one board is a real state');
  assert.equal(list[0].kind, 'vestaboard');
  assert.equal(list[0].id, 'sim');
  registry.stop();
});

test('an announced display reads as a full display', () => {
  const root = tempRoot();
  const registry = createDisplayRegistry({ ROOT: root }, silentLog());
  registry.upsertFromAnnounce(
    { display: { id: 'disp-1', name: 'Theater PC', port: 47832 } },
    { address: '192.168.1.50' },
  );

  assert.equal(registry.list()[0].kind, 'full');
  registry.stop();
});

test('a board is never pruned by the announce timeout', () => {
  const root = tempRoot();
  const registry = createDisplayRegistry(
    { ROOT: root },
    silentLog(),
    { staticEntries: () => [{ id: 'sim', name: 'Simulator', enabled: true }] },
  );
  registry.upsertFromAnnounce(
    { display: { id: 'disp-1', name: 'Theater PC', port: 47832 } },
    { address: '192.168.1.50' },
  );

  // Well past the point where a silent Windows client is dropped.
  registry.pruneStale(Date.now() + 60 * 60 * 1000);

  const ids = registry.list({ skipPrune: true }).map((entry) => entry.id);
  assert.deepEqual(ids, ['sim'], 'the client is gone, the board stays');
  registry.stop();
});

test('a disabled board disappears from the picker', () => {
  const root = tempRoot();
  let enabled = true;
  const registry = createDisplayRegistry(
    { ROOT: root },
    silentLog(),
    { staticEntries: () => [{ id: 'sim', name: 'Simulator', enabled }] },
  );

  assert.equal(registry.list().length, 1);
  enabled = false;
  assert.equal(registry.list().length, 0);
  registry.stop();
});

test('a board is not something the UDP path will try to reach', () => {
  const root = tempRoot();
  const registry = createDisplayRegistry(
    { ROOT: root },
    silentLog(),
    { staticEntries: () => [{ id: 'sim', name: 'Simulator', enabled: true }] },
  );

  const delivery = registry.resolveDelivery('sim');
  assert.equal(delivery.kind, 'vestaboard');
  assert.equal(delivery.error, undefined);
  assert.deepEqual(delivery.sendOptions, {});
  assert.deepEqual(delivery.target, { id: 'sim' });

  // And a push to everything never tries to unicast at it.
  registry.upsertFromAnnounce(
    { display: { id: 'disp-1', name: 'Theater PC', port: 47832 } },
    { address: '192.168.1.50' },
  );
  const all = registry.resolveDelivery('all');
  assert.deepEqual(all.sendOptions.hosts, ['192.168.1.50']);
  registry.stop();
});

test('the identity frame says which board answered and shows every colour', () => {
  const frame = identityFrame({ name: 'KITCHEN BOARD' });
  assert.equal(validate(frame.rows).ok, true);

  const text = frame.rows.map((row) => decodeCodes(row));
  assert.match(text[0], /SIGNAL BRIDGE/);
  assert.match(text[2], /VESTABOARD LINKED/);
  assert.match(text[3], /KITCHEN BOARD - OK/);

  const parade = frame.rows[5].filter((code) => code >= CHIPS.red);
  assert.equal(parade.length, 14, 'every colour, twice');
  assert.deepEqual(
    frame.rows[5].slice(1, 8),
    [CHIPS.red, CHIPS.orange, CHIPS.yellow, CHIPS.green, CHIPS.blue, CHIPS.violet, CHIPS.white],
  );
});

test('a board name too long for the row is cut rather than overflowing', () => {
  const frame = identityFrame({ name: 'A VERY LONG BOARD NAME INDEED' });
  assert.equal(validate(frame.rows).ok, true);
});

/** A hub with a live simulator behind it. */
async function makeHub() {
  const root = tempRoot();
  const config = {
    ROOT: root,
    vestaboardSimulator: { port: 0, host: '127.0.0.1', rateWindowSeconds: 0 },
  };
  const log = silentLog();
  const simulator = createVestaboardSimulator({ config, log });
  await simulator.start();

  const hub = createVestaboardHub({ config, log, simulator });
  await hub.start();

  return {
    hub,
    simulator,
    log,
    root,
    async stop() {
      hub.stop();
      await simulator.stop();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test('the hub adopts the simulator by walking its enablement handshake', async () => {
  const h = await makeHub();
  try {
    assert.equal(h.hub.settings.hasKey('sim'), true, 'the key came from the endpoint, not a shortcut');
    assert.equal(h.hub.settings.keyFor('sim'), h.simulator.apiKey());

    const entries = h.hub.registryEntries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, 'vestaboard');
    assert.equal(entries[0].health, 'ok');
    assert.equal(entries[0].hasKey, true);
  } finally {
    await h.stop();
  }
});

test('a test flip puts the identity frame on the board', async () => {
  const h = await makeHub();
  try {
    const outcome = await h.hub.testFlip('sim');
    assert.equal(outcome.ok, true);

    const shown = h.simulator.state().current;
    assert.deepEqual(shown, identityFrame({ name: 'Vestaboard Simulator' }).rows);
  } finally {
    await h.stop();
  }
});

test('a second boot re-enables the simulator so a stale stored key cannot wedge the queue', async () => {
  const h = await makeHub();
  try {
    h.hub.settings.setKey('sim', 'stale-wrong-key');
    h.hub.stop();

    const hub2 = createVestaboardHub({
      config: { ROOT: h.root, vestaboardSimulator: { port: 0, host: '127.0.0.1', rateWindowSeconds: 0 } },
      log: silentLog(),
      simulator: h.simulator,
    });
    await hub2.start();
    try {
      assert.equal(hub2.settings.keyFor('sim'), h.simulator.apiKey());
      const outcome = await hub2.testFlip('sim');
      assert.equal(outcome.ok, true);
      assert.deepEqual(
        h.simulator.state().current,
        identityFrame({ name: 'Vestaboard Simulator' }).rows,
      );
    } finally {
      hub2.stop();
    }
  } finally {
    await h.stop();
  }
});

test('a restart waits out the simulator rate window instead of posting a 503', async () => {
  let clock = 1_700_000_000_000;
  const now = () => clock;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-rate-'));
  const config = {
    ROOT: root,
    vestaboardSimulator: { port: 0, host: '127.0.0.1', rateWindowSeconds: 15 },
  };
  const log = silentLog();
  const simulator = createVestaboardSimulator({ config, log, now });
  await simulator.start();
  const hub = createVestaboardHub({ config, log, simulator, now });
  await hub.start();
  try {
    assert.equal((await hub.testFlip('sim')).ok, true);
    hub.stop();

    const hub2 = createVestaboardHub({ config, log, simulator, now });
    await hub2.start();
    try {
      const other = Array.from({ length: 6 }, () => new Array(22).fill(0));
      other[0][0] = 1;
      hub2.submit('sim', [{ rows: other, dwellSeconds: 15, label: 'NEXT' }], {
        quietHoursExempt: true,
      });
      assert.equal(await hub2.queueFor('sim').tick(), null);
      assert.equal(
        simulator.calls().some((entry) => entry.result === '503 rate'),
        false,
        'the queue must not probe the Local API while flaps are still moving',
      );
      clock += 15_000;
      assert.equal(await hub2.queueFor('sim').tick(), 'posted');
    } finally {
      hub2.stop();
    }
  } finally {
    hub.stop();
    await simulator.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a test flip at an unknown or disabled board says so plainly', async () => {
  const h = await makeHub();
  try {
    assert.match((await h.hub.testFlip('nope')).error, /not enabled/);

    h.hub.settings.setEnabled('sim', false);
    assert.match((await h.hub.testFlip('sim')).error, /not enabled/);
  } finally {
    await h.stop();
  }
});

test('switching a board off stops its queue, and on starts it again', async () => {
  const h = await makeHub();
  try {
    assert.equal(h.hub.queueFor('sim') !== null, true);

    h.hub.settings.setEnabled('sim', false);
    assert.equal(h.hub.queueFor('sim'), null, 'no queue for a board that is off');
    assert.equal(h.hub.registryEntries()[0].health, 'offline');

    h.hub.settings.setEnabled('sim', true);
    assert.equal(h.hub.queueFor('sim') !== null, true, 'live, with no restart');
  } finally {
    await h.stop();
  }
});

test('a new board starts running the moment it is saved', async () => {
  const h = await makeHub();
  try {
    h.hub.settings.upsert({
      id: 'kitchen',
      name: 'Kitchen Board',
      baseUrl: 'http://127.0.0.1:1',
      key: 'a-key',
    });

    assert.equal(h.hub.queueFor('kitchen') !== null, true);
    assert.equal(h.hub.queueFor('kitchen'), h.hub.queueFor('sim'), 'one house queue');
    assert.deepEqual(
      h.hub.registryEntries().map((entry) => entry.id).sort(),
      ['kitchen', 'sim'],
    );
  } finally {
    await h.stop();
  }
});

test('a house push still flips the simulator when another board is unreachable', async () => {
  const h = await makeHub();
  try {
    h.hub.settings.upsert({
      id: 'kitchen',
      name: 'Kitchen Board',
      baseUrl: 'http://127.0.0.1:1',
      key: 'a-key',
    });
    h.hub.settings.upsert({ id: 'sim', quietHours: null, rateWindowSeconds: 0 });
    h.hub.settings.setHouse({ dwellSeconds: 15 });
    const outcome = h.hub.pushEvent(weatherPayload(), { targetId: 'kitchen', explicit: true });
    assert.ok(outcome.boards.some((row) => row.accepted > 0));
    await waitForFlip(h);
    assert.ok(hasFace(h.simulator.state().current), 'the simulator still flipped');
  } finally {
    await h.stop();
  }
});

function hasFace(rows) {
  return Array.isArray(rows) && rows.some((row) => Array.isArray(row) && row.some(Boolean));
}

async function waitForFlip(h, { kitchenSim = null } = {}) {
  const queue = h.hub.queueFor('sim');
  for (let i = 0; i < 20; i += 1) {
    if (hasFace(h.simulator.state().current) || hasFace(kitchenSim?.state()?.current)) {
      return;
    }
    await queue?.tick();
  }
}

function weatherPayload() {
  return {
    type: 'weather.query',
    weather: {
      current: { temperatureF: 72, condition: 'sunny' },
      next7Days: [{ date: '2026-08-24', highF: 80, lowF: 60, condition: 'sunny' }],
    },
  };
}

async function attachKitchen(h) {
  const kitchenRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-kitchen-'));
  const kitchenSim = createVestaboardSimulator({
    config: {
      ROOT: kitchenRoot,
      vestaboardSimulator: { port: 0, host: '127.0.0.1', rateWindowSeconds: 0 },
    },
    log: silentLog(),
  });
  await kitchenSim.start();
  const port = kitchenSim.address()?.port || kitchenSim.port;
  const transport = createTransport({ baseUrl: `http://127.0.0.1:${port}` });
  const enabled = await transport.enable(kitchenSim.enablementToken());
  h.hub.settings.upsert({
    id: 'kitchen',
    name: 'Kitchen',
    baseUrl: `http://127.0.0.1:${port}`,
    key: enabled.apiKey,
    quietHours: null,
  });
  h.hub.settings.upsert({ id: 'sim', quietHours: null, rateWindowSeconds: 0 });
  return {
    kitchenSim,
    kitchenRoot,
    async stop() {
      await kitchenSim.stop();
      fs.rmSync(kitchenRoot, { recursive: true, force: true });
    },
  };
}

test('every enabled board receives the same posted house page', async () => {
  const h = await makeHub();
  const kitchen = await attachKitchen(h);
  try {
    const outcome = h.hub.pushEvent(weatherPayload(), { targetId: 'kitchen', explicit: true });
    assert.ok(outcome.boards.some((row) => row.accepted > 0));
    await waitForFlip(h, { kitchenSim: kitchen.kitchenSim });
    const shown = h.simulator.state().current;
    assert.ok(hasFace(shown), 'the simulator flipped');
    assert.deepEqual(kitchen.kitchenSim.state().current, shown);
  } finally {
    await kitchen.stop();
    await h.stop();
  }
});

test('one board 503 does not drop the house page', async () => {
  const h = await makeHub();
  const kitchen = await attachKitchen(h);
  try {
    kitchen.kitchenSim.setOnline(false);
    const outcome = h.hub.pushEvent(weatherPayload(), { targetId: 'sim', explicit: true });
    assert.ok(outcome.boards.some((row) => row.accepted > 0));
    await waitForFlip(h);
    const shown = h.simulator.state().current;
    assert.ok(hasFace(shown), 'the house still flipped the live board');
    assert.notDeepEqual(
      kitchen.kitchenSim.state().current,
      shown,
      'the offline board must not have taken the house page',
    );
  } finally {
    await kitchen.stop();
    await h.stop();
  }
});

test('the hub survives having no simulator at all', async () => {
  const root = tempRoot();
  const hub = createVestaboardHub({ config: { ROOT: root }, log: silentLog(), simulator: null });
  await hub.start();
  try {
    assert.deepEqual(hub.registryEntries(), []);
    assert.match((await hub.testFlip('sim')).error, /not enabled/);
  } finally {
    hub.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
