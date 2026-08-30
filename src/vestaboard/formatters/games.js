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

function lobbyRows({ code = '', playerCount = 0 } = {}) {
  const pin = String(code || '').trim().toUpperCase().slice(0, 4);
  const n = Math.max(0, Number(playerCount) || 0);
  const who = n === 1 ? '1 PLAYER' : `${n} PLAYERS`;
  return assertValidLayout([
    titleRow(),
    centered(fold(who), { from: 0, width: COLS }),
    centered(fold('GAME CODE'), { from: 0, width: COLS }),
    centered(fold(pin), { from: 0, width: COLS }),
    centered(fold('WAITING TO START'), { from: 0, width: COLS }),
    blankRow(COLS),
  ], 'word-scramble-lobby');
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

function withHold(frame, holdSeconds) {
  const seconds = Number(holdSeconds);
  if (Number.isFinite(seconds) && seconds > 0) {
    frame.holdSeconds = seconds;
  }
  return frame;
}

function inviteFrames(payload = {}) {
  return [snapshotFrame(inviteRows(payload), 'Word Scramble', SOURCE)];
}

function lobbyFrames(payload = {}) {
  return [snapshotFrame(lobbyRows(payload), 'Word Scramble lobby', SOURCE)];
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
  return [snapshotFrame(
    scoresRows({ ...payload, final }),
    final ? 'Final scores' : 'High scores',
    SOURCE,
  )];
}

function bestFrames(payload = {}) {
  return [snapshotFrame(bestRows(payload), 'Best word', SOURCE)];
}

function framesFor(payload = {}) {
  switch (payload.phase || payload.card) {
    case 'invite':
    case 'invited':
      return inviteFrames(payload);
    case 'lobby':
      return lobbyFrames(payload);
    case 'round':
      return roundFrames(payload);
    case 'scores':
    case 'intermission':
    case 'final':
      return payload.card === 'best' ? bestFrames(payload) : scoresFrames(payload);
    case 'best':
      return bestFrames(payload);
    default:
      return inviteFrames(payload);
  }
}

const FORMATTERS = {
  'word.scramble': framesFor,
  'word.scramble.invite': inviteFrames,
  'word.scramble.lobby': lobbyFrames,
  'word.scramble.round': roundFrames,
  'word.scramble.scores': scoresFrames,
  'word.scramble.best': bestFrames,
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
  bestRows,
  inviteFrames,
  lobbyFrames,
  roundFrames,
  scoresFrames,
  bestFrames,
};
