/**
 * Public base URL — one origin for every human-facing link.
 *
 * Lives in data/public-url-settings.json (not data/config.json, which loads
 * once at boot). Getter re-reads the file; applyToConfig() copies onto
 * config.web.publicBaseUrl so booth / QR / short-link callers keep reading
 * the field they already know.
 *
 * Precedence for resolvePublicOrigin / publicUrl:
 *   web.publicBaseUrl → GUEST_PHOTOBOOTH_URL (env / .env / extras) →
 *   extras.boothUrl (data/guest-photobooth.json) → computed LAN default.
 *
 * publicUrl(path) has no trailing slash unless path supplies one.
 */

const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const FALLBACK = {
  publicBaseUrl: '',
};

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

function stripTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function isPrivateHost(host) {
  const h = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) {
    return true;
  }
  if (h === 'localhost' || h === '::1' || h === '0.0.0.0' || h.endsWith('.local')) {
    return true;
  }
  const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 10 || a === 127) {
      return true;
    }
    if (a === 192 && b === 168) {
      return true;
    }
    if (a === 172 && b >= 16 && b <= 31) {
      return true;
    }
    if (a === 169 && b === 254) {
      return true;
    }
    return false;
  }
  if (h === '::' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80:')) {
    return true;
  }
  return false;
}

function sanitisePublicBaseUrl(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) {
    return '';
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('Public base URL is not valid');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('Public base URL must start with https://');
  }
  if (!parsed.hostname) {
    throw new Error('Public base URL is missing a host');
  }
  const pathname = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
  return `${parsed.protocol}//${parsed.host}${pathname}`;
}

function isUsableShortLinkOrigin(url) {
  try {
    const parsed = new URL(String(url || '').trim());
    return parsed.protocol === 'https:' && Boolean(parsed.hostname) && !isPrivateHost(parsed.hostname);
  } catch {
    return false;
  }
}

function lanOrigin(config = {}) {
  const httpsOn = config.webServer?.https !== false;
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
  const scheme = httpsOn ? 'https' : 'http';
  return `${scheme}://${host}:${port}`;
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

/**
 * First non-empty origin, no trailing slash.
 * extras: { env, fileEnv, boothUrl }
 */
function resolvePublicOrigin(config = {}, extras = {}) {
  try {
    const fromSettings = sanitisePublicBaseUrl(config.web?.publicBaseUrl);
    if (fromSettings) {
      return fromSettings;
    }
  } catch {
    // Invalid stored value — fall through rather than breaking booth QR.
  }

  const envBag = extras.env || process.env;
  const fileEnv = extras.fileEnv && typeof extras.fileEnv === 'object'
    ? extras.fileEnv
    : (config.ROOT ? parseDotEnvFile(path.join(config.ROOT, '.env')) : {});
  const fromEnv = firstNonEmpty(
    envBag.GUEST_PHOTOBOOTH_URL,
    fileEnv.GUEST_PHOTOBOOTH_URL,
    extras.boothUrl,
  );
  if (fromEnv) {
    return stripTrailingSlash(fromEnv);
  }

  return lanOrigin(config);
}

/**
 * Join origin + path. No trailing slash unless `pathname` supplies one.
 */
function publicUrl(pathname, config = {}, extras = {}) {
  const origin = resolvePublicOrigin(config, extras);
  if (!origin) {
    return '';
  }
  const raw = pathname == null ? '' : String(pathname);
  if (!raw) {
    return origin;
  }
  if (/^https?:\/\//i.test(raw)) {
    return raw.endsWith('/') ? raw : stripTrailingSlash(raw);
  }
  const joined = raw.startsWith('/') ? `${origin}${raw}` : `${origin}/${raw}`;
  if (raw.endsWith('/')) {
    return joined;
  }
  return stripTrailingSlash(joined);
}

function sanitiseSettings(raw = {}, base = FALLBACK) {
  const merged = { ...base, ...(raw || {}) };
  let publicBaseUrl = '';
  try {
    publicBaseUrl = sanitisePublicBaseUrl(merged.publicBaseUrl);
  } catch {
    publicBaseUrl = '';
  }
  return { publicBaseUrl };
}

function applyToConfig(config = {}, settings = {}) {
  if (!config.web) {
    config.web = {};
  }
  config.web.publicBaseUrl = String(settings.publicBaseUrl || '').trim();
  return config;
}

function createPublicUrlSettings(config = {}, log = console) {
  const settingsPath = config.publicUrlSettingsPath
    || path.resolve(config.ROOT || path.resolve(__dirname, '..'), 'data', 'public-url-settings.json');
  let current = { ...FALLBACK };

  function load() {
    try {
      if (!fs.existsSync(settingsPath)) {
        current = { ...FALLBACK };
        applyToConfig(config, current);
        return current;
      }
      current = sanitiseSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8')));
    } catch (error) {
      log?.warn?.('Could not read public URL settings', error?.message || error);
      current = { ...FALLBACK };
    }
    applyToConfig(config, current);
    return current;
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
    } catch (error) {
      log?.warn?.('Could not save public URL settings', error?.message || error);
    }
  }

  load();

  return {
    get() {
      load();
      return { ...current };
    },
    update(patch = {}) {
      const nextUrl = Object.prototype.hasOwnProperty.call(patch, 'publicBaseUrl')
        ? sanitisePublicBaseUrl(patch.publicBaseUrl)
        : current.publicBaseUrl;
      current = sanitiseSettings({ ...current, publicBaseUrl: nextUrl });
      save();
      applyToConfig(config, current);
      return { ...current };
    },
    reload: load,
    path: settingsPath,
  };
}

module.exports = {
  FALLBACK,
  firstNonEmpty,
  stripTrailingSlash,
  isPrivateHost,
  sanitisePublicBaseUrl,
  isUsableShortLinkOrigin,
  lanOrigin,
  resolvePublicOrigin,
  publicUrl,
  sanitiseSettings,
  applyToConfig,
  createPublicUrlSettings,
};
