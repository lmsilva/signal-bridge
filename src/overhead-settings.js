/**
 * Persisted settings for Overhead (flight radar).
 */

const fs = require('fs');
const path = require('path');

const LOOP_MODES = ['once', '2', '3', 'until-dismissed'];
const SORT_MODES = ['nearest', 'altitude', 'callsign'];
const ROWS_PER_PAGE = ['auto', 4, 6];
const PROVIDERS = ['airplanes-live', 'local-readsb', 'opensky'];
const MAP_STYLES = ['scope', 'tiles'];

const SLACK_SECONDS = 4;

function defaultSettings() {
  return {
    radiusNm: 40,
    refreshSeconds: 5,
    rowsPerPage: 'auto',
    pageSeconds: 8,
    maxPages: 6,
    loops: 'once',
    sort: 'nearest',
    altitudeFloorFt: 0,
    includeGround: false,
    showRoutes: true,
    provider: 'airplanes-live',
    localReceiverUrl: '',
    mapStyle: 'scope',
  };
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function rowsPerPageValue(rowsPerPage, aircraftCount = 0) {
  if (rowsPerPage === 4 || rowsPerPage === 6) {
    return rowsPerPage;
  }
  // Auto: conservative estimate for duration — client may pick 4 or 6 at render.
  return aircraftCount > 12 ? 6 : 4;
}

function pageCount(settings = {}, aircraftCount = 0) {
  const rows = rowsPerPageValue(settings.rowsPerPage, aircraftCount);
  const maxPages = clampInt(settings.maxPages, 1, 12, 6);
  if (!aircraftCount) return 1;
  return Math.min(maxPages, Math.ceil(aircraftCount / rows));
}

function loopCount(loops) {
  if (loops === 'until-dismissed') return 0;
  if (loops === 'once') return 1;
  const n = Number(loops);
  return Number.isFinite(n) && n > 0 ? Math.max(1, Math.round(n)) : 1;
}

function cycleSecondsFor(settings = {}, aircraftCount = 0) {
  const pages = pageCount(settings, aircraftCount);
  const pageSeconds = clampInt(settings.pageSeconds, 3, 60, 8);
  return pages * pageSeconds;
}

function estimateDuration(settings = {}, aircraftCount = 0) {
  const oneCycle = cycleSecondsFor(settings, aircraftCount);
  const loops = loopCount(settings.loops);
  return (loops > 0 ? oneCycle * loops : oneCycle) + SLACK_SECONDS;
}

function sanitiseSettings(raw = {}, base = defaultSettings()) {
  const merged = { ...base, ...(raw || {}) };
  const loops = LOOP_MODES.includes(String(merged.loops))
    ? String(merged.loops)
    : base.loops;
  const sort = SORT_MODES.includes(String(merged.sort))
    ? String(merged.sort)
    : base.sort;
  let rowsPerPage = merged.rowsPerPage;
  if (rowsPerPage !== 'auto') {
    const n = Number(rowsPerPage);
    rowsPerPage = (n === 4 || n === 6) ? n : base.rowsPerPage;
  }
  const provider = PROVIDERS.includes(String(merged.provider))
    ? String(merged.provider)
    : base.provider;
  const mapStyle = MAP_STYLES.includes(String(merged.mapStyle))
    ? String(merged.mapStyle)
    : base.mapStyle;

  return {
    radiusNm: clampInt(merged.radiusNm, 10, 150, base.radiusNm),
    refreshSeconds: clampInt(merged.refreshSeconds, 3, 30, base.refreshSeconds),
    rowsPerPage,
    pageSeconds: clampInt(merged.pageSeconds, 3, 60, base.pageSeconds),
    maxPages: clampInt(merged.maxPages, 1, 12, base.maxPages),
    loops,
    sort,
    altitudeFloorFt: clampInt(merged.altitudeFloorFt, 0, 60000, base.altitudeFloorFt),
    includeGround: merged.includeGround === true,
    showRoutes: merged.showRoutes !== false,
    provider,
    localReceiverUrl: String(merged.localReceiverUrl || '').trim().slice(0, 500),
    mapStyle,
  };
}

function createOverheadSettings(config = {}, log = console) {
  const settingsPath = config.overheadSettingsPath
    || path.resolve(config.ROOT || path.resolve(__dirname, '..'), 'data', 'overhead-settings.json');
  let current = defaultSettings();

  function load() {
    try {
      if (!fs.existsSync(settingsPath)) {
        current = defaultSettings();
        return current;
      }
      current = sanitiseSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8')));
    } catch (error) {
      log?.warn?.('Could not read overhead settings', error?.message || error);
      current = defaultSettings();
    }
    return current;
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
    } catch (error) {
      log?.warn?.('Could not save overhead settings', error?.message || error);
    }
  }

  load();

  return {
    get: () => ({ ...current }),
    update(patch = {}) {
      current = sanitiseSettings({ ...current, ...patch }, current);
      save();
      return { ...current };
    },
    path: settingsPath,
  };
}

module.exports = {
  LOOP_MODES,
  SORT_MODES,
  ROWS_PER_PAGE,
  PROVIDERS,
  MAP_STYLES,
  SLACK_SECONDS,
  defaultSettings,
  sanitiseSettings,
  rowsPerPageValue,
  pageCount,
  loopCount,
  cycleSecondsFor,
  estimateDuration,
  createOverheadSettings,
};
