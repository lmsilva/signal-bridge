/**
 * Voice match + config helpers for the dual-QR Guest Photo Booth overlay.
 *
 * Phrases like "guest photobooth" / "show guest photo booth" push a page with
 * (1) a Wi-Fi join QR and (2) a URL QR for the public booth at `/`.
 */

const GUEST_PHOTOBOOTH_RE = /\b(?:show|open|start|launch|display)?\s*(?:the\s+)?guest\s*photo\s*-?\s*booths?\b|\bguest\s*photo\s*-?\s*booth\b/i;

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

/**
 * Resolve guest Wi-Fi + booth URL from env / config.
 * Returns null fields when required pieces are missing (caller decides whether to send).
 */
function resolveGuestPhotoboothSettings(config = {}) {
  const guest = config.guestPhotobooth || {};
  const ssid = String(
    process.env.GUEST_WIFI_SSID
    || guest.wifiSsid
    || '',
  ).trim();
  const password = String(
    process.env.GUEST_WIFI_PASSWORD != null
      ? process.env.GUEST_WIFI_PASSWORD
      : (guest.wifiPassword != null ? guest.wifiPassword : ''),
  );
  const securityRaw = String(
    process.env.GUEST_WIFI_SECURITY
    || guest.wifiSecurity
    || 'WPA',
  ).trim().toLowerCase();
  const security = securityRaw === 'nopass' || securityRaw === 'open' || securityRaw === 'none'
    ? 'nopass'
    : 'WPA';
  const hidden = process.env.GUEST_WIFI_HIDDEN != null
    ? truthyEnv(process.env.GUEST_WIFI_HIDDEN)
    : Boolean(guest.wifiHidden);

  let boothUrl = String(
    process.env.GUEST_PHOTOBOOTH_URL
    || guest.boothUrl
    || '',
  ).trim();
  if (!boothUrl) {
    boothUrl = defaultGuestPhotoboothUrl(config);
  }

  const displaySeconds = Number(
    process.env.GUEST_PHOTOBOOTH_DISPLAY_SECONDS
    || guest.defaultDisplaySeconds
    || 180,
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
};
