const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('dgram');
const { createUdpBroadcaster } = require('../src/broadcast-udp');
const { decodeInbound, encodeOutbound } = require('../src/lan-crypto');

const SECRET = 'bridge-udp-integration-secret';

function freePort() {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    sock.bind(0, '127.0.0.1', () => {
      const { port } = sock.address();
      sock.close(() => resolve(port));
    });
    sock.on('error', reject);
  });
}

test('UDP send seals payload when LAN secret set; receiver opens it', async () => {
  const overlayPort = await freePort();
  const discoveryPort = await freePort();
  const received = [];

  const receiver = dgram.createSocket('udp4');
  await new Promise((resolve, reject) => {
    receiver.once('error', reject);
    receiver.bind(overlayPort, '127.0.0.1', resolve);
  });
  receiver.on('message', (msg) => {
    const payload = decodeInbound(msg, SECRET);
    if (payload) {
      received.push(payload);
    }
  });

  const broadcaster = createUdpBroadcaster(
    {
      lanUdpSecret: SECRET,
      udpBroadcast: {
        enabled: true,
        port: overlayPort,
        discoveryPort,
        targets: ['127.0.0.1'],
        defaultDisplaySeconds: 30,
      },
    },
    { info() {}, warn() {}, error() {}, debug() {} },
  );

  await broadcaster.start();
  await broadcaster.send({
    version: 2,
    type: 'time.query',
    timestamp: new Date().toISOString(),
    query: 'what time is it',
  }, { host: '127.0.0.1' });

  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(received.length, 1);
  assert.equal(received[0].type, 'time.query');
  assert.ok(received[0].sentAt, 'seal must stamp sentAt');

  broadcaster.close();
  receiver.close();
});

test('UDP discovery inbound decrypts display.announce', async () => {
  const overlayPort = await freePort();
  const discoveryPort = await freePort();
  const announced = [];

  const broadcaster = createUdpBroadcaster(
    {
      lanUdpSecret: SECRET,
      udpBroadcast: {
        enabled: true,
        port: overlayPort,
        discoveryPort,
        targets: [],
      },
    },
    { info() {}, warn() {}, error() {}, debug() {} },
    {
      onMessage: (payload, rinfo) => {
        announced.push({ payload, rinfo });
      },
    },
  );

  await broadcaster.start();
  assert.equal(broadcaster.listeningForAnnounces, true);

  const wire = encodeOutbound({
    version: 2,
    type: 'display.announce',
    timestamp: new Date().toISOString(),
    display: { id: 'abc123', displayName: 'Poster' },
  }, SECRET);

  const client = dgram.createSocket('udp4');
  await new Promise((resolve, reject) => {
    client.send(Buffer.from(JSON.stringify(wire)), discoveryPort, '127.0.0.1', (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
  client.close();

  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(announced.length, 1);
  assert.equal(announced[0].payload.type, 'display.announce');
  assert.equal(announced[0].payload.display.id, 'abc123');

  broadcaster.close();
});

test('UDP inbound drops plaintext when encryption required', async () => {
  const overlayPort = await freePort();
  const discoveryPort = await freePort();
  const announced = [];

  const broadcaster = createUdpBroadcaster(
    {
      lanUdpSecret: SECRET,
      udpBroadcast: {
        enabled: true,
        port: overlayPort,
        discoveryPort,
        targets: [],
      },
    },
    { info() {}, warn() {}, error() {}, debug() {} },
    {
      onMessage: (payload) => announced.push(payload),
    },
  );

  await broadcaster.start();
  const client = dgram.createSocket('udp4');
  await new Promise((resolve, reject) => {
    client.send(
      Buffer.from(JSON.stringify({
        version: 2,
        type: 'display.announce',
        timestamp: new Date().toISOString(),
        display: { id: 'plain' },
      })),
      discoveryPort,
      '127.0.0.1',
      (err) => (err ? reject(err) : resolve()),
    );
  });
  client.close();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(announced.length, 0);
  broadcaster.close();
});
