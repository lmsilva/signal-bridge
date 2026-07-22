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
});

test('display registry persists across reload', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-reg-'));
  const first = createDisplayRegistry({ ROOT: root }, { warn() {} });
  first.upsertFromAnnounce({
    display: { id: 'disp-a', name: 'Kitchen' },
  }, { address: '10.0.0.8' });

  const second = createDisplayRegistry({ ROOT: root }, { warn() {} });
  assert.equal(second.get('disp-a').host, '10.0.0.8');
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
  const delivery = registry.resolveDelivery('missing');
  assert.match(delivery.error, /Unknown display/);
});
