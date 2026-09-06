/**
 * Persist event-routing settings in data/event-routing-settings.json.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const {
  defaultSettings,
  sanitiseSettings,
  cloneFamilyRule,
  FAMILIES,
} = require('./event-routing');

function createEventRoutingSettings(config = {}, log = console) {
  const settingsPath = config.eventRoutingSettingsPath
    || path.resolve(config.ROOT || path.resolve(__dirname, '..'), 'data', 'event-routing-settings.json');
  let current = defaultSettings();

  function load() {
    try {
      if (!fs.existsSync(settingsPath)) {
        current = defaultSettings();
        return current;
      }
      current = sanitiseSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8')));
    } catch (error) {
      log?.warn?.('Could not read event routing settings', error?.message || error);
      current = defaultSettings();
    }
    return current;
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
    } catch (error) {
      log?.warn?.('Could not save event routing settings', error?.message || error);
    }
  }

  load();

  return {
    get() {
      load();
      const families = {};
      for (const [id, rule] of Object.entries(current.families || {})) {
        families[id] = cloneFamilyRule(rule);
      }
      return { version: current.version || 2, families };
    },
    catalog() {
      return FAMILIES.map((row) => ({ ...row }));
    },
    update(patch = {}) {
      const incoming = patch && typeof patch === 'object' ? patch : {};
      const merged = {
        version: 2,
        families: {
          ...(current.families || {}),
          ...(incoming.families && typeof incoming.families === 'object' ? incoming.families : {}),
        },
      };
      current = sanitiseSettings(merged);
      save();
      return this.get();
    },
    reload: load,
    path: settingsPath,
  };
}

module.exports = {
  createEventRoutingSettings,
};