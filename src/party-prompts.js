/**
 * Party Prompts — answer an open-ended prompt with your wittiest line, then
 * vote for somebody else's.
 *
 * A round runs in two halves. Everyone seated writes one answer to the prompt
 * the board is showing, then everyone votes on the answers they can see (never
 * their own). A vote is a point, so the leaderboard stays single-digit and
 * readable from across the room.
 *
 * Everything a phone types has to survive the trip to a split-flap board, so
 * answers are folded to the board alphabet and refused when they would not fit
 * the winner card. That check happens once, here, rather than being discovered
 * later by a formatter that can only truncate.
 */

const fs = require('fs');
const path = require('path');
const { COLS, fold, wrap } = require('./vestaboard/encoder');

const PROMPTS_PATH = path.join(__dirname, 'party-prompts-prompts.json');

/** The prompt card keeps three rows for the question itself. */
const PROMPT_ROWS = 3;
/** The round-winner card keeps three rows for the answer. */
const ANSWER_ROWS = 3;
/** A phone can type this much; the wrap check below is the real limit. */
const ANSWER_MAX_CHARS = 60;
const MIN_ANSWER_CHARS = 1;

let cachedPrompts = null;

function loadPrompts(override) {
  if (Array.isArray(override)) {
    return override.map((row) => String(row || '')).filter(Boolean);
  }
  if (cachedPrompts) return cachedPrompts;
  try {
    const parsed = JSON.parse(fs.readFileSync(PROMPTS_PATH, 'utf8'));
    cachedPrompts = Array.isArray(parsed)
      ? parsed.map((row) => String(row || '')).filter(Boolean)
      : [];
  } catch {
    cachedPrompts = [];
  }
  return cachedPrompts;
}

/** Does this text wrap into `rows` board rows or fewer? */
function fitsRows(text, rows, width = COLS) {
  const folded = fold(text);
  if (!folded) return false;
  return wrap(folded, width).length <= rows;
}

/** The corpus gate: a prompt nobody can read in three rows is not shippable. */
function promptFits(text) {
  return fitsRows(text, PROMPT_ROWS);
}

function answerFits(text) {
  return fitsRows(text, ANSWER_ROWS);
}

/**
 * Fold a typed answer down to what a board can spell. Case is thrown away
 * because every flap is a capital, so "Cup Holder" and "CUP HOLDER" are the
 * same answer and should not both appear in the voting list.
 */
function normaliseAnswer(value) {
  return fold(value).slice(0, ANSWER_MAX_CHARS).trim();
}

/** Two answers only collide when they read identically on the board. */
function answerKey(value) {
  return normaliseAnswer(value).replace(/[^A-Z0-9]/g, '');
}

/**
 * Pick a prompt the table has not seen this session. Falls back to reusing
 * the corpus once every prompt has been spent rather than ending the game.
 */
function createRound({ random = Math.random, used = [], prompts } = {}) {
  const pool = loadPrompts(prompts).filter(promptFits);
  if (!pool.length) {
    throw new Error('No Party Prompts questions are available');
  }
  const spent = new Set((used || []).map((row) => fold(row)));
  const fresh = pool.filter((row) => !spent.has(fold(row)));
  const choices = fresh.length ? fresh : pool;
  const roll = typeof random === 'function' ? random() : Math.random();
  const index = Math.min(choices.length - 1, Math.max(0, Math.floor(roll * choices.length)));
  return { prompt: fold(choices[index]) };
}

/**
 * Check one typed answer. `taken` carries the answers already in this round so
 * two people cannot submit the same line — the voting list has to stay
 * unambiguous, and a duplicate would split the vote for no reason.
 */
function validateAnswer(answer, { taken = [] } = {}) {
  const cleaned = normaliseAnswer(answer);
  if (cleaned.length < MIN_ANSWER_CHARS) {
    return { ok: false, reason: 'empty' };
  }
  if (!answerFits(cleaned)) {
    return { ok: false, reason: 'too-long' };
  }
  const key = answerKey(cleaned);
  if (!key) {
    return { ok: false, reason: 'empty' };
  }
  if (taken.some((row) => answerKey(row) === key)) {
    return { ok: false, reason: 'duplicate' };
  }
  return { ok: true, answer: cleaned };
}

/**
 * Turn a round's votes into points. One vote is one point. Self-votes were
 * refused on the way in, so nothing has to be unwound here.
 *
 * `answers` is `[{ playerId, answer }]`, `votes` is `[{ voterId, answerPlayerId }]`.
 */
function scoreRound(answers = [], votes = []) {
  const wrote = new Set((answers || []).map((row) => String(row?.playerId || '')).filter(Boolean));
  const tally = new Map();
  for (const id of wrote) tally.set(id, 0);
  const voted = new Set();
  for (const vote of votes || []) {
    const voterId = String(vote?.voterId || '');
    const targetId = String(vote?.answerPlayerId || '');
    // One vote each, and never for yourself.
    if (!targetId || !wrote.has(targetId) || voterId === targetId) continue;
    if (voterId && voted.has(voterId)) continue;
    if (voterId) voted.add(voterId);
    tally.set(targetId, (tally.get(targetId) || 0) + 1);
  }
  return [...tally.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

module.exports = {
  PROMPTS_PATH,
  PROMPT_ROWS,
  ANSWER_ROWS,
  ANSWER_MAX_CHARS,
  loadPrompts,
  fitsRows,
  promptFits,
  answerFits,
  normaliseAnswer,
  answerKey,
  createRound,
  validateAnswer,
  scoreRound,
};
