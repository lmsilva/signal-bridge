/**
 * Space Launch Alerts — house settings (look-ahead, chip colour, refresh).
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_SETTINGS = Object.freeze({
  hoursAhead: 168,
  chipColor: 'blue',
  refreshHours: 6,
  includeSuborbital: false,
});

function cleanChip(value) {
  const chip = String(value || DEFAULT_SETTINGS.chipColor).trim().toLowerCase();
  const allowed = new Set(['blue', 'green', 'white']);
  return allowed.has(chip) ? chip : DEFAULT_SETTINGS.chipColor;
}

function sanitiseSettings(raw = {}, base = DEFAULT_SETTINGS) {
  const incoming = raw && typeof raw === 'object' ? raw : {};
  const hoursAhead = Math.min(336, Math.max(24, Math.round(
    Number(incoming.hoursAhead != null ? incoming.hoursAhead : base.hoursAhead) || 168,
  )));
  const refreshHours = Math.min(24, Math.max(1, Math.round(
    Number(incoming.refreshHours != null ? incoming.refreshHours : base.refreshHours) || 6,
  )));
  return {
    hoursAhead,
    refreshHours,
    chipColor: cleanChip(incoming.chipColor != null ? incoming.chipColor : base.chipColor),
    includeSuborbital: incoming.includeSuborbital != null
      ? Boolean(incoming.includeSuborbital)
      : Boolean(base.includeSuborbital),
  };
}

function createSpaceLaunchAlertsSettings(config = {}, log = console) {
  const settingsPath = config.spaceLaunchAlertsSettingsPath
    || path.resolve(config.ROOT || path.resolve(__dirname, '..'), 'data', 'space-launch-alerts-settings.json');
  let current = sanitiseSettings({}, DEFAULT_SETTINGS);

  function load() {
    try {
      if (!fs.existsSync(settingsPath)) {
        current = sanitiseSettings({}, DEFAULT_SETTINGS);
        return current;
      }
      current = sanitiseSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), DEFAULT_SETTINGS);
    } catch (error) {
      log?.warn?.('Could not read Space Launch Alerts settings', error?.message || error);
      current = sanitiseSettings({}, DEFAULT_SETTINGS);
    }
    return current;
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
    } catch (error) {
      log?.warn?.('Could not save Space Launch Alerts settings', error?.message || error);
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

module.exports = {
  DEFAULT_SETTINGS,
  sanitiseSettings,
  createSpaceLaunchAlertsSettings,
};
