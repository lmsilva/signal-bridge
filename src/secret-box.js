const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * Symmetric encryption for secrets the bridge has to keep on disk.
 *
 * Everything stored under `data/` up to now has been a plaintext token, which
 * was acceptable while the only secrets were ones the user could re-obtain in
 * seconds (an NPSSO cookie, a Steam API key). YouTube Lounge tokens are
 * different: they are long-lived, they grant control of a TV, and youtube.md
 * §12.11 calls out encrypting them at rest specifically.
 *
 * This is deliberately not a key-management system. The threat model is "the
 * `data/` volume gets copied off the NAS", not "an attacker already has code
 * execution as the bridge" — with the key on the same host, the latter is
 * unwinnable and pretending otherwise would be theatre.
 */

const ALGORITHM = 'aes-256-gcm';
const NONCE_LEN = 12;
const TAG_LEN = 16;
const PREFIX = 'v1:';

/**
 * Load (or create) the box key.
 *
 * `SIGNAL_SECRET_KEY` wins when set, so a deployment can keep the key out of
 * the data volume entirely and a copied volume decrypts to nothing. Otherwise
 * we generate one next to the data it protects, 0600.
 */
function loadKey({ keyPath, env = process.env } = {}) {
  const fromEnv = String(env.SIGNAL_SECRET_KEY || '').trim();
  if (fromEnv) {
    return crypto.createHash('sha256').update(fromEnv).digest();
  }
  if (!keyPath) {
    throw new Error('secret-box needs either SIGNAL_SECRET_KEY or a keyPath');
  }
  try {
    const raw = fs.readFileSync(keyPath, 'utf8').trim();
    if (raw.length >= 32) {
      return Buffer.from(raw, 'base64');
    }
  } catch {
    // First run.
  }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.writeFileSync(keyPath, key.toString('base64'), { encoding: 'utf8', mode: 0o600 });
  return key;
}

function createSecretBox({ keyPath, env = process.env } = {}) {
  let key = null;

  function getKey() {
    if (!key) {
      key = loadKey({ keyPath, env });
    }
    return key;
  }

  function encrypt(plaintext) {
    if (plaintext == null || plaintext === '') {
      return null;
    }
    const nonce = crypto.randomBytes(NONCE_LEN);
    const cipher = crypto.createCipheriv(ALGORITHM, getKey(), nonce);
    const body = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    return PREFIX + Buffer.concat([nonce, cipher.getAuthTag(), body]).toString('base64');
  }

  function decrypt(value) {
    if (!value) {
      return null;
    }
    const text = String(value);
    if (!text.startsWith(PREFIX)) {
      // A value written before encryption existed, or hand-edited into the
      // file. Read it rather than losing the user's link over a format change.
      return text;
    }
    try {
      const raw = Buffer.from(text.slice(PREFIX.length), 'base64');
      const nonce = raw.subarray(0, NONCE_LEN);
      const tag = raw.subarray(NONCE_LEN, NONCE_LEN + TAG_LEN);
      const body = raw.subarray(NONCE_LEN + TAG_LEN);
      const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), nonce);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    } catch {
      // Wrong key or tampered ciphertext. Callers treat null as "needs relink",
      // which is the honest outcome and is recoverable without a human.
      return null;
    }
  }

  /** Never return a secret to a browser; return its shape instead. */
  function mask(value, visible = 4) {
    const text = String(value || '');
    if (!text) {
      return '';
    }
    if (text.length <= visible) {
      return '•'.repeat(text.length);
    }
    return `${'•'.repeat(Math.min(20, text.length - visible))}${text.slice(-visible)}`;
  }

  return { encrypt, decrypt, mask, isEncrypted: (v) => String(v || '').startsWith(PREFIX) };
}

module.exports = {
  ALGORITHM,
  PREFIX,
  loadKey,
  createSecretBox,
};
