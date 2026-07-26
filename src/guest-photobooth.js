/**
 * Voice match + config helpers for the dual-QR Guest Photo Booth overlay.
 *
 * Phrases like "guest photobooth" / "show guest photo booth" push a page with
 * (1) a Wi-Fi join QR and (2) a URL QR for the public booth at `/`.
 *
 * Settings are resolved from (first non-empty wins):
 *   process.env → root `.env` on disk → `data/guest-photobooth.json` → config.guestPhotobooth
 * The data-file path matters in Docker: `./data` is bind-mounted, while compose
 * `env_file` only injects vars at container create time.
 */

const fs = require('fs');
const path = require('path');

const GUEST_PHOTOBOOTH_RE = /\b(?:show|open|start|launch|display)?\s*(?:the\s+)?guest\s*photo\s*-?\s*booths?\b|\bguest\s*photo\s*-?\s*booth\b|\bguest\s*photo\s*boot\b/i;

function normalizeText(value) {
  return String(value || '')
    .replace(/[\u2018\u2019\u2032`´]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function matchesGuestPhotoboothQuery(summary, response) {
  const text = normalizeText(summary);
  const spoken = normalizeText(response);
  if (GUEST_PHOTOBOOTH_RE.test(text)) {
    return true;
  }
  // Some activities leave the transcript thin and only echo the skill name back.
  if (GUEST_PHOTOBOOTH_RE.test(spoken) && /\bguest\b/i.test(text || spoken)) {
    return true;
  }
  return false;
}

function truthyEnv(value) {
  const raw = String(value == null ? '' : value).trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value == null) {
      continue;
    }
    const text = String(value).trim();
    if (text) {
      return text;
    }
  }
  return '';
}

function parseDotEnvFile(envPath) {
  const out = {};
  if (!envPath || !fs.existsSync(envPath) || fs.statSync(envPath).isDirectory()) {
    return out;
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
    if (key) {
      out[key] = value;
    }
  }
  return out;
}

function loadGuestPhotoboothFile(config = {}) {
  const root = config.ROOT || path.resolve(__dirname, '..');
  const candidates = [
    config.guestPhotoboothPath,
    path.join(root, 'data', 'guest-photobooth.json'),
    path.join(root, 'guest-photobooth.json'),
  ].filter(Boolean);

  for (const filePath of candidates) {
    try {
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        continue;
      }
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (raw && typeof raw === 'object') {
        return raw;
      }
    } catch {
      // ignore malformed optional file
    }
  }
  return {};
}

/**
 * Resolve guest Wi-Fi + booth URL from env / data file / config.
 * Returns null fields when required pieces are missing (caller decides whether to send).
 */
function resolveGuestPhotoboothSettings(config = {}) {
  const guest = { ...loadGuestPhotoboothFile(config), ...(config.guestPhotobooth || {}) };
  const root = config.ROOT || path.resolve(__dirname, '..');
  const fileEnv = parseDotEnvFile(path.join(root, '.env'));

  const ssid = firstNonEmpty(
    process.env.GUEST_WIFI_SSID,
    fileEnv.GUEST_WIFI_SSID,
    guest.wifiSsid,
    guest.ssid,
  );
  const password = firstNonEmpty(
    process.env.GUEST_WIFI_PASSWORD,
    fileEnv.GUEST_WIFI_PASSWORD,
    guest.wifiPassword,
    guest.password,
  );
  const securityRaw = firstNonEmpty(
    process.env.GUEST_WIFI_SECURITY,
    fileEnv.GUEST_WIFI_SECURITY,
    guest.wifiSecurity,
    guest.security,
    'WPA',
  ).toLowerCase();
  const security = securityRaw === 'nopass' || securityRaw === 'open' || securityRaw === 'none'
    ? 'nopass'
    : 'WPA';

  let hidden = Boolean(guest.wifiHidden || guest.hidden);
  if (process.env.GUEST_WIFI_HIDDEN != null && String(process.env.GUEST_WIFI_HIDDEN).trim() !== '') {
    hidden = truthyEnv(process.env.GUEST_WIFI_HIDDEN);
  } else if (fileEnv.GUEST_WIFI_HIDDEN != null && String(fileEnv.GUEST_WIFI_HIDDEN).trim() !== '') {
    hidden = truthyEnv(fileEnv.GUEST_WIFI_HIDDEN);
  }

  let boothUrl = firstNonEmpty(
    process.env.GUEST_PHOTOBOOTH_URL,
    fileEnv.GUEST_PHOTOBOOTH_URL,
    guest.boothUrl,
    guest.url,
  );
  if (!boothUrl) {
    boothUrl = defaultGuestPhotoboothUrl(config);
  }

  const displaySeconds = Number(
    firstNonEmpty(
      process.env.GUEST_PHOTOBOOTH_DISPLAY_SECONDS,
      fileEnv.GUEST_PHOTOBOOTH_DISPLAY_SECONDS,
      guest.defaultDisplaySeconds,
      guest.displaySeconds,
      '180',
    ),
  );

  return {
    ssid,
    password,
    security,
    hidden,
    boothUrl,
    displaySeconds: Number.isFinite(displaySeconds) ? displaySeconds : 180,
    configured: Boolean(ssid && boothUrl),
  };
}

function defaultGuestPhotoboothUrl(config = {}) {
  const https = config.webServer?.https !== false;
  const port = Number(config.webServer?.port) > 0
    ? Number(config.webServer.port)
    : 47810;
  const host = String(
    config.proxyOwnIp
    || (Array.isArray(config.webServer?.certHosts) && config.webServer.certHosts[0])
    || '',
  ).trim();
  if (!host || host === '127.0.0.1' || host === 'localhost') {
    return '';
  }
  const scheme = https ? 'https' : 'http';
  return `${scheme}://${host}:${port}/`;
}

module.exports = {
  GUEST_PHOTOBOOTH_RE,
  matchesGuestPhotoboothQuery,
  resolveGuestPhotoboothSettings,
  defaultGuestPhotoboothUrl,
  loadGuestPhotoboothFile,
  parseDotEnvFile,
};
