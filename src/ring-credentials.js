/**
 * Ring refresh token — env or encrypted admin save.
 * Precedence: RING_REFRESH_TOKEN → data/ring-credentials.json.
 */

const fs = require('fs');
const path = require('path');
const { createSecretBox } = require('./secret-box');

function defaultCredentialsPath(root) {
  return path.resolve(root || path.resolve(__dirname, '..'), 'data', 'ring-credentials.json');
}

function createBox(credentialsPath) {
  return createSecretBox({
    keyPath: path.resolve(path.dirname(credentialsPath), 'secret.key'),
  });
}

function readCredentialsFile(credentialsPath) {
  try {
    return JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
  } catch {
    return null;
  }
}

function loadRingRefreshToken(credentialsPath, { secretBox = null } = {}) {
  const raw = readCredentialsFile(credentialsPath);
  const stored = raw?.refreshToken;
  if (!stored) {
    return '';
  }
  const box = secretBox || createBox(credentialsPath);
  if (typeof stored === 'string' && box.isEncrypted(stored)) {
    return String(box.decrypt(stored) || '').trim();
  }
  return String(stored || '').trim();
}

function saveRingRefreshToken(credentialsPath, token, { secretBox = null } = {}) {
  const key = String(token || '').trim();
  if (!key) {
    throw new Error('Ring refresh token is empty');
  }
  const box = secretBox || createBox(credentialsPath);
  const existing = readCredentialsFile(credentialsPath) || {};
  const next = {
    ...existing,
    refreshToken: box.encrypt(key),
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(credentialsPath), { recursive: true });
  fs.writeFileSync(credentialsPath, JSON.stringify(next, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  return { ok: true, source: 'session' };
}

function clearRingRefreshToken(credentialsPath) {
  try {
    if (fs.existsSync(credentialsPath)) {
      fs.unlinkSync(credentialsPath);
    }
  } catch {
    // ignore
  }
  return { ok: true };
}

function resolveRingRefreshToken({
  env = process.env,
  credentialsPath,
} = {}) {
  const envKey = String(env.RING_REFRESH_TOKEN || '').trim();
  if (envKey) {
    return { refreshToken: envKey, tokenSource: 'env' };
  }
  const sessionKey = credentialsPath ? loadRingRefreshToken(credentialsPath) : '';
  if (sessionKey) {
    return { refreshToken: sessionKey, tokenSource: 'session' };
  }
  return { refreshToken: '', tokenSource: null };
}

function credentialsStatus(credentialsPath, { env = process.env } = {}) {
  const resolved = resolveRingRefreshToken({ env, credentialsPath });
  const raw = readCredentialsFile(credentialsPath);
  const stored = raw?.refreshToken;
  const keyUnreadable = Boolean(
    stored && !resolved.refreshToken && !String(env.RING_REFRESH_TOKEN || '').trim(),
  );
  const hint = resolved.refreshToken ? resolved.refreshToken.slice(-4) : '';
  return {
    hasToken: Boolean(resolved.refreshToken),
    tokenHint: hint,
    keyUnreadable,
    tokenSource: resolved.tokenSource,
    envBlocksOverwrite: Boolean(String(env.RING_REFRESH_TOKEN || '').trim()),
  };
}

module.exports = {
  defaultCredentialsPath,
  loadRingRefreshToken,
  saveRingRefreshToken,
  clearRingRefreshToken,
  resolveRingRefreshToken,
  credentialsStatus,
};
