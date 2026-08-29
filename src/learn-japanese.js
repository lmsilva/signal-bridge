/**
 * Learn Japanese — pick a random lexicon row and build a Vestaboard payload.
 *
 * The board cannot show kana or kanji, so the shipped list is romaji + English
 * + part of speech, converted from OpenJLPT / JMDict. No network at runtime.
 */

const LEXICON = require('./learn-japanese-words.json');

const POS_LABEL = Object.freeze({
  noun: 'NOUN',
  verb: 'VERB',
  adj: 'ADJ',
  adverb: 'ADVERB',
  phrase: 'PHRASE',
  particle: 'PARTICLE',
  pronoun: 'PRONOUN',
  counter: 'COUNTER',
  other: 'OTHER',
});

function loadLexicon() {
  return Array.isArray(LEXICON?.words) ? LEXICON.words : [];
}

function matchingWords(settings = {}) {
  const levels = new Set(settings.levels || []);
  const parts = new Set(settings.partsOfSpeech || []);
  return loadLexicon().filter((word) => {
    if (levels.size && !levels.has(word.level)) {
      return false;
    }
    if (parts.size && !parts.has(word.pos)) {
      return false;
    }
    return Boolean(word.romaji && word.english);
  });
}

function pickWord(settings = {}, { random = Math.random } = {}) {
  const pool = matchingWords(settings);
  if (!pool.length) {
    return null;
  }
  const recent = new Set(settings.recentIds || []);
  const fresh = pool.filter((word) => !recent.has(word.id));
  const choices = fresh.length ? fresh : pool;
  const index = Math.min(choices.length - 1, Math.floor(Number(random()) * choices.length));
  return choices[Math.max(0, index)] || null;
}

function buildLearnJapanesePayload(word, { asOf } = {}) {
  if (!word?.romaji || !word?.english) {
    return null;
  }
  return {
    type: 'japanese.learn',
    asOf: asOf || new Date().toISOString(),
    word: {
      id: word.id || '',
      romaji: word.romaji,
      english: word.english,
      pos: word.pos || 'other',
      level: word.level || '',
    },
  };
}

function posLabel(pos) {
  return POS_LABEL[pos] || POS_LABEL.other;
}

function createLearnJapanese(config, log) {
  const { createLearnJapaneseSettings } = require('./learn-japanese-settings');
  const settingsApi = createLearnJapaneseSettings(config, log);

  return {
    getSettings: () => settingsApi.get(),
    updateSettings: (patch) => settingsApi.update(patch),
    statusSnapshot() {
      const settings = settingsApi.get();
      return {
        available: matchingWords(settings).length,
        total: loadLexicon().length,
        settings,
      };
    },
    nextPayload(options = {}) {
      const settings = settingsApi.get();
      const word = pickWord(settings, options);
      if (!word) {
        return null;
      }
      settingsApi.remember(word.id);
      return buildLearnJapanesePayload(word, options);
    },
  };
}

module.exports = {
  POS_LABEL,
  loadLexicon,
  matchingWords,
  pickWord,
  buildLearnJapanesePayload,
  posLabel,
  createLearnJapanese,
};
