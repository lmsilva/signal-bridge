/**
 * Hangman -- call a letter, keep the turn while you are right, solve the word.
 *
 * House rules, folded onto a 6x22 board:
 *   - six misses and the round is over; the word is revealed either way
 *   - a correct letter keeps your turn, a miss costs a life and passes it
 *   - a wrong solve costs a life too, so a wild stab is never free
 *   - alone, the house deals the word; with company, one player sets it and
 *     the rest take turns guessing, and the setter's seat rotates each round
 *
 * The corpus is gated here (single words, 4-14 letters, one board row) so a
 * word that cannot be painted never reaches a formatter that can only
 * truncate. A word a player types is checked against the Word Scramble
 * dictionary, so "somebody made that up" is not a way to win.
 */

const fs = require('fs');
const path = require('path');
const { COLS, fold } = require('./vestaboard/encoder');
const { loadWords: loadDictionary, hasWord } = require('./word-scramble');

const WORDS_PATH = path.join(__dirname, 'hangman-words.json');

/** Six misses: head, body, two arms, two legs. */
const LIVES = 6;
const MIN_WORD = 4;
const MAX_WORD = 14;
/** Suggestions a word setter chooses between before typing their own. */
const SUGGESTIONS = 3;

/** A found letter pays per flap it turns over, so ES in CHEESE pays twice. */
const LETTER_POINTS = 10;
/** Saying the whole word out loud is the moment worth playing for. */
const SOLVE_BONUS = 50;
/** Every life still standing when it falls. */
const LIFE_BONUS = 5;
/**
 * The setter is paid for every miss they forced -- but only if somebody got
 * there in the end. A word nobody can guess is worth nothing, which is the
 * whole reason it is safe to let a person pick one.
 */
const SETTER_PER_MISS = 5;
const SETTER_MAX = 30;

let cachedCategories = null;

function normaliseCategory(row) {
  if (!row) return null;
  const label = fold(row.label || row.category || '');
  const id = String(row.id || label).trim().toLowerCase();
  if (!label || label.length > COLS) return null;
  const words = (Array.isArray(row.words) ? row.words : [])
    .map((word) => fold(word).replace(/[^A-Z]/g, ''))
    .filter((word) => word.length >= MIN_WORD && word.length <= MAX_WORD);
  if (!words.length) return null;
  return { id, label, words };
}

function loadCategories(override) {
  if (Array.isArray(override)) {
    return override.map(normaliseCategory).filter(Boolean);
  }
  if (cachedCategories) return cachedCategories;
  try {
    const parsed = JSON.parse(fs.readFileSync(WORDS_PATH, 'utf8'));
    const rows = Array.isArray(parsed) ? parsed : (parsed?.categories || []);
    cachedCategories = rows.map(normaliseCategory).filter(Boolean);
  } catch {
    cachedCategories = [];
  }
  return cachedCategories;
}

/** The whole deck, flattened, each word carrying the category that hints it. */
function loadWords(override) {
  const out = [];
  for (const category of loadCategories(override)) {
    for (const word of category.words) {
      out.push({ category: category.label, word });
    }
  }
  return out;
}

function wordKey(row) {
  if (!row) return '';
  if (typeof row === 'string') return fold(row);
  return fold(row.category || '') + '|' + fold(row.word || '');
}

/** Does the mask fit the one board row it is painted on? */
function wordFits(row) {
  const word = fold(typeof row === 'string' ? row : row?.word || '').replace(/[^A-Z]/g, '');
  const category = fold(typeof row === 'string' ? '' : row?.category || 'WORD');
  return Boolean(
    word.length >= MIN_WORD
    && word.length <= MAX_WORD
    && word.length <= COLS
    && category.length <= COLS,
  );
}

function lettersOf(word) {
  return new Set([...fold(word)].filter((ch) => ch >= 'A' && ch <= 'Z'));
}

function countLetter(word, letter) {
  const ch = fold(letter).slice(0, 1);
  if (!ch) return 0;
  return [...fold(word)].filter((row) => row === ch).length;
}

function isFullyRevealed(word, revealed) {
  const shown = revealed instanceof Set ? revealed : new Set(revealed || []);
  return [...lettersOf(word)].every((ch) => shown.has(ch));
}

/**
 * Phone / board mask: called letters show, the rest are `_`. The formatter
 * turns `_` into a white chip so an unguessed flap reads as a blank tile
 * rather than a punctuation mark.
 */
function maskWord(word, revealed) {
  const shown = revealed instanceof Set ? revealed : new Set(revealed || []);
  return [...fold(word)].map((ch) => {
    if (ch >= 'A' && ch <= 'Z') return shown.has(ch) ? ch : '_';
    return ch;
  }).join('');
}

/** Letters called that are not in the word, in the order they were called. */
function missesOf(word, called) {
  const inWord = lettersOf(word);
  return [...(called || [])]
    .map((ch) => fold(ch).slice(0, 1))
    .filter((ch) => ch && !inWord.has(ch));
}

/**
 * The ledger holds `CATEGORY|WORD` keys, and `fold` drops the pipe along
 * with everything else the flaps cannot paint -- so the two halves are
 * folded either side of it, never through it.
 */
function spentKeys(used = []) {
  const spent = new Set();
  for (const row of used || []) {
    if (!row) continue;
    if (typeof row === 'string') {
      const cut = row.indexOf('|');
      if (cut >= 0) {
        const word = fold(row.slice(cut + 1));
        spent.add(fold(row.slice(0, cut)) + '|' + word);
        spent.add(word);
      } else {
        spent.add(fold(row));
      }
      continue;
    }
    spent.add(wordKey(row));
    spent.add(fold(row.word || ''));
  }
  return spent;
}

function pickFrom(list, random) {
  const roll = typeof random === 'function' ? random() : Math.random();
  const index = Math.min(list.length - 1, Math.max(0, Math.floor(roll * list.length)));
  return list[index];
}

function freshPool({ used = [], categories, categoryId = '' } = {}) {
  let pool = loadWords(categories).filter(wordFits);
  const wanted = String(categoryId || '').trim().toLowerCase();
  if (wanted && wanted !== 'all') {
    const only = loadCategories(categories).find((row) => row.id === wanted);
    if (only) pool = pool.filter((row) => row.category === only.label);
  }
  if (!pool.length) {
    throw new Error('No Hangman words are available');
  }
  const spent = spentKeys(used);
  const fresh = pool.filter((row) => !spent.has(wordKey(row)) && !spent.has(row.word));
  return fresh.length ? fresh : pool;
}

/** One word the house deals -- solo play, or a setter who ran out of clock. */
function createRound({ random = Math.random, used = [], categories, categoryId = '' } = {}) {
  const pick = pickFrom(freshPool({ used, categories, categoryId }), random);
  return { category: pick.category, word: pick.word };
}

/**
 * A short menu for whoever is setting the word. Three words from three
 * different categories, so the choice is a real one rather than three
 * shades of the same hint.
 */
function suggestWords({
  random = Math.random,
  used = [],
  categories,
  categoryId = '',
  count = SUGGESTIONS,
} = {}) {
  const pool = freshPool({ used, categories, categoryId });
  const wanted = Math.max(1, Math.min(count, pool.length));
  const roll = typeof random === 'function' ? random() : Math.random();
  const from = Math.min(pool.length - 1, Math.max(0, Math.floor(roll * pool.length)));
  const out = [];
  const takenWords = new Set();
  const takenCategories = new Set();
  // Two laps of the deck from one random start: the first takes a different
  // category each time so the menu is a real choice, the second fills any
  // gap left when the deck has fewer categories than the menu has seats.
  // Walking beats re-rolling, which can hand back the same word all night.
  for (const spread of [true, false]) {
    for (let step = 0; step < pool.length && out.length < wanted; step += 1) {
      const pick = pool[(from + step) % pool.length];
      if (!pick || takenWords.has(pick.word)) continue;
      if (spread && takenCategories.has(pick.category)) continue;
      takenWords.add(pick.word);
      takenCategories.add(pick.category);
      out.push({ category: pick.category, word: pick.word });
    }
  }
  return out;
}

function validateGuess(letter, { called = [] } = {}) {
  const ch = fold(letter).replace(/[^A-Z]/g, '').slice(0, 1);
  if (!ch) return { ok: false, reason: 'empty' };
  const used = new Set([...(called || [])].map((row) => fold(row).slice(0, 1)));
  if (used.has(ch)) return { ok: false, reason: 'called' };
  return { ok: true, letter: ch };
}

function validateSolve(guess, word) {
  const want = fold(word).replace(/[^A-Z]/g, '');
  const got = fold(guess).replace(/[^A-Z]/g, '');
  if (!got) return { ok: false, reason: 'empty' };
  if (got !== want) return { ok: false, reason: 'wrong' };
  return { ok: true, word: want };
}

/**
 * A word a player typed. It has to fit the board, be one word of real
 * letters, and be in the dictionary -- an invented word would make the round
 * unwinnable and there would be no way to prove it from across the room.
 */
function validateSetterWord(text, { words, used = [] } = {}) {
  const word = fold(text).replace(/[^A-Z]/g, '');
  if (!word) return { ok: false, reason: 'empty', error: 'Type a word' };
  if (word.length < MIN_WORD) {
    return { ok: false, reason: 'short', error: `At least ${MIN_WORD} letters` };
  }
  if (word.length > MAX_WORD) {
    return { ok: false, reason: 'long', error: `At most ${MAX_WORD} letters` };
  }
  if (lettersOf(word).size < 3) {
    return { ok: false, reason: 'thin', error: 'Use at least three different letters' };
  }
  if (spentKeys(used).has(word)) {
    return { ok: false, reason: 'used', error: 'That word has already been played' };
  }
  const dictionary = Array.isArray(words) ? words : loadDictionary();
  if (dictionary.length && !hasWord(dictionary, word.toLowerCase())) {
    return { ok: false, reason: 'unknown', error: 'That is not in the dictionary' };
  }
  return { ok: true, word };
}

function letterScore(count) {
  return Math.max(0, Number(count) || 0) * LETTER_POINTS;
}

function solveScore(livesLeft) {
  return SOLVE_BONUS + Math.max(0, Number(livesLeft) || 0) * LIFE_BONUS;
}

function setterScore(misses, solved) {
  if (!solved) return 0;
  return Math.min(SETTER_MAX, Math.max(0, Number(misses) || 0) * SETTER_PER_MISS);
}

/**
 * How far the drawing has got, 0-6. The board paints it as chips rather
 * than a stick figure -- the flap alphabet has no backslash, so half a
 * gallows would be a lie.
 */
function livesLeft(misses) {
  return Math.max(0, LIVES - Math.max(0, Number(misses) || 0));
}

module.exports = {
  WORDS_PATH,
  LIVES,
  MIN_WORD,
  MAX_WORD,
  SUGGESTIONS,
  LETTER_POINTS,
  SOLVE_BONUS,
  LIFE_BONUS,
  SETTER_PER_MISS,
  SETTER_MAX,
  loadCategories,
  loadWords,
  wordKey,
  wordFits,
  lettersOf,
  countLetter,
  isFullyRevealed,
  maskWord,
  missesOf,
  createRound,
  suggestWords,
  validateGuess,
  validateSolve,
  validateSetterWord,
  letterScore,
  solveScore,
  setterScore,
  livesLeft,
};
