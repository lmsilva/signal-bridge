const fs = require('fs');
const path = require('path');
const { createSecretBox } = require('./secret-box');
const { DEFAULT_CLIENT_ID } = require('./autodarts-api');

/** Community helper that returns { client_id, client_secret } — not Autodarts official. */
const COMMUNITY_CREDENTIALS_URL = 'http://login-darts-caller.peschi.org:3006/client-credentials';

function defaultCredentialsPath(root) {
  return path.resolve(root || path.resolve(__dirname, '..'), 'data', 'autodarts-credentials.json');
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

function decryptField(box, value) {
  if (!value) return '';
  return String(box.isEncrypted(value) ? box.decrypt(value) || '' : value).trim();
}

function envPasswordCredentials(env = process.env) {
  const email = String(env.AUTODARTS_EMAIL || '').trim();
  const password = String(env.AUTODARTS_PASSWORD || '').trim();
  return {
    email,
    password,
    clientId: String(env.AUTODARTS_CLIENT_ID || '').trim(),
    clientSecret: String(env.AUTODARTS_CLIENT_SECRET || '').trim(),
    present: Boolean(email && password),
  };
}

function envOauthCredentials(env = process.env) {
  const clientId = String(env.AUTODARTS_CLIENT_ID || '').trim();
  const clientSecret = String(env.AUTODARTS_CLIENT_SECRET || '').trim();
  return {
    clientId,
    clientSecret,
    present: Boolean(clientId && clientSecret),
  };
}

function emptyStored() {
  return {
    refreshToken: '',
    accessToken: '',
    clientId: '',
    clientSecret: '',
    userId: '',
    userName: '',
    boardId: '',
    boardName: '',
    linkedAt: null,
    needsRelink: false,
    unavailableReason: null,
  };
}

function loadStored(credentialsPath, { secretBox = null, env = process.env } = {}) {
  const raw = readFile(credentialsPath);
  if (!raw) return emptyStored();
  const box = secretBox || createBox(credentialsPath, env);
  return {
    refreshToken: decryptField(box, raw.refreshToken),
    accessToken: decryptField(box, raw.accessToken),
    clientId: decryptField(box, raw.clientId) || String(raw.clientIdPlain || '').trim(),
    clientSecret: decryptField(box, raw.clientSecret),
    userId: String(raw.userId || '').trim(),
    userName: String(raw.userName || '').trim(),
    boardId: String(raw.boardId || '').trim(),
    boardName: String(raw.boardName || '').trim(),
    linkedAt: raw.linkedAt || null,
    needsRelink: raw.needsRelink === true,
    unavailableReason: raw.unavailableReason || null,
  };
}

function writeFile(credentialsPath, next) {
  fs.mkdirSync(path.dirname(credentialsPath), { recursive: true });
  const temporaryPath = `${credentialsPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  fs.renameSync(temporaryPath, credentialsPath);
}

function persistRecord(credentialsPath, record, { secretBox = null, env = process.env } = {}) {
  const box = secretBox || createBox(credentialsPath, env);
  const next = {
    refreshToken: record.refreshToken ? box.encrypt(String(record.refreshToken)) : null,
    accessToken: record.accessToken ? box.encrypt(String(record.accessToken)) : null,
    clientId: record.clientId ? box.encrypt(String(record.clientId)) : null,
    clientSecret: record.clientSecret ? box.encrypt(String(record.clientSecret)) : null,
    userId: String(record.userId || '').trim() || null,
    userName: String(record.userName || '').trim() || null,
    boardId: String(record.boardId || '').trim() || null,
    boardName: String(record.boardName || '').trim() || null,
    linkedAt: record.linkedAt || null,
    needsRelink: record.needsRelink === true,
    unavailableReason: record.unavailableReason || null,
    updatedAt: new Date().toISOString(),
  };
  writeFile(credentialsPath, next);
  return { ok: true };
}

function saveLinkedAccount(credentialsPath, payload, {
  env = process.env,
  secretBox = null,
} = {}) {
  if (envPasswordCredentials(env).present && payload?.refuseEnvOverwrite) {
    return {
      ok: false,
      status: 409,
      error: 'Autodarts credentials are set by environment variables and cannot be changed here',
    };
  }
  const refreshToken = String(payload?.refreshToken || '').trim();
  if (!refreshToken) {
    throw new Error('Autodarts refresh token is required');
  }
  const box = secretBox || createBox(credentialsPath, env);
  const existing = loadStored(credentialsPath, { secretBox: box, env });
  return persistRecord(credentialsPath, {
    refreshToken,
    accessToken: payload?.accessToken || existing.accessToken,
    clientId: existing.clientId,
    clientSecret: existing.clientSecret,
    userId: payload?.userId ?? existing.userId,
    userName: payload?.userName ?? existing.userName,
    boardId: payload?.boardId ?? existing.boardId,
    boardName: payload?.boardName ?? existing.boardName,
    linkedAt: payload?.linkedAt || existing.linkedAt || new Date().toISOString(),
    needsRelink: payload?.needsRelink === true,
    unavailableReason: payload?.unavailableReason || null,
  }, { secretBox: box, env });
}

function saveOauthClient(credentialsPath, payload, {
  env = process.env,
  secretBox = null,
} = {}) {
  if (envOauthCredentials(env).present) {
    return {
      ok: false,
      status: 409,
      error: 'Autodarts client id/secret are set by environment variables and cannot be changed here',
    };
  }
  const { normalizeClientId } = require('./autodarts-api');
  const clientId = normalizeClientId(String(payload?.clientId || '').trim() || DEFAULT_CLIENT_ID);
  const secretProvided = Object.prototype.hasOwnProperty.call(payload || {}, 'clientSecret');
  let clientSecret = String(payload?.clientSecret || '').trim();
  const box = secretBox || createBox(credentialsPath, env);
  const existing = loadStored(credentialsPath, { secretBox: box, env });
  if (!clientSecret && !secretProvided) {
    clientSecret = existing.clientSecret;
  }
  // Secret is optional for the public `darts-caller` device/password client.
  return persistRecord(credentialsPath, {
    ...existing,
    clientId,
    clientSecret,
  }, { secretBox: box, env });
}

function clearCredentials(credentialsPath, { keepOauth = true } = {}) {
  try {
    if (!fs.existsSync(credentialsPath)) return;
    if (!keepOauth) {
      fs.unlinkSync(credentialsPath);
      return;
    }
    const existing = loadStored(credentialsPath);
    if (!existing.clientId && !existing.clientSecret) {
      fs.unlinkSync(credentialsPath);
      return;
    }
    persistRecord(credentialsPath, {
      ...emptyStored(),
      clientId: existing.clientId,
      clientSecret: existing.clientSecret,
    });
  } catch {
    // ignore
  }
}

function resolveOauthClient(credentialsPath, env = process.env) {
  const { normalizeClientId } = require('./autodarts-api');
  const fromEnv = envOauthCredentials(env);
  if (fromEnv.clientId || fromEnv.clientSecret) {
    return {
      clientId: normalizeClientId(fromEnv.clientId || DEFAULT_CLIENT_ID),
      clientSecret: fromEnv.clientSecret,
      source: fromEnv.present ? 'env' : 'env-partial',
    };
  }
  const stored = loadStored(credentialsPath, { env });
  if (stored.clientId || stored.clientSecret) {
    return {
      clientId: normalizeClientId(stored.clientId || DEFAULT_CLIENT_ID),
      clientSecret: stored.clientSecret || '',
      source: 'session',
    };
  }
  return {
    clientId: DEFAULT_CLIENT_ID,
    clientSecret: '',
    source: 'default',
  };
}

function createAutodartsCredentials(config = {}) {
  const credentialsPath = path.resolve(
    config.autodartsCredentialsPath || defaultCredentialsPath(config.ROOT),
  );
  const env = config.env || process.env;
  return {
    credentialsPath,
    COMMUNITY_CREDENTIALS_URL,
    load: () => loadStored(credentialsPath, { env }),
    envPasswordCredentials: () => envPasswordCredentials(env),
    envOauthCredentials: () => envOauthCredentials(env),
    resolveOauthClient: () => resolveOauthClient(credentialsPath, env),
    oauthStatus: () => {
      const resolved = resolveOauthClient(credentialsPath, env);
      const fromEnv = envOauthCredentials(env);
      return {
        clientId: resolved.clientId || DEFAULT_CLIENT_ID,
        hasClientSecret: Boolean(resolved.clientSecret),
        source: resolved.source,
        envBlocksOverwrite: fromEnv.present,
        credentialsUrl: COMMUNITY_CREDENTIALS_URL,
        defaultClientId: DEFAULT_CLIENT_ID,
      };
    },
    save: (payload, options = {}) => saveLinkedAccount(credentialsPath, payload, {
      env: options.env || env,
    }),
    saveOauthClient: (payload, options = {}) => saveOauthClient(credentialsPath, payload, {
      env: options.env || env,
    }),
    clear: (options) => clearCredentials(credentialsPath, options),
    markNeedsRelink: (reason) => {
      const current = loadStored(credentialsPath, { env });
      if (!current.refreshToken && !current.userId) {
        return { ok: false };
      }
      return saveLinkedAccount(credentialsPath, {
        ...current,
        needsRelink: true,
        unavailableReason: reason || 'Re-link needed',
      }, { env });
    },
    updateBoard: ({ boardId, boardName }) => {
      const current = loadStored(credentialsPath, { env });
      if (!current.refreshToken) {
        return { ok: false, error: 'Link Autodarts before choosing a board' };
      }
      return saveLinkedAccount(credentialsPath, {
        ...current,
        boardId,
        boardName,
        needsRelink: false,
        unavailableReason: null,
      }, { env });
    },
  };
}

module.exports = {
  createAutodartsCredentials,
  loadStored,
  envPasswordCredentials,
  envOauthCredentials,
  resolveOauthClient,
  saveOauthClient,
  defaultCredentialsPath,
  COMMUNITY_CREDENTIALS_URL,
};
