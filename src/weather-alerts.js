/**
 * Weather Alerts — active NWS alerts for the house pin.
 *
 * Free U.S. National Weather Service CAP feed (api.weather.gov). No API key;
 * a descriptive User-Agent is required. Non-US pins get an empty alert list
 * (NWS coverage), which we surface as a clear "no coverage" board rather than
 * inventing a second paid provider.
 */

const fs = require('fs');
const path = require('path');
const { fold } = require('./vestaboard/encoder');

const TYPE = 'weather.alerts';
const NWS_ALERTS_URL = 'https://api.weather.gov/alerts/active';
const USER_AGENT = '(SignalBridge, https://github.com/local/alexa-broadcast-bridge)';
const DEFAULT_TIMEOUT_MS = 8000;
const MAX_ALERTS = 4;

const SEVERITY_RANK = Object.freeze({
  Extreme: 4,
  Severe: 3,
  Moderate: 2,
  Minor: 1,
  Unknown: 0,
});

const DEFAULT_SETTINGS = Object.freeze({
  minSeverity: 'Minor',
  includeWatches: true,
  includeAdvisories: true,
  maxAlerts: 3,
});

function sanitiseSettings(raw = {}, base = DEFAULT_SETTINGS) {
  const incoming = raw && typeof raw === 'object' ? raw : {};
  const minRaw = String(incoming.minSeverity != null ? incoming.minSeverity : base.minSeverity).trim();
  const minSeverity = SEVERITY_RANK[minRaw] != null ? minRaw : 'Minor';
  const maxAlerts = Math.min(MAX_ALERTS, Math.max(1, Math.round(
    Number(incoming.maxAlerts != null ? incoming.maxAlerts : base.maxAlerts) || 3,
  )));
  const includeWatches = incoming.includeWatches != null
    ? Boolean(incoming.includeWatches)
    : Boolean(base.includeWatches);
  const includeAdvisories = incoming.includeAdvisories != null
    ? Boolean(incoming.includeAdvisories)
    : Boolean(base.includeAdvisories);
  return {
    minSeverity,
    includeWatches,
    includeAdvisories,
    maxAlerts,
  };
}

function createWeatherAlertsSettings(config = {}, log = console) {
  const settingsPath = config.weatherAlertsSettingsPath
    || path.resolve(config.ROOT || path.resolve(__dirname, '..'), 'data', 'weather-alerts-settings.json');
  let current = sanitiseSettings({}, DEFAULT_SETTINGS);

  function load() {
    try {
      if (!fs.existsSync(settingsPath)) {
        current = sanitiseSettings({}, DEFAULT_SETTINGS);
        return current;
      }
      current = sanitiseSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), DEFAULT_SETTINGS);
    } catch (error) {
      log?.warn?.('Could not read Weather Alerts settings', error?.message || error);
      current = sanitiseSettings({}, DEFAULT_SETTINGS);
    }
    return current;
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
    } catch (error) {
      log?.warn?.('Could not save Weather Alerts settings', error?.message || error);
    }
  }

  load();

  return {
    get: () => ({ ...current }),
    update(patch = {}) {
      current = sanitiseSettings({ ...current, ...patch }, current);
      save();
      return this.get();
    },
    reset() {
      current = sanitiseSettings({}, DEFAULT_SETTINGS);
      save();
      return this.get();
    },
    reload: load,
    path: settingsPath,
  };
}

function isLikelyUs(locale = {}) {
  const country = String(locale.country || '').trim().toUpperCase();
  if (country === 'US' || country === 'USA' || country === 'UNITED STATES') {
    return true;
  }
  const zip = String(locale.postalCode || '').trim();
  if (/^\d{5}(-\d{4})?$/.test(zip)) {
    return true;
  }
  const lat = Number(locale.latitude);
  const lon = Number(locale.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return false;
  }
  // Rough CONUS + AK/HI/PR bounding box — NWS will still return [] outside.
  return lat >= 17 && lat <= 72 && lon >= -180 && lon <= -64;
}

/**
 * Marketplace-style colour by event family (severity is a tie-break).
 */
function chipColorFor(event, severity) {
  const text = String(event || '').toLowerCase();
  if (/tornado|hurricane|typhoon|extreme wind/.test(text)) {
    return 'red';
  }
  if (/thunderstorm|severe|hail/.test(text)) {
    return 'red';
  }
  if (/fire|red flag|heat|excessive heat/.test(text)) {
    return 'orange';
  }
  if (/flood|flash flood|coastal|surf|tsunami|marine/.test(text)) {
    return 'blue';
  }
  if (/winter|blizzard|ice|freeze|frost|snow|cold|wind chill/.test(text)) {
    return 'white';
  }
  if (/fog|smoke|dust|ash|air quality/.test(text)) {
    return 'violet';
  }
  if (/wind|gale|hurricane force/.test(text)) {
    return 'yellow';
  }
  if (/watch/.test(text)) {
    return 'yellow';
  }
  if (/advisory/.test(text)) {
    return 'violet';
  }
  const rank = SEVERITY_RANK[severity] || 0;
  if (rank >= 3) {
    return 'red';
  }
  if (rank === 2) {
    return 'orange';
  }
  return 'yellow';
}

function severityPasses(severity, minSeverity) {
  const have = SEVERITY_RANK[severity] ?? 0;
  const need = SEVERITY_RANK[minSeverity] ?? 0;
  return have >= need;
}

function eventKind(event) {
  const text = String(event || '').toLowerCase();
  if (/\bwatch\b/.test(text)) {
    return 'watch';
  }
  if (/\badvisory\b/.test(text)) {
    return 'advisory';
  }
  if (/\bwarning\b/.test(text)) {
    return 'warning';
  }
  return 'other';
}

function formatUntil(iso, timeZone) {
  if (!iso) {
    return '';
  }
  const stamp = Date.parse(iso);
  if (!Number.isFinite(stamp)) {
    return '';
  }
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || 'UTC',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).formatToParts(new Date(stamp));
    const hour = parts.find((part) => part.type === 'hour')?.value || '';
    const minute = parts.find((part) => part.type === 'minute')?.value || '';
    const dayPeriod = parts.find((part) => part.type === 'dayPeriod')?.value || '';
    if (!hour) {
      return '';
    }
    const clock = minute === '00' ? `${hour} ${dayPeriod}` : `${hour}:${minute} ${dayPeriod}`;
    return fold(`UNTIL ${clock}`);
  } catch {
    return '';
  }
}

function shortArea(areaDesc) {
  const raw = fold(String(areaDesc || '').split(';')[0] || '');
  if (!raw) {
    return '';
  }
  return raw.length <= 22 ? raw : `${raw.slice(0, 21)}`;
}

function normaliseAlert(feature = {}, { timeZone } = {}) {
  const props = feature.properties || feature;
  const event = fold(props.event || '');
  if (!event) {
    return null;
  }
  const severity = String(props.severity || 'Unknown').trim() || 'Unknown';
  const ends = props.ends || props.expires || props.onset || null;
  return {
    id: String(props.id || feature.id || `${event}-${ends || ''}`).slice(0, 120),
    event,
    headline: fold(props.headline || event).slice(0, 80),
    severity: SEVERITY_RANK[severity] != null ? severity : 'Unknown',
    urgency: String(props.urgency || '').trim(),
    certainty: String(props.certainty || '').trim(),
    kind: eventKind(event),
    color: chipColorFor(event, severity),
    until: formatUntil(ends, timeZone),
    area: shortArea(props.areaDesc),
    ends,
  };
}

function filterAlerts(alerts, settings = DEFAULT_SETTINGS) {
  const cfg = sanitiseSettings(settings, DEFAULT_SETTINGS);
  return alerts.filter((alert) => {
    if (!severityPasses(alert.severity, cfg.minSeverity)) {
      return false;
    }
    if (!cfg.includeWatches && alert.kind === 'watch') {
      return false;
    }
    if (!cfg.includeAdvisories && alert.kind === 'advisory') {
      return false;
    }
    return true;
  });
}

function rankAlert(alert) {
  return (SEVERITY_RANK[alert.severity] || 0) * 10
    + (alert.kind === 'warning' ? 3 : alert.kind === 'watch' ? 2 : 1);
}

async function fetchNwsAlerts(latitude, longitude, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
} = {}) {
  const lat = Number(latitude);
  const lon = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error('Weather alerts need a house pin');
  }
  const url = `${NWS_ALERTS_URL}?point=${encodeURIComponent(lat)},${encodeURIComponent(lon)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(500, timeoutMs));
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/geo+json',
        'User-Agent': USER_AGENT,
      },
    });
    if (!response.ok) {
      throw new Error(`NWS alerts HTTP ${response.status}`);
    }
    const data = await response.json();
    return Array.isArray(data?.features) ? data.features : [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the Vestaboard payload. Always returns a payload when a pin exists:
 * alerts, all-clear, or outside-US coverage notice.
 */
function buildWeatherAlertsPayload({
  locale = {},
  settings = DEFAULT_SETTINGS,
  features = [],
  asOf,
  coverage = null,
} = {}) {
  if (!Number.isFinite(Number(locale.latitude)) || !Number.isFinite(Number(locale.longitude))) {
    return null;
  }
  const cfg = sanitiseSettings(settings, DEFAULT_SETTINGS);
  const us = coverage != null ? Boolean(coverage) : isLikelyUs(locale);
  const timeZone = locale.timeZone || 'America/Denver';
  const city = fold(locale.city || locale.label || 'HOME').split(',')[0].trim().slice(0, 22);
  const normalised = features
    .map((feature) => normaliseAlert(feature, { timeZone }))
    .filter(Boolean);
  const alerts = filterAlerts(normalised, cfg)
    .sort((a, b) => rankAlert(b) - rankAlert(a) || String(a.event).localeCompare(String(b.event)))
    .slice(0, cfg.maxAlerts);

  let mode = 'clear';
  if (!us) {
    mode = 'outside-us';
  } else if (alerts.length) {
    mode = 'alerts';
  }

  return {
    type: TYPE,
    asOf: asOf || new Date().toISOString(),
    mode,
    source: 'NWS',
    location: {
      city: locale.city || '',
      label: locale.label || locale.city || '',
      latitude: Number(locale.latitude),
      longitude: Number(locale.longitude),
      timeZone,
      country: locale.country || '',
    },
    settings: cfg,
    alerts,
    city,
  };
}

async function loadWeatherAlertsPayload({
  locale,
  settings,
  fetchImpl,
  timeoutMs,
} = {}) {
  if (!Number.isFinite(Number(locale?.latitude)) || !Number.isFinite(Number(locale?.longitude))) {
    return null;
  }
  const us = isLikelyUs(locale);
  if (!us) {
    return buildWeatherAlertsPayload({ locale, settings, features: [], coverage: false });
  }
  const features = await fetchNwsAlerts(locale.latitude, locale.longitude, {
    fetchImpl,
    timeoutMs,
  });
  return buildWeatherAlertsPayload({ locale, settings, features, coverage: true });
}

function createWeatherAlerts(config = {}, log = console) {
  const settingsApi = createWeatherAlertsSettings(config, log);
  const defaultFetch = typeof config.weatherAlertsFetchImpl === 'function'
    ? config.weatherAlertsFetchImpl
    : fetch;

  return {
    getSettings: () => settingsApi.get(),
    updateSettings: (patch) => settingsApi.update(patch),
    resetSettings: () => settingsApi.reset(),
    statusSnapshot() {
      return {
        settings: settingsApi.get(),
        defaults: { ...DEFAULT_SETTINGS },
        source: 'NWS',
        requiresLocation: true,
        usOnly: true,
      };
    },
    async nextPayload({ locale, fetchImpl, timeoutMs } = {}) {
      return loadWeatherAlertsPayload({
        locale,
        settings: settingsApi.get(),
        fetchImpl: fetchImpl || defaultFetch,
        timeoutMs,
      });
    },
  };
}

module.exports = {
  TYPE,
  DEFAULT_SETTINGS,
  SEVERITY_RANK,
  USER_AGENT,
  sanitiseSettings,
  createWeatherAlertsSettings,
  createWeatherAlerts,
  isLikelyUs,
  chipColorFor,
  formatUntil,
  shortArea,
  normaliseAlert,
  filterAlerts,
  fetchNwsAlerts,
  buildWeatherAlertsPayload,
  loadWeatherAlertsPayload,
};
