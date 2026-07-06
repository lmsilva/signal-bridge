const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATHS = [
  path.join(ROOT, 'data', 'config.json'),
  path.join(ROOT, 'config.json'),
];
const EXAMPLE_CONFIG_PATH = path.join(ROOT, 'config.example.json');

function readJsonFile(filePath) {
  const stats = fs.statSync(filePath);
  if (stats.isDirectory()) {
    throw new Error(
      `${filePath} is a directory, not a file. `
      + 'Docker often creates folders when a mount source file is missing. '
      + 'Stop the container, remove that directory, and create the real file.',
    );
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function resolveConfigPath() {
  for (const candidate of CONFIG_PATHS) {
    if (!fs.existsSync(candidate)) {
      continue;
    }
    if (fs.statSync(candidate).isDirectory()) {
      console.warn(`[config] Skipping ${candidate} — it is a directory, not a file`);
      continue;
    }
    return candidate;
  }
  return null;
}

const DEFAULTS = {
  amazonPage: process.env.AMAZON_PAGE || 'amazon.com',
  acceptLanguage: process.env.ACCEPT_LANGUAGE || 'en-US',
  proxyPort: Number(process.env.PROXY_PORT || 3456),
  proxyOwnIp: process.env.PROXY_OWN_IP || '127.0.0.1',
  sessionFile: process.env.SESSION_FILE || 'data/alexa-session.json',
  debug: process.env.DEBUG === '1' || process.env.DEBUG === 'true',
};

function deriveProxyLanguage(acceptLanguage) {
  return String(acceptLanguage || 'en-US').replace('-', '_');
}

function loadConfig() {
  let fileConfig = {};
  const configPath = resolveConfigPath();

  if (configPath) {
    fileConfig = readJsonFile(configPath);
  } else if (fs.existsSync(EXAMPLE_CONFIG_PATH) && !fs.statSync(EXAMPLE_CONFIG_PATH).isDirectory()) {
    fileConfig = readJsonFile(EXAMPLE_CONFIG_PATH);
  }

  const config = { ...DEFAULTS, ...fileConfig, ROOT };

  config.amazonPageProxyLanguage = config.amazonPageProxyLanguage
    || deriveProxyLanguage(config.acceptLanguage);
  config.formerDataStorePath = path.resolve(ROOT, config.formerDataStorePath || 'data/formerDataStore.json');
  config.bridgeStatePath = path.resolve(ROOT, config.bridgeStateFile || 'data/bridge-state.json');
  config.sessionPath = path.resolve(ROOT, config.sessionFile);
  config.sessionAuthJournalPath = path.resolve(
    ROOT,
    config.sessionAuthJournalFile || 'data/session-auth-journal.jsonl',
  );
  config.voiceEventsLogPath = path.resolve(
    ROOT,
    config.voiceEvents?.eventsLogFile || 'data/voice-events.jsonl',
  );
  config.timerMirrorPath = path.resolve(
    ROOT,
    config.timerSync?.mirrorFile || 'data/timer-mirror.json',
  );
  config.shoppingListCachePath = path.resolve(
    ROOT,
    config.shoppingListCacheFile || 'data/shopping-list-cache.json',
  );

  return config;
}

module.exports = {
  ROOT,
  loadConfig,
  deriveProxyLanguage,
};
