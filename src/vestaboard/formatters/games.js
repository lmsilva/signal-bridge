/**
 * Word Scramble board frames — invite, lobby, the 4×4 grid, high scores,
 * and the hardest word of the session.
 */

const { COLS, fold, blankRow, placeText, assertValidLayout } = require('../encoder');
const { chipCode, centered } = require('../frames');
const { snapshotFrame } = require('./common');
const { flapLabel } = require('../../shortlinks');
const { scoreWord } = require('../../word-scramble');

const SOURCE = 'word.scramble';
const YELLOW = () => chipCode('yellow');
const GREEN = () => chipCode('green');

/** Chips own the first and last two flaps; the title centres in what is left. */
const TITLE_FROM = 2;
const TITLE_WIDTH = COLS - 4;

/** The round card keeps the grid (and its border) right of this column. */
const ROUND_TEXT_WIDTH = 14;

function titleRow() {
  const row = blankRow(COLS);
  row[0] = GREEN();
  row[1] = GREEN();
  row[20] = GREEN();
  row[21] = GREEN();
  return centered(fold('WORD SCRAMBLE'), {
    row,
    from: TITLE_FROM,
    width: TITLE_WIDTH,
    lean: 'left',
  });
}

function codeLabel(code) {
  const pin = String(code || '').trim().toUpperCase().slice(0, 4);
  return pin ? `GAME CODE: ${pin}` : '';
}

function roundLabel(roundIndex, rounds) {
  const index = Math.max(0, Number(roundIndex) || 0);
  if (!index) return '';
  const total = Math.max(0, Number(rounds) || 0);
  return total > 1 ? `ROUND ${index} OF ${total}` : `ROUND ${index}`;
}

function inviteRows({ code = '', alias = 'WITTYGAME' } = {}) {
  const pin = String(code || '').trim().toUpperCase().slice(0, 4);
  const url = flapLabel(alias) || 'TINYURL.COM/WITTYGAME';
  return assertValidLayout([
    titleRow(),
    blankRow(COLS),
    centered(fold('JOIN THE NEXT GAME'), { from: 0, width: COLS }),
    centered(fold(url), { from: 0, width: COLS }),
    centered(fold(`GAME CODE: ${pin}`), { from: 0, width: COLS }),
    blankRow(COLS),
  ], 'word-scramble-invite');
}

/**
 * Lobby keeps the invite card so the URL and code stay readable. Only the
 * blank row fills in with the seat count — a full rewrite used to cascade
 * across every flap and briefly read as "2         s" while PLAYERS was
 * still flipping and JOIN THE NEXT GAME had not yet become GAME CODE.
 */
function lobbyRows({ code = '', alias = 'WITTYGAME', playerCount = 0 } = {}) {
  const n = Math.max(0, Number(playerCount) || 0);
  const who = n <= 0 ? '' : n === 1 ? '1 PLAYER' : `${n} PLAYERS`;
  const rows = inviteRows({ code, alias });
  if (who) {
    rows[1] = centered(fold(who), { from: 0, width: COLS });
  }
  return assertValidLayout(rows, 'word-scramble-lobby');
}

/**
 * HOW MANY / SCRAMBLED / WORDS CAN / YOU FIND? on the left, then which round
 * this is and — when late joining is allowed — the code to get in on a phone.
 * Yellow border at cols 14–21 around the 4×4 letters at cols 16–19, rows 1–4.
 */
function roundRows({
  grid = [],
  roundIndex = 0,
  rounds = 0,
  code = '',
  showCode = false,
} = {}) {
  const lines = [
    'HOW MANY',
    'SCRAMBLED',
    'WORDS CAN',
    'YOU FIND?',
    roundLabel(roundIndex, rounds),
    showCode && codeLabel(code) ? `CODE ${String(code).trim().toUpperCase().slice(0, 4)}` : '',
  ];
  const rows = [];
  for (let r = 0; r < 6; r += 1) {
    const row = blankRow(COLS);
    const line = lines[r];
    if (line) {
      placeText(row, fold(line).slice(0, ROUND_TEXT_WIDTH), 0);
    }
    if (r === 0 || r === 5) {
      for (let c = 14; c <= 21; c += 1) row[c] = YELLOW();
    } else {
      row[14] = YELLOW();
      row[15] = YELLOW();
      row[20] = YELLOW();
      row[21] = YELLOW();
      const letters = String(grid[r - 1] || '').toUpperCase().padEnd(4, ' ').slice(0, 4);
      placeText(row, letters, 16);
    }
    rows.push(row);
  }
  return assertValidLayout(rows, 'word-scramble-round');
}

function leaderDots(name, score, width = COLS) {
  const left = fold(String(name || '').toUpperCase()).slice(0, 10);
  const right = String(Math.max(0, Number(score) || 0));
  const dots = Math.max(1, width - left.length - right.length - 1);
  return `${left} ${'.'.repeat(dots)}${right}`.slice(0, width);
}

/**
 * The last row is the code when players may still join, so the board never
 * leaves a latecomer guessing between rounds. Without it the fifth score fits.
 */
function scoresRows({
  scores = [],
  code = '',
  showCode = false,
  final = false,
} = {}) {
  const footer = showCode ? codeLabel(code) : '';
  const capacity = footer ? 4 : 5;
  const rows = [
    centered(fold(final ? 'FINAL SCORES' : 'HIGH SCORES'), { from: 0, width: COLS }),
  ];
  const top = (scores || []).slice(0, capacity);
  for (let i = 0; i < capacity; i += 1) {
    const entry = top[i];
    rows.push(entry
      ? placeText(blankRow(COLS), leaderDots(entry.name, entry.score), 0)
      : blankRow(COLS));
  }
  if (footer) {
    rows.push(centered(fold(footer), { from: 0, width: COLS }));
  }
  return assertValidLayout(rows, 'word-scramble-scores');
}

/**
 * Between rounds: who won the round just played, then the running total.
 */
function intermissionRows({
  roundIndex = 0,
  rounds = 0,
  roundWinner = null,
  roundScores = [],
  scores = [],
} = {}) {
  const title = roundLabel(roundIndex, rounds)
    ? `${roundLabel(roundIndex, rounds)} WINNER`
    : 'ROUND WINNER';
  const rows = [
    centered(fold(title), { from: 0, width: COLS }),
  ];
  if (roundWinner) {
    rows.push(placeText(blankRow(COLS), leaderDots(roundWinner.name, roundWinner.score), 0));
  } else {
    rows.push(centered(fold('NO POINTS'), { from: 0, width: COLS }));
  }
  rows.push(blankRow(COLS));
  rows.push(centered(fold('RUNNING TOTAL'), { from: 0, width: COLS }));
  const top = (scores || roundScores || []).slice(0, 2);
  for (let i = 0; i < 2; i += 1) {
    const entry = top[i];
    rows.push(entry
      ? placeText(blankRow(COLS), leaderDots(entry.name, entry.score), 0)
      : blankRow(COLS));
  }
  return assertValidLayout(rows, 'word-scramble-intermission');
}

function bestRows({ word = '', name = '', points = 0 } = {}) {
  return assertValidLayout([
    centered(fold('BEST WORD'), { from: 0, width: COLS }),
    centered(fold(String(word || '').toUpperCase()), { from: 0, width: COLS }),
    centered(fold('FOUND BY'), { from: 0, width: COLS }),
    centered(fold(String(name || '').toUpperCase()), { from: 0, width: COLS }),
    centered(fold(String(points || scoreWord(word) || '')), { from: 0, width: COLS }),
    blankRow(COLS),
  ], 'word-scramble-best');
}

/**
 * The game is over. Blank rather than a sign-off card: whatever airs next
 * should own the board, and a card reading "waiting to start" for a session
 * nobody can join any more is worse than an empty wall for a minute.
 */
function clearedRows() {
  return assertValidLayout(
    Array.from({ length: 6 }, () => blankRow(COLS)),
    'word-scramble-clear',
  );
}

function withHold(frame, holdSeconds) {
  const seconds = Number(holdSeconds);
  if (Number.isFinite(seconds) && seconds > 0) {
    frame.holdSeconds = seconds;
  }
  return frame;
}

function inviteFrames(payload = {}) {
  return [withHold(
    snapshotFrame(inviteRows(payload), 'Word Scramble', SOURCE),
    payload.holdSeconds || payload.remainingSeconds,
  )];
}

function lobbyFrames(payload = {}) {
  return [withHold(
    snapshotFrame(lobbyRows(payload), 'Word Scramble lobby', SOURCE),
    payload.holdSeconds || payload.remainingSeconds,
  )];
}

function roundFrames(payload = {}) {
  const hold = Number(payload.holdSeconds || payload.remainingSeconds || 0);
  return [withHold(
    snapshotFrame(roundRows(payload), 'Word Scramble', SOURCE),
    hold,
  )];
}

function scoresFrames(payload = {}) {
  const final = payload.final != null ? payload.final : payload.phase === 'final';
  return [withHold(
    snapshotFrame(
      scoresRows({ ...payload, final }),
      final ? 'Final scores' : 'High scores',
      SOURCE,
    ),
    payload.holdSeconds || payload.remainingSeconds,
  )];
}

function intermissionFrames(payload = {}) {
  return [withHold(
    snapshotFrame(intermissionRows(payload), 'Round winner', SOURCE),
    payload.holdSeconds || payload.remainingSeconds,
  )];
}

function bestFrames(payload = {}) {
  return [withHold(
    snapshotFrame(bestRows(payload), 'Best word', SOURCE),
    payload.holdSeconds || payload.remainingSeconds,
  )];
}

function finalFrames(payload = {}) {
  const hold = payload.holdSeconds || payload.remainingSeconds;
  const out = scoresFrames({ ...payload, final: true, card: 'scores' });
  if (payload.word && payload.name) {
    out.push(...bestFrames(payload));
  }
  for (const frame of out) {
    withHold(frame, hold);
  }
  return out;
}

function clearFrames() {
  return [snapshotFrame(clearedRows(), 'Game over', SOURCE)];
}

function framesFor(payload = {}) {
  if (payload.card === 'clear') {
    return clearFrames(payload);
  }
  // Prefer `card` — that is what pushPhase asked for. `phase` can lag a tick
  // behind on the way into a new stage and would otherwise paint the wrong
  // layout (invite body with a half-written player line).
  switch (payload.card || payload.phase) {
    case 'invite':
    case 'invited':
      return inviteFrames(payload);
    case 'lobby':
      return lobbyFrames(payload);
    case 'round':
      return roundFrames(payload);
    case 'intermission':
      return intermissionFrames(payload);
    case 'final':
      return finalFrames(payload);
    case 'scores':
      return scoresFrames(payload);
    case 'best':
      return bestFrames(payload);
    case 'closed':
      return clearFrames(payload);
    default:
      return inviteFrames(payload);
  }
}

const FORMATTERS = {
  'word.scramble': framesFor,
  'word.scramble.invite': inviteFrames,
  'word.scramble.lobby': lobbyFrames,
  'word.scramble.round': roundFrames,
  'word.scramble.intermission': intermissionFrames,
  'word.scramble.scores': scoresFrames,
  'word.scramble.best': bestFrames,
  'word.scramble.final': finalFrames,
  'word.scramble.clear': clearFrames,
};

module.exports = {
  SOURCE,
  FORMATTERS,
  framesFor,
  roundLabel,
  inviteRows,
  lobbyRows,
  roundRows,
  scoresRows,
  intermissionRows,
  bestRows,
  clearedRows,
  inviteFrames,
  lobbyFrames,
  roundFrames,
  intermissionFrames,
  scoresFrames,
  bestFrames,
  finalFrames,
  clearFrames,
};
