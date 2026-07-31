const test = require('node:test');
const assert = require('node:assert/strict');
const {
  matchesGuestPhotoboothQuery,
  matchesGuestSnapsSlideshowQuery,
  photosToSlideshowEntries,
  resolveGuestPhotoboothSettings,
  defaultGuestPhotoboothUrl,
} = require('../src/guest-photobooth');
const { buildGuestPhotoboothPayload, buildWifiQrContent } = require('../src/udp-payload');
const { createVoiceQueryParser } = require('../src/voice-query-parser');

test('matches guest snaps and legacy photobooth voice phrases', () => {
  assert.equal(matchesGuestPhotoboothQuery('open guest snaps', ''), true);
  assert.equal(matchesGuestPhotoboothQuery('guest snaps', ''), true);
  assert.equal(matchesGuestPhotoboothQuery('show the guest snaps', ''), true);
  assert.equal(matchesGuestPhotoboothQuery('guest photobooth', ''), true);
  assert.equal(matchesGuestPhotoboothQuery('guest photo booth', ''), true);
  assert.equal(matchesGuestPhotoboothQuery("what's the weather", ''), false);
});

test('matches guest snaps slideshow phrases and not the dual-QR welcome', () => {
  // Preferred Alexa phrasing.
  assert.equal(matchesGuestSnapsSlideshowQuery('open guest snaps slideshow', ''), true);
  assert.equal(matchesGuestSnapsSlideshowQuery('guest snaps slideshow', ''), true);
  assert.equal(matchesGuestSnapsSlideshowQuery('show guest snaps slideshow', ''), true);
  // ASR often splits "slideshow" / singular "snap".
  assert.equal(matchesGuestSnapsSlideshowQuery('open guest snap slide show', ''), true);
  assert.equal(matchesGuestSnapsSlideshowQuery('guest snap slideshow', ''), true);
  // Legacy order still works.
  assert.equal(matchesGuestSnapsSlideshowQuery('slideshow guest snaps', ''), true);
  assert.equal(matchesGuestSnapsSlideshowQuery('slideshow of the guest snaps', ''), true);
  assert.equal(matchesGuestSnapsSlideshowQuery('open guest snaps', ''), false);
  assert.equal(matchesGuestSnapsSlideshowQuery("what's the weather", ''), false);
  // Must not route slideshow phrasing to the dual-QR welcome.
  assert.equal(matchesGuestPhotoboothQuery('open guest snaps slideshow', ''), false);
  assert.equal(matchesGuestPhotoboothQuery('slideshow guest snaps', ''), false);
  assert.equal(matchesGuestPhotoboothQuery('guest snaps slideshow', ''), false);
});

test('photosToSlideshowEntries builds absolute URLs from cache list paths', () => {
  const entries = photosToSlideshowEntries(
    [
      { path: '/qr-images/abc.jpg', createdAt: '2026-07-26T12:00:00.000Z' },
      { path: 'qr-images/def.png', createdAt: '2026-07-26T11:00:00.000Z' },
    ],
    { proxyOwnIp: '192.168.1.50', webServer: { port: 47810, https: true } },
  );
  assert.deepEqual(entries, [
    {
      url: 'https://192.168.1.50:47810/qr-images/abc.jpg',
      uploadedAt: '2026-07-26T12:00:00.000Z',
    },
    {
      url: 'https://192.168.1.50:47810/qr-images/def.png',
      uploadedAt: '2026-07-26T11:00:00.000Z',
    },
  ]);
  assert.deepEqual(
    photosToSlideshowEntries([{ path: '/qr-images/x.jpg' }], { proxyOwnIp: '127.0.0.1' }),
    [],
  );
});

test('voice query parser returns guest-photobooth with all-displays target', () => {
  const parser = createVoiceQueryParser();
  const event = parser.parse({
    creationTimestamp: Date.now(),
    name: 'Kitchen Echo',
    description: { summary: 'open guest snaps' },
    alexaResponse: '',
    data: { recordKey: 'guest-booth-1' },
  });
  assert.equal(event?.kind, 'guest-photobooth');
  assert.equal(event?.trigger, 'guest-photobooth-query');
  assert.equal(event?.targetId, '*');
});

test('voice query parser returns photo-slideshow for open guest snaps slideshow', () => {
  const parser = createVoiceQueryParser();
  const event = parser.parse({
    creationTimestamp: Date.now(),
    name: 'Kitchen Echo',
    description: { summary: 'open guest snaps slideshow' },
    alexaResponse: '',
    data: { recordKey: 'guest-slides-1' },
  });
  assert.equal(event?.kind, 'photo-slideshow');
  assert.equal(event?.trigger, 'guest-snaps-slideshow-query');
  assert.equal(event?.targetId, '*');
});

test('defaultGuestPhotoboothUrl uses proxy IP and web port', () => {
  assert.equal(
    defaultGuestPhotoboothUrl({
      proxyOwnIp: '192.168.1.50',
      webServer: { port: 47810, https: true },
    }),
    'https://192.168.1.50:47810/',
  );
  assert.equal(
    defaultGuestPhotoboothUrl({ proxyOwnIp: '127.0.0.1', webServer: { port: 47810 } }),
    '',
  );
});

test('resolveGuestPhotoboothSettings reads env overrides', () => {
  const prev = {
    ssid: process.env.GUEST_WIFI_SSID,
    password: process.env.GUEST_WIFI_PASSWORD,
    url: process.env.GUEST_PHOTOBOOTH_URL,
  };
  process.env.GUEST_WIFI_SSID = 'PartyNet';
  process.env.GUEST_WIFI_PASSWORD = 'secret;pass';
  process.env.GUEST_PHOTOBOOTH_URL = 'https://192.168.1.50:47810/';
  try {
    const settings = resolveGuestPhotoboothSettings({
      ROOT: require('path').join(__dirname, '..'),
      // Avoid picking up the real data/guest-photobooth.json during this test.
      guestPhotoboothPath: require('path').join(__dirname, 'does-not-exist.json'),
      proxyOwnIp: '10.0.0.1',
    });
    assert.equal(settings.ssid, 'PartyNet');
    assert.equal(settings.password, 'secret;pass');
    assert.equal(settings.boothUrl, 'https://192.168.1.50:47810/');
    assert.equal(settings.configured, true);
  } finally {
    if (prev.ssid == null) delete process.env.GUEST_WIFI_SSID;
    else process.env.GUEST_WIFI_SSID = prev.ssid;
    if (prev.password == null) delete process.env.GUEST_WIFI_PASSWORD;
    else process.env.GUEST_WIFI_PASSWORD = prev.password;
    if (prev.url == null) delete process.env.GUEST_PHOTOBOOTH_URL;
    else process.env.GUEST_PHOTOBOOTH_URL = prev.url;
  }
});

test('resolveGuestPhotoboothSettings reads data/guest-photobooth.json', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guest-booth-cfg-'));
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(
    path.join(root, 'data', 'guest-photobooth.json'),
    JSON.stringify({
      wifiSsid: 'FromFile',
      wifiPassword: 'file-pass',
      boothUrl: 'https://10.0.0.9:47810/',
    }),
  );
  const prev = {
    ssid: process.env.GUEST_WIFI_SSID,
    password: process.env.GUEST_WIFI_PASSWORD,
    url: process.env.GUEST_PHOTOBOOTH_URL,
  };
  delete process.env.GUEST_WIFI_SSID;
  delete process.env.GUEST_WIFI_PASSWORD;
  delete process.env.GUEST_PHOTOBOOTH_URL;
  try {
    const settings = resolveGuestPhotoboothSettings({ ROOT: root });
    assert.equal(settings.ssid, 'FromFile');
    assert.equal(settings.password, 'file-pass');
    assert.equal(settings.boothUrl, 'https://10.0.0.9:47810/');
    assert.equal(settings.configured, true);
  } finally {
    if (prev.ssid == null) delete process.env.GUEST_WIFI_SSID;
    else process.env.GUEST_WIFI_SSID = prev.ssid;
    if (prev.password == null) delete process.env.GUEST_WIFI_PASSWORD;
    else process.env.GUEST_WIFI_PASSWORD = prev.password;
    if (prev.url == null) delete process.env.GUEST_PHOTOBOOTH_URL;
    else process.env.GUEST_PHOTOBOOTH_URL = prev.url;
  }
});

test('buildGuestPhotoboothPayload includes wifi + booth QR content', () => {
  const settings = {
    ssid: 'Home',
    password: 'pw',
    security: 'WPA',
    hidden: false,
    boothUrl: 'https://192.168.1.50:47810/',
    displaySeconds: 180,
    configured: true,
  };
  const payload = buildGuestPhotoboothPayload(
    { device: 'Kitchen', query: 'open guest snaps', trigger: 'guest-photobooth-query' },
    {},
    settings,
  );
  assert.equal(payload.type, 'guest.photobooth');
  assert.equal(payload.displaySeconds, 180);
  assert.equal(payload.guestPhotobooth.title, 'Guest Snaps');
  assert.equal(payload.guestPhotobooth.wifi.content, buildWifiQrContent({ ssid: 'Home', password: 'pw' }));
  assert.equal(payload.guestPhotobooth.booth.content, 'https://192.168.1.50:47810/');
  assert.match(payload.guestPhotobooth.booth.hint, /Already on Wi/i);
  assert.match(payload.guestPhotobooth.wifi.hint, /Scan to connect/i);
  assert.equal(payload.guestPhotobooth.accessPin, undefined);
});

test('buildGuestPhotoboothPayload includes accessPin when provided', () => {
  const payload = buildGuestPhotoboothPayload(
    { device: 'Kitchen', query: 'open guest snaps' },
    {},
    {
      ssid: 'Home',
      password: 'pw',
      boothUrl: 'https://192.168.1.50:47810/',
      accessPin: '654321',
      accessPinHint: 'Enter this PIN on your phone',
    },
  );
  assert.equal(payload.guestPhotobooth.accessPin, '654321');
  assert.match(payload.guestPhotobooth.accessPinHint, /PIN/i);
});

test('buildGuestPhotoboothPayload rejects incomplete settings', () => {
  assert.equal(
    buildGuestPhotoboothPayload({}, {}, { ssid: '', boothUrl: 'https://x/' }),
    null,
  );
  assert.equal(
    buildGuestPhotoboothPayload({}, {}, { ssid: 'Home', boothUrl: '' }),
    null,
  );
});
