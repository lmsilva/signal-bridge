/**
 * Learn {Language} filters — CEFR levels and parts of speech.
 *
 * Lexicons are shipped (`learn-*-words.json`). This file only remembers what
 * the house wants to see and which words were shown recently so a scheduled
 * rotation does not repeat itself.
 */

const fs = require('fs');
const path = require('path');

const LEVELS = Object.freeze(['A1', 'A2']);
const PARTS_OF_SPEECH = Object.freeze([
  'noun', 'verb', 'adj', 'adverb', 'phrase', 'pronoun', 'other',
]);
const RECENT_CAP = 80;

const FALLBACK = {
  levels: ['A1', 'A2'],
  partsOfSpeech: [...PARTS_OF_SPEECH],
  recentIds: [],
};

function uniqueIn(list, allowed) {
  const allow = new Set(allowed);
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const value = String(raw || '').trim();
    if (!allow.has(value) || out.includes(value)) {
      continue;
    }
    out.push(value);
  }
  return out;
}

function sanitiseSettings(raw = {}, base = FALLBACK) {
  const incoming = raw || {};
  const levels = uniqueIn(
    Array.isArray(incoming.levels) ? incoming.levels : base.levels,
    LEVELS,
  );
  const partsOfSpeech = uniqueIn(
    Array.isArray(incoming.partsOfSpeech) ? incoming.partsOfSpeech : base.partsOfSpeech,
    PARTS_OF_SPEECH,
  );
  const recentSource = Array.isArray(incoming.recentIds) ? incoming.recentIds : base.recentIds;
  const recentIds = (Array.isArray(recentSource) ? recentSource : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean)
    .slice(-RECENT_CAP);
  return {
    levels: levels.length ? levels : [...FALLBACK.levels],
    partsOfSpeech: partsOfSpeech.length ? partsOfSpeech : [...FALLBACK.partsOfSpeech],
    recentIds,
  };
}

function settingsFileName(languageId) {
  return `learn-${String(languageId || 'language').trim()}-settings.json`;
}

function createLearnLanguageSettings(spec, config = {}, log = console) {
  const languageId = spec?.id || spec;
  const title = spec?.title || 'Learn Language';
  const explicitPath = config.learnLanguageSettingsPath
    || config[`${String(languageId)}SettingsPath`];
  const settingsPath = explicitPath
    || path.resolve(
      config.ROOT || path.resolve(__dirname, '..'),
      'data',
      settingsFileName(languageId),
    );
  let current = {
    ...FALLBACK,
    levels: [...FALLBACK.levels],
    partsOfSpeech: [...FALLBACK.partsOfSpeech],
  };

  function load() {
    try {
      if (!fs.existsSync(settingsPath)) {
        current = {
          ...FALLBACK,
          levels: [...FALLBACK.levels],
          partsOfSpeech: [...FALLBACK.partsOfSpeech],
        };
        return current;
      }
      current = sanitiseSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), FALLBACK);
    } catch (error) {
      log?.warn?.(`Could not read ${title} settings`, error?.message || error);
      current = sanitiseSettings({}, FALLBACK);
    }
    return current;
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
    } catch (error) {
      log?.warn?.(`Could not save ${title} settings`, error?.message || error);
    }
  }

  load();

  return {
    get: () => ({
      ...current,
      levels: [...current.levels],
      partsOfSpeech: [...current.partsOfSpeech],
      recentIds: [...current.recentIds],
    }),
    update(patch = {}) {
      current = sanitiseSettings({ ...current, ...patch }, current);
      save();
      return this.get();
    },
    remember(id) {
      const next = String(id || '').trim();
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
  LEVELS,
  PARTS_OF_SPEECH,
  RECENT_CAP,
  FALLBACK,
  sanitiseSettings,
  settingsFileName,
  createLearnLanguageSettings,
};
