const fs = require('fs');
const path = require('path');
const { createSecretBox } = require('./secret-box');

function defaultCredentialsPath(root) {
  return path.resolve(root || path.resolve(__dirname, '..'), 'data', 'roll-credits-credentials.json');
}

function createBox(credentialsPath, env = process.env) {
  return createSecretBox({
    keyPath: path.resolve(path.dirname(credentialsPath), 'secret.key'),
    env,
  });
}

function readFile(credentialsPath) {
  try {
    const value = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function loadCredentials(credentialsPath, { secretBox = null, env = process.env } = {}) {
  if (!credentialsPath) {
    return { clientId: '', clientSecret: '' };
  }
  const raw = readFile(credentialsPath);
  if (!raw) {
    return { clientId: '', clientSecret: '' };
  }
  const box = secretBox || createBox(credentialsPath, env);
  const decrypt = (value) => {
    if (!value) return '';
    return String(box.isEncrypted(value) ? box.decrypt(value) || '' : value).trim();
  };
  return {
    clientId: decrypt(raw.clientId),
    clientSecret: decrypt(raw.clientSecret),
  };
}

function hasCredentials(value, options) {
  const credentials = typeof value === 'string'
    ? loadCredentials(value, options)
    : (value || {});
  return Boolean(
    String(credentials.clientId || '').trim()
    && String(credentials.clientSecret || '').trim(),
  );
}

function resolveCredentials({
  env = process.env,
  credentialsPath = defaultCredentialsPath(),
  secretBox = null,
} = {}) {
  const envClientId = String(env.IGDB_CLIENT_ID || '').trim();
  const envClientSecret = String(env.IGDB_CLIENT_SECRET || '').trim();
  if (envClientId || envClientSecret) {
    return {
      clientId: envClientId,
      clientSecret: envClientSecret,
      source: 'env',
      complete: Boolean(envClientId && envClientSecret),
    };
  }
  const stored = loadCredentials(credentialsPath, { secretBox, env });
  return {
    ...stored,
    source: hasCredentials(stored) ? 'session' : null,
    complete: hasCredentials(stored),
  };
}

function saveCredentials(credentialsPath, credentials, {
  env = process.env,
  secretBox = null,
} = {}) {
  if (String(env.IGDB_CLIENT_ID || '').trim() || String(env.IGDB_CLIENT_SECRET || '').trim()) {
    return {
      ok: false,
      status: 409,
      error: 'IGDB credentials are set by environment variables and cannot be changed here',
    };
  }
  const clientId = String(credentials?.clientId || '').trim();
  const clientSecret = String(credentials?.clientSecret || '').trim();
  if (!clientId || !clientSecret) {
    throw new Error('IGDB client id and client secret are required');
  }
  const box = secretBox || createBox(credentialsPath, env);
  fs.mkdirSync(path.dirname(credentialsPath), { recursive: true });
  const temporaryPath = `${credentialsPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify({
    clientId: box.encrypt(clientId),
    clientSecret: box.encrypt(clientSecret),
    updatedAt: new Date().toISOString(),
  }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporaryPath, credentialsPath);
  return { ok: true, source: 'session' };
}

function createRollCreditsCredentials(config = {}) {
  const credentialsPath = path.resolve(
    config.rollCreditsCredentialsPath
      || defaultCredentialsPath(config.ROOT),
  );
  const env = config.env || process.env;
  return {
    loadCredentials: () => loadCredentials(credentialsPath, { env }),
    resolveCredentials: (options = {}) => resolveCredentials({
      env: options.env || env,
      credentialsPath,
    }),
    saveCredentials: (credentials, options = {}) => saveCredentials(
      credentialsPath,
      credentials,
      { env: options.env || env },
    ),
    hasCredentials: () => hasCredentials(resolveCredentials({ env, credentialsPath })),
    credentialsPath,
  };
}

module.exports = {
  defaultCredentialsPath,
  loadCredentials,
  saveCredentials,
  resolveCredentials,
  hasCredentials,
  createRollCreditsCredentials,
};
