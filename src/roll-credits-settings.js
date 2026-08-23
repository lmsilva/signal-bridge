const fs = require('fs');
const path = require('path');

const VALID_ORDERS = ['recent', 'oldest', 'random', 'alpha'];
const VALID_MEDIA_KINDS = ['video', 'screenshot', 'cover'];
const VALID_PROVIDERS = ['igdb', 'steam'];
const VALID_RESOLUTIONS = [360, 480, 720, 1080];

const DEFAULTS = Object.freeze({
  mediaPriority: Object.freeze(['video', 'screenshot', 'cover']),
  youtube: Object.freeze({ downloadEnabled: true, defaultResolution: 720 }),
  scrape: Object.freeze({
    maxScreenshots: 6,
    downloadVideo: true,
    providerOrder: Object.freeze(['igdb', 'steam']),
  }),
  display: Object.freeze({
    secondsPerGame: 12,
    dashboardSeconds: 25,
    order: 'recent',
    scheduledGameLimit: 15,
  }),
  limits: Object.freeze({
    maxImageBytes: 10_485_760,
    maxVideoBytes: 314_572_800,
  }),
});

function cloneDefaults() {
  return JSON.parse(JSON.stringify(DEFAULTS));
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(number)));
}

function sanitiseOrderedList(value, allowed, fallback) {
  if (!Array.isArray(value)) {
    return [...fallback];
  }
  const result = [...new Set(value.map((item) => String(item).toLowerCase()))]
    .filter((item) => allowed.includes(item));
  for (const item of fallback) {
    if (!result.includes(item)) {
      result.push(item);
    }
  }
  return result;
}

function sanitiseSettings(raw = {}, base = cloneDefaults()) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const youtube = { ...base.youtube, ...(source.youtube || {}) };
  const scrape = { ...base.scrape, ...(source.scrape || {}) };
  const display = { ...base.display, ...(source.display || {}) };
  const limits = { ...base.limits, ...(source.limits || {}) };
  const resolution = Number(youtube.defaultResolution);
  const order = String(display.order || '').toLowerCase();

  return {
    mediaPriority: sanitiseOrderedList(
      source.mediaPriority ?? base.mediaPriority,
      VALID_MEDIA_KINDS,
      base.mediaPriority,
    ),
    youtube: {
      downloadEnabled: youtube.downloadEnabled !== false,
      defaultResolution: VALID_RESOLUTIONS.includes(resolution)
        ? resolution
        : base.youtube.defaultResolution,
    },
    scrape: {
      maxScreenshots: clampInt(scrape.maxScreenshots, 1, 12, base.scrape.maxScreenshots),
      downloadVideo: scrape.downloadVideo !== false,
      providerOrder: sanitiseOrderedList(
        scrape.providerOrder,
        VALID_PROVIDERS,
        base.scrape.providerOrder,
      ),
    },
    display: {
      secondsPerGame: clampInt(display.secondsPerGame, 5, 300, base.display.secondsPerGame),
      dashboardSeconds: clampInt(
        display.dashboardSeconds,
        10,
        120,
        base.display.dashboardSeconds,
      ),
      order: VALID_ORDERS.includes(order) ? order : base.display.order,
      scheduledGameLimit: clampInt(
        display.scheduledGameLimit,
        0,
        Number.MAX_SAFE_INTEGER,
        base.display.scheduledGameLimit,
      ),
    },
    limits: {
      maxImageBytes: clampInt(
        limits.maxImageBytes,
        1,
        Number.MAX_SAFE_INTEGER,
        base.limits.maxImageBytes,
      ),
      maxVideoBytes: clampInt(
        limits.maxVideoBytes,
        1,
        Number.MAX_SAFE_INTEGER,
        base.limits.maxVideoBytes,
      ),
    },
  };
}

function createRollCreditsSettings(config = {}, log = console) {
  const root = config.ROOT || path.resolve(__dirname, '..');
  const settingsPath = path.resolve(
    config.rollCreditsSettingsPath || path.join(root, 'data', 'roll-credits-settings.json'),
  );
  let settings = cloneDefaults();

  function loadFromDisk() {
    try {
      if (!fs.existsSync(settingsPath)) {
        settings = cloneDefaults();
        return settings;
      }
      settings = sanitiseSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8')));
    } catch (error) {
      settings = cloneDefaults();
      log?.warn?.('Could not read Roll Credits settings — using defaults', error?.message || error);
    }
    return settings;
  }

  function persist() {
    try {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      const temporaryPath = `${settingsPath}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
      fs.renameSync(temporaryPath, settingsPath);
      return true;
    } catch (error) {
      log?.warn?.('Could not persist Roll Credits settings', error?.message || error);
      return false;
    }
  }

  function get() {
    loadFromDisk();
    return JSON.parse(JSON.stringify(settings));
  }

  function update(patch = {}) {
    loadFromDisk();
    settings = sanitiseSettings({
      ...settings,
      ...(patch || {}),
      youtube: { ...settings.youtube, ...(patch.youtube || {}) },
      scrape: { ...settings.scrape, ...(patch.scrape || {}) },
      display: { ...settings.display, ...(patch.display || {}) },
      limits: { ...settings.limits, ...(patch.limits || {}) },
    }, settings);
    if (!persist()) {
      return { ok: false, error: 'Could not persist Roll Credits settings' };
    }
    return { ok: true, settings: get() };
  }

  loadFromDisk();

  return {
    get,
    update,
    save: update,
    settingsPath,
    getSettingsPath: () => settingsPath,
  };
}

module.exports = {
  createRollCreditsSettings,
  DEFAULTS,
  VALID_ORDERS,
  sanitiseSettings,
};
