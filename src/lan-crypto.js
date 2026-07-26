/**
 * Shared-secret AES-256-GCM for bridge ↔ display UDP.
 *
 * Wire envelope (protocol v3):
 *   { v: 3, alg: "aes-256-gcm", n: "<base64 nonce>", c: "<base64 ciphertext||tag>" }
 *
 * Inner plaintext is the existing v2 JSON payload. Key = SHA-256(utf8(secret)).
 */

const crypto = require('crypto');

const ALG = 'aes-256-gcm';
const ALG_NAME = 'aes-256-gcm';
const NONCE_LEN = 12;
const TAG_LEN = 16;
const MAX_SKEW_MS = 120 * 1000;

function normalizeSecret(secret) {
  return String(secret == null ? '' : secret).trim();
}

function isEnabled(secret) {
  return Boolean(normalizeSecret(secret));
}

function deriveKey(secret) {
  return crypto.createHash('sha256').update(normalizeSecret(secret), 'utf8').digest();
}

function ensureTimestamp(payload, now = Date.now()) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload;
  }
  const nowIso = new Date(now).toISOString();
  // Always stamp sentAt at seal time. Activity timestamps from Alexa history
  // can be minutes old by the time we UDP — freshness must not use those.
  return {
    ...payload,
    timestamp: payload.timestamp || nowIso,
    sentAt: nowIso,
  };
}

function parseTimestampMs(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : null;
}

function isFresh(payload, now = Date.now()) {
  // Prefer wire send time; fall back to payload timestamp for older clients.
  const ms = parseTimestampMs(payload?.sentAt) ?? parseTimestampMs(payload?.timestamp);
  if (ms == null) {
    return false;
  }
  return Math.abs(now - ms) <= MAX_SKEW_MS;
}

/**
 * @param {object} payload
 * @param {string} secret
 * @param {{ nonce?: Buffer, now?: number }} [options] - nonce/now for deterministic tests only
 */
function sealJson(payload, secret, options = {}) {
  if (!isEnabled(secret)) {
    throw new Error('LAN UDP secret is not configured');
  }
  const plain = ensureTimestamp(payload, options.now);
  const plaintext = Buffer.from(JSON.stringify(plain), 'utf8');
  const nonce = options.nonce && Buffer.isBuffer(options.nonce) && options.nonce.length === NONCE_LEN
    ? options.nonce
    : crypto.randomBytes(NONCE_LEN);
  const cipher = crypto.createCipheriv(ALG, deriveKey(secret), nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 3,
    alg: ALG_NAME,
    n: nonce.toString('base64'),
    c: Buffer.concat([ciphertext, tag]).toString('base64'),
  };
}

function openEnvelope(envelope, secret, { now = Date.now() } = {}) {
  if (!isEnabled(secret) || !envelope || typeof envelope !== 'object') {
    return null;
  }
  if (envelope.v !== 3 || envelope.alg !== ALG_NAME) {
    return null;
  }
  try {
    const nonce = Buffer.from(String(envelope.n || ''), 'base64');
    const combined = Buffer.from(String(envelope.c || ''), 'base64');
    if (nonce.length !== NONCE_LEN || combined.length <= TAG_LEN) {
      return null;
    }
    const tag = combined.subarray(combined.length - TAG_LEN);
    const ciphertext = combined.subarray(0, combined.length - TAG_LEN);
    const decipher = crypto.createDecipheriv(ALG, deriveKey(secret), nonce);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const payload = JSON.parse(plaintext.toString('utf8'));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return null;
    }
    if (!isFresh(payload, now)) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

/** Encode an outbound UDP object (encrypt when secret set, else plaintext v2). */
function encodeOutbound(payload, secret) {
  if (isEnabled(secret)) {
    return sealJson(payload, secret);
  }
  return payload;
}

/**
 * Decode an inbound UDP datagram.
 * - Secret set: only accept decryptable v3 envelopes (reject plaintext).
 * - Secret empty: accept plaintext JSON; reject opaque v3 envelopes.
 */
function decodeInbound(raw, secret, { now = Date.now() } = {}) {
  let parsed;
  try {
    const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  const looksEncrypted = parsed.v === 3 && parsed.alg === ALG_NAME;
  if (isEnabled(secret)) {
    if (!looksEncrypted) {
      return null;
    }
    return openEnvelope(parsed, secret, { now });
  }
  if (looksEncrypted) {
    return null;
  }
  return parsed;
}

module.exports = {
  ALG_NAME,
  NONCE_LEN,
  TAG_LEN,
  MAX_SKEW_MS,
  normalizeSecret,
  isEnabled,
  deriveKey,
  ensureTimestamp,
  isFresh,
  sealJson,
  openEnvelope,
  encodeOutbound,
  decodeInbound,
};
