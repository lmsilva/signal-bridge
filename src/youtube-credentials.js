const fs = require('fs');
const path = require('path');
const { createSecretBox } = require('./secret-box');

/**
 * Persist the YouTube Data API key under data/ so admin saves survive container
 * recreates. Encrypted at rest like Lounge authState (secret-box).
 *
 * Precedence when resolving: YOUTUBE_API_KEY env → credentials file → config.json.
 */

function defaultCredentialsPath(root) {
  return path.resolve(root || path.resolve(__dirname, '..'), 'data', 'youtube-credentials.json');
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

function loadYoutubeApiKey(credentialsPath, { secretBox = null } = {}) {
  const raw = readCredentialsFile(credentialsPath);
  const stored = raw?.apiKey;
  if (!stored) {
    return '';
  }
  const box = secretBox || createBox(credentialsPath);
  if (typeof stored === 'string' && box.isEncrypted(stored)) {
    return String(box.decrypt(stored) || '').trim();
  }
  // Plaintext leftover from an early write — accept once, migrate on next save.
  return String(stored || '').trim();
}

function saveYoutubeApiKey(credentialsPath, apiKey, { secretBox = null } = {}) {
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

/**
 * Resolve the live API key + where it came from.
 * Mutates nothing; callers assign into config.youtube.apiKey on boot/save.
 */
function resolveYoutubeApiKey({ env = process.env, configKey = '', credentialsPath } = {}) {
  const envKey = String(env.YOUTUBE_API_KEY || '').trim();
  if (envKey) {
    return { apiKey: envKey, apiKeySource: 'env' };
  }
  const sessionKey = credentialsPath ? loadYoutubeApiKey(credentialsPath) : '';
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
  loadYoutubeApiKey,
  saveYoutubeApiKey,
  resolveYoutubeApiKey,
};
