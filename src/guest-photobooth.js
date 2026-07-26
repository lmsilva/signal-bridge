/**
 * Voice match + config helpers for Guest Snaps:
 *   - dual-QR welcome ("open guest snaps")
 *   - Shared Photo Slideshow ("slideshow guest snaps")
 *
 * Prefer "open guest snaps" — Alexa reserves "photobooth" and tries to run its
 * own feature. Legacy "guest photobooth" phrases still match as a fallback.
 *
 * Settings resolve from (first non-empty wins):
 *   process.env → root `.env` on disk → `data/guest-photobooth.json` → config.guestPhotobooth
 */

const fs = require('fs');
const path = require('path');

// Primary brand phrase — "Alexa, open guest snaps"
const GUEST_SNAPS_RE = /\b(?:open|show|start|launch|display)?\s*(?:the\s+)?guest\s*snaps?\b/i;
// Legacy aliases (Alexa often hijacks bare "photobooth")
const GUEST_PHOTOBOOTH_RE = /\b(?:show|open|start|launch|display)?\s*(?:the\s+)?guest\s*photo\s*-?\s*booths?\b|\bguest\s*photo\s*-?\s*booth\b|\bguest\s*photo\s*boot\b/i;

// "Alexa, slideshow guest snaps" / "guest snaps slideshow" — Shared Photo
// Slideshow of every stored guest photo (not the dual-QR welcome).
const GUEST_SNAPS_SLIDESHOW_RE = /\b(?:(?:show|start|play|open|launch|display)\s+)?(?:(?:the\s+)?(?:guest\s*snaps?\s+slideshow|slideshow\s+(?:of\s+)?(?:the\s+)?guest\s*snaps?)|(?:the\s+)?slideshow\s+guest\s*snaps?)\b/i;

function normalizeText(value) {
  return String(value || '')
    .replace(/[\u2018\u2019\u2032`´']/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function matchesGuestSnapsSlideshowQuery(summary, response) {
  const text = normalizeText(summary);
  const spoken = normalizeText(response);
  if (text && GUEST_SNAPS_SLIDESHOW_RE.test(text)) {
    return true;
  }
  if (spoken && GUEST_SNAPS_SLIDESHOW_RE.test(spoken) && /\b(?:guest|slideshow)\b/i.test(text || spoken)) {
    return true;
  }
  return false;
}

function matchesGuestPhotoboothQuery(summary, response) {
  // Slideshow phrasing also contains "guest snaps" — handle that path first.
  if (matchesGuestSnapsSlideshowQuery(summary, response)) {
    return false;
  }
  const text = normalizeText(summary);
  const spoken = normalizeText(response);
  if (GUEST_SNAPS_RE.test(text) || GUEST_PHOTOBOOTH_RE.test(text)) {
    return true;
  }
  if (
    (GUEST_SNAPS_RE.test(spoken) || GUEST_PHOTOBOOTH_RE.test(spoken))
    && /\bguest\b/i.test(text || spoken)
  ) {
    return true;
  }
  return false;
}

/** Absolute http(s) URLs for UDP `photo.slideshow` from qr-image-cache `list()`. */
function photosToSlideshowEntries(listed, config = {}) {
  const origin = String(defaultGuestPhotoboothUrl(config) || '').replace(/\/$/, '');
  if (!origin) {
    return [];
  }
  return (Array.isArray(listed) ? listed : [])
    .map((entry) => {
      const rel = String(entry?.path || '').trim();
      if (!rel) {
        return null;
      }
      const pathPart = rel.startsWith('/') ? rel : `/${rel}`;
      return {
        url: `${origin}${pathPart}`,
        uploadedAt: entry.createdAt || null,
      };
    })
    .filter(Boolean);
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
  GUEST_SNAPS_RE,
  GUEST_PHOTOBOOTH_RE,
  GUEST_SNAPS_SLIDESHOW_RE,
  matchesGuestSnapsSlideshowQuery,
  matchesGuestPhotoboothQuery,
  photosToSlideshowEntries,
  resolveGuestPhotoboothSettings,
  defaultGuestPhotoboothUrl,
  loadGuestPhotoboothFile,
  parseDotEnvFile,
};
