/**
 * Word of the Day — rotation and part-of-speech filter preferences.
 */

const fs = require('fs');
const path = require('path');

const RECENT_CAP = 500;

const FALLBACK = {
  recentIds: [],
  partsOfSpeech: [],
};

function cleanId(value) {
  return String(value || '').trim().toLowerCase();
}

function cleanPos(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'adjective') {
    return 'adj';
  }
  return raw.replace(/\s+/g, '-');
}

function uniqueIds(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const id = cleanId(raw);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.push(id);
  }
  return out;
}

function uniquePos(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const id = cleanPos(raw);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.push(id);
  }
  return out;
}

function sanitiseSettings(raw = {}, base = FALLBACK) {
  const incoming = raw || {};
  const recentSource = Array.isArray(incoming.recentIds) ? incoming.recentIds : base.recentIds;
  const posSource = Array.isArray(incoming.partsOfSpeech) ? incoming.partsOfSpeech : base.partsOfSpeech;
  return {
    recentIds: uniqueIds(recentSource).slice(-RECENT_CAP),
    partsOfSpeech: uniquePos(posSource),
  };
}

function createWordOfTheDaySettings(config = {}, log = console) {
  const settingsPath = config.wordOfTheDaySettingsPath
    || path.resolve(config.ROOT || path.resolve(__dirname, '..'), 'data', 'word-of-the-day-settings.json');
  let current = sanitiseSettings({}, FALLBACK);

  function load() {
    try {
      if (!fs.existsSync(settingsPath)) {
        current = sanitiseSettings({}, FALLBACK);
        return current;
      }
      current = sanitiseSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), FALLBACK);
    } catch (error) {
      log?.warn?.('Could not read Word of the Day settings', error?.message || error);
      current = sanitiseSettings({}, FALLBACK);
    }
    return current;
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
    } catch (error) {
      log?.warn?.('Could not save Word of the Day settings', error?.message || error);
    }
  }

  load();

  return {
    get: () => ({
      recentIds: [...current.recentIds],
      partsOfSpeech: [...current.partsOfSpeech],
    }),
    update(patch = {}) {
      current = sanitiseSettings({ ...current, ...patch }, current);
      save();
      return this.get();
    },
    remember(id) {
      const next = cleanId(id);
      if (!next) {
        return this.get();
      }
      const recentIds = current.recentIds.filter((item) => item !== next);
      recentIds.push(next);
      current = sanitiseSettings({ ...current, recentIds }, current);
      save();
      return this.get();
    },
    reload: load,
    path: settingsPath,
  };
}

module.exports = {
  RECENT_CAP,
  FALLBACK,
  sanitiseSettings,
  createWordOfTheDaySettings,
};
