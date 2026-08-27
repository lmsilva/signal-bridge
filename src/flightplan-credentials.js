const fs = require('fs');
const path = require('path');
const { createSecretBox } = require('./secret-box');

function defaultCredentialsPath(root) {
  return path.resolve(root || path.resolve(__dirname, '..'), 'data', 'flightplan-credentials.json');
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

function loadFlightplanApiKey(credentialsPath, { secretBox = null } = {}) {
  const raw = readCredentialsFile(credentialsPath);
  const stored = raw?.rapidApiKey;
  if (!stored) return '';
  const box = secretBox || createBox(credentialsPath);
  if (typeof stored === 'string' && box.isEncrypted(stored)) {
    return String(box.decrypt(stored) || '').trim();
  }
  return String(stored || '').trim();
}

function saveFlightplanApiKey(credentialsPath, apiKey, { secretBox = null } = {}) {
  const key = String(apiKey || '').trim();
  if (!key) throw new Error('RapidAPI key is empty');
  const box = secretBox || createBox(credentialsPath);
  const existing = readCredentialsFile(credentialsPath) || {};
  const next = {
    ...existing,
    rapidApiKey: box.encrypt(key),
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(credentialsPath), { recursive: true });
  fs.writeFileSync(credentialsPath, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
  return { ok: true };
}

function resolveFlightplanApiKey({ env = process.env, credentialsPath } = {}) {
  const envKey = String(env.FLIGHTPLAN_RAPIDAPI_KEY || env.RAPIDAPI_KEY || '').trim();
  if (envKey) return { apiKey: envKey, apiKeySource: 'env' };
  const sessionKey = credentialsPath ? loadFlightplanApiKey(credentialsPath) : '';
  if (sessionKey) return { apiKey: sessionKey, apiKeySource: 'session' };
  return { apiKey: '', apiKeySource: null };
}

function credentialsStatus(credentialsPath, { env = process.env } = {}) {
  const resolved = resolveFlightplanApiKey({ env, credentialsPath });
  return {
    hasApiKey: Boolean(resolved.apiKey),
    apiKeySource: resolved.apiKeySource,
    envBlocksOverwrite: Boolean(String(env.FLIGHTPLAN_RAPIDAPI_KEY || env.RAPIDAPI_KEY || '').trim()),
  };
}

module.exports = {
  defaultCredentialsPath,
  loadFlightplanApiKey,
  saveFlightplanApiKey,
  resolveFlightplanApiKey,
  credentialsStatus,
};
