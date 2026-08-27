const fs = require('fs');
const path = require('path');

// Basketball sessions go quiet faster than a darts match — someone wanders off
// mid free-play far more often than mid-leg — so the choices start lower than
// the Autodarts equivalents.
const INACTIVITY_OPTIONS = Object.freeze([2, 5, 10, 15, 30]);

const MODES = Object.freeze(['family', 'justhuupe', 'dailyprize', 'fitness', 'live']);

const DEFAULTS = Object.freeze({
  device: Object.freeze({
    // Blank means "discover it". A reservation is better, but the sweep is the
    // recovery path when DHCP moves the hoop.
    host: '',
    autoDiscover: true,
    port: 5555,
  }),
  live: Object.freeze({
    autoPush: true,
    inactivityMinutes: 5,
    finalHoldSeconds: 60,
    // A single make is not a session. Waiting for a second shot keeps a stray
    // bounce off the ToF sensor from taking over the wall.
    minShotsToOpen: 2,
  }),
  modes: Object.freeze({
    family: true,
    justhuupe: true,
    dailyprize: true,
    fitness: true,
    live: true,
  }),
  dashboard: Object.freeze({
    leaderboardSize: 10,
    displaySeconds: 120,
  }),
  lastGame: Object.freeze({
    displaySeconds: 90,
  }),
});

function cloneDefaults() {
  return JSON.parse(JSON.stringify(DEFAULTS));
}

function cloneDeep(value) {
  return JSON.parse(JSON.stringify(value));
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

/** `host` may be bare or `host:port`; the port is kept separately. */
function sanitiseHost(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return '';
  return raw.replace(/^adb:\/\//i, '').replace(/:\d+$/, '');
}

function sanitiseSettings(raw = {}, base = cloneDefaults()) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const device = { ...base.device, ...(source.device || {}) };
  const live = { ...base.live, ...(source.live || {}) };
  const modes = { ...base.modes, ...(source.modes || {}) };
  const dashboard = { ...base.dashboard, ...(source.dashboard || {}) };
  const lastGame = { ...base.lastGame, ...(source.lastGame || {}) };

  const inactivity = clampInt(live.inactivityMinutes, 2, 30, base.live.inactivityMinutes);

  return {
    device: {
      host: sanitiseHost(device.host),
      autoDiscover: device.autoDiscover !== false,
      port: clampInt(device.port, 1, 65535, base.device.port),
    },
    live: {
      autoPush: live.autoPush !== false,
      inactivityMinutes: INACTIVITY_OPTIONS.includes(inactivity)
        ? inactivity
        : base.live.inactivityMinutes,
      finalHoldSeconds: clampInt(live.finalHoldSeconds, 15, 180, base.live.finalHoldSeconds),
      minShotsToOpen: clampInt(live.minShotsToOpen, 1, 10, base.live.minShotsToOpen),
    },
    modes: MODES.reduce((out, mode) => {
      out[mode] = modes[mode] !== false;
      return out;
    }, {}),
    dashboard: {
      leaderboardSize: clampInt(dashboard.leaderboardSize, 3, 16, base.dashboard.leaderboardSize),
      displaySeconds: clampInt(dashboard.displaySeconds, 30, 600, base.dashboard.displaySeconds),
    },
    lastGame: {
      displaySeconds: clampInt(lastGame.displaySeconds, 30, 600, base.lastGame.displaySeconds),
    },
  };
}

function createHuupeSettings(config = {}, log = console) {
  const root = config.ROOT || path.resolve(__dirname, '..');
  const settingsPath = path.resolve(
    config.huupeSettingsPath || path.join(root, 'data', 'huupe-settings.json'),
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
      log?.warn?.('Could not read Huupe settings — using defaults', error?.message || error);
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
      log?.warn?.('Could not persist Huupe settings', error?.message || error);
      return false;
    }
  }

  loadFromDisk();

  return {
    settingsPath,
    get: () => {
      loadFromDisk();
      return cloneDeep(settings);
    },
    update(patch = {}) {
      loadFromDisk();
      settings = sanitiseSettings({
        device: { ...settings.device, ...(patch.device || {}) },
        live: { ...settings.live, ...(patch.live || {}) },
        modes: { ...settings.modes, ...(patch.modes || {}) },
        dashboard: { ...settings.dashboard, ...(patch.dashboard || {}) },
        lastGame: { ...settings.lastGame, ...(patch.lastGame || {}) },
      });
      persist();
      return cloneDeep(settings);
    },
    /** True when a mode is allowed to take over the wall on its own. */
    modeEnabled(mode) {
      loadFromDisk();
      if (!mode) return true;
      return settings.modes[mode] !== false;
    },
    INACTIVITY_OPTIONS,
    MODES,
  };
}

module.exports = {
  createHuupeSettings,
  sanitiseSettings,
  sanitiseHost,
  DEFAULTS,
  INACTIVITY_OPTIONS,
  MODES,
};
