/**
 * Word Scramble — Boggle on a 4×4 Vestaboard grid.
 *
 * Dice are the classic 16, minus Q (a flap is one letter; Qu needs a rule
 * nobody can read from across the room). The solver walks 8-way adjacency
 * without reusing a cell, pruning prefixes with a binary search on the
 * sorted ENABLE1 list. Scoring climbs with every extra letter.
 */

const fs = require('fs');
const path = require('path');

const GRID = 4;
const MIN_WORD = 3;
const DEFAULT_MIN_SOLUTIONS = 30;
const MAX_ROLLS = 40;
const WORDS_PATH = path.join(__dirname, 'word-scramble-words.json');

/** Classic Boggle dice; the Qu face is X so every cell is one flap. */
const DICE = Object.freeze([
  'AACIOT', 'ABILTY', 'ABJMOX', 'ACDEMP',
  'ACELRS', 'ADENVZ', 'AHMORS', 'BIFORX',
  'DENOSW', 'DKNOTU', 'EEFHIY', 'EGKLUY',
  'EGINTV', 'EHINPS', 'ELPSTU', 'GILRUW',
]);

const NEIGHBORS = [];
for (let row = 0; row < GRID; row += 1) {
  for (let col = 0; col < GRID; col += 1) {
    const next = [];
    for (let dr = -1; dr <= 1; dr += 1) {
      for (let dc = -1; dc <= 1; dc += 1) {
        if (!dr && !dc) continue;
        const r = row + dr;
        const c = col + dc;
        if (r >= 0 && r < GRID && c >= 0 && c < GRID) {
          next.push(r * GRID + c);
        }
      }
    }
    NEIGHBORS.push(next);
  }
}

let cachedWords = null;

function loadWords(override) {
  if (Array.isArray(override)) {
    return override;
  }
  if (cachedWords) return cachedWords;
  try {
    const parsed = JSON.parse(fs.readFileSync(WORDS_PATH, 'utf8'));
    cachedWords = Array.isArray(parsed) ? parsed : [];
  } catch {
    cachedWords = [];
  }
  return cachedWords;
}

function compare(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function insertionPoint(words, prefix) {
  let lo = 0;
  let hi = words.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (compare(words[mid], prefix) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function hasWord(words, word) {
  const i = insertionPoint(words, word);
  return words[i] === word;
}

function hasPrefix(words, prefix) {
  const i = insertionPoint(words, prefix);
  return i < words.length && String(words[i]).startsWith(prefix);
}

function rollDice(random = Math.random) {
  const faces = DICE.map((die) => {
    const index = Math.min(die.length - 1, Math.max(0, Math.floor(random() * die.length)));
    return die[index];
  });
  for (let i = faces.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const tmp = faces[i];
    faces[i] = faces[j];
    faces[j] = tmp;
  }
  const grid = [];
  for (let row = 0; row < GRID; row += 1) {
    grid.push(faces.slice(row * GRID, row * GRID + GRID).join(''));
  }
  return grid;
}

function letterAt(grid, index) {
  const row = Math.floor(index / GRID);
  const col = index % GRID;
  return String(grid[row] || '')[col] || '';
}

function solveGrid(grid, words = loadWords()) {
  const found = new Set();
  const used = new Array(GRID * GRID).fill(false);

  function walk(index, soFar) {
    const next = soFar + letterAt(grid, index).toLowerCase();
    if (next.length >= MIN_WORD && hasWord(words, next)) {
      found.add(next);
    }
    if (!hasPrefix(words, next)) {
      return;
    }
    used[index] = true;
    for (const neighbor of NEIGHBORS[index]) {
      if (!used[neighbor]) walk(neighbor, next);
    }
    used[index] = false;
  }

  for (let i = 0; i < GRID * GRID; i += 1) {
    walk(i, '');
  }
  return [...found].sort();
}

/**
 * Points by word length. Classic Boggle pays a 3 and a 4 the same 1 point,
 * which reads as a bug to anyone watching the board — every extra letter
 * earns more here. Past the ladder each letter is worth another 3.
 */
const SCORE_LADDER = Object.freeze([0, 0, 0, 1, 2, 4, 6, 9, 12]);
const SCORE_PER_EXTRA_LETTER = 3;

function scoreWord(word) {
  const n = String(word || '').length;
  if (n < MIN_WORD) return 0;
  const last = SCORE_LADDER.length - 1;
  if (n <= last) return SCORE_LADDER[n];
  return SCORE_LADDER[last] + SCORE_PER_EXTRA_LETTER * (n - last);
}

function createRound({
  random = Math.random,
  words = loadWords(),
  minSolutions = DEFAULT_MIN_SOLUTIONS,
  maxRolls = MAX_ROLLS,
} = {}) {
  let grid = null;
  let solutions = [];
  for (let attempt = 0; attempt < maxRolls; attempt += 1) {
    grid = rollDice(random);
    solutions = solveGrid(grid, words);
    const longEnough = solutions.some((word) => word.length >= 6);
    if (solutions.length >= minSolutions && longEnough) {
      return { grid, solutions };
    }
  }
  return { grid: grid || rollDice(random), solutions };
}

function validateWord(grid, word, words = loadWords()) {
  const cleaned = String(word || '').trim().toLowerCase();
  if (cleaned.length < MIN_WORD || !hasWord(words, cleaned)) {
    return { ok: false, reason: 'not-a-word' };
  }
  const solutions = new Set(solveGrid(grid, words));
  if (!solutions.has(cleaned)) {
    return { ok: false, reason: 'not-on-board' };
  }
  return { ok: true, word: cleaned, points: scoreWord(cleaned) };
}

/**
 * @param {Array<{ id: string, words: string[] }>} players
 * @param {{ duplicateRule?: 'everyone'|'cancel', grid?: string[], words?: string[] }} options
 */
function scoreRound(players, {
  duplicateRule = 'everyone',
  grid = null,
  words = loadWords(),
} = {}) {
  const legal = new Set(grid ? solveGrid(grid, words) : words);
  const claimed = new Map();
  for (const player of players || []) {
    const seen = new Set();
    for (const raw of player.words || []) {
      const word = String(raw || '').trim().toLowerCase();
      if (!word || seen.has(word) || (legal.size && !legal.has(word))) continue;
      seen.add(word);
      const list = claimed.get(word) || [];
      list.push(player.id);
      claimed.set(word, list);
    }
  }

  const byPlayer = new Map();
  for (const player of players || []) {
    byPlayer.set(player.id, { id: player.id, score: 0, words: [] });
  }
  for (const [word, ids] of claimed) {
    const points = duplicateRule === 'cancel' && ids.length > 1 ? 0 : scoreWord(word);
    for (const id of ids) {
      const row = byPlayer.get(id);
      if (!row) continue;
      row.score += points;
      row.words.push({ word, points });
    }
  }
  return [...byPlayer.values()];
}

function hardestWord(entries = []) {
  let best = null;
  for (const entry of entries) {
    const word = String(entry.word || entry || '');
    if (!word) continue;
    if (!best
      || word.length > best.word.length
      || (word.length === best.word.length && word < best.word)) {
      best = { word, playerId: entry.playerId || entry.id || '', points: scoreWord(word) };
    }
  }
  return best;
}

module.exports = {
  GRID,
  DICE,
  MIN_WORD,
  SCORE_LADDER,
  DEFAULT_MIN_SOLUTIONS,
  WORDS_PATH,
  loadWords,
  hasWord,
  hasPrefix,
  rollDice,
  solveGrid,
  scoreWord,
  createRound,
  validateWord,
  scoreRound,
  hardestWord,
};
