const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { ensureWebTls, generateWithNodeCrypto } = require('../src/web-tls');
const { createWebServer } = require('../src/web-server');

test('generateWithNodeCrypto writes usable key and cert PEMs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-tls-'));
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  generateWithNodeCrypto(keyPath, certPath, {
    cn: 'test-control',
    hosts: ['test-control', '127.0.0.1', 'localhost'],
    days: 30,
  });
  const key = fs.readFileSync(keyPath, 'utf8');
  const cert = fs.readFileSync(certPath, 'utf8');
  assert.match(key, /BEGIN PRIVATE KEY/);
  assert.match(cert, /BEGIN CERTIFICATE/);
});

test('ensureWebTls reuses existing certs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-tls-root-'));
  const config = { ROOT: root, webServer: { certDir: 'certs' } };
  const first = ensureWebTls(config, { hosts: ['127.0.0.1'] });
  assert.equal(first.created, true);
  const second = ensureWebTls(config, { hosts: ['127.0.0.1'] });
  assert.equal(second.created, false);
  assert.equal(second.certPath, first.certPath);
});

test('https control server serves status over TLS', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-https-'));
  const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'web-root-'));
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<html>ok</html>');
  const config = {
    ROOT: root,
    sessionPath: path.join(root, 'alexa-session.json'),
    proxyPort: 3456,
    proxyOwnIp: '127.0.0.1',
    udpBroadcast: { defaultDisplaySeconds: 120 },
    webServer: {
      enabled: true,
      port: 0,
      https: true,
      httpRedirectPort: 0,
      certDir: 'certs',
    },
    teslaFleet: {
      enabled: false,
      sessionPath: path.join(root, 'tesla-session.json'),
      authStatusPath: path.join(root, 'tesla-auth-status.json'),
    },
  };

  const webServer = createWebServer({
    config,
    log: { info() {}, warn() {}, error() {}, debug() {} },
    sendUdpPayload: () => {},
    recordVoiceEvent: async () => {},
    webRoot,
  });

  const server = await webServer.start();
  try {
    const { port } = server.address();
    const body = await new Promise((resolve, reject) => {
      https.get(
        `https://127.0.0.1:${port}/api/status`,
        { rejectUnauthorized: false },
        (res) => {
          let text = '';
          res.on('data', (chunk) => { text += chunk; });
          res.on('end', () => resolve({ status: res.statusCode, text }));
        },
      ).on('error', reject);
    });
    assert.equal(body.status, 200);
    assert.equal(JSON.parse(body.text).ok, true);
  } finally {
    webServer.stop();
  }
});
