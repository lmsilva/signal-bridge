/**
 * Ring Doorbell settings — live-reload data/ring-settings.json.
 * Never writes config.json. Token lives in ring-credentials.js.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  title: 'Ring Door Bell',
  message: 'Someone is at your front door',
  pushOnDing: true,
  pushOnMotion: false,
  quietHoursExempt: true,
  cameraIds: [],
});

const TITLE_MAX = 18;
const MESSAGE_MAX = 80;

function clampText(value, max, fallback) {
  const text = String(value != null ? value : '').trim();
  if (!text) {
    return fallback;
  }
  return text.slice(0, max);
}

function sanitiseCameraIds(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }
  const seen = new Set();
  const out = [];
  for (const entry of raw) {
    const id = String(entry || '').trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.push(id);
    if (out.length >= 32) {
      break;
    }
  }
  return out;
}

function sanitiseSettings(raw = {}, base = DEFAULT_SETTINGS) {
  const incoming = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: incoming.enabled != null ? Boolean(incoming.enabled) : Boolean(base.enabled),
    title: clampText(incoming.title != null ? incoming.title : base.title, TITLE_MAX, DEFAULT_SETTINGS.title),
    message: clampText(
      incoming.message != null ? incoming.message : base.message,
      MESSAGE_MAX,
      DEFAULT_SETTINGS.message,
    ),
    pushOnDing: incoming.pushOnDing != null
      ? Boolean(incoming.pushOnDing)
      : Boolean(base.pushOnDing),
    pushOnMotion: incoming.pushOnMotion != null
      ? Boolean(incoming.pushOnMotion)
      : Boolean(base.pushOnMotion),
    quietHoursExempt: incoming.quietHoursExempt != null
      ? Boolean(incoming.quietHoursExempt)
      : Boolean(base.quietHoursExempt),
    cameraIds: sanitiseCameraIds(
      incoming.cameraIds != null ? incoming.cameraIds : base.cameraIds,
    ),
  };
}

function createRingSettings(config = {}, log = console) {
  const settingsPath = config.ringSettingsPath
    || path.resolve(config.ROOT || path.resolve(__dirname, '..'), 'data', 'ring-settings.json');
  let current = sanitiseSettings({}, DEFAULT_SETTINGS);

  function load() {
    try {
      if (!fs.existsSync(settingsPath)) {
        current = sanitiseSettings({}, DEFAULT_SETTINGS);
        return current;
      }
      current = sanitiseSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), DEFAULT_SETTINGS);
    } catch (error) {
      log?.warn?.('Could not read Ring settings', error?.message || error);
      current = sanitiseSettings({}, DEFAULT_SETTINGS);
    }
    return current;
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
    } catch (error) {
      log?.warn?.('Could not save Ring settings', error?.message || error);
    }
  }

  load();

  return {
    get: () => ({ ...current, cameraIds: [...current.cameraIds] }),
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

module.exports = {
  DEFAULT_SETTINGS,
  TITLE_MAX,
  MESSAGE_MAX,
  sanitiseSettings,
  createRingSettings,
};
