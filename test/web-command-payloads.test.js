const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildWebOpenPayload,
  buildWebClosePayload,
  buildSystemCommandPayload,
} = require('../src/udp-payload');

const config = { udpBroadcast: { defaultDisplaySeconds: 120 } };

test('buildWebOpenPayload builds persistent payload with normalized url', () => {
  const payload = buildWebOpenPayload({ url: '  https://play.autodarts.io/board/abc  ' }, config);

  assert.equal(payload.version, 2);
  assert.equal(payload.type, 'web.open');
  assert.equal(payload.persistent, true);
  assert.equal(payload.displaySeconds, 0);
  assert.equal(payload.device, 'Signal');
  assert.equal(payload.trigger, 'web-api');
  assert.equal(payload.web.url, 'https://play.autodarts.io/board/abc');
  assert.equal(payload.web.errorDisplaySeconds, 30);
});

test('buildWebOpenPayload caps error display window at config default', () => {
  const payload = buildWebOpenPayload(
    { url: 'http://example.com' },
    { udpBroadcast: { defaultDisplaySeconds: 20 } },
  );
  assert.equal(payload.web.errorDisplaySeconds, 20);
});

test('buildWebOpenPayload rejects non-http urls', () => {
  assert.equal(buildWebOpenPayload({ url: 'ftp://example.com' }, config), null);
  assert.equal(buildWebOpenPayload({ url: 'javascript:alert(1)' }, config), null);
  assert.equal(buildWebOpenPayload({ url: '' }, config), null);
  assert.equal(buildWebOpenPayload({}, config), null);
});

test('buildWebClosePayload builds close command', () => {
  const payload = buildWebClosePayload({ device: 'iPhone' }, config);

  assert.equal(payload.version, 2);
  assert.equal(payload.type, 'web.close');
  assert.equal(payload.device, 'iPhone');
  assert.equal(payload.trigger, 'web-api');
});

test('buildSystemCommandPayload builds reboot and poweroff', () => {
  const reboot = buildSystemCommandPayload({ action: 'reboot' }, config);
  assert.equal(reboot.type, 'system.command');
  assert.equal(reboot.system.action, 'reboot');

  const poweroff = buildSystemCommandPayload({ action: ' PowerOff ' }, config);
  assert.equal(poweroff.system.action, 'poweroff');
});

test('buildSystemCommandPayload rejects unknown actions', () => {
  assert.equal(buildSystemCommandPayload({ action: 'format-c' }, config), null);
  assert.equal(buildSystemCommandPayload({}, config), null);
});
