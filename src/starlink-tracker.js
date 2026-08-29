/**
 * Starlink Tracker — next visible Starlink pass / train over the house pin.
 *
 * Free Satlas pass predictions (no API key) across a sample of Starlink NORAD
 * ids; optional Open-Meteo cloud cover for local sky conditions. Settings in
 * data/starlink-tracker-settings.json.
 */

const fs = require('fs');
const path = require('path');
const { fold } = require('./vestaboard/encoder');
const { dateParts, clockLabel, weekday, dayPhrase } = require('./vestaboard/clock');

const TYPE = 'starlink.track';
const SATLAS_BASE = 'https://satlas.app/api';
const USER_AGENT = 'Mozilla/5.0 (compatible; SignalBridge/1.0)';
const DEFAULT_TIMEOUT_MS = 12000;
const TRAIN_WINDOW_MS = 8 * 60 * 1000;

const DEFAULT_SETTINGS = Object.freeze({
  hoursAhead: 72,
  minElevation: 20,
  sampleSize: 8,
  preferVisible: true,
  showWeather: true,
  showVisibility: true,
});

function sanitiseSettings(raw = {}, base = DEFAULT_SETTINGS) {
  const incoming = raw && typeof raw === 'object' ? raw : {};
  const hoursAhead = Math.min(168, Math.max(12, Math.round(
    Number(incoming.hoursAhead != null ? incoming.hoursAhead : base.hoursAhead) || 72,
  )));
  const minElevation = Math.min(60, Math.max(5, Math.round(
    Number(incoming.minElevation != null ? incoming.minElevation : base.minElevation) || 20,
  )));
  const sampleSize = Math.min(16, Math.max(3, Math.round(
    Number(incoming.sampleSize != null ? incoming.sampleSize : base.sampleSize) || 8,
  )));
  return {
    hoursAhead,
    minElevation,
    sampleSize,
    preferVisible: incoming.preferVisible != null
      ? Boolean(incoming.preferVisible)
      : Boolean(base.preferVisible),
    showWeather: incoming.showWeather != null
      ? Boolean(incoming.showWeather)
      : Boolean(base.showWeather),
    showVisibility: incoming.showVisibility != null
      ? Boolean(incoming.showVisibility)
      : Boolean(base.showVisibility),
  };
}

function createStarlinkTrackerSettings(config = {}, log = console) {
  const settingsPath = config.starlinkTrackerSettingsPath
    || path.resolve(config.ROOT || path.resolve(__dirname, '..'), 'data', 'starlink-tracker-settings.json');
  let current = sanitiseSettings({}, DEFAULT_SETTINGS);

  function load() {
    try {
      if (!fs.existsSync(settingsPath)) {
        current = sanitiseSettings({}, DEFAULT_SETTINGS);
        return current;
      }
      current = sanitiseSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), DEFAULT_SETTINGS);
    } catch (error) {
      log?.warn?.('Could not read Starlink tracker settings', error?.message || error);
      current = sanitiseSettings({}, DEFAULT_SETTINGS);
    }
    return current;
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
    } catch (error) {
      log?.warn?.('Could not save Starlink tracker settings', error?.message || error);
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

async function fetchStarlinkSample({
  sampleSize = 8,
  fetchImpl,
  timeoutMs,
} = {}) {
  const want = Math.min(40, Math.max(sampleSize * 3, sampleSize));
  const data = await fetchJson(
    `${SATLAS_BASE}/satellites?category=STARLINK&limit=${want}`,
    { fetchImpl, timeoutMs },
  );
  const results = Array.isArray(data?.results) ? data.results : [];
  // Newer catalog numbers are more likely to still fly as visible trains.
  const sorted = [...results].sort(
    (a, b) => Number(b.norad_id) - Number(a.norad_id),
  );
  return sorted.slice(0, sampleSize).map((row) => ({
    name: String(row.name || ''),
    noradId: String(row.norad_id || ''),
  })).filter((row) => row.noradId);
}

function normalisePass(raw = {}, sat = {}) {
  const startUtc = raw.start_utc || raw.startUtc || '';
  const endUtc = raw.end_utc || raw.endUtc || '';
  const startMs = Date.parse(startUtc);
  if (!Number.isFinite(startMs)) {
    return null;
  }
  const elevation = Number(raw.max_elevation_deg ?? raw.maxElevationDeg);
  const score = Number(raw.visibility_score ?? raw.visibilityScore);
  return {
    startUtc,
    endUtc,
    startMs,
    maxElevationDeg: Number.isFinite(elevation) ? elevation : 0,
    direction: String(raw.direction || '').trim().toUpperCase(),
    skyCondition: String(raw.sky_condition || raw.skyCondition || '').trim(),
    visibilityScore: Number.isFinite(score) ? score : 0,
    visibilityLabel: String(raw.visibility_label || raw.visibilityLabel || '').trim(),
    satelliteIlluminated: Boolean(raw.satellite_illuminated ?? raw.satelliteIlluminated),
    noradId: sat.noradId || '',
    name: sat.name || '',
  };
}

async function fetchPassesForSat(sat, {
  latitude,
  longitude,
  hoursAhead = 72,
  fetchImpl,
  timeoutMs,
} = {}) {
  const url = `${SATLAS_BASE}/pass?norad_id=${encodeURIComponent(sat.noradId)}`
    + `&latitude=${encodeURIComponent(latitude)}`
    + `&longitude=${encodeURIComponent(longitude)}`
    + `&hours_ahead=${encodeURIComponent(hoursAhead)}`;
  try {
    const data = await fetchJson(url, { fetchImpl, timeoutMs });
    const list = Array.isArray(data?.passes) ? data.passes : [];
    return list.map((row) => normalisePass(row, sat)).filter(Boolean);
  } catch {
    return [];
  }
}

function isLikelyVisible(pass) {
  if (!pass) {
    return false;
  }
  if (pass.visibilityScore > 0) {
    return true;
  }
  const label = String(pass.visibilityLabel || '').toLowerCase();
  if (label && label !== 'none' && label !== 'poor') {
    return true;
  }
  const sky = String(pass.skyCondition || '').toLowerCase();
  return pass.satelliteIlluminated && (sky.includes('night') || sky.includes('twilight'));
}

function pickNextPass(passes, {
  minElevation = 20,
  preferVisible = true,
  nowMs = Date.now(),
} = {}) {
  const future = (passes || [])
    .filter((pass) => pass.startMs >= nowMs - 60_000)
    .filter((pass) => pass.maxElevationDeg >= minElevation)
    .sort((a, b) => a.startMs - b.startMs || b.maxElevationDeg - a.maxElevationDeg);

  if (!future.length) {
    return null;
  }

  const visible = preferVisible ? future.filter(isLikelyVisible) : future;
  const pool = visible.length ? visible : future;
  const lead = pool[0];
  const train = pool.filter((pass) => Math.abs(pass.startMs - lead.startMs) <= TRAIN_WINDOW_MS);
  const best = train.reduce((winner, pass) => (
    pass.maxElevationDeg > winner.maxElevationDeg ? pass : winner
  ), lead);

  return {
    ...best,
    trainCount: train.length,
  };
}

function elevationBand(degrees) {
  const value = Number(degrees);
  if (!Number.isFinite(value)) {
    return '';
  }
  if (value >= 60) {
    return 'HIGH';
  }
  if (value >= 30) {
    return 'MID';
  }
  return 'LOW';
}

function formatWhenLabel(startMs, { timeZone, nowMs = Date.now() } = {}) {
  const at = new Date(startMs);
  const clock = clockLabel(at, { timeZone }).replace(/\s+/g, '');
  const phrase = dayPhrase(at, new Date(nowMs), { timeZone });
  if (phrase === 'TODAY') {
    const parts = dateParts(at, timeZone);
    const tonight = parts && (parts.hour >= 17 || parts.hour < 5);
    const day = tonight ? 'TONIGHT' : 'TODAY';
    return fold(`${day} ${clock}`).slice(0, 22);
  }
  if (phrase === 'TOMORROW') {
    return fold(`TOMORROW ${clock}`).slice(0, 22);
  }
  const day = weekday(at, { short: true, timeZone }) || phrase;
  return fold(`${day} ${clock}`).slice(0, 22);
}

function formatDirectionLabel(pass) {
  const dir = fold(pass.direction || '').slice(0, 3);
  const elev = Math.round(Number(pass.maxElevationDeg) || 0);
  const band = elevationBand(elev);
  if (dir && elev > 0) {
    const line = band ? `${dir} ${band} ${elev}DEG` : `${dir} ${elev}DEG`;
    return fold(line).slice(0, 22);
  }
  if (dir) {
    return fold(`LOOK ${dir}`).slice(0, 22);
  }
  return fold(`${elev} DEG HIGH`).slice(0, 22);
}

function formatVisibilityBoard(pass) {
  const label = fold(pass.visibilityLabel || '').slice(0, 22);
  if (label && label !== 'NONE') {
    return label;
  }
  if (isLikelyVisible(pass)) {
    return 'VISIBLE';
  }
  const sky = fold(pass.skyCondition || '').slice(0, 22);
  return sky || '';
}

function weatherConditionLabel(condition) {
  const raw = String(condition || '').toLowerCase();
  if (!raw) {
    return '';
  }
  if (raw.includes('clear') || raw === 'sunny') {
    return 'CLEAR SKY';
  }
  if (raw.includes('partly')) {
    return 'PARTLY CLOUDY';
  }
  if (raw.includes('cloud') || raw === 'overcast') {
    return 'CLOUDY';
  }
  if (raw.includes('rain') || raw.includes('drizzle') || raw.includes('shower')) {
    return 'RAINY';
  }
  if (raw.includes('snow')) {
    return 'SNOW';
  }
  if (raw.includes('fog') || raw.includes('mist')) {
    return 'FOGGY';
  }
  if (raw.includes('thunder') || raw.includes('storm')) {
    return 'STORMS';
  }
  return fold(raw.replace(/_/g, ' ')).slice(0, 22);
}

function weatherNearPass(weather, startMs) {
  const hours = weather?.hourly || [];
  if (!hours.length || !Number.isFinite(startMs)) {
    return weatherConditionLabel(weather?.current?.condition);
  }
  let best = null;
  let bestDelta = Infinity;
  for (const hour of hours) {
    const at = Date.parse(`${hour.time}Z`);
    if (!Number.isFinite(at)) {
      continue;
    }
    const delta = Math.abs(at - startMs);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = hour;
    }
  }
  return weatherConditionLabel(best?.condition || weather?.current?.condition);
}

function buildStarlinkTrackPayload({
  pass,
  locale = {},
  settings = DEFAULT_SETTINGS,
  weather = null,
  asOf,
  source = 'satlas',
  nowMs = Date.now(),
} = {}) {
  if (!pass?.startMs) {
    return null;
  }
  const cfg = sanitiseSettings(settings, DEFAULT_SETTINGS);
  const timeZone = locale.timeZone || 'America/Denver';
  const whenLabel = formatWhenLabel(pass.startMs, { timeZone, nowMs });
  const directionLabel = formatDirectionLabel(pass);
  const visibilityBoard = formatVisibilityBoard(pass);
  const weatherLabel = cfg.showWeather ? weatherNearPass(weather, pass.startMs) : '';
  const city = fold(locale.city || locale.label || 'HOME').split(',')[0].trim().slice(0, 18);

  return {
    type: TYPE,
    asOf: asOf || new Date(nowMs).toISOString(),
    source,
    startUtc: pass.startUtc,
    endUtc: pass.endUtc,
    maxElevationDeg: pass.maxElevationDeg,
    direction: pass.direction,
    skyCondition: pass.skyCondition,
    visibilityScore: pass.visibilityScore,
    visibilityLabel: pass.visibilityLabel,
    trainCount: pass.trainCount || 1,
    noradId: pass.noradId,
    name: pass.name,
    whenLabel,
    directionLabel,
    visibilityBoard,
    weatherLabel,
    lookLabel: pass.direction ? fold(`LOOK ${pass.direction}`).slice(0, 22) : '',
    home: {
      city,
      latitude: Number(locale.latitude),
      longitude: Number(locale.longitude),
      timeZone,
      label: locale.label || locale.city || '',
    },
    settings: cfg,
  };
}

async function loadStarlinkTrackPayload({
  locale = {},
  settings = DEFAULT_SETTINGS,
  fetchImpl,
  timeoutMs,
  weatherFetch,
  nowMs = Date.now(),
} = {}) {
  const cfg = sanitiseSettings(settings, DEFAULT_SETTINGS);
  const latitude = Number(locale.latitude);
  const longitude = Number(locale.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    const err = new Error('Set the house location under Settings → Global');
    err.code = 'NO_LOCATION';
    throw err;
  }

  const sample = await fetchStarlinkSample({
    sampleSize: cfg.sampleSize,
    fetchImpl,
    timeoutMs,
  });
  if (!sample.length) {
    throw new Error('No Starlink satellites in the catalog');
  }

  const batches = await Promise.all(sample.map((sat) => fetchPassesForSat(sat, {
    latitude,
    longitude,
    hoursAhead: cfg.hoursAhead,
    fetchImpl,
    timeoutMs,
  })));
  const passes = batches.flat();
  const pass = pickNextPass(passes, {
    minElevation: cfg.minElevation,
    preferVisible: cfg.preferVisible,
    nowMs,
  });
  if (!pass) {
    return {
      type: TYPE,
      asOf: new Date(nowMs).toISOString(),
      source: 'satlas',
      mode: 'none',
      whenLabel: 'NO PASS SOON',
      directionLabel: fold(`NEXT ${cfg.hoursAhead}H`).slice(0, 22),
      visibilityBoard: '',
      weatherLabel: '',
      lookLabel: '',
      home: {
        city: fold(locale.city || locale.label || 'HOME').split(',')[0].trim().slice(0, 18),
        latitude,
        longitude,
        timeZone: locale.timeZone || 'America/Denver',
      },
      settings: cfg,
    };
  }

  let weather = null;
  if (cfg.showWeather && typeof weatherFetch === 'function') {
    try {
      weather = await weatherFetch({
        latitude,
        longitude,
        name: locale.city || locale.label || 'Home',
      });
    } catch {
      weather = null;
    }
  }

  return buildStarlinkTrackPayload({
    pass,
    locale,
    settings: cfg,
    weather,
    source: 'satlas',
    nowMs,
  });
}

function createStarlinkTracker(config = {}, log = console) {
  const settingsApi = createStarlinkTrackerSettings(config, log);
  const defaultFetch = typeof config.starlinkTrackerFetchImpl === 'function'
    ? config.starlinkTrackerFetchImpl
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
        source: 'satlas',
      };
    },
    async nextPayload({ locale, fetchImpl, timeoutMs, weatherFetch } = {}) {
      return loadStarlinkTrackPayload({
        locale: locale || {},
        settings: settingsApi.get(),
        fetchImpl: fetchImpl || defaultFetch,
        timeoutMs,
        weatherFetch,
      });
    },
  };
}

module.exports = {
  TYPE,
  DEFAULT_SETTINGS,
  TRAIN_WINDOW_MS,
  sanitiseSettings,
  normalisePass,
  pickNextPass,
  isLikelyVisible,
  elevationBand,
  formatWhenLabel,
  formatDirectionLabel,
  formatVisibilityBoard,
  weatherConditionLabel,
  weatherNearPass,
  buildStarlinkTrackPayload,
  loadStarlinkTrackPayload,
  fetchStarlinkSample,
  createStarlinkTrackerSettings,
  createStarlinkTracker,
};
