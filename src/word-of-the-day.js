/**
 * Word of the Day — pick a vocabulary entry for the board.
 *
 * All words ship in local JSON (already board-fit). No network at runtime.
 * Never run `fitsBoard` over the whole list — that freezes the process.
 */

const SHIPPED = require('./word-of-the-day-words.json');
const { createWordOfTheDaySettings } = require('./word-of-the-day-settings');
const { wordLines, fitsBoard } = require('./word-of-the-day-layout');

const TYPE = 'word.day';

function loadShipped() {
  return Array.isArray(SHIPPED?.words) ? SHIPPED.words : [];
}

const BY_ID = new Map();
const BY_WORD = new Map();
for (const entry of loadShipped()) {
  if (entry?.id) {
    BY_ID.set(String(entry.id).toLowerCase(), entry);
  }
  const word = String(entry?.word || '').trim().toLowerCase();
  if (word && !BY_WORD.has(word)) {
    BY_WORD.set(word, entry);
  }
}

function loadPartsOfSpeech() {
  if (Array.isArray(SHIPPED?.partsOfSpeech) && SHIPPED.partsOfSpeech.length) {
    return SHIPPED.partsOfSpeech.map((row) => ({
      id: String(row.id || '').trim(),
      label: String(row.label || '').trim(),
      count: Number(row.count) || 0,
    })).filter((row) => row.id);
  }
  const counts = new Map();
  for (const entry of loadShipped()) {
    counts.set(entry.pos, (counts.get(entry.pos) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([id, count]) => ({ id, label: id, count }));
}

function allowedPos(settings = {}) {
  return new Set(
    (settings.partsOfSpeech || []).map((value) => String(value).trim()).filter(Boolean),
  );
}

function matchesFilter(entry, settings = {}) {
  if (!entry) {
    return false;
  }
  const allowed = allowedPos(settings);
  return !allowed.size || allowed.has(entry.pos);
}

/**
 * The shipped list is already board-fit (see the build tool). Do not run
 * `fitsBoard` here — 160k layout passes freeze the event loop and can OOM
 * the process, which drops the simulator SSE and marks the bridge offline.
 */
function resolveWords(settings = {}) {
  const allowed = allowedPos(settings);
  const all = loadShipped();
  if (!allowed.size) {
    return all;
  }
  return all.filter((entry) => allowed.has(entry.pos));
}

function countAvailable(settings = {}) {
  const allowed = allowedPos(settings);
  if (!allowed.size) {
    return Number(SHIPPED?.wordCount) || loadShipped().length;
  }
  const parts = loadPartsOfSpeech();
  let total = 0;
  let known = 0;
  for (const row of parts) {
    if (allowed.has(row.id)) {
      total += row.count;
      known += 1;
    }
  }
  return known === allowed.size ? total : resolveWords(settings).length;
}

function findWord({ id, word } = {}) {
  const key = String(id || word || '').trim().toLowerCase();
  if (!key) {
    return null;
  }
  return BY_ID.get(key) || BY_WORD.get(key) || null;
}

function pickWord(settings = {}, { random = Math.random, id, word } = {}) {
  const chosen = findWord({ id, word });
  if (matchesFilter(chosen, settings)) {
    return chosen;
  }
  const pool = resolveWords(settings);
  if (!pool.length) {
    return null;
  }
  const recent = new Set(settings.recentIds || []);
  const fresh = pool.filter((entry) => !recent.has(entry.id));
  const choices = fresh.length ? fresh : pool;
  const index = Math.min(choices.length - 1, Math.floor(Number(random()) * choices.length));
  return choices[Math.max(0, index)] || null;
}

function buildWordOfTheDayPayload(entry, { asOf } = {}) {
  if (!entry || !fitsBoard(entry.word, entry.pos, entry.definition)) {
    return null;
  }
  const parsed = wordLines(entry.word, entry.pos, entry.definition);
  if (!parsed) {
    return null;
  }
  return {
    type: TYPE,
    asOf: asOf || new Date().toISOString(),
    entry: {
      id: entry.id,
      word: entry.word,
      pos: entry.pos,
      posLabel: entry.posLabel,
      definition: entry.definition,
      headline: parsed.headline,
      lines: parsed.preview,
    },
  };
}

function listWords(settings = {}, { query = '', limit = 80 } = {}) {
  const needle = String(query || '').trim().toLowerCase();
  let pool = resolveWords(settings);
  if (needle) {
    pool = pool.filter((entry) => entry.word.includes(needle)
      || String(entry.definition || '').toLowerCase().includes(needle));
  } else {
    const featured = ['oracy', 'sympatric', 'panglossian'];
    const picks = featured.map((word) => findWord({ word })).filter(Boolean);
    const seen = new Set(picks.map((entry) => entry.id));
    pool = [
      ...picks,
      ...pool.filter((entry) => !seen.has(entry.id)),
    ];
  }
  const cap = Math.max(1, Math.min(Number(limit) || 80, 200));
  return pool.slice(0, cap);
}

function createWordOfTheDay(config, log) {
  const settingsApi = createWordOfTheDaySettings(config, log);

  function snapshot(extra = {}) {
    const settings = settingsApi.get();
    const words = listWords(settings, {
      query: extra.query,
      limit: extra.limit,
    }).map((entry) => {
      const parsed = wordLines(entry.word, entry.pos, entry.definition);
      return {
        id: entry.id,
        word: entry.word,
        pos: entry.pos,
        posLabel: entry.posLabel,
        definition: entry.definition,
        headline: parsed?.headline || entry.headline,
        lines: parsed?.preview || [],
      };
    });
    return {
      available: countAvailable(settings),
      total: loadShipped().length,
      partsOfSpeech: loadPartsOfSpeech(),
      settings,
      words,
      query: String(extra.query || ''),
      ...extra,
    };
  }

  return {
    getSettings: () => settingsApi.get(),
    statusSnapshot(extra = {}) {
      return snapshot(extra);
    },
    updateSettings(patch = {}) {
      settingsApi.update(patch);
      return snapshot();
    },
    nextPayload(options = {}) {
      const settings = settingsApi.get();
      const entry = pickWord(settings, options);
      if (!entry) {
        return null;
      }
      settingsApi.remember(entry.id);
      return buildWordOfTheDayPayload(entry, options);
    },
  };
}

module.exports = {
  TYPE,
  loadShipped,
  loadPartsOfSpeech,
  resolveWords,
  listWords,
  countAvailable,
  findWord,
  pickWord,
  buildWordOfTheDayPayload,
  createWordOfTheDay,
};
