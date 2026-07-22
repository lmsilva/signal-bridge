const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createDisplayRegistry,
  attachTarget,
  ALL_TARGET_ID,
} = require('../src/display-registry');
const {
  buildDisplayDiscoverPayload,
  buildInputPointerPayload,
  buildInputKeyPayload,
} = require('../src/udp-payload');

test('display registry upserts announce and resolves unicast delivery', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-reg-'));
  const registry = createDisplayRegistry({ ROOT: root }, { warn() {}, info() {} });
  try {
    const entry = registry.upsertFromAnnounce({
      type: 'display.announce',
      display: { id: 'disp-1', name: 'Poster', port: 47832 },
    }, { address: '192.168.1.50', port: 50000 });

    assert.equal(entry.host, '192.168.1.50');
    assert.equal(registry.get('disp-1').name, 'Poster');

    const list = registry.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].stale, false);

    const delivery = registry.resolveDelivery('disp-1');
    assert.equal(delivery.isAll, false);
    assert.equal(delivery.sendOptions.host, '192.168.1.50');
    assert.deepEqual(delivery.target, { id: 'disp-1' });

    const all = registry.resolveDelivery(ALL_TARGET_ID);
    assert.equal(all.isAll, true);
    assert.deepEqual(all.target, { all: true });
    assert.deepEqual(all.sendOptions, {});
  } finally {
    registry.stop();
  }
});

test('display registry persists across reload', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-reg-'));
  const first = createDisplayRegistry({ ROOT: root }, { warn() {} });
  try {
    first.upsertFromAnnounce({
      display: { id: 'disp-a', name: 'Kitchen' },
    }, { address: '10.0.0.8' });
  } finally {
    first.stop();
  }

  const second = createDisplayRegistry({ ROOT: root }, { warn() {} });
  try {
    assert.equal(second.get('disp-a').host, '10.0.0.8');
  } finally {
    second.stop();
  }
});

test('attachTarget adds target block without mutating original', () => {
  const payload = { version: 2, type: 'web.close' };
  const out = attachTarget(payload, { id: 'disp-1' });
  assert.equal(payload.target, undefined);
  assert.deepEqual(out.target, { id: 'disp-1' });
});

test('discover and input payload builders', () => {
  const discover = buildDisplayDiscoverPayload({}, { udpBroadcast: { discoveryPort: 47833 } });
  assert.equal(discover.type, 'display.discover');
  assert.equal(discover.discovery?.port, 47833);

  const pointer = buildInputPointerPayload({ dx: 3, dy: -2, buttons: { left: 'click' } });
  assert.equal(pointer.type, 'input.pointer');
  assert.equal(pointer.pointer.dx, 3);
  assert.equal(pointer.pointer.buttons.left, 'click');

  const key = buildInputKeyPayload({ key: 'F4', modifiers: ['alt', 'win'] });
  assert.equal(key.type, 'input.key');
  assert.equal(key.key.key, 'F4');
  assert.deepEqual(key.key.modifiers, ['alt', 'meta']);

  assert.equal(buildInputKeyPayload({ key: '' }), null);
});

test('resolveDelivery errors when display unknown', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-reg-'));
  const registry = createDisplayRegistry({ ROOT: root }, { warn() {} });
  try {
    const delivery = registry.resolveDelivery('missing');
    assert.match(delivery.error, /Unknown display/);
  } finally {
    registry.stop();
  }
});

test('duplicate display names get disambiguated labels but unique ids', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-reg-'));
  const registry = createDisplayRegistry({ ROOT: root }, { warn() {} });
  try {
    registry.upsertFromAnnounce({
      display: { id: 'disp-aaaa1111', name: 'Poster Display', shortId: '1111' },
    }, { address: '192.168.0.1' });
    registry.upsertFromAnnounce({
      display: { id: 'disp-bbbb2222', name: 'Poster Display', shortId: '2222' },
    }, { address: '192.168.0.2' });

    const list = registry.list();
    assert.equal(list.length, 2);
    assert.equal(list[0].name, 'Poster Display');
    assert.equal(list[1].name, 'Poster Display');
    assert.notEqual(list[0].id, list[1].id);
    assert.match(list[0].label, /Poster Display · /);
    assert.match(list[1].label, /Poster Display · /);
    assert.notEqual(list[0].label, list[1].label);

    const d1 = registry.resolveDelivery('disp-aaaa1111');
    const d2 = registry.resolveDelivery('disp-bbbb2222');
    assert.equal(d1.sendOptions.host, '192.168.0.1');
    assert.equal(d2.sendOptions.host, '192.168.0.2');
  } finally {
    registry.stop();
  }
});

test('registry removes displays that miss re-announce', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-reg-'));
  const file = path.join(root, 'data', 'displays-registry.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const oldSeen = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  fs.writeFileSync(file, `${JSON.stringify({
    displays: [{
      id: 'disp-old',
      name: 'Gone',
      host: '1.2.3.4',
      port: 47832,
      lastSeen: oldSeen,
    }, {
      id: 'disp-fresh',
      name: 'Alive',
      host: '1.2.3.5',
      port: 47832,
      lastSeen: new Date().toISOString(),
    }],
  }, null, 2)}\n`);

  const registry = createDisplayRegistry({ ROOT: root }, { warn() {}, info() {} });
  try {
    const list = registry.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'disp-fresh');
    assert.equal(registry.get('disp-old'), null);
  } finally {
    registry.stop();
  }
});
