/**
 * Guardian Open Platform API key — env or encrypted admin save.
 * Precedence: GUARDIAN_API_KEY → data/guardian-credentials.json → config.
 */

const fs = require('fs');
const path = require('path');
const { createSecretBox } = require('./secret-box');

function defaultCredentialsPath(root) {
  return path.resolve(root || path.resolve(__dirname, '..'), 'data', 'guardian-credentials.json');
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

function loadGuardianApiKey(credentialsPath, { secretBox = null } = {}) {
  const raw = readCredentialsFile(credentialsPath);
  const stored = raw?.apiKey;
  if (!stored) {
    return '';
  }
  const box = secretBox || createBox(credentialsPath);
  if (typeof stored === 'string' && box.isEncrypted(stored)) {
    return String(box.decrypt(stored) || '').trim();
  }
  return String(stored || '').trim();
}

function saveGuardianApiKey(credentialsPath, apiKey, { secretBox = null } = {}) {
  const key = String(apiKey || '').trim();
  if (!key) {
    throw new Error('API key is empty');
  }
  const box = secretBox || createBox(credentialsPath);
  const existing = readCredentialsFile(credentialsPath) || {};
  const next = {
    ...existing,
    apiKey: box.encrypt(key),
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(credentialsPath), { recursive: true });
  fs.writeFileSync(credentialsPath, JSON.stringify(next, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  return { ok: true, source: 'session' };
}

function clearGuardianApiKey(credentialsPath) {
  try {
    if (fs.existsSync(credentialsPath)) {
      fs.unlinkSync(credentialsPath);
    }
  } catch {
    // ignore
  }
  return { ok: true };
}

function resolveGuardianApiKey({
  env = process.env,
  configKey = '',
  credentialsPath,
} = {}) {
  const envKey = String(env.GUARDIAN_API_KEY || '').trim();
  if (envKey) {
    return { apiKey: envKey, apiKeySource: 'env' };
  }
  const sessionKey = credentialsPath ? loadGuardianApiKey(credentialsPath) : '';
  if (sessionKey) {
    return { apiKey: sessionKey, apiKeySource: 'session' };
  }
  const fromConfig = String(configKey || '').trim();
  if (fromConfig) {
    return { apiKey: fromConfig, apiKeySource: 'config' };
  }
  return { apiKey: '', apiKeySource: null };
}

module.exports = {
  defaultCredentialsPath,
  loadGuardianApiKey,
  saveGuardianApiKey,
  clearGuardianApiKey,
  resolveGuardianApiKey,
};
