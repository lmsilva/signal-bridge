/**
 * House locale — one place for where the house is.
 *
 * City, ZIP, coordinates, IANA timezone and temperature unit live in
 * data/locale-settings.json. On load and save they are copied onto
 * voiceEvents.defaultLocation / localTimeZone so weather, Overhead, routes
 * and board clocks keep reading the fields they already know.
 */

const fs = require('fs');
const path = require('path');

const FALLBACK = {
  city: '',
  postalCode: '',
  region: '',
  country: 'US',
  latitude: null,
  longitude: null,
  timeZone: 'America/Denver',
  label: '',
  temperatureUnit: 'F',
  currencyCode: 'USD',
};

function finiteCoord(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function cleanCurrencyCode(value, fallback = 'USD') {
  const code = String(value || '').trim().toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3);
  if (code === 'RMB') {
    return 'CNY';
  }
  return code || fallback;
}

function sanitiseSettings(raw = {}, base = FALLBACK) {
  const merged = { ...base, ...(raw || {}) };
  const unit = String(merged.temperatureUnit || 'F').trim().toUpperCase();
  const lat = finiteCoord(merged.latitude);
  const lon = finiteCoord(merged.longitude);
  const timeZone = String(merged.timeZone || base.timeZone || 'America/Denver').trim()
    || 'America/Denver';
  return {
    city: String(merged.city || '').trim(),
    postalCode: String(merged.postalCode || '').trim(),
    region: String(merged.region || '').trim(),
    country: String(merged.country || 'US').trim() || 'US',
    latitude: lat,
    longitude: lon,
    timeZone,
    label: String(merged.label || '').trim(),
    temperatureUnit: unit === 'C' ? 'C' : 'F',
    currencyCode: cleanCurrencyCode(
      merged.currencyCode != null ? merged.currencyCode : base.currencyCode,
      base.currencyCode || 'USD',
    ),
  };
}

function seedFromConfig(config = {}) {
  const loc = config.voiceEvents?.defaultLocation || {};
  return sanitiseSettings({
    city: loc.name || '',
    label: loc.name || '',
    latitude: loc.latitude,
    longitude: loc.longitude,
    timeZone: config.voiceEvents?.localTimeZone
      || config.alarmSync?.localTimeZone
      || FALLBACK.timeZone,
  }, FALLBACK);
}

function hasLocation(settings = {}) {
  return finiteCoord(settings.latitude) != null && finiteCoord(settings.longitude) != null;
}

/**
 * Point every existing reader at this locale without rewriting them.
 * Mutates `config` in place.
 */
function applyToConfig(config = {}, settings = {}) {
  if (!config.voiceEvents) {
    config.voiceEvents = {};
  }
  if (hasLocation(settings)) {
    config.voiceEvents.defaultLocation = {
      name: settings.label || settings.city || config.voiceEvents.defaultLocation?.name || 'Home',
      latitude: settings.latitude,
      longitude: settings.longitude,
    };
  }
  if (settings.timeZone) {
    config.voiceEvents.localTimeZone = settings.timeZone;
    if (!config.alarmSync) {
      config.alarmSync = {};
    }
    config.alarmSync.localTimeZone = settings.timeZone;
  }
  return config;
}

function toWeatherLocation(settings = {}) {
  if (!hasLocation(settings)) {
    return null;
  }
  return {
    scope: 'local',
    query: 'local',
    city: settings.city || '',
    resolvedName: settings.label || settings.city || 'Home',
    latitude: settings.latitude,
    longitude: settings.longitude,
    timezone: settings.timeZone || 'auto',
  };
}

function createLocaleSettings(config = {}, log = console) {
  const settingsPath = config.localeSettingsPath
    || path.resolve(config.ROOT || path.resolve(__dirname, '..'), 'data', 'locale-settings.json');
  const defaults = seedFromConfig(config);
  let current = { ...defaults };

  function load() {
    try {
      if (!fs.existsSync(settingsPath)) {
        current = { ...defaults };
        applyToConfig(config, current);
        return current;
      }
      current = sanitiseSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), defaults);
    } catch (error) {
      log?.warn?.('Could not read locale settings', error?.message || error);
      current = { ...defaults };
    }
    applyToConfig(config, current);
    return current;
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
    } catch (error) {
      log?.warn?.('Could not save locale settings', error?.message || error);
    }
  }

  load();

  return {
    get: () => ({ ...current }),
    hasLocation: () => hasLocation(current),
    weatherLocation: () => toWeatherLocation(current),
    update(patch = {}) {
      current = sanitiseSettings({ ...current, ...patch }, current);
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
  sanitiseSettings,
  seedFromConfig,
  hasLocation,
  applyToConfig,
  toWeatherLocation,
  cleanCurrencyCode,
  createLocaleSettings,
};
