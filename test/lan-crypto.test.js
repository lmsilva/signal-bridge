const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('path');
const {
  isEnabled,
  deriveKey,
  sealJson,
  openEnvelope,
  encodeOutbound,
  decodeInbound,
  MAX_SKEW_MS,
} = require('../src/lan-crypto');

const SECRET = 'test-lan-udp-secret';
const FRESH_TS = new Date().toISOString();

test('isEnabled treats blank as off', () => {
  assert.equal(isEnabled(''), false);
  assert.equal(isEnabled('   '), false);
  assert.equal(isEnabled(SECRET), true);
});

test('deriveKey is SHA-256 of the secret utf8 bytes', () => {
  const crypto = require('node:crypto');
  assert.deepEqual(
    deriveKey(SECRET),
    crypto.createHash('sha256').update(SECRET, 'utf8').digest(),
  );
});

function withoutSentAt(payload) {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }
  const { sentAt, ...rest } = payload;
  return rest;
}

test('sealJson / openEnvelope round-trip', () => {
  const payload = {
    version: 2,
    type: 'time.query',
    timestamp: FRESH_TS,
    query: 'what time is it',
  };
  const envelope = sealJson(payload, SECRET);
  assert.equal(envelope.v, 3);
  assert.equal(envelope.alg, 'aes-256-gcm');
  assert.ok(envelope.n);
  assert.ok(envelope.c);
  const opened = openEnvelope(envelope, SECRET);
  assert.ok(opened.sentAt);
  assert.deepEqual(withoutSentAt(opened), payload);
});

test('openEnvelope rejects wrong key, tamper, and stale sentAt', () => {
  const payload = { version: 2, type: 'broadcast', timestamp: FRESH_TS, message: 'hi' };
  const envelope = sealJson(payload, SECRET);
  assert.equal(openEnvelope(envelope, 'other-secret'), null);

  const tampered = { ...envelope, c: `${envelope.c.slice(0, -4)}AAAA` };
  assert.equal(openEnvelope(tampered, SECRET), null);

  const stale = sealJson({
    version: 2,
    type: 'broadcast',
    timestamp: FRESH_TS,
    message: 'old',
  }, SECRET, { now: Date.now() - MAX_SKEW_MS - 5_000 });
  assert.equal(openEnvelope(stale, SECRET), null);
});

test('openEnvelope accepts old activity timestamp when sentAt is fresh', () => {
  const oldActivity = new Date(Date.now() - MAX_SKEW_MS - 60_000).toISOString();
  const envelope = sealJson({
    version: 2,
    type: 'weather.query',
    timestamp: oldActivity,
    query: 'weather',
  }, SECRET);
  const opened = openEnvelope(envelope, SECRET);
  assert.ok(opened);
  assert.equal(opened.timestamp, oldActivity);
  assert.ok(opened.sentAt);
});

test('encodeOutbound / decodeInbound honor secret-on vs secret-off modes', () => {
  const payload = { version: 2, type: 'display.announce', timestamp: FRESH_TS, display: { id: 'x' } };

  const plainWire = encodeOutbound(payload, '');
  assert.equal(plainWire.type, 'display.announce');
  assert.deepEqual(withoutSentAt(decodeInbound(JSON.stringify(plainWire), '')), payload);
  assert.equal(decodeInbound(JSON.stringify(plainWire), SECRET), null);

  const encWire = encodeOutbound(payload, SECRET);
  assert.equal(encWire.v, 3);
  assert.deepEqual(withoutSentAt(decodeInbound(JSON.stringify(encWire), SECRET)), payload);
  assert.equal(decodeInbound(JSON.stringify(encWire), ''), null);
});

test('python lan_crypto opens a Node-sealed envelope (cross-compat)', () => {
  const payload = {
    version: 2,
    type: 'input.pointer',
    timestamp: FRESH_TS,
    pointer: { action: 'move', x: 10, y: 20 },
  };
  const envelope = sealJson(payload, SECRET);
  const clientRoot = path.join(__dirname, '..', 'alexa broadcast client');
  const script = [
    'import json, sys',
    'sys.path.insert(0, r"' + clientRoot.replace(/\\/g, '\\\\') + '")',
    'from src.lan_crypto import open_envelope',
    'env = json.loads(sys.stdin.read())',
    'out = open_envelope(env, sys.argv[1])',
    'print(json.dumps(out, separators=(",", ":")))',
  ].join('; ');

  const pythonCandidates = [
    process.env.PYTHON,
    process.env.PYTHON312,
    path.join(clientRoot, '.venv', 'Scripts', 'python.exe'),
    path.join(clientRoot, '.venv', 'bin', 'python'),
    'python',
    'python3',
  ].filter(Boolean);

  let result = null;
  for (const python of pythonCandidates) {
    result = spawnSync(python, ['-c', script, SECRET], {
      input: JSON.stringify(envelope),
      encoding: 'utf8',
      cwd: clientRoot,
    });
    if (result.error?.code === 'ENOENT') {
      continue;
    }
    break;
  }

  if (!result || result.error?.code === 'ENOENT') {
    return; // no Python available in this environment
  }
  if (result.status !== 0) {
    const errText = `${result.stderr || ''}\n${result.stdout || ''}`;
    // cryptography may be missing in some CI shells — skip rather than fail the suite.
    if (/No module named ['"]cryptography['"]/i.test(errText)) {
      return;
    }
    assert.fail(`python open failed: ${errText.trim() || `exit ${result.status}`}`);
  }
  const opened = JSON.parse(result.stdout);
  assert.ok(opened.sentAt);
  assert.deepEqual(withoutSentAt(opened), payload);
});
