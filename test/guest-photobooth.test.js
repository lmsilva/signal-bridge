const test = require('node:test');
const assert = require('node:assert/strict');
const {
  matchesGuestPhotoboothQuery,
  resolveGuestPhotoboothSettings,
  defaultGuestPhotoboothUrl,
} = require('../src/guest-photobooth');
const { buildGuestPhotoboothPayload, buildWifiQrContent } = require('../src/udp-payload');
const { createVoiceQueryParser } = require('../src/voice-query-parser');

test('matches guest photobooth voice phrases', () => {
  assert.equal(matchesGuestPhotoboothQuery('guest photobooth', ''), true);
  assert.equal(matchesGuestPhotoboothQuery('guest photo booth', ''), true);
  assert.equal(matchesGuestPhotoboothQuery('show the guest photo booth', ''), true);
  assert.equal(matchesGuestPhotoboothQuery('open guest photo-booth', ''), true);
  assert.equal(matchesGuestPhotoboothQuery("what's the weather", ''), false);
});

test('voice query parser returns guest-photobooth with all-displays target', () => {
  const parser = createVoiceQueryParser();
  const event = parser.parse({
    creationTimestamp: Date.now(),
    name: 'Kitchen Echo',
    description: { summary: 'guest photobooth' },
    alexaResponse: '',
    data: { recordKey: 'guest-booth-1' },
  });
  assert.equal(event?.kind, 'guest-photobooth');
  assert.equal(event?.trigger, 'guest-photobooth-query');
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
    const settings = resolveGuestPhotoboothSettings({ proxyOwnIp: '10.0.0.1' });
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
    { device: 'Kitchen', query: 'guest photobooth', trigger: 'guest-photobooth-query' },
    {},
    settings,
  );
  assert.equal(payload.type, 'guest.photobooth');
  assert.equal(payload.displaySeconds, 180);
  assert.equal(payload.guestPhotobooth.wifi.content, buildWifiQrContent({ ssid: 'Home', password: 'pw' }));
  assert.equal(payload.guestPhotobooth.booth.content, 'https://192.168.1.50:47810/');
  assert.match(payload.guestPhotobooth.booth.hint, /Already connected/i);
  assert.match(payload.guestPhotobooth.wifi.hint, /home network/i);
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
