/**
 * Word Scramble board frames — invite, lobby, the 4×4 grid, high scores,
 * and the hardest word of the session.
 */

const { COLS, fold, blankRow, placeText, assertValidLayout } = require('../encoder');
const { chipCode, centered } = require('../frames');
const { snapshotFrame } = require('./common');
const { flapLabel } = require('../../shortlinks');

const SOURCE = 'word.scramble';
const YELLOW = () => chipCode('yellow');
const GREEN = () => chipCode('green');

function titleRow() {
  const row = blankRow(COLS);
  row[0] = GREEN();
  row[1] = GREEN();
  row[20] = GREEN();
  row[21] = GREEN();
  placeText(row, fold('WORD SCRAMBLE'), 3);
  return row;
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
 * HOW MANY / SCRAMBLED / WORDS CAN / YOU FIND? on the left.
 * Yellow border at cols 14–21 around the 4×4 letters at cols 16–19, rows 1–4.
 */
function roundRows({ grid = [] } = {}) {
  const lines = ['HOW MANY', 'SCRAMBLED', 'WORDS CAN', 'YOU FIND?'];
  const rows = [];
  for (let r = 0; r < 6; r += 1) {
    const row = blankRow(COLS);
    if (r < 4) {
      placeText(row, fold(lines[r]), 0);
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

function scoresRows({ scores = [] } = {}) {
  const rows = [
    centered(fold('HIGH SCORES'), { from: 0, width: COLS }),
  ];
  const top = (scores || []).slice(0, 5);
  for (let i = 0; i < 5; i += 1) {
    const entry = top[i];
    rows.push(entry
      ? placeText(blankRow(COLS), leaderDots(entry.name, entry.score), 0)
      : blankRow(COLS));
  }
  return assertValidLayout(rows, 'word-scramble-scores');
}

function bestRows({ word = '', name = '', points = 0 } = {}) {
  return assertValidLayout([
    centered(fold('BEST WORD'), { from: 0, width: COLS }),
    centered(fold(String(word || '').toUpperCase()), { from: 0, width: COLS }),
    centered(fold('FOUND BY'), { from: 0, width: COLS }),
    centered(fold(String(name || '').toUpperCase()), { from: 0, width: COLS }),
    centered(fold(String(points || scoreOrBlank(word))), { from: 0, width: COLS }),
    blankRow(COLS),
  ], 'word-scramble-best');
}

function scoreOrBlank(word) {
  const n = String(word || '').length;
  if (n < 3) return '';
  if (n <= 4) return '1';
  if (n === 5) return '2';
  if (n === 6) return '3';
  if (n === 7) return '5';
  return '11';
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
  return [snapshotFrame(scoresRows(payload), 'High scores', SOURCE)];
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
