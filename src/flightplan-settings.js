/**
 * Flight Plan settings — persisted beside other bridge state.
 */

const fs = require('fs');
const path = require('path');

const DEFAULTS = Object.freeze({
  enabled: false,
  homeAirport: 'SLC',
  softCapUnits: 500,
  hardCapUnits: 600,
  billingCycleDay: 1,
  autoPushEnabled: true,
  autoPushCooldownMinutes: 10,
  materialDelayMinutes: 15,
  livePositionStaleMinutes: 15,
  searchCacheHours: 6,
  imageCandidateCount: 4,
  displaySeconds: 120,
  pollerLogOnly: true,
});

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function normaliseIata(value, fallback = '') {
  const text = String(value || '').trim().toUpperCase();
  if (!text) return fallback;
  if (/^[A-Z0-9]{3,4}$/.test(text)) return text;
  return fallback;
}

function sanitiseSettings(raw = {}, base = DEFAULTS) {
  const merged = { ...base, ...(raw || {}) };
  const softCap = clampInt(merged.softCapUnits, 100, 5000, base.softCapUnits);
  const hardCap = clampInt(merged.hardCapUnits, softCap, 10000, base.hardCapUnits);
  return {
    enabled: merged.enabled === true,
    homeAirport: normaliseIata(merged.homeAirport, base.homeAirport),
    softCapUnits: softCap,
    hardCapUnits: hardCap,
    billingCycleDay: clampInt(merged.billingCycleDay, 1, 28, base.billingCycleDay),
    autoPushEnabled: merged.autoPushEnabled !== false,
    autoPushCooldownMinutes: clampInt(merged.autoPushCooldownMinutes, 1, 120, base.autoPushCooldownMinutes),
    materialDelayMinutes: clampInt(merged.materialDelayMinutes, 5, 120, base.materialDelayMinutes),
    livePositionStaleMinutes: clampInt(merged.livePositionStaleMinutes, 5, 60, base.livePositionStaleMinutes),
    searchCacheHours: clampInt(merged.searchCacheHours, 1, 72, base.searchCacheHours),
    imageCandidateCount: clampInt(merged.imageCandidateCount, 1, 8, base.imageCandidateCount),
    displaySeconds: clampInt(merged.displaySeconds, 30, 600, base.displaySeconds),
    pollerLogOnly: merged.pollerLogOnly !== false,
  };
}

function createFlightplanSettings(config = {}, log = console) {
  const root = config.ROOT || path.resolve(__dirname, '..');
  const settingsPath = path.resolve(
    config.flightplanSettingsPath || path.join(root, 'data', 'flightplan-settings.json'),
  );
  let settings = sanitiseSettings(config.flightplan || {});

  function loadFromDisk() {
    try {
      if (!fs.existsSync(settingsPath)) return;
      settings = sanitiseSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8')));
    } catch (error) {
      log?.warn?.('Could not read Flight Plan settings — using defaults', error?.message || error);
    }
  }

  loadFromDisk();

  function persist() {
    try {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    } catch (error) {
      log?.warn?.('Could not persist Flight Plan settings', error?.message || error);
    }
  }

  function get() {
    loadFromDisk();
    return { ...settings };
  }

  function update(patch = {}) {
    loadFromDisk();
    settings = sanitiseSettings({ ...settings, ...(patch || {}) });
    persist();
    return { ok: true, settings: { ...settings } };
  }

  return {
    get,
    update,
    settingsPath,
    DEFAULTS,
    sanitiseSettings,
  };
}

module.exports = {
  createFlightplanSettings,
  DEFAULTS,
  sanitiseSettings,
  normaliseIata,
};
