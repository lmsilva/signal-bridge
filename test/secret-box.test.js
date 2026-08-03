const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { PREFIX, loadKey, createSecretBox } = require('../src/secret-box');

function keyPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'secret-box-')), 'secret.key');
}

test('a round trip returns exactly what went in', () => {
  const box = createSecretBox({ keyPath: keyPath(), env: {} });
  const secret = JSON.stringify({ token: 'lounge-token', screenId: 'screen-abc' });

  const sealed = box.encrypt(secret);
  assert.notEqual(sealed, secret);
  assert.ok(sealed.startsWith(PREFIX));
  assert.equal(box.decrypt(sealed), secret);
});

test('the ciphertext does not leak the plaintext', () => {
  const box = createSecretBox({ keyPath: keyPath(), env: {} });
  const sealed = box.encrypt('super-secret-lounge-token');

  assert.doesNotMatch(sealed, /lounge/);
  assert.doesNotMatch(sealed, /secret/);
});

test('encrypting the same value twice gives different ciphertext', () => {
  const box = createSecretBox({ keyPath: keyPath(), env: {} });

  const first = box.encrypt('same');
  const second = box.encrypt('same');

  assert.notEqual(first, second, 'a reused nonce would be a real weakness');
  assert.equal(box.decrypt(first), 'same');
  assert.equal(box.decrypt(second), 'same');
});

test('the key persists so a restart can still read old secrets', () => {
  const file = keyPath();
  const sealed = createSecretBox({ keyPath: file, env: {} }).encrypt('token');

  const reopened = createSecretBox({ keyPath: file, env: {} });
  assert.equal(reopened.decrypt(sealed), 'token');
});

test('the key file is written with owner-only permissions', () => {
  const file = keyPath();
  createSecretBox({ keyPath: file, env: {} }).encrypt('token');

  assert.ok(fs.existsSync(file));
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
});

test('a different key cannot read the ciphertext, and says so instead of throwing', () => {
  const sealed = createSecretBox({ keyPath: keyPath(), env: {} }).encrypt('token');
  const stranger = createSecretBox({ keyPath: keyPath(), env: {} });

  assert.equal(stranger.decrypt(sealed), null);
});

test('tampering is detected rather than silently accepted', () => {
  const box = createSecretBox({ keyPath: keyPath(), env: {} });
  const sealed = box.encrypt('token');

  const raw = Buffer.from(sealed.slice(PREFIX.length), 'base64');
  raw[raw.length - 1] ^= 0xff;
  const tampered = PREFIX + raw.toString('base64');

  assert.equal(box.decrypt(tampered), null);
});

test('an environment key overrides the file entirely', () => {
  const file = keyPath();
  const env = { SIGNAL_SECRET_KEY: 'a-passphrase-from-the-deployment' };

  const sealed = createSecretBox({ keyPath: file, env }).encrypt('token');
  assert.equal(createSecretBox({ keyPath: file, env }).decrypt(sealed), 'token');
  assert.equal(fs.existsSync(file), false, 'no key file when the env supplies one');
});

test('a value written before encryption existed is still readable', () => {
  const box = createSecretBox({ keyPath: keyPath(), env: {} });
  assert.equal(box.decrypt('plain-old-token'), 'plain-old-token');
  assert.equal(box.isEncrypted('plain-old-token'), false);
  assert.equal(box.isEncrypted(box.encrypt('x')), true);
});

test('empty values encrypt and decrypt to nothing', () => {
  const box = createSecretBox({ keyPath: keyPath(), env: {} });
  assert.equal(box.encrypt(''), null);
  assert.equal(box.encrypt(null), null);
  assert.equal(box.decrypt(null), null);
  assert.equal(box.decrypt(''), null);
});

test('masking shows only the tail of a secret', () => {
  const box = createSecretBox({ keyPath: keyPath(), env: {} });

  assert.equal(box.mask('AIzaSyEXAMPLEKEY1234'), '••••••••••••••••1234');
  assert.equal(box.mask('abc'), '•••');
  assert.equal(box.mask(''), '');
  assert.doesNotMatch(box.mask('AIzaSyEXAMPLEKEY1234'), /AIza/);
});

test('loadKey refuses to guess when it has neither a path nor an env key', () => {
  assert.throws(() => loadKey({ env: {} }), /SIGNAL_SECRET_KEY or a keyPath/);
});
