const fs = require('fs');
const path = require('path');

const INACTIVITY_OPTIONS = Object.freeze([5, 10, 15, 30, 60]);

const DEFAULTS = Object.freeze({
  live: Object.freeze({
    autoPush: true,
    inactivityMinutes: 15,
    finalHoldSeconds: 60,
  }),
  dashboard: Object.freeze({
    leaderboardSize: 8,
    displaySeconds: 120,
  }),
  lastMatch: Object.freeze({
    displaySeconds: 90,
  }),
  sync: Object.freeze({
    historyBackfill: true,
    historyEndpointConfirmed: false,
  }),
});

function cloneDefaults() {
  return JSON.parse(JSON.stringify(DEFAULTS));
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function sanitiseSettings(raw = {}, base = cloneDefaults()) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const live = { ...base.live, ...(source.live || {}) };
  const dashboard = { ...base.dashboard, ...(source.dashboard || {}) };
  const lastMatch = { ...base.lastMatch, ...(source.lastMatch || {}) };
  const sync = { ...base.sync, ...(source.sync || {}) };
  const inactivity = clampInt(
    live.inactivityMinutes,
    5,
    60,
    base.live.inactivityMinutes,
  );
  return {
    live: {
      autoPush: live.autoPush !== false,
      inactivityMinutes: INACTIVITY_OPTIONS.includes(inactivity)
        ? inactivity
        : base.live.inactivityMinutes,
      finalHoldSeconds: clampInt(live.finalHoldSeconds, 30, 180, base.live.finalHoldSeconds),
    },
    dashboard: {
      leaderboardSize: clampInt(dashboard.leaderboardSize, 3, 16, base.dashboard.leaderboardSize),
      displaySeconds: clampInt(dashboard.displaySeconds, 30, 600, base.dashboard.displaySeconds),
    },
    lastMatch: {
      displaySeconds: clampInt(lastMatch.displaySeconds, 30, 600, base.lastMatch.displaySeconds),
    },
    sync: {
      historyBackfill: sync.historyBackfill !== false,
      historyEndpointConfirmed: sync.historyEndpointConfirmed === true,
    },
  };
}

function createAutodartsSettings(config = {}, log = console) {
  const root = config.ROOT || path.resolve(__dirname, '..');
  const settingsPath = path.resolve(
    config.autodartsSettingsPath || path.join(root, 'data', 'autodarts-settings.json'),
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
      log?.warn?.('Could not read Autodarts settings — using defaults', error?.message || error);
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
      log?.warn?.('Could not persist Autodarts settings', error?.message || error);
      return false;
    }
  }

  loadFromDisk();

  return {
    get: () => {
      loadFromDisk();
      return cloneDeep(settings);
    },
    update(patch = {}) {
      loadFromDisk();
      settings = sanitiseSettings({
        live: { ...settings.live, ...(patch.live || {}) },
        dashboard: { ...settings.dashboard, ...(patch.dashboard || {}) },
        lastMatch: { ...settings.lastMatch, ...(patch.lastMatch || {}) },
        sync: { ...settings.sync, ...(patch.sync || {}) },
      });
      persist();
      return cloneDeep(settings);
    },
    settingsPath,
    INACTIVITY_OPTIONS,
  };
}

function cloneDeep(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = {
  createAutodartsSettings,
  sanitiseSettings,
  DEFAULTS,
  INACTIVITY_OPTIONS,
};
