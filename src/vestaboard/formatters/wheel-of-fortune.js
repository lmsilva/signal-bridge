/**
 * Wheel of Fortune board frames -- invite, lobby, the masked puzzle,
 * the round winner, high scores, the night's biggest win, and the
 * not-enough-players card.
 *
 * Yellow chips (the show's gold) own the first and last two flaps. Hidden
 * letters are white chips so the board reads like the puzzle board on TV.
 */

const { COLS, fold, wrap, blankRow, placeText, assertValidLayout, CODE_BY_CHAR } = require('../encoder');
const { chipCode, centered } = require('../frames');
const { snapshotFrame } = require('./common');
const { flapLabel } = require('../../shortlinks');
const { maskPuzzle } = require('../../wheel-of-fortune');

const SOURCE = 'wheel.fortune';
const YELLOW = () => chipCode('yellow');
const WHITE = () => chipCode('white');

const TITLE_FROM = 2;
const TITLE_WIDTH = COLS - 4;
const BODY_FROM_ROW = 2;
const BODY_ROWS = 3;
const LEADER_MIN_WIDTH = 11;
const LEADER_MAX_WIDTH = 20;
const MAX_NAME = 10;

function centreRow(text, options = {}) {
  return centered(fold(text), { from: 0, width: COLS, lean: 'left', ...options });
}

function titleRow(text = 'WHEEL OF FORTUNE') {
  const row = blankRow(COLS);
  row[0] = YELLOW();
  row[1] = YELLOW();
  row[COLS - 2] = YELLOW();
  row[COLS - 1] = YELLOW();
  return centered(fold(text), {
    row,
    from: TITLE_FROM,
    width: TITLE_WIDTH,
    lean: 'left',
  });
}

function pin(code) {
  return String(code || '').trim().toUpperCase().slice(0, 4);
}

function roundLabel(roundIndex, rounds, { short = false } = {}) {
  const index = Math.max(0, Number(roundIndex) || 0);
  if (!index) return '';
  const total = Math.max(0, Number(rounds) || 0);
  return !short && total > 1 ? 'ROUND ' + index + ' OF ' + total : 'ROUND ' + index;
}

function joinLine(alias) {
  const url = flapLabel(alias) || 'TINYURL.COM/WITTYGAME';
  const prefixed = 'JOIN AT ' + url;
  return prefixed.length <= COLS ? prefixed : url;
}

function plural(count, word) {
  const n = Math.max(0, Number(count) || 0);
  return n + ' ' + word + (n === 1 ? '' : 'S');
}

function money(value) {
  return String(Math.max(0, Number(value) || 0));
}

function shell(title = 'WHEEL OF FORTUNE') {
  const rows = [titleRow(title)];
  for (let r = 1; r < 6; r += 1) rows.push(blankRow(COLS));
  return rows;
}

function fillBody(rows, text, { from = BODY_FROM_ROW, limit = BODY_ROWS } = {}) {
  const lines = wrap(text, COLS).slice(0, limit);
  const top = from + Math.floor((limit - lines.length) / 2);
  lines.forEach((line, index) => {
    rows[top + index] = centreRow(line);
  });
  return rows;
}

/**
 * Paint a masked puzzle: letters that are in play, white chips for the rest,
 * and a blank flap between words. Wrapped by word so a long phrase stacks.
 */
function paintMask(mask) {
  const folded = String(mask || '');
  const words = folded.split(/\s+/).filter(Boolean);
  const lines = [];
  let current = [];
  let width = 0;
  for (const word of words) {
    const need = word.length + (current.length ? 1 : 0);
    if (width + need > COLS && current.length) {
      lines.push(current);
      current = [];
      width = 0;
    }
    if (current.length) {
      current.push(' ');
      width += 1;
    }
    current.push(word);
    width += word.length;
  }
  if (current.length) lines.push(current);
  return lines.slice(0, BODY_ROWS).map((parts) => {
    const row = blankRow(COLS);
    const text = parts.join('');
    const start = Math.max(0, Math.floor((COLS - text.length) / 2));
    for (let i = 0; i < text.length && start + i < COLS; i += 1) {
      const ch = text[i];
      if (ch === ' ') continue;
      if (ch === '_') row[start + i] = WHITE();
      else row[start + i] = CODE_BY_CHAR.get(ch) != null ? CODE_BY_CHAR.get(ch) : WHITE();
    }
    return row;
  });
}

function inviteRows({ code = '', alias = 'WITTYGAME' } = {}) {
  const rows = shell();
  rows[2] = centreRow('JOIN THE NEXT GAME');
  rows[3] = centreRow(flapLabel(alias) || 'TINYURL.COM/WITTYGAME');
  rows[4] = centreRow('GAME CODE: ' + pin(code));
  return assertValidLayout(rows, 'wheel-invite');
}

function lobbyRows({
  code = '',
  alias = 'WITTYGAME',
  playerCount = 0,
  minPlayers = 2,
} = {}) {
  const seated = Math.max(0, Number(playerCount) || 0);
  const floor = Math.max(1, Number(minPlayers) || 1);
  const rows = inviteRows({ code, alias });
  if (seated) rows[1] = centreRow(plural(seated, 'PLAYER'));
  if (seated && seated < floor) {
    rows[5] = centreRow('NEED ' + (floor - seated) + ' MORE');
  } else if (seated) {
    rows[5] = centreRow('STARTING SOON');
  }
  return assertValidLayout(rows, 'wheel-lobby');
}

function roundRows({
  category = '',
  puzzle = '',
  revealed = [],
  mask = '',
  lastEvent = '',
  turnName = '',
  step = '',
  showCode = false,
  code = '',
} = {}) {
  const rows = shell();
  const cat = fold(category);
  if (cat) rows[1] = centreRow(cat);
  const painted = paintMask(mask || maskPuzzle(puzzle, revealed));
  const top = BODY_FROM_ROW + Math.floor((BODY_ROWS - painted.length) / 2);
  painted.forEach((row, index) => {
    rows[top + index] = row;
  });
  const footer = fold(lastEvent)
    || (showCode && pin(code) ? 'CODE ' + pin(code) : '')
    || (turnName ? fold(turnName).slice(0, 10) + (step === 'guess' ? ' TO GUESS' : ' TO SPIN') : '');
  if (footer) rows[5] = centreRow(footer.slice(0, COLS));
  return assertValidLayout(rows, 'wheel-round');
}

function leaderLines(scores = []) {
  const entries = (scores || []).map((row) => ({
    name: fold(row?.name).slice(0, MAX_NAME),
    score: money(row?.score),
  }));
  if (!entries.length) return { lines: [], start: 0 };
  const width = Math.min(
    LEADER_MAX_WIDTH,
    Math.max(LEADER_MIN_WIDTH, ...entries.map((row) => row.name.length + 2 + row.score.length)),
  );
  const lines = entries.map((row) => {
    const dots = Math.max(2, width - row.name.length - row.score.length);
    return (row.name + '.'.repeat(dots) + row.score).slice(0, COLS);
  });
  return { lines, start: Math.floor((COLS - width) / 2) };
}

function scoresRows({
  scores = [],
  code = '',
  showCode = false,
  final = false,
} = {}) {
  const footer = showCode && pin(code) ? 'GAME CODE: ' + pin(code) : '';
  const capacity = footer ? 4 : 5;
  const { lines, start } = leaderLines((scores || []).slice(0, capacity));
  const rows = [titleRow(final ? 'FINAL SCORES' : 'HIGH SCORES')];
  for (let i = 0; i < capacity; i += 1) {
    const line = lines[i];
    rows.push(line ? placeText(blankRow(COLS), line, start) : blankRow(COLS));
  }
  if (footer) rows.push(centreRow(footer));
  return assertValidLayout(rows, 'wheel-scores');
}

function winnerRows({
  title = 'ROUND WINNER',
  puzzle = '',
  name = '',
  amount = 0,
  empty = 'NOBODY SOLVED IT',
} = {}) {
  const rows = shell(title);
  const text = fold(puzzle);
  if (!text) {
    rows[3] = centreRow(empty);
    return assertValidLayout(rows, 'wheel-winner');
  }
  fillBody(rows, text);
  const who = fold(name).slice(0, MAX_NAME);
  if (who) rows[5] = centreRow(who + ' - ' + money(amount));
  return assertValidLayout(rows, 'wheel-winner');
}

function intermissionRows({
  roundIndex = 0,
  rounds = 0,
  roundWinner = null,
} = {}) {
  const label = roundLabel(roundIndex, rounds, { short: true });
  return winnerRows({
    title: label ? label + ' WINNER' : 'ROUND WINNER',
    puzzle: roundWinner?.puzzle || '',
    name: roundWinner?.name || '',
    amount: roundWinner?.score || 0,
    empty: 'NOBODY SOLVED IT',
  });
}

function bestRows({ puzzle = '', puzzleWin = '', name = '', amount = 0 } = {}) {
  return winnerRows({
    title: 'BIGGEST WIN',
    puzzle: puzzleWin || puzzle,
    name,
    amount,
    empty: 'NO WINS TONIGHT',
  });
}

function shortRows({ minPlayers = 2, playerCount = 0 } = {}) {
  const floor = Math.max(1, Number(minPlayers) || 1);
  const rows = shell();
  rows[2] = centreRow('NOT ENOUGH PLAYERS');
  rows[3] = centreRow('NEEDS ' + floor + ' TO START');
  if (playerCount > 0) {
    rows[5] = centreRow('ONLY ' + plural(playerCount, 'PLAYER') + ' JOINED');
  }
  return assertValidLayout(rows, 'wheel-short');
}

function withHold(frame, holdSeconds, card) {
  const seconds = Number(holdSeconds);
  if (Number.isFinite(seconds) && seconds > 0) frame.holdSeconds = seconds;
  if (card) frame.card = card;
  return frame;
}

function one(rows, label, card, payload) {
  return [withHold(
    snapshotFrame(rows, label, SOURCE),
    payload.holdSeconds || payload.remainingSeconds,
    card,
  )];
}

function inviteFrames(payload = {}) {
  return one(inviteRows(payload), 'Wheel of Fortune', 'invite', payload);
}

function lobbyFrames(payload = {}) {
  return one(lobbyRows(payload), 'Wheel of Fortune lobby', 'lobby', payload);
}

function roundFrames(payload = {}) {
  return one(roundRows(payload), 'Wheel of Fortune', 'round', payload);
}

function intermissionFrames(payload = {}) {
  return one(intermissionRows(payload), 'Round winner', 'intermission', payload);
}

function scoresFrames(payload = {}) {
  const final = payload.final != null ? payload.final : payload.phase === 'final';
  return one(
    scoresRows({ ...payload, final }),
    final ? 'Final scores' : 'High scores',
    final ? 'final' : 'scores',
    payload,
  );
}

function bestFrames(payload = {}) {
  return one(bestRows(payload), 'Biggest win', 'best', payload);
}

function shortFrames(payload = {}) {
  return one(shortRows(payload), 'Not enough players', 'short', payload);
}

function finalFrames(payload = {}) {
  const hold = payload.holdSeconds || payload.remainingSeconds;
  const out = scoresFrames({ ...payload, final: true });
  if (payload.puzzleWin && payload.name) {
    out.push(...bestFrames(payload));
  }
  for (const frame of out) withHold(frame, hold, 'final');
  return out;
}

function framesFor(payload = {}) {
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
    case 'short':
      return shortFrames(payload);
    case 'final':
    case 'closed':
      return finalFrames(payload);
    case 'scores':
      return scoresFrames(payload);
    case 'best':
      return bestFrames(payload);
    default:
      return inviteFrames(payload);
  }
}

const FORMATTERS = {
  'wheel.fortune': framesFor,
  'wheel.fortune.invite': inviteFrames,
  'wheel.fortune.lobby': lobbyFrames,
  'wheel.fortune.round': roundFrames,
  'wheel.fortune.intermission': intermissionFrames,
  'wheel.fortune.scores': scoresFrames,
  'wheel.fortune.best': bestFrames,
  'wheel.fortune.short': shortFrames,
  'wheel.fortune.final': finalFrames,
};

module.exports = {
  SOURCE,
  FORMATTERS,
  framesFor,
  inviteRows,
  lobbyRows,
  roundRows,
  intermissionRows,
  scoresRows,
  bestRows,
  shortRows,
};
