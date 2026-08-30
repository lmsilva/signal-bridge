const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  isPrivateHost,
  sanitisePublicBaseUrl,
  isUsableShortLinkOrigin,
  resolvePublicOrigin,
  publicUrl,
  applyToConfig,
  createPublicUrlSettings,
} = require('../src/public-url');

test('sanitisePublicBaseUrl requires https and strips a trailing slash', () => {
  assert.equal(sanitisePublicBaseUrl(''), '');
  assert.equal(
    sanitisePublicBaseUrl('https://signal.wittydigital.com/'),
    'https://signal.wittydigital.com',
  );
  assert.equal(
    sanitisePublicBaseUrl('https://signal.wittydigital.com/bridge/'),
    'https://signal.wittydigital.com/bridge',
  );
  assert.throws(() => sanitisePublicBaseUrl('http://signal.wittydigital.com'), /https/);
  assert.throws(() => sanitisePublicBaseUrl('not a url'), /not valid/);
});

test('isPrivateHost covers RFC1918, loopback, and .local', () => {
  assert.equal(isPrivateHost('192.168.1.10'), true);
  assert.equal(isPrivateHost('10.0.0.5'), true);
  assert.equal(isPrivateHost('172.16.0.1'), true);
  assert.equal(isPrivateHost('127.0.0.1'), true);
  assert.equal(isPrivateHost('localhost'), true);
  assert.equal(isPrivateHost('printer.local'), true);
  assert.equal(isPrivateHost('signal.wittydigital.com'), false);
  assert.equal(isPrivateHost('8.8.8.8'), false);
});

test('isUsableShortLinkOrigin rejects LAN https targets', () => {
  assert.equal(isUsableShortLinkOrigin('https://signal.wittydigital.com/guestbook/'), true);
  assert.equal(isUsableShortLinkOrigin('https://192.168.1.10:47810/guestbook/'), false);
  assert.equal(isUsableShortLinkOrigin('http://example.com/guestbook/'), false);
});

test('publicUrl has no trailing slash unless path supplies one', () => {
  const config = { web: { publicBaseUrl: 'https://signal.wittydigital.com/' } };
  assert.equal(publicUrl('', config), 'https://signal.wittydigital.com');
  assert.equal(publicUrl('/', config), 'https://signal.wittydigital.com/');
  assert.equal(publicUrl('/guestbook/', config), 'https://signal.wittydigital.com/guestbook/');
  assert.equal(publicUrl('/guestbook', config), 'https://signal.wittydigital.com/guestbook');
  assert.equal(publicUrl('qr-images/a.jpg', config), 'https://signal.wittydigital.com/qr-images/a.jpg');
});

test('resolvePublicOrigin prefers publicBaseUrl over env then LAN', () => {
  const prev = process.env.GUEST_PHOTOBOOTH_URL;
  process.env.GUEST_PHOTOBOOTH_URL = 'https://env.example.com/booth';
  try {
    assert.equal(
      resolvePublicOrigin({
        web: { publicBaseUrl: 'https://signal.wittydigital.com' },
        proxyOwnIp: '192.168.1.50',
        webServer: { port: 47810, https: true },
      }),
      'https://signal.wittydigital.com',
    );
    assert.equal(
      resolvePublicOrigin({
        proxyOwnIp: '192.168.1.50',
        webServer: { port: 47810, https: true },
      }),
      'https://env.example.com/booth',
    );
    delete process.env.GUEST_PHOTOBOOTH_URL;
    assert.equal(
      resolvePublicOrigin({
        proxyOwnIp: '192.168.1.50',
        webServer: { port: 47810, https: true },
      }),
      'https://192.168.1.50:47810',
    );
  } finally {
    if (prev == null) delete process.env.GUEST_PHOTOBOOTH_URL;
    else process.env.GUEST_PHOTOBOOTH_URL = prev;
  }
});

test('createPublicUrlSettings live-reloads and applyToConfig mutates config.web', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'public-url-'));
  const config = { ROOT: root, web: {} };
  const store = createPublicUrlSettings(config);
  assert.equal(store.get().publicBaseUrl, '');
  assert.equal(config.web.publicBaseUrl, '');

  store.update({ publicBaseUrl: 'https://signal.wittydigital.com/' });
  assert.equal(config.web.publicBaseUrl, 'https://signal.wittydigital.com');
  assert.equal(publicUrl('/guestbook/', config), 'https://signal.wittydigital.com/guestbook/');

  const onDisk = JSON.parse(fs.readFileSync(store.path, 'utf8'));
  assert.equal(onDisk.publicBaseUrl, 'https://signal.wittydigital.com');

  fs.writeFileSync(store.path, `${JSON.stringify({ publicBaseUrl: 'https://other.example/' }, null, 2)}\n`);
  assert.equal(store.get().publicBaseUrl, 'https://other.example');
  assert.equal(config.web.publicBaseUrl, 'https://other.example');

  applyToConfig(config, { publicBaseUrl: '' });
  assert.equal(config.web.publicBaseUrl, '');
});
