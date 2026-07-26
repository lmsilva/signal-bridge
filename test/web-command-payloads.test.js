const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildWebOpenPayload,
  buildWebClosePayload,
  buildSystemCommandPayload,
  buildQrDisplayPayload,
  buildWifiQrContent,
  buildInputTextPayload,
  buildPhotoSlideshowPayload,
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

test('buildWifiQrContent builds standard WPA QR string', () => {
  const content = buildWifiQrContent({ ssid: 'Home Network', password: 'sup3r;secret' });
  assert.equal(content, 'WIFI:T:WPA;S:Home Network;P:sup3r\\;secret;;');
});

test('buildWifiQrContent escapes special characters in ssid/password', () => {
  const content = buildWifiQrContent({ ssid: 'Bob\'s Wi-Fi, Guest', password: 'a\\b:c' });
  assert.equal(content, 'WIFI:T:WPA;S:Bob\'s Wi-Fi\\, Guest;P:a\\\\b\\:c;;');
});

test('buildWifiQrContent omits password for open networks', () => {
  const content = buildWifiQrContent({ ssid: 'Free WiFi', security: 'nopass' });
  assert.equal(content, 'WIFI:T:nopass;S:Free WiFi;;');
});

test('buildWifiQrContent marks hidden networks', () => {
  const content = buildWifiQrContent({ ssid: 'Hidden', password: 'pw', hidden: true });
  assert.equal(content, 'WIFI:T:WPA;S:Hidden;P:pw;H:true;;');
});

test('buildWifiQrContent rejects a missing ssid', () => {
  assert.equal(buildWifiQrContent({ password: 'pw' }), null);
  assert.equal(buildWifiQrContent({}), null);
});

test('buildQrDisplayPayload builds url and wifi QR payloads', () => {
  const urlPayload = buildQrDisplayPayload({
    qrType: 'url',
    content: 'https://example.com',
    label: 'Example',
  }, config);
  assert.equal(urlPayload.version, 2);
  assert.equal(urlPayload.type, 'qr.display');
  assert.equal(urlPayload.device, 'Signal');
  assert.equal(urlPayload.trigger, 'qr-api');
  assert.equal(urlPayload.qr.qrType, 'url');
  assert.equal(urlPayload.qr.content, 'https://example.com');
  assert.equal(urlPayload.qr.label, 'Example');
  assert.ok(urlPayload.displaySeconds >= 15);

  const wifiContent = buildWifiQrContent({ ssid: 'Home', password: 'pw' });
  const wifiPayload = buildQrDisplayPayload({
    qrType: 'wifi',
    content: wifiContent,
    label: 'Wi-Fi: Home',
    device: 'iPhone',
  }, config);
  assert.equal(wifiPayload.type, 'qr.display');
  assert.equal(wifiPayload.device, 'iPhone');
  assert.equal(wifiPayload.qr.qrType, 'wifi');
  assert.equal(wifiPayload.qr.content, wifiContent);
});

test('buildQrDisplayPayload rejects unknown types and empty content', () => {
  assert.equal(buildQrDisplayPayload({ qrType: 'image', content: 'x' }, config), null);
  assert.equal(buildQrDisplayPayload({ qrType: 'url', content: '' }, config), null);
  assert.equal(buildQrDisplayPayload({}, config), null);
});

test('buildInputTextPayload builds a full-string keyboard command', () => {
  const payload = buildInputTextPayload({ value: 'hunter2', pressEnter: true, device: 'iPhone' });
  assert.equal(payload.version, 2);
  assert.equal(payload.type, 'input.text');
  assert.equal(payload.device, 'iPhone');
  assert.equal(payload.displaySeconds, 0);
  assert.equal(payload.trigger, 'web-api');
  assert.equal(payload.text.value, 'hunter2');
  assert.equal(payload.text.pressEnter, true);
});

test('buildInputTextPayload defaults pressEnter to false and device to Signal', () => {
  const payload = buildInputTextPayload({ value: 'https://example.com' });
  assert.equal(payload.device, 'Signal');
  assert.equal(payload.text.pressEnter, false);
});

test('buildInputTextPayload rejects empty/missing text', () => {
  assert.equal(buildInputTextPayload({ value: '' }), null);
  assert.equal(buildInputTextPayload({}), null);
});

test('buildPhotoSlideshowPayload builds a slideshow spanning all photos', () => {
  const photos = ['https://nas/qr-images/a.jpg', 'https://nas/qr-images/b.jpg', 'https://nas/qr-images/c.jpg'];
  const payload = buildPhotoSlideshowPayload({ photos, device: 'iPhone' });
  assert.equal(payload.version, 2);
  assert.equal(payload.type, 'photo.slideshow');
  assert.equal(payload.device, 'iPhone');
  assert.equal(payload.trigger, 'photo-slideshow-api');
  assert.deepEqual(payload.slideshow.photos, photos);
  assert.equal(payload.slideshow.secondsPerPhoto, 5);
  // 3 photos * 5s each — the client should not auto-dismiss partway through.
  assert.equal(payload.displaySeconds, 15);
});

test('buildPhotoSlideshowPayload honors a custom secondsPerPhoto and filters blanks', () => {
  const payload = buildPhotoSlideshowPayload({
    photos: ['https://nas/a.jpg', '', '  ', 'https://nas/b.jpg'],
    secondsPerPhoto: 8,
  });
  assert.deepEqual(payload.slideshow.photos, ['https://nas/a.jpg', 'https://nas/b.jpg']);
  assert.equal(payload.slideshow.secondsPerPhoto, 8);
  assert.equal(payload.displaySeconds, 16);
});

test('buildPhotoSlideshowPayload rejects an empty photo list', () => {
  assert.equal(buildPhotoSlideshowPayload({ photos: [] }), null);
  assert.equal(buildPhotoSlideshowPayload({ photos: ['', '  '] }), null);
  assert.equal(buildPhotoSlideshowPayload({}), null);
});
