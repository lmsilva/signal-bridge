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
  buildRoutePlannerPayload,
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

test('buildQrDisplayPayload builds url, wifi, and photo QR payloads', () => {
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

  const photoPayload = buildQrDisplayPayload({
    qrType: 'photo',
    content: 'https://nas/qr-images/abc.jpg',
    label: 'Scan to save this photo',
  }, config);
  assert.equal(photoPayload.type, 'qr.display');
  assert.equal(photoPayload.qr.qrType, 'photo');
  assert.equal(photoPayload.qr.content, 'https://nas/qr-images/abc.jpg');
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

test('buildPhotoSlideshowPayload builds a slideshow spanning all photos (bare URL strings)', () => {
  const photos = ['https://nas/qr-images/a.jpg', 'https://nas/qr-images/b.jpg', 'https://nas/qr-images/c.jpg'];
  const payload = buildPhotoSlideshowPayload({ photos, device: 'iPhone' });
  assert.equal(payload.version, 2);
  assert.equal(payload.type, 'photo.slideshow');
  assert.equal(payload.device, 'iPhone');
  assert.equal(payload.trigger, 'photo-slideshow-api');
  // Bare strings normalize to {url, uploadedAt: null}; with no timestamps to
  // sort by, incoming order is preserved (stable sort, all keys tie at 0).
  assert.deepEqual(payload.slideshow.photos, photos.map((url) => ({ url, uploadedAt: null })));
  assert.equal(payload.slideshow.secondsPerPhoto, 5);
  // 3 photos * 5s each — the client should not auto-dismiss partway through.
  assert.equal(payload.displaySeconds, 15);
});

test('buildPhotoSlideshowPayload accepts {url, uploadedAt} objects and orders by the requested setting', () => {
  const photos = [
    { url: 'https://nas/a.jpg', uploadedAt: '2026-01-01T00:00:00.000Z' },
    { url: 'https://nas/b.jpg', uploadedAt: '2026-01-03T00:00:00.000Z' },
    { url: 'https://nas/c.jpg', uploadedAt: '2026-01-02T00:00:00.000Z' },
  ];

  const recent = buildPhotoSlideshowPayload({ photos, order: 'recent' });
  assert.deepEqual(recent.slideshow.photos.map((p) => p.url), ['https://nas/b.jpg', 'https://nas/c.jpg', 'https://nas/a.jpg']);

  const oldest = buildPhotoSlideshowPayload({ photos, order: 'oldest' });
  assert.deepEqual(oldest.slideshow.photos.map((p) => p.url), ['https://nas/a.jpg', 'https://nas/c.jpg', 'https://nas/b.jpg']);

  // Default (no order given) behaves like 'recent'.
  const noOrder = buildPhotoSlideshowPayload({ photos });
  assert.deepEqual(noOrder.slideshow.photos.map((p) => p.url), ['https://nas/b.jpg', 'https://nas/c.jpg', 'https://nas/a.jpg']);

  const queued = buildPhotoSlideshowPayload({ photos, order: 'queued' });
  assert.deepEqual(queued.slideshow.photos.map((p) => p.url), [
    'https://nas/a.jpg', 'https://nas/b.jpg', 'https://nas/c.jpg',
  ]);

  const random = buildPhotoSlideshowPayload({ photos, order: 'random' });
  assert.deepEqual(
    [...random.slideshow.photos.map((p) => p.url)].sort(),
    ['https://nas/a.jpg', 'https://nas/b.jpg', 'https://nas/c.jpg'],
  );
});

test('buildPhotoSlideshowPayload honors a custom secondsPerPhoto and filters blanks', () => {
  const payload = buildPhotoSlideshowPayload({
    photos: ['https://nas/a.jpg', '', '  ', 'https://nas/b.jpg'],
    secondsPerPhoto: 8,
  });
  assert.deepEqual(payload.slideshow.photos.map((p) => p.url), ['https://nas/a.jpg', 'https://nas/b.jpg']);
  assert.equal(payload.slideshow.secondsPerPhoto, 8);
  assert.equal(payload.displaySeconds, 16);
});

test('buildPhotoSlideshowPayload rejects an empty photo list', () => {
  assert.equal(buildPhotoSlideshowPayload({ photos: [] }), null);
  assert.equal(buildPhotoSlideshowPayload({ photos: ['', '  '] }), null);
  assert.equal(buildPhotoSlideshowPayload({}), null);
});

const ORIGIN = { resolvedName: 'Home, US', latitude: 40.0, longitude: -111.0 };
const DESTINATION = { resolvedName: 'Moab, UT, US', latitude: 38.5733, longitude: -109.5498 };
const DRIVING_ROUTE = {
  distanceMiles: 177.1,
  durationMin: 180,
  geometry: [[40.0, -111.0], [38.5733, -109.5498]],
};

test('buildRoutePlannerPayload builds a driving payload with names, coords and route line', () => {
  const event = {
    device: 'Kitchen Echo',
    query: 'what is the distance between Saratoga Springs and Moab',
    spokenResponse: "it's roughly 177 miles",
    trigger: 'route-query',
  };
  const payload = buildRoutePlannerPayload(event, config, {
    origin: ORIGIN,
    destination: DESTINATION,
    route: DRIVING_ROUTE,
    mode: 'driving',
  });

  assert.equal(payload.version, 2);
  assert.equal(payload.type, 'route-planner.query');
  assert.equal(payload.device, 'Kitchen Echo');
  assert.equal(payload.trigger, 'route-query');
  assert.equal(payload.mode, 'driving');
  assert.equal(payload.origin.name, 'Home, US');
  assert.equal(payload.origin.latitude, 40.0);
  assert.equal(payload.destination.name, 'Moab, UT, US');
  assert.equal(payload.distanceMiles, 177.1);
  assert.equal(payload.durationMin, 180);
  assert.deepEqual(payload.route.geometry, DRIVING_ROUTE.geometry);
  // A lot to read — dismiss window is 2× the standard default (min 180s;
  // override via routePlanner.displaySeconds).
  assert.equal(payload.displaySeconds, 240);
  assert.equal(payload.status, 'ready');
});

test('buildRoutePlannerPayload displaySeconds doubles the default and honors override', () => {
  const doubled = buildRoutePlannerPayload({ device: 'Signal' }, {
    udpBroadcast: { defaultDisplaySeconds: 90 },
  }, {
    origin: ORIGIN,
    destination: DESTINATION,
    route: DRIVING_ROUTE,
    mode: 'driving',
  });
  assert.equal(doubled.displaySeconds, 180);

  const overridden = buildRoutePlannerPayload({ device: 'Signal' }, {
    udpBroadcast: { defaultDisplaySeconds: 90 },
    routePlanner: { displaySeconds: 300 },
  }, {
    origin: ORIGIN,
    destination: DESTINATION,
    route: DRIVING_ROUTE,
    mode: 'driving',
  });
  assert.equal(overridden.displaySeconds, 300);
});

test('buildRoutePlannerPayload can emit a loading skeleton without a route', () => {
  const payload = buildRoutePlannerPayload({ device: 'Signal', query: 'how far is Moab' }, config, {
    origin: { query: 'Home', latitude: 40.0, longitude: -111.0 },
    destination: { query: 'Moab' },
    route: null,
    status: 'loading',
  });
  assert.equal(payload.status, 'loading');
  assert.equal(payload.distanceMiles, null);
  assert.equal(payload.destination.name, 'Moab');
  assert.equal(payload.destination.latitude, null);
  assert.equal(payload.displaySeconds, 240);
});

test('buildRoutePlannerPayload can emit a failed status after a skeleton', () => {
  const payload = buildRoutePlannerPayload({ device: 'Signal' }, config, {
    origin: ORIGIN,
    destination: { query: 'Atlantis' },
    route: null,
    status: 'failed',
    error: 'Could not find one of those places',
  });
  assert.equal(payload.status, 'failed');
  assert.match(payload.error, /Could not find/);
});

test('buildRoutePlannerPayload defaults an unrecognized mode to driving', () => {
  const payload = buildRoutePlannerPayload({ device: 'Signal' }, config, {
    origin: ORIGIN,
    destination: DESTINATION,
    route: DRIVING_ROUTE,
  });
  assert.equal(payload.mode, 'driving');
});

test('buildRoutePlannerPayload supports flight mode', () => {
  const payload = buildRoutePlannerPayload({ device: 'Signal' }, config, {
    origin: ORIGIN,
    destination: DESTINATION,
    route: { distanceMiles: 175.6, durationMin: 66, geometry: [[40.0, -111.0], [38.5733, -109.5498]] },
    mode: 'flight',
  });
  assert.equal(payload.mode, 'flight');
});

test('buildRoutePlannerPayload falls back to the raw query string when a place has no resolved name', () => {
  const payload = buildRoutePlannerPayload({ device: 'Signal' }, config, {
    origin: { query: 'moab', latitude: 38.5733, longitude: -109.5498 },
    destination: DESTINATION,
    route: DRIVING_ROUTE,
  });
  assert.equal(payload.origin.name, 'moab');
});

test('buildRoutePlannerPayload returns null when origin or destination is missing', () => {
  assert.equal(buildRoutePlannerPayload({}, config, { destination: DESTINATION, route: DRIVING_ROUTE }), null);
  assert.equal(buildRoutePlannerPayload({}, config, { origin: ORIGIN, route: DRIVING_ROUTE }), null);
  assert.equal(buildRoutePlannerPayload({}, config), null);
});
