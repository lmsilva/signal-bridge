const fs = require('fs');
const path = require('path');
const { resolveTeslaFleetConfig } = require('./tesla-config');
const { resolveSteamConfig } = require('./steam-config');
const { resolvePsnConfig } = require('./psn-config');
const { resolveYoutubeConfig } = require('./youtube-config');

const ROOT = path.resolve(__dirname, '..');

/** Load `.env` from project root (does not override existing process.env). */
function loadDotEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath) || fs.statSync(envPath).isDirectory()) {
    return;
  }
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq === -1) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && !(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadDotEnv();
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
  config.weatherCachePath = path.resolve(
    ROOT,
    config.weatherCacheFile || 'data/weather-cache.json',
  );
  config.notificationsCachePath = path.resolve(
    ROOT,
    config.notificationsCacheFile || 'data/notifications-cache.json',
  );
  config.airQualityCachePath = path.resolve(
    ROOT,
    config.airQualityCacheFile || 'data/air-quality-cache.json',
  );
  // Uploaded "QR code -> embedded photo" images, also the pool the Shared
  // Photo Slideshow / Slideshow Manager draw from. Kept indefinitely — see
  // src/qr-image-cache.js — until removed from the web page's Slideshow
  // Manager tab.
  config.qrImageCacheDir = path.resolve(
    ROOT,
    config.qrImage?.cacheDir || 'data/qr-image-cache',
  );
  // Persisted Shared Photo Slideshow playback order ('recent'|'oldest'|'random'),
  // set from the web page's Settings tab — see src/slideshow-settings.js.
  config.slideshowSettingsPath = path.resolve(
    ROOT,
    config.slideshow?.settingsFile || 'data/slideshow-settings.json',
  );
  // The built-in Vestaboard stands in for hardware. It listens on the board's
  // own port and speaks the Local API, so the send path is the same code
  // whether or not a real board is on the wall.
  config.vestaboardSimulator = {
    enabled: fileConfig.vestaboardSimulator?.enabled !== false,
    port: Number(
      process.env.VESTABOARD_SIM_PORT
      || fileConfig.vestaboardSimulator?.port
      || 7000,
    ),
    host: process.env.VESTABOARD_SIM_HOST
      || fileConfig.vestaboardSimulator?.host
      || '0.0.0.0',
    rateWindowSeconds: Number(fileConfig.vestaboardSimulator?.rateWindowSeconds ?? 15),
  };
  config.vestaboardSimulatorPath = path.resolve(
    ROOT,
    fileConfig.vestaboardSimulator?.stateFile || 'data/vestaboard-simulator.json',
  );

  config.teslaFleet = resolveTeslaFleetConfig({ ...config, ROOT }, fileConfig);
  config.steam = resolveSteamConfig({ ...config, ROOT }, fileConfig);
  config.psn = resolvePsnConfig({ ...config, ROOT }, fileConfig);
  config.youtube = resolveYoutubeConfig({ ...config, ROOT }, fileConfig);

  // Admin UI password (/admin). Prefer env; optional config.webServer.adminPassword.
  config.webServer = {
    ...(config.webServer || {}),
    adminPassword: process.env.ADMIN_PASSWORD
      || config.webServer?.adminPassword
      || '',
    adminSessionHours: Number(process.env.ADMIN_SESSION_HOURS)
      || Number(config.webServer?.adminSessionHours)
      || 12,
    certFile: process.env.WEB_TLS_CERT_FILE || config.webServer?.certFile || '',
    keyFile: process.env.WEB_TLS_KEY_FILE || config.webServer?.keyFile || '',
  };

  // Guest Snaps dual-QR overlay (Alexa "open guest snaps").
  // Secrets live in .env; see resolveGuestPhotoboothSettings().
  config.guestPhotobooth = {
    ...(config.guestPhotobooth || {}),
  };

  // Shared secret for AES-GCM UDP between bridge and display clients.
  // Prefer .env LAN_UDP_SECRET; optional udpBroadcast.sharedSecret in config.json.
  config.lanUdpSecret = String(
    process.env.LAN_UDP_SECRET
    || config.udpBroadcast?.sharedSecret
    || config.lanUdpSecret
    || '',
  ).trim();

  return config;
}

module.exports = {
  ROOT,
  loadConfig,
  deriveProxyLanguage,
};
