/**
 * Wheel of Fortune -- spin, call a letter, solve the puzzle.
 *
 * Classic living-room rules, folded onto a 6x22 board:
 *   - a consonant pays the wedge times how many there are
 *   - a vowel costs $250 from the round bank
 *   - BANKRUPT zeros the round bank (and free spins); LOSE A TURN passes
 *   - only the solver banks the round, with a $1,000 floor
 *   - Y is a consonant
 *
 * The puzzle corpus is gated here so a phrase that will not fit the board
 * never reaches a formatter that can only truncate.
 */

const fs = require('fs');
const path = require('path');
const { COLS, fold, wrap } = require('./vestaboard/encoder');

const PUZZLES_PATH = path.join(__dirname, 'wheel-of-fortune-puzzles.json');

/** Three body rows under the category, above the turn footer. */
const PUZZLE_ROWS = 3;
const VOWELS = new Set(['A', 'E', 'I', 'O', 'U']);
const VOWEL_COST = 250;
/** Classic floor: solving an empty bank still pays something. */
const SOLVE_FLOOR = 1000;

/**
 * A slightly thinned American wheel. Cash first so a random() of 0, which
 * the session tests use, is a predictable $500 rather than BANKRUPT.
 */
const WHEEL = Object.freeze([
  Object.freeze({ type: 'cash', value: 500 }),
  Object.freeze({ type: 'cash', value: 550 }),
  Object.freeze({ type: 'cash', value: 600 }),
  Object.freeze({ type: 'cash', value: 650 }),
  Object.freeze({ type: 'cash', value: 700 }),
  Object.freeze({ type: 'cash', value: 800 }),
  Object.freeze({ type: 'cash', value: 900 }),
  Object.freeze({ type: 'cash', value: 500 }),
  Object.freeze({ type: 'cash', value: 600 }),
  Object.freeze({ type: 'cash', value: 700 }),
  Object.freeze({ type: 'cash', value: 800 }),
  Object.freeze({ type: 'cash', value: 900 }),
  Object.freeze({ type: 'cash', value: 1000 }),
  Object.freeze({ type: 'cash', value: 1500 }),
  Object.freeze({ type: 'cash', value: 2500 }),
  Object.freeze({ type: 'cash', value: 3500 }),
  Object.freeze({ type: 'bankrupt' }),
  Object.freeze({ type: 'bankrupt' }),
  Object.freeze({ type: 'lose' }),
  Object.freeze({ type: 'free' }),
]);

let cachedPuzzles = null;

function loadPuzzles(override) {
  if (Array.isArray(override)) {
    return override.map(normalisePuzzle).filter(Boolean);
  }
  if (cachedPuzzles) return cachedPuzzles;
  try {
    const parsed = JSON.parse(fs.readFileSync(PUZZLES_PATH, 'utf8'));
    cachedPuzzles = Array.isArray(parsed)
      ? parsed.map(normalisePuzzle).filter(Boolean)
      : [];
  } catch {
    cachedPuzzles = [];
  }
  return cachedPuzzles;
}

function normalisePuzzle(row) {
  if (!row) return null;
  if (typeof row === 'string') {
    const puzzle = fold(row);
    return puzzle ? { category: 'PHRASE', puzzle } : null;
  }
  const puzzle = fold(row.puzzle || row.text || '');
  const category = fold(row.category || 'PHRASE');
  if (!puzzle || !category) return null;
  return { category, puzzle };
}

function puzzleKey(row) {
  return row.category + '|' + row.puzzle;
}

/** Does this phrase wrap into `rows` board rows? */
function fitsRows(text, rows, width = COLS) {
  const folded = fold(text);
  if (!folded) return false;
  return wrap(folded, width).length <= rows;
}

function puzzleFits(row) {
  const puzzle = typeof row === 'string' ? fold(row) : fold(row && row.puzzle || '');
  const category = typeof row === 'string' ? 'PHRASE' : fold(row && row.category || 'PHRASE');
  return Boolean(puzzle && category && category.length <= COLS && fitsRows(puzzle, PUZZLE_ROWS));
}

function lettersOf(puzzle) {
  return new Set([...fold(puzzle)].filter((ch) => ch >= 'A' && ch <= 'Z'));
}

function isVowel(letter) {
  return VOWELS.has(fold(letter).slice(0, 1));
}

function countLetter(puzzle, letter) {
  const ch = fold(letter).slice(0, 1);
  if (!ch) return 0;
  return [...fold(puzzle)].filter((row) => row === ch).length;
}

function isFullyRevealed(puzzle, revealed) {
  const shown = revealed instanceof Set ? revealed : new Set(revealed || []);
  return [...lettersOf(puzzle)].every((ch) => shown.has(ch));
}

/**
 * Phone / board mask: spaces stay spaces, called letters show, the rest `_`.
 * The formatter turns `_` into a white chip so the living-room read matches
 * the show.
 */
function maskPuzzle(puzzle, revealed) {
  const shown = revealed instanceof Set ? revealed : new Set(revealed || []);
  return [...fold(puzzle)].map((ch) => {
    if (ch === ' ') return ' ';
    if (ch >= 'A' && ch <= 'Z') return shown.has(ch) ? ch : '_';
    return ch;
  }).join('');
}

/** The wedge carries its seat on the wheel so a phone can animate to it. */
function spinWheel(random = Math.random) {
  const roll = typeof random === 'function' ? random() : Math.random();
  const index = Math.min(WHEEL.length - 1, Math.max(0, Math.floor(roll * WHEEL.length)));
  return { ...WHEEL[index], index };
}

function wedgeLabel(wedge) {
  if (!wedge) return '';
  if (wedge.type === 'bankrupt') return 'BANKRUPT';
  if (wedge.type === 'lose') return 'LOSE A TURN';
  if (wedge.type === 'free') return 'FREE SPIN';
  return String(wedge.value || 0);
}

/** The painted wheel every phone draws, in wheel order. */
function wheelLayout() {
  return WHEEL.map((wedge, index) => ({
    index,
    type: wedge.type,
    value: wedge.value || 0,
    label: wedgeLabel(wedge),
  }));
}

function createRound({ random = Math.random, used = [], puzzles } = {}) {
  const pool = loadPuzzles(puzzles).filter(puzzleFits);
  if (!pool.length) {
    throw new Error('No Wheel of Fortune puzzles are available');
  }
  const spent = new Set();
  for (const row of used || []) {
    if (typeof row === 'string') {
      if (row.includes('|')) {
        const cut = row.indexOf('|');
        const key = puzzleKey({
          category: fold(row.slice(0, cut)),
          puzzle: fold(row.slice(cut + 1)),
        });
        spent.add(key);
        spent.add(key.split('|')[1] || '');
      } else {
        spent.add(fold(row));
      }
      continue;
    }
    const norm = normalisePuzzle(row);
    if (norm) {
      spent.add(puzzleKey(norm));
      spent.add(norm.puzzle);
    }
  }
  const fresh = pool.filter((row) => !spent.has(puzzleKey(row)) && !spent.has(row.puzzle));
  const choices = fresh.length ? fresh : pool;
  const roll = typeof random === 'function' ? random() : Math.random();
  const index = Math.min(choices.length - 1, Math.max(0, Math.floor(roll * choices.length)));
  const pick = choices[index];
  return { category: pick.category, puzzle: pick.puzzle };
}

function validateLetter(letter, { called = [], vowel = false } = {}) {
  const ch = fold(letter).replace(/[^A-Z]/g, '').slice(0, 1);
  if (!ch) return { ok: false, reason: 'empty' };
  if (vowel ? !isVowel(ch) : isVowel(ch)) {
    return { ok: false, reason: vowel ? 'not-vowel' : 'not-consonant' };
  }
  const used = new Set([...(called || [])].map((row) => fold(row).slice(0, 1)));
  if (used.has(ch)) return { ok: false, reason: 'called' };
  return { ok: true, letter: ch };
}

function validateSolve(guess, puzzle) {
  const want = fold(puzzle).replace(/[^A-Z]/g, '');
  const got = fold(guess).replace(/[^A-Z]/g, '');
  if (!got) return { ok: false, reason: 'empty' };
  if (got !== want) return { ok: false, reason: 'wrong' };
  return { ok: true, puzzle: fold(puzzle) };
}

function winAmount(bank) {
  return Math.max(SOLVE_FLOOR, Math.max(0, Number(bank) || 0));
}

module.exports = {
  PUZZLES_PATH,
  PUZZLE_ROWS,
  VOWELS,
  VOWEL_COST,
  SOLVE_FLOOR,
  WHEEL,
  loadPuzzles,
  normalisePuzzle,
  puzzleKey,
  fitsRows,
  puzzleFits,
  lettersOf,
  isVowel,
  countLetter,
  isFullyRevealed,
  maskPuzzle,
  spinWheel,
  wedgeLabel,
  wheelLayout,
  createRound,
  validateLetter,
  validateSolve,
  winAmount,
};
