/**
 * International Space Station tracker — live position + speed relative to the
 * house pin. Free APIs, no keys: Where the ISS at? first, Open Notify fallback
 * for lat/lon only. Settings live in data/iss-tracker-settings.json.
 */

const fs = require('fs');
const path = require('path');
const { fold } = require('./vestaboard/encoder');

const TYPE = 'iss.track';
const ISS_NORAD_ID = 25544;
const WTIA_URL = `https://api.wheretheiss.at/v1/satellites/${ISS_NORAD_ID}`;
const OPEN_NOTIFY_URL = 'https://api.open-notify.org/iss-now.json';
const USER_AGENT = 'Mozilla/5.0 (compatible; SignalBridge/1.0)';
const DEFAULT_TIMEOUT_MS = 8000;
/** Typical ISS ground speed when Open Notify has no velocity. */
const FALLBACK_SPEED_KMH = 27600;
const FALLBACK_ALT_KM = 420;

const DEFAULT_SETTINGS = Object.freeze({
  distanceUnit: 'miles',
  showAltitude: true,
  showCoordinates: true,
  showVisibility: true,
});

function sanitiseSettings(raw = {}, base = DEFAULT_SETTINGS) {
  const incoming = raw && typeof raw === 'object' ? raw : {};
  const unitRaw = String(
    incoming.distanceUnit != null ? incoming.distanceUnit : base.distanceUnit,
  ).trim().toLowerCase();
  const distanceUnit = unitRaw === 'km' || unitRaw === 'kilometers' ? 'km' : 'miles';
  return {
    distanceUnit,
    showAltitude: incoming.showAltitude != null
      ? Boolean(incoming.showAltitude)
      : Boolean(base.showAltitude),
    showCoordinates: incoming.showCoordinates != null
      ? Boolean(incoming.showCoordinates)
      : Boolean(base.showCoordinates),
    showVisibility: incoming.showVisibility != null
      ? Boolean(incoming.showVisibility)
      : Boolean(base.showVisibility),
  };
}

function createIssTrackerSettings(config = {}, log = console) {
  const settingsPath = config.issTrackerSettingsPath
    || path.resolve(config.ROOT || path.resolve(__dirname, '..'), 'data', 'iss-tracker-settings.json');
  let current = sanitiseSettings({}, DEFAULT_SETTINGS);

  function load() {
    try {
      if (!fs.existsSync(settingsPath)) {
        current = sanitiseSettings({}, DEFAULT_SETTINGS);
        return current;
      }
      current = sanitiseSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), DEFAULT_SETTINGS);
    } catch (error) {
      log?.warn?.('Could not read ISS tracker settings', error?.message || error);
      current = sanitiseSettings({}, DEFAULT_SETTINGS);
    }
    return current;
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
    } catch (error) {
      log?.warn?.('Could not save ISS tracker settings', error?.message || error);
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

function toRad(degrees) {
  return (Number(degrees) * Math.PI) / 180;
}

function toDeg(radians) {
  return (Number(radians) * 180) / Math.PI;
}

/** Great-circle distance in kilometres. */
function haversineKm(lat1, lon1, lat2, lon2) {
  const r = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial bearing from home → ISS, degrees clockwise from north. */
function bearingDegrees(lat1, lon1, lat2, lon2) {
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function compassLabel(bearing) {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const index = Math.round(Number(bearing) / 45) % 8;
  return dirs[index] || 'N';
}

function formatCoord(lat, lon) {
  const latitude = Number(lat);
  const longitude = Number(lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return '';
  }
  const ns = latitude >= 0 ? 'N' : 'S';
  const ew = longitude >= 0 ? 'E' : 'W';
  const latAbs = Math.abs(latitude);
  const lonAbs = Math.abs(longitude);
  const latStr = latAbs >= 10 ? latAbs.toFixed(1) : latAbs.toFixed(2);
  const lonStr = lonAbs >= 100 ? lonAbs.toFixed(1) : lonAbs.toFixed(1);
  return `${latStr}${ns} ${lonStr}${ew}`;
}

function formatDistance(km, unit) {
  const value = unit === 'km' ? km : km * 0.621371;
  const label = unit === 'km' ? 'KM' : 'MI';
  if (!Number.isFinite(value) || value < 0) {
    return '';
  }
  if (value >= 1000) {
    return `${Math.round(value)} ${label}`;
  }
  if (value >= 100) {
    return `${Math.round(value)} ${label}`;
  }
  return `${value.toFixed(0)} ${label}`;
}

function formatSpeed(kmh, unit) {
  const value = unit === 'km' ? kmh : kmh * 0.621371;
  const label = unit === 'km' ? 'KM/H' : 'MPH';
  if (!Number.isFinite(value) || value <= 0) {
    return '';
  }
  return `${Math.round(value)} ${label}`;
}

function formatAltitude(km, unit) {
  const value = unit === 'km' ? km : km * 0.621371;
  const label = unit === 'km' ? 'KM' : 'MI';
  if (!Number.isFinite(value) || value <= 0) {
    return '';
  }
  return `${Math.round(value)} ${label} UP`;
}

function visibilityLabel(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (value === 'daylight' || value === 'visible') {
    return 'DAYLIGHT';
  }
  if (value === 'eclipsed' || value === 'night') {
    return 'ECLIPSED';
  }
  return '';
}

async function fetchJson(url, { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(500, timeoutMs));
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWtiaPosition({ units = 'kilometers', fetchImpl, timeoutMs } = {}) {
  const wantMiles = units === 'miles';
  const url = `${WTIA_URL}?units=${wantMiles ? 'miles' : 'kilometers'}`;
  const data = await fetchJson(url, { fetchImpl, timeoutMs });
  const latitude = Number(data?.latitude);
  const longitude = Number(data?.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error('Where the ISS at? returned no coordinates');
  }
  const altitude = Number(data?.altitude);
  const velocity = Number(data?.velocity);
  // API returns altitude/velocity already in the requested unit system.
  const altKm = wantMiles
    ? (Number.isFinite(altitude) ? altitude / 0.621371 : FALLBACK_ALT_KM)
    : (Number.isFinite(altitude) ? altitude : FALLBACK_ALT_KM);
  const speedKmh = wantMiles
    ? (Number.isFinite(velocity) ? velocity / 0.621371 : FALLBACK_SPEED_KMH)
    : (Number.isFinite(velocity) ? velocity : FALLBACK_SPEED_KMH);
  return {
    latitude,
    longitude,
    altitudeKm: altKm,
    speedKmh,
    visibility: data?.visibility || '',
    timestamp: data?.timestamp ? Number(data.timestamp) * 1000 : Date.now(),
    source: 'wheretheiss',
  };
}

async function fetchOpenNotifyPosition({ fetchImpl, timeoutMs } = {}) {
  const data = await fetchJson(OPEN_NOTIFY_URL, { fetchImpl, timeoutMs });
  const latitude = Number(data?.iss_position?.latitude);
  const longitude = Number(data?.iss_position?.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error('Open Notify returned no coordinates');
  }
  return {
    latitude,
    longitude,
    altitudeKm: FALLBACK_ALT_KM,
    speedKmh: FALLBACK_SPEED_KMH,
    visibility: '',
    timestamp: data?.timestamp ? Number(data.timestamp) * 1000 : Date.now(),
    source: 'open-notify',
  };
}

async function fetchIssPosition(options = {}) {
  const errors = [];
  try {
    return await fetchWtiaPosition(options);
  } catch (error) {
    errors.push(`wheretheiss: ${error?.message || error}`);
  }
  try {
    return await fetchOpenNotifyPosition(options);
  } catch (error) {
    errors.push(`open-notify: ${error?.message || error}`);
  }
  const err = new Error(errors.join('; ') || 'ISS position unavailable');
  err.details = errors;
  throw err;
}

function buildIssTrackPayload({
  position,
  locale = {},
  settings = DEFAULT_SETTINGS,
  asOf,
} = {}) {
  if (!position || !Number.isFinite(Number(position.latitude))) {
    return null;
  }
  const cfg = sanitiseSettings(settings, DEFAULT_SETTINGS);
  const unit = cfg.distanceUnit;
  const homeLat = Number(locale.latitude);
  const homeLon = Number(locale.longitude);
  const hasHome = Number.isFinite(homeLat) && Number.isFinite(homeLon);

  let distanceKm = null;
  let bearing = null;
  let direction = '';
  if (hasHome) {
    distanceKm = haversineKm(homeLat, homeLon, position.latitude, position.longitude);
    bearing = bearingDegrees(homeLat, homeLon, position.latitude, position.longitude);
    direction = compassLabel(bearing);
  }

  const city = fold(locale.city || locale.label || 'HOME').split(',')[0].trim().slice(0, 18);
  const distanceLabel = hasHome ? formatDistance(distanceKm, unit) : '';
  const relativeLabel = hasHome && distanceLabel && direction
    ? `${distanceLabel} ${direction}`
    : (distanceLabel || '');

  return {
    type: TYPE,
    asOf: asOf || new Date(position.timestamp || Date.now()).toISOString(),
    source: position.source || '',
    latitude: Number(position.latitude),
    longitude: Number(position.longitude),
    altitudeKm: Number(position.altitudeKm),
    speedKmh: Number(position.speedKmh),
    visibility: String(position.visibility || ''),
    visibilityLabel: visibilityLabel(position.visibility),
    coordLabel: formatCoord(position.latitude, position.longitude),
    speedLabel: formatSpeed(position.speedKmh, unit),
    altitudeLabel: formatAltitude(position.altitudeKm, unit),
    distanceKm: hasHome ? distanceKm : null,
    bearing: hasHome ? bearing : null,
    direction,
    distanceLabel,
    relativeLabel,
    unit,
    hasHome,
    home: hasHome
      ? {
        city,
        latitude: homeLat,
        longitude: homeLon,
        label: locale.label || locale.city || '',
      }
      : null,
    settings: cfg,
  };
}

async function loadIssTrackPayload({
  locale = {},
  settings = DEFAULT_SETTINGS,
  fetchImpl,
  timeoutMs,
} = {}) {
  const cfg = sanitiseSettings(settings, DEFAULT_SETTINGS);
  const position = await fetchIssPosition({
    units: 'kilometers',
    fetchImpl,
    timeoutMs,
  });
  return buildIssTrackPayload({ position, locale, settings: cfg });
}

function createIssTracker(config = {}, log = console) {
  const settingsApi = createIssTrackerSettings(config, log);
  const defaultFetch = typeof config.issTrackerFetchImpl === 'function'
    ? config.issTrackerFetchImpl
    : fetch;

  return {
    getSettings: () => settingsApi.get(),
    updateSettings: (patch) => settingsApi.update(patch),
    resetSettings: () => settingsApi.reset(),
    statusSnapshot(locale = {}) {
      const settings = settingsApi.get();
      const hasLocation = Number.isFinite(Number(locale.latitude))
        && Number.isFinite(Number(locale.longitude));
      return {
        settings,
        hasLocation,
        defaults: { ...DEFAULT_SETTINGS },
        source: 'wheretheiss / open-notify',
      };
    },
    async nextPayload({ locale, fetchImpl, timeoutMs } = {}) {
      return loadIssTrackPayload({
        locale: locale || {},
        settings: settingsApi.get(),
        fetchImpl: fetchImpl || defaultFetch,
        timeoutMs,
      });
    },
  };
}

module.exports = {
  TYPE,
  ISS_NORAD_ID,
  DEFAULT_SETTINGS,
  sanitiseSettings,
  haversineKm,
  bearingDegrees,
  compassLabel,
  formatCoord,
  formatDistance,
  formatSpeed,
  formatAltitude,
  visibilityLabel,
  fetchWtiaPosition,
  fetchOpenNotifyPosition,
  fetchIssPosition,
  buildIssTrackPayload,
  loadIssTrackPayload,
  createIssTrackerSettings,
  createIssTracker,
};
