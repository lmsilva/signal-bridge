/**
 * TinyURL API token — env or encrypted admin save.
 * Precedence: TINYURL_API_TOKEN → data/tinyurl-credentials.json.
 */

const fs = require('fs');
const path = require('path');
const { createSecretBox } = require('./secret-box');

function defaultCredentialsPath(root) {
  return path.resolve(root || path.resolve(__dirname, '..'), 'data', 'tinyurl-credentials.json');
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

function loadTinyurlToken(credentialsPath, { secretBox = null } = {}) {
  const raw = readCredentialsFile(credentialsPath);
  const stored = raw?.token;
  if (!stored) {
    return '';
  }
  const box = secretBox || createBox(credentialsPath);
  if (typeof stored === 'string' && box.isEncrypted(stored)) {
    return String(box.decrypt(stored) || '').trim();
  }
  return String(stored || '').trim();
}

function saveTinyurlToken(credentialsPath, token, { secretBox = null } = {}) {
  const key = String(token || '').trim();
  if (!key) {
    throw new Error('TinyURL API token is empty');
  }
  const box = secretBox || createBox(credentialsPath);
  const existing = readCredentialsFile(credentialsPath) || {};
  const next = {
    ...existing,
    token: box.encrypt(key),
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(credentialsPath), { recursive: true });
  fs.writeFileSync(credentialsPath, JSON.stringify(next, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  return { ok: true, source: 'session' };
}

function clearTinyurlToken(credentialsPath) {
  try {
    if (fs.existsSync(credentialsPath)) {
      fs.unlinkSync(credentialsPath);
    }
  } catch {
    // ignore
  }
  return { ok: true };
}

function resolveTinyurlToken({
  env = process.env,
  credentialsPath,
} = {}) {
  const envKey = String(env.TINYURL_API_TOKEN || '').trim();
  if (envKey) {
    return { token: envKey, tokenSource: 'env' };
  }
  const sessionKey = credentialsPath ? loadTinyurlToken(credentialsPath) : '';
  if (sessionKey) {
    return { token: sessionKey, tokenSource: 'session' };
  }
  return { token: '', tokenSource: null };
}

function credentialsStatus(credentialsPath, { env = process.env } = {}) {
  const resolved = resolveTinyurlToken({ env, credentialsPath });
  const raw = readCredentialsFile(credentialsPath);
  const stored = raw?.token;
  const keyUnreadable = Boolean(
    stored && !resolved.token && !String(env.TINYURL_API_TOKEN || '').trim(),
  );
  const hint = resolved.token ? resolved.token.slice(-4) : '';
  return {
    hasToken: Boolean(resolved.token),
    tokenHint: hint,
    keyUnreadable,
    tokenSource: resolved.tokenSource,
    envBlocksOverwrite: Boolean(String(env.TINYURL_API_TOKEN || '').trim()),
  };
}

module.exports = {
  defaultCredentialsPath,
  loadTinyurlToken,
  saveTinyurlToken,
  clearTinyurlToken,
  resolveTinyurlToken,
  credentialsStatus,
};
