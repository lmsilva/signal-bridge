/**
 * Learn {Language} — pick a random shipped lexicon row and build a payload.
 *
 * Same shape as Learn Japanese, minus kana: a native word, English gloss,
 * part of speech, and CEFR level. No network at runtime.
 */

const { posLabel: japanesePosLabel } = require('./learn-japanese');
const CONCEPTS = require('./learn-language-concepts');

const FORM_INDEX = Object.freeze({
  portuguese: 0,
  spanish: 1,
  french: 2,
  german: 3,
  italian: 4,
});

const POS_LABEL = Object.freeze({
  noun: 'NOUN',
  verb: 'VERB',
  adj: 'ADJ',
  adverb: 'ADVERB',
  phrase: 'PHRASE',
  pronoun: 'PRONOUN',
  other: 'OTHER',
});

const LANGUAGES = Object.freeze({
  portuguese: {
    id: 'portuguese',
    commandId: 'portuguese.learn',
    title: 'Learn Portuguese',
    subtitle: 'A random word on the board',
    route: '/api/push/learn-portuguese',
    settingsPath: '/api/learn-portuguese/settings',
    icon: 'portuguese',
    chips: { left: 'green', right: 'red' },
    levels: ['A1', 'A2'],
  },
  spanish: {
    id: 'spanish',
    commandId: 'spanish.learn',
    title: 'Learn Spanish',
    subtitle: 'A random word on the board',
    route: '/api/push/learn-spanish',
    settingsPath: '/api/learn-spanish/settings',
    icon: 'spanish',
    chips: { left: 'red', right: 'yellow' },
    levels: ['A1', 'A2'],
  },
  french: {
    id: 'french',
    commandId: 'french.learn',
    title: 'Learn French',
    subtitle: 'A random word on the board',
    route: '/api/push/learn-french',
    settingsPath: '/api/learn-french/settings',
    icon: 'french',
    chips: { left: 'blue', right: 'red' },
    levels: ['A1', 'A2'],
  },
  german: {
    id: 'german',
    commandId: 'german.learn',
    title: 'Learn German',
    subtitle: 'A random word on the board',
    route: '/api/push/learn-german',
    settingsPath: '/api/learn-german/settings',
    icon: 'german',
    chips: { left: 'yellow', right: 'red' },
    levels: ['A1', 'A2'],
  },
  italian: {
    id: 'italian',
    commandId: 'italian.learn',
    title: 'Learn Italian',
    subtitle: 'A random word on the board',
    route: '/api/push/learn-italian',
    settingsPath: '/api/learn-italian/settings',
    icon: 'italian',
    chips: { left: 'green', right: 'white' },
    levels: ['A1', 'A2'],
  },
});

function languageIds() {
  return Object.keys(LANGUAGES);
}

function languageOf(id) {
  const key = String(id || '').trim().toLowerCase().replace(/\.learn$/, '');
  return LANGUAGES[key] || null;
}

function slug(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'word';
}

function loadConceptLexicon(languageId) {
  const spec = languageOf(languageId);
  const formIndex = FORM_INDEX[spec?.id];
  if (formIndex == null || !Array.isArray(CONCEPTS)) {
    return [];
  }
  const seen = new Set();
  const words = [];
  for (const row of CONCEPTS) {
    const [id, english, pos, level, ...forms] = row;
    const native = String(forms[formIndex] || '').trim();
    if (!native || !english) {
      continue;
    }
    let key = `${slug(native)}-${slug(english)}-${String(level).toLowerCase()}`;
    if (seen.has(key)) {
      key = `${slug(id)}-${key}`;
    }
    seen.add(key);
    words.push({
      id: key,
      word: native,
      english,
      pos,
      level,
    });
  }
  return words;
}

function loadShippedLexicon(languageId) {
  const spec = languageOf(languageId);
  if (!spec) {
    return null;
  }
  try {
    const packed = require(`./learn-${spec.id}-words.json`);
    return Array.isArray(packed?.words) && packed.words.length ? packed.words : null;
  } catch {
    return null;
  }
}

function loadLexicon(languageId) {
  return loadShippedLexicon(languageId) || loadConceptLexicon(languageId);
}

function matchingWords(languageId, settings = {}) {
  const levels = new Set(settings.levels || []);
  const parts = new Set(settings.partsOfSpeech || []);
  return loadLexicon(languageId).filter((word) => {
    if (levels.size && !levels.has(word.level)) {
      return false;
    }
    if (parts.size && !parts.has(word.pos)) {
      return false;
    }
    return Boolean(word.word && word.english);
  });
}

function pickWord(languageId, settings = {}, { random = Math.random } = {}) {
  const pool = matchingWords(languageId, settings);
  if (!pool.length) {
    return null;
  }
  const recent = new Set(settings.recentIds || []);
  const fresh = pool.filter((word) => !recent.has(word.id));
  const choices = fresh.length ? fresh : pool;
  const index = Math.min(choices.length - 1, Math.floor(Number(random()) * choices.length));
  return choices[Math.max(0, index)] || null;
}

function buildLearnLanguagePayload(languageId, word, { asOf } = {}) {
  const spec = languageOf(languageId);
  if (!spec || !word?.word || !word?.english) {
    return null;
  }
  return {
    type: spec.commandId,
    language: spec.id,
    title: spec.title,
    chips: { ...spec.chips },
    asOf: asOf || new Date().toISOString(),
    word: {
      id: word.id || '',
      word: word.word,
      english: word.english,
      pos: word.pos || 'other',
      level: word.level || '',
    },
  };
}

function posLabel(pos) {
  return POS_LABEL[pos] || japanesePosLabel(pos) || POS_LABEL.other;
}

function createLearnLanguage(languageId, config, log) {
  const spec = languageOf(languageId);
  if (!spec) {
    throw new Error(`Unknown learn-language id ${JSON.stringify(languageId)}`);
  }
  const { createLearnLanguageSettings } = require('./learn-language-settings');
  const settingsApi = createLearnLanguageSettings(spec, config, log);

  return {
    spec,
    getSettings: () => settingsApi.get(),
    updateSettings: (patch) => settingsApi.update(patch),
    statusSnapshot() {
      const settings = settingsApi.get();
      return {
        language: spec.id,
        title: spec.title,
        available: matchingWords(spec.id, settings).length,
        total: loadLexicon(spec.id).length,
        settings,
      };
    },
    nextPayload(options = {}) {
      const settings = settingsApi.get();
      const word = pickWord(spec.id, settings, options);
      if (!word) {
        return null;
      }
      settingsApi.remember(word.id);
      return buildLearnLanguagePayload(spec.id, word, options);
    },
  };
}

function createLearnLanguages(config, log) {
  const services = {};
  for (const id of languageIds()) {
    services[LANGUAGES[id].commandId] = createLearnLanguage(id, config, log);
  }
  return services;
}

module.exports = {
  POS_LABEL,
  LANGUAGES,
  languageIds,
  languageOf,
  loadLexicon,
  loadConceptLexicon,
  matchingWords,
  pickWord,
  buildLearnLanguagePayload,
  posLabel,
  createLearnLanguage,
  createLearnLanguages,
};
