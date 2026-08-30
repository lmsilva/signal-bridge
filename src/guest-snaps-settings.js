/**
 * Guest Snaps short-link settings — preferred TinyURL alias for the booth.
 *
 * Wi-Fi / booth origin still come from .env / public base URL.
 * Token lives in tinyurl-credentials.js. Link state lives in shortlinks.js.
 */

const fs = require('fs');
const path = require('path');
const { sanitiseAlias } = require('./guest-book-settings');

const FALLBACK = {
  preferredAlias: '',
};

function sanitiseSettings(raw = {}, base = FALLBACK) {
  const merged = { ...base, ...(raw || {}) };
  return {
    preferredAlias: sanitiseAlias(merged.preferredAlias),
  };
}

function createGuestSnapsSettings(config = {}, log = console) {
  const settingsPath = config.guestSnapsSettingsPath
    || path.resolve(config.ROOT || path.resolve(__dirname, '..'), 'data', 'guest-snaps-settings.json');
  let current = { ...FALLBACK };

  function load() {
    try {
      if (!fs.existsSync(settingsPath)) {
        current = { ...FALLBACK };
        return current;
      }
      current = sanitiseSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8')));
    } catch (error) {
      log?.warn?.('Could not read Guest Snaps settings', error?.message || error);
      current = { ...FALLBACK };
    }
    return current;
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
    } catch (error) {
      log?.warn?.('Could not save Guest Snaps settings', error?.message || error);
    }
  }

  load();

  return {
    get() {
      load();
      return { ...current };
    },
    update(patch = {}) {
      current = sanitiseSettings({ ...current, ...patch }, current);
      save();
      return { ...current };
    },
    reload: load,
    path: settingsPath,
  };
}

module.exports = {
  FALLBACK,
  sanitiseSettings,
  createGuestSnapsSettings,
};
