/**
 * US Weather Map — the continental US painted in colour chips.
 *
 * The marketplace channel draws a fixed 22x6 silhouette of the lower 48 and
 * colours each flap by what the weather is doing at that point. No text: the
 * whole board is the map, so the only thing to get right is which flap gets
 * which colour.
 *
 * The silhouette below was traced off the channel's own cards, which all share
 * one mask down to the flap. Note the notch in rows 0-1 around columns 15-19:
 * that is the Great Lakes, and the two cells hanging off the right of row 0
 * are New England reaching up past them. The two lonely cells on row 5 are the
 * tip of Texas and the tip of Florida.
 */

const fs = require('fs');
const path = require('path');
const { CHIPS } = require('./vestaboard/encoder');

const TYPE = 'us.weather-map';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const USER_AGENT = 'signal-bridge/1.0 (+vestaboard)';
const DEFAULT_TIMEOUT_MS = 12000;

/** `#` is land the channel paints, `.` is a flap left blank. */
const MASK = Object.freeze([
  '###############.....##',
  '################..###.',
  '.###################..',
  '..#################...',
  '...###############....',
  '..........#......#....',
]);

// A plain equirectangular fit, anchored on the three corners the mask makes
// unambiguous: row 5 column 10 is the tip of Texas, row 5 column 17 is the tip
// of Florida, and row 0 column 0 is the northwest corner of Washington. Two
// anchors fix the longitude scale and the third falls out at -122.3, which is
// Puget Sound — so the fit is the channel's own.
//
// At 2.4 degrees a flap this is a caricature, and a handful of edge cells land
// just offshore or just over a border. That is fine: the model has weather
// everywhere, and at this resolution a neighbouring reading is the same colour.
const LON_WEST = -122.3;
const LON_STEP = 2.43;
const LAT_NORTH = 47.0;
const LAT_STEP = -4.2;

/**
 * Temperature bands, coldest first, in Fahrenheit.
 *
 * Six bands for six chips. White reads as snow and sits at the cold end rather
 * than the middle, which is what the channel's winter card does: a board that
 * is white across the north and blue across the south.
 */
const TEMPERATURE_BANDS = Object.freeze([
  { chip: 'white', maxF: 32, label: 'Below 32' },
  { chip: 'blue', maxF: 50, label: '32 to 49' },
  { chip: 'green', maxF: 65, label: '50 to 64' },
  { chip: 'yellow', maxF: 80, label: '65 to 79' },
  { chip: 'orange', maxF: 95, label: '80 to 94' },
  { chip: 'red', maxF: Infinity, label: '95 and up' },
]);

/**
 * WMO weather codes to chips, for the channel's other mode.
 *
 * Overcast, fog and snow all land on white — a white sky and a white ground
 * read the same from across a room, and splitting them would spend a chip on a
 * distinction nobody makes at this size.
 */
const CONDITION_BANDS = Object.freeze([
  { chip: 'yellow', label: 'Clear', codes: [0, 1] },
  { chip: 'green', label: 'Partly cloudy', codes: [2] },
  { chip: 'white', label: 'Cloud, fog or snow', codes: [3, 45, 48, 71, 73, 75, 77, 85, 86] },
  { chip: 'blue', label: 'Rain', codes: [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82] },
  { chip: 'violet', label: 'Storms', codes: [95, 96, 99] },
]);

const CONDITION_CHIP_BY_CODE = (() => {
  const map = new Map();
  for (const band of CONDITION_BANDS) {
    for (const code of band.codes) {
      map.set(code, band.chip);
    }
  }
  return map;
})();

const MODES = Object.freeze(['temperature', 'conditions']);

const DEFAULT_SETTINGS = Object.freeze({
  mode: 'temperature',
  refreshMinutes: 30,
});

/** Every land flap, in reading order, with the point it samples. */
const CELLS = Object.freeze(MASK.flatMap((line, row) => (
  [...line].flatMap((mark, col) => (mark === '#' ? [Object.freeze({
    row,
    col,
    lat: Number((LAT_NORTH + LAT_STEP * row).toFixed(4)),
    lon: Number((LON_WEST + LON_STEP * col).toFixed(4)),
  })] : []))
)));

function celsiusToFahrenheit(celsius) {
  return (Number(celsius) * 9) / 5 + 32;
}

function fahrenheitToCelsius(fahrenheit) {
  return ((Number(fahrenheit) - 32) * 5) / 9;
}

function chipForTemperature(fahrenheit) {
  // Number(null) is 0, which would paint a missing reading as a hard freeze
  // rather than reporting the hole.
  if (fahrenheit == null || fahrenheit === '') {
    return null;
  }
  const value = Number(fahrenheit);
  if (!Number.isFinite(value)) {
    return null;
  }
  return (TEMPERATURE_BANDS.find((band) => value < band.maxF)
    || TEMPERATURE_BANDS[TEMPERATURE_BANDS.length - 1]).chip;
}

function chipForCondition(code) {
  if (code == null || code === '') {
    return null;
  }
  const value = Number(code);
  if (!Number.isFinite(value)) {
    return null;
  }
  // An unlisted code is some flavour of cloud; that is the safe default and it
  // keeps a gap in the WMO table from punching a hole in the map.
  return CONDITION_CHIP_BY_CODE.get(value) || 'white';
}

function cleanMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  return MODES.includes(mode) ? mode : DEFAULT_SETTINGS.mode;
}

function sanitiseSettings(raw = {}, base = DEFAULT_SETTINGS) {
  const incoming = raw || {};
  const minutes = Number(
    incoming.refreshMinutes != null ? incoming.refreshMinutes : base.refreshMinutes,
  );
  return {
    mode: cleanMode(incoming.mode != null ? incoming.mode : base.mode),
    refreshMinutes: Number.isFinite(minutes)
      ? Math.min(360, Math.max(10, Math.round(minutes)))
      : DEFAULT_SETTINGS.refreshMinutes,
  };
}

function createUsWeatherMapSettings(config = {}, log = console) {
  const settingsPath = config.usWeatherMapSettingsPath
    || path.resolve(config.ROOT || path.resolve(__dirname, '..'), 'data', 'us-weather-map-settings.json');
  let current = sanitiseSettings({}, DEFAULT_SETTINGS);

  function load() {
    try {
      if (fs.existsSync(settingsPath)) {
        current = sanitiseSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), DEFAULT_SETTINGS);
      }
    } catch (error) {
      log?.warn?.('Could not read US Weather Map settings', error?.message || error);
      current = sanitiseSettings({}, DEFAULT_SETTINGS);
    }
    return current;
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
    } catch (error) {
      log?.warn?.('Could not save US Weather Map settings', error?.message || error);
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
    reset() {
      current = sanitiseSettings({}, DEFAULT_SETTINGS);
      save();
      return { ...current };
    },
    reload: load,
    path: settingsPath,
  };
}

/**
 * One request for the whole map.
 *
 * Open-Meteo takes comma-separated coordinate lists and answers with an array
 * in the same order, so 89 points cost one call and no key. Asking per point
 * would be 89 calls for a board that changes once an hour.
 */
async function fetchMapReadings({
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  cells = CELLS,
} = {}) {
  const params = new URLSearchParams({
    latitude: cells.map((cell) => cell.lat).join(','),
    longitude: cells.map((cell) => cell.lon).join(','),
    current: 'temperature_2m,weather_code',
    temperature_unit: 'fahrenheit',
    timezone: 'UTC',
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
  let payload;
  try {
    const response = await fetchImpl(`${FORECAST_URL}?${params}`, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`Open-Meteo returned HTTP ${response.status}`);
    }
    payload = await response.json();
  } finally {
    clearTimeout(timer);
  }

  // A single-point request answers with an object, so normalise before reading.
  const list = Array.isArray(payload) ? payload : [payload];
  if (list.length !== cells.length) {
    throw new Error(`Open-Meteo returned ${list.length} points for ${cells.length} cells`);
  }
  return cells.map((cell, index) => {
    const current = list[index]?.current || {};
    const tempF = Number(current.temperature_2m);
    return {
      ...cell,
      tempF: Number.isFinite(tempF) ? Math.round(tempF) : null,
      tempC: Number.isFinite(tempF) ? Math.round(fahrenheitToCelsius(tempF)) : null,
      code: Number.isFinite(Number(current.weather_code)) ? Number(current.weather_code) : null,
    };
  });
}

function buildUsWeatherMapPayload({
  readings = [],
  mode = DEFAULT_SETTINGS.mode,
  unit = 'F',
  asOf = null,
} = {}) {
  const wanted = cleanMode(mode);
  const cells = [];
  for (const reading of readings) {
    const chip = wanted === 'conditions'
      ? chipForCondition(reading.code)
      : chipForTemperature(reading.tempF);
    if (!chip) {
      continue;
    }
    cells.push({
      row: reading.row,
      col: reading.col,
      chip,
      tempF: reading.tempF ?? null,
      tempC: reading.tempC ?? null,
      code: reading.code ?? null,
    });
  }
  // Half a map is a broken map, not a partial one.
  if (cells.length < CELLS.length) {
    return null;
  }
  const temps = cells.map((cell) => cell.tempF).filter((value) => Number.isFinite(value));
  return {
    type: TYPE,
    asOf: asOf || new Date().toISOString(),
    mode: wanted,
    unit: unit === 'C' ? 'C' : 'F',
    cells,
    range: temps.length
      ? {
        minF: Math.min(...temps),
        maxF: Math.max(...temps),
        minC: Math.round(fahrenheitToCelsius(Math.min(...temps))),
        maxC: Math.round(fahrenheitToCelsius(Math.max(...temps))),
      }
      : null,
  };
}

/** The legend the settings card draws, in the unit the house reads in. */
function legendFor(mode = DEFAULT_SETTINGS.mode, unit = 'F') {
  if (cleanMode(mode) === 'conditions') {
    return CONDITION_BANDS.map((band) => ({ chip: band.chip, label: band.label }));
  }
  return TEMPERATURE_BANDS.map((band, index) => {
    const lowF = index === 0 ? null : TEMPERATURE_BANDS[index - 1].maxF;
    const highF = band.maxF === Infinity ? null : band.maxF - 1;
    const convert = (value) => (unit === 'C' ? Math.round(fahrenheitToCelsius(value)) : value);
    const suffix = unit === 'C' ? 'C' : 'F';
    if (lowF == null) {
      return { chip: band.chip, label: `Below ${convert(band.maxF)}${suffix}` };
    }
    if (highF == null) {
      return { chip: band.chip, label: `${convert(lowF)}${suffix} and up` };
    }
    return { chip: band.chip, label: `${convert(lowF)} to ${convert(highF)}${suffix}` };
  });
}

function createUsWeatherMap(config = {}, log = console, { getLocaleSettings = null } = {}) {
  const settingsApi = createUsWeatherMapSettings(config, log);
  const defaultFetch = typeof config.usWeatherMapFetchImpl === 'function'
    ? config.usWeatherMapFetchImpl
    : fetch;

  let cache = null;
  let lastError = null;

  const unit = () => (getLocaleSettings?.()?.temperatureUnit === 'C' ? 'C' : 'F');

  function cacheAgeMs(now) {
    return cache ? now - cache.at : Infinity;
  }

  async function readings({ fetchImpl, timeoutMs, now = Date.now(), force = false } = {}) {
    const settings = settingsApi.get();
    const ttl = settings.refreshMinutes * 60 * 1000;
    if (!force && cache && cacheAgeMs(now) < ttl) {
      return cache.readings;
    }
    try {
      const fresh = await fetchMapReadings({
        fetchImpl: fetchImpl || defaultFetch,
        timeoutMs,
      });
      cache = { at: now, readings: fresh };
      lastError = null;
      return fresh;
    } catch (error) {
      lastError = error?.message || String(error);
      // A stale map beats a blank board, so an expired cache still gets used
      // when the network is the thing that broke.
      if (cache) {
        log?.warn?.('US Weather Map falling back to the cached map', lastError);
        return cache.readings;
      }
      throw error;
    }
  }

  return {
    getSettings: () => settingsApi.get(),
    updateSettings: (patch) => settingsApi.update(patch),
    resetSettings: () => settingsApi.reset(),
    statusSnapshot() {
      const settings = settingsApi.get();
      const currentUnit = unit();
      return {
        settings,
        unit: currentUnit,
        modes: [...MODES],
        cellCount: CELLS.length,
        legend: legendFor(settings.mode, currentUnit),
        // Sync and never networked — the scheduler asks this on every tick.
        hasMap: Boolean(cache),
        mapAgeMinutes: cache ? Math.round((Date.now() - cache.at) / 60000) : null,
        lastError,
        defaults: { ...DEFAULT_SETTINGS },
      };
    },
    async nextPayload(options = {}) {
      const settings = settingsApi.get();
      return buildUsWeatherMapPayload({
        readings: await readings(options),
        mode: options.mode || settings.mode,
        unit: unit(),
        asOf: options.asOf,
      });
    },
  };
}

module.exports = {
  TYPE,
  MASK,
  CELLS,
  CHIPS,
  MODES,
  DEFAULT_SETTINGS,
  TEMPERATURE_BANDS,
  CONDITION_BANDS,
  LON_WEST,
  LON_STEP,
  LAT_NORTH,
  LAT_STEP,
  celsiusToFahrenheit,
  fahrenheitToCelsius,
  chipForTemperature,
  chipForCondition,
  cleanMode,
  sanitiseSettings,
  legendFor,
  fetchMapReadings,
  buildUsWeatherMapPayload,
  createUsWeatherMapSettings,
  createUsWeatherMap,
};
