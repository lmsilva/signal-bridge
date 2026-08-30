/**
 * TinyURL API token — one store, optional per-feature overrides.
 *
 * Resolver ladder (first hit wins), keyed by short-link scope
 * (`guestbook`, `guestsnaps`, `games`):
 *   1. scope env     TINYURL_API_TOKEN_GAMES
 *   2. scope saved   overrides[scope]
 *   3. global env    TINYURL_API_TOKEN
 *   4. global saved  token
 *
 * A file that only has `token` still resolves. Env always wins for that
 * rung — the admin returns 409 rather than overwrite it.
 */

const fs = require('fs');
const path = require('path');
const { createSecretBox } = require('./secret-box');

const SCOPES = Object.freeze(['guestbook', 'guestsnaps', 'games']);

function defaultCredentialsPath(root) {
  return path.resolve(root || path.resolve(__dirname, '..'), 'data', 'tinyurl-credentials.json');
}

function normaliseScope(scope) {
  const value = String(scope || '').trim().toLowerCase();
  return SCOPES.includes(value) ? value : '';
}

function scopeEnvName(scope) {
  const key = normaliseScope(scope);
  return key ? `TINYURL_API_TOKEN_${key.toUpperCase()}` : '';
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

function writeCredentialsFile(credentialsPath, next) {
  fs.mkdirSync(path.dirname(credentialsPath), { recursive: true });
  fs.writeFileSync(credentialsPath, JSON.stringify(next, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
}

function decryptStored(stored, box) {
  if (!stored) return '';
  if (typeof stored === 'string' && box.isEncrypted(stored)) {
    return String(box.decrypt(stored) || '').trim();
  }
  return String(stored || '').trim();
}

function loadTinyurlToken(credentialsPath, { secretBox = null, scope = '' } = {}) {
  const raw = readCredentialsFile(credentialsPath);
  if (!raw) return '';
  const box = secretBox || createBox(credentialsPath);
  const key = normaliseScope(scope);
  if (key) {
    return decryptStored(raw.overrides?.[key], box);
  }
  return decryptStored(raw.token, box);
}

function saveTinyurlToken(credentialsPath, token, { secretBox = null, scope = '' } = {}) {
  const key = String(token || '').trim();
  if (!key) {
    throw new Error('TinyURL API token is empty');
  }
  const box = secretBox || createBox(credentialsPath);
  const existing = readCredentialsFile(credentialsPath) || {};
  const next = {
    ...existing,
    overrides: existing.overrides && typeof existing.overrides === 'object'
      ? { ...existing.overrides }
      : {},
    updatedAt: new Date().toISOString(),
  };
  const scoped = normaliseScope(scope);
  if (scoped) {
    next.overrides[scoped] = box.encrypt(key);
  } else {
    next.token = box.encrypt(key);
  }
  writeCredentialsFile(credentialsPath, next);
  return { ok: true, source: 'session', scope: scoped || null };
}

function clearTinyurlToken(credentialsPath, { scope = '' } = {}) {
  const scoped = normaliseScope(scope);
  try {
    if (!fs.existsSync(credentialsPath)) {
      return { ok: true };
    }
    if (!scoped) {
      fs.unlinkSync(credentialsPath);
      return { ok: true };
    }
    const existing = readCredentialsFile(credentialsPath) || {};
    const overrides = existing.overrides && typeof existing.overrides === 'object'
      ? { ...existing.overrides }
      : {};
    delete overrides[scoped];
    const next = { ...existing, overrides, updatedAt: new Date().toISOString() };
    if (!next.token && !Object.keys(overrides).length) {
      fs.unlinkSync(credentialsPath);
    } else {
      writeCredentialsFile(credentialsPath, next);
    }
  } catch {
    // ignore
  }
  return { ok: true, scope: scoped || null };
}

function resolveTinyurlToken({
  env = process.env,
  credentialsPath,
  scope = '',
} = {}) {
  const scoped = normaliseScope(scope);
  if (scoped) {
    const scopeEnv = String(env[scopeEnvName(scoped)] || '').trim();
    if (scopeEnv) {
      return { token: scopeEnv, tokenSource: 'env-scope', scope: scoped, usingGlobal: false };
    }
    const scopedSaved = credentialsPath
      ? loadTinyurlToken(credentialsPath, { scope: scoped })
      : '';
    if (scopedSaved) {
      return { token: scopedSaved, tokenSource: 'session-scope', scope: scoped, usingGlobal: false };
    }
  }
  const envKey = String(env.TINYURL_API_TOKEN || '').trim();
  if (envKey) {
    return { token: envKey, tokenSource: 'env', scope: scoped || null, usingGlobal: Boolean(scoped) };
  }
  const sessionKey = credentialsPath ? loadTinyurlToken(credentialsPath) : '';
  if (sessionKey) {
    return {
      token: sessionKey,
      tokenSource: 'session',
      scope: scoped || null,
      usingGlobal: Boolean(scoped),
    };
  }
  return { token: '', tokenSource: null, scope: scoped || null, usingGlobal: Boolean(scoped) };
}

function credentialsStatus(credentialsPath, { env = process.env, scope = '' } = {}) {
  const scoped = normaliseScope(scope);
  const resolved = resolveTinyurlToken({ env, credentialsPath, scope: scoped });
  const raw = readCredentialsFile(credentialsPath);
  const stored = scoped ? raw?.overrides?.[scoped] : raw?.token;
  const scopeEnvSet = scoped && Boolean(String(env[scopeEnvName(scoped)] || '').trim());
  const globalEnvSet = Boolean(String(env.TINYURL_API_TOKEN || '').trim());
  const keyUnreadable = Boolean(
    stored && !resolved.token && !scopeEnvSet && !globalEnvSet,
  );
  const hasOverride = Boolean(scoped && (scopeEnvSet || (raw?.overrides && raw.overrides[scoped])));
  const hint = resolved.token ? resolved.token.slice(-4) : '';
  return {
    hasToken: Boolean(resolved.token),
    tokenHint: hint,
    keyUnreadable,
    tokenSource: resolved.tokenSource,
    usingGlobal: Boolean(resolved.usingGlobal),
    hasOverride,
    scope: scoped || null,
    envBlocksOverwrite: scoped ? Boolean(scopeEnvSet || globalEnvSet) : globalEnvSet,
  };
}

module.exports = {
  SCOPES,
  defaultCredentialsPath,
  normaliseScope,
  scopeEnvName,
  loadTinyurlToken,
  saveTinyurlToken,
  clearTinyurlToken,
  resolveTinyurlToken,
  credentialsStatus,
};
