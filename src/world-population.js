/**
 * World Population Tracker — estimated live count from a UN-style baseline.
 *
 * No network at runtime. Population clocks are estimates anyway: take a
 * reference population at an epoch, then advance by (births − deaths) per
 * second derived from annual rates. Defaults follow UN WPP 2024 medium
 * figures for ~2026; Settings can retune the baseline without redeploying.
 */

const fs = require('fs');
const path = require('path');

const TYPE = 'world.population';
const SECONDS_PER_YEAR = 365.25 * 24 * 60 * 60;

/** UN WPP 2024 medium-inspired defaults (approximate 2026 calendar year). */
const DEFAULTS = Object.freeze({
  basePopulation: 8_266_429_563,
  baseAt: '2026-01-01T00:00:00.000Z',
  birthsPerYear: 132_500_000,
  deathsPerYear: 63_000_000,
  sourceLabel: 'UN WPP 2024 est.',
});

function toFinite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function cleanIso(value, fallback) {
  const raw = String(value || '').trim();
  const stamp = Date.parse(raw);
  if (!Number.isFinite(stamp)) {
    return fallback;
  }
  return new Date(stamp).toISOString();
}

function sanitiseSettings(raw = {}, base = DEFAULTS) {
  const incoming = raw && typeof raw === 'object' ? raw : {};
  const basePopulation = Math.max(0, Math.round(toFinite(
    incoming.basePopulation,
    base.basePopulation,
  )));
  const birthsPerYear = Math.max(0, Math.round(toFinite(
    incoming.birthsPerYear,
    base.birthsPerYear,
  )));
  const deathsPerYear = Math.max(0, Math.round(toFinite(
    incoming.deathsPerYear,
    base.deathsPerYear,
  )));
  return {
    basePopulation,
    baseAt: cleanIso(incoming.baseAt, base.baseAt),
    birthsPerYear,
    deathsPerYear,
    sourceLabel: String(incoming.sourceLabel || base.sourceLabel || '').trim().slice(0, 40)
      || base.sourceLabel,
  };
}

function ratesFromAnnual(settings) {
  const birthsPerSec = settings.birthsPerYear / SECONDS_PER_YEAR;
  const deathsPerSec = settings.deathsPerYear / SECONDS_PER_YEAR;
  return {
    birthsPerSec,
    deathsPerSec,
    netPerSec: birthsPerSec - deathsPerSec,
  };
}

/**
 * Point-in-time estimate. Pure — pass `now` for tests.
 */
function estimatePopulation(settings = DEFAULTS, now = Date.now()) {
  const cfg = sanitiseSettings(settings, DEFAULTS);
  const rates = ratesFromAnnual(cfg);
  const baseMs = Date.parse(cfg.baseAt);
  const elapsedSec = Math.max(0, (Number(now) - baseMs) / 1000);
  const population = Math.max(0, Math.round(
    cfg.basePopulation + (elapsedSec * rates.netPerSec),
  ));
  return {
    population,
    asOf: new Date(Number(now)).toISOString(),
    basePopulation: cfg.basePopulation,
    baseAt: cfg.baseAt,
    birthsPerYear: cfg.birthsPerYear,
    deathsPerYear: cfg.deathsPerYear,
    birthsPerSec: rates.birthsPerSec,
    deathsPerSec: rates.deathsPerSec,
    netPerSec: rates.netPerSec,
    sourceLabel: cfg.sourceLabel,
  };
}

/** `8266429563` → `8,266,429,563` (board-legal commas). */
function formatPopulation(value) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number) || number < 0) {
    return '';
  }
  return String(number).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** One decimal for per-second rates: `2.2`, `4.0`. */
function formatRate(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return '';
  }
  const fixed = Math.abs(number) >= 10 ? number.toFixed(0) : number.toFixed(1);
  return fixed.replace(/\.0$/, '');
}

function buildWorldPopulationPayload(settings = DEFAULTS, { asOf, now } = {}) {
  const stamp = asOf ? Date.parse(asOf) : (now != null ? Number(now) : Date.now());
  const estimate = estimatePopulation(settings, stamp);
  return {
    type: TYPE,
    asOf: estimate.asOf,
    population: {
      total: estimate.population,
      formatted: formatPopulation(estimate.population),
      birthsPerSec: estimate.birthsPerSec,
      deathsPerSec: estimate.deathsPerSec,
      netPerSec: estimate.netPerSec,
      sourceLabel: estimate.sourceLabel,
    },
  };
}

function createWorldPopulationSettings(config = {}, log = console) {
  const settingsPath = config.worldPopulationSettingsPath
    || path.resolve(config.ROOT || path.resolve(__dirname, '..'), 'data', 'world-population-settings.json');
  let current = sanitiseSettings({}, DEFAULTS);

  function load() {
    try {
      if (!fs.existsSync(settingsPath)) {
        current = sanitiseSettings({}, DEFAULTS);
        return current;
      }
      current = sanitiseSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), DEFAULTS);
    } catch (error) {
      log?.warn?.('Could not read World Population settings', error?.message || error);
      current = sanitiseSettings({}, DEFAULTS);
    }
    return current;
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
    } catch (error) {
      log?.warn?.('Could not save World Population settings', error?.message || error);
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
      current = sanitiseSettings({}, DEFAULTS);
      save();
      return this.get();
    },
    reload: load,
    path: settingsPath,
  };
}

function createWorldPopulation(config, log) {
  const settingsApi = createWorldPopulationSettings(config, log);

  return {
    getSettings: () => settingsApi.get(),
    updateSettings: (patch) => settingsApi.update(patch),
    resetSettings: () => settingsApi.reset(),
    statusSnapshot(now) {
      const settings = settingsApi.get();
      const estimate = estimatePopulation(settings, now);
      return {
        settings,
        defaults: { ...DEFAULTS },
        estimate,
        formatted: formatPopulation(estimate.population),
      };
    },
    nextPayload(options = {}) {
      return buildWorldPopulationPayload(settingsApi.get(), options);
    },
  };
}

module.exports = {
  TYPE,
  DEFAULTS,
  SECONDS_PER_YEAR,
  sanitiseSettings,
  ratesFromAnnual,
  estimatePopulation,
  formatPopulation,
  formatRate,
  buildWorldPopulationPayload,
  createWorldPopulationSettings,
  createWorldPopulation,
};
