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
  assert.equal(board.dwellSeconds, 15);
  assert.equal(board.rateWindowSeconds, 15);
  assert.equal(board.minRotationGapSeconds, 600);
  assert.equal(board.enabled, true);
  assert.deepEqual(board.quietHours, { start: '22:00', end: '07:00', enabled: true });
  assert.equal(board.events, 'all');

  assert.equal(normaliseBoard({ name: 'no id' }), null);
  assert.equal(normaliseBoard({ id: 'x', events: [] }).events, 'all');
  assert.deepEqual(normaliseBoard({ id: 'x', events: ['broadcast', ' timers '] }).events, ['broadcast', 'timers']);
  assert.equal(normaliseBoard({ id: 'x', quietHours: null }).quietHours.enabled, false);
});

test('adding, editing and removing a board all persist', () => {
  const { root, settings } = makeSettings();

  const added = settings.upsert({ id: 'kitchen', name: 'Kitchen Board', dwellSeconds: 20 });
  assert.equal(added.ok, true);
  assert.equal(added.created, true);

  const edited = settings.upsert({ id: 'kitchen', name: 'Kitchen', dwellSeconds: 25 });
  assert.equal(edited.created, false);
  assert.equal(settings.get('kitchen').dwellSeconds, 25);

  const revived = createVestaboardSettings({ config: { ROOT: root }, log: silentLog() });
  assert.equal(revived.get('kitchen').name, 'Kitchen');

  assert.equal(settings.remove('kitchen').ok, true);
  assert.equal(settings.get('kitchen'), null);
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
    assert.deepEqual(
      h.hub.registryEntries().map((entry) => entry.id).sort(),
      ['kitchen', 'sim'],
    );
  } finally {
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
