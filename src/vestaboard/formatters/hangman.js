/**
 * Hangman board frames -- invite, lobby, the masked word with its lives,
 * the round winner, high scores, the word of the night, and the
 * not-enough-players card.
 *
 * Orange chips own the first and last two flaps. Unguessed letters are white
 * chips, so a blank reads as an empty tile rather than punctuation, and the
 * six lives are a row of chips that turn from green to red as they go. The
 * flap alphabet has no backslash, so a stick figure would only ever be half
 * a drawing -- the chips say the same thing and say it from the doorway.
 */

const { COLS, fold, wrap, blankRow, placeText, assertValidLayout, CODE_BY_CHAR } = require('../encoder');
const { chipCode, centered } = require('../frames');
const { snapshotFrame } = require('./common');
const { flapLabel } = require('../../shortlinks');
const { maskWord, LIVES } = require('../../hangman');

const SOURCE = 'hangman.game';
const ORANGE = () => chipCode('orange');
const GREEN = () => chipCode('green');
const RED = () => chipCode('red');
const WHITE = () => chipCode('white');

const TITLE_FROM = 2;
const TITLE_WIDTH = COLS - 4;
const BODY_FROM_ROW = 2;
const BODY_ROWS = 3;
const LEADER_MIN_WIDTH = 11;
const LEADER_MAX_WIDTH = 20;
const MAX_NAME = 10;
/** What marks the four flaps of a join code as a code and not a score. */
const CODE_TAG = '#';
/** Misses that still fit the row once `MISS ` has had its say. */
const MAX_MISSES_SHOWN = 8;

function centreRow(text, options = {}) {
  return centered(fold(text), { from: 0, width: COLS, lean: 'left', ...options });
}

/**
 * The masthead. With a code it reads like a marquee -- name on the left, room
 * number on the right -- which costs no row the game needs and keeps the way
 * in on the wall for the whole word. The split only happens when the pair fits
 * with a blank between them and one off each chip pair; a title too long to
 * share keeps the band to itself and the code goes without.
 */
function titleRow(text = 'HANGMAN', { code = '' } = {}) {
  const row = blankRow(COLS);
  row[0] = ORANGE();
  row[1] = ORANGE();
  row[COLS - 2] = ORANGE();
  row[COLS - 1] = ORANGE();
  const title = fold(text);
  const tag = pin(code) ? CODE_TAG + pin(code) : '';
  if (tag && title.length + tag.length + 3 <= TITLE_WIDTH) {
    placeText(row, title, TITLE_FROM + 1);
    return placeText(row, tag, TITLE_FROM + TITLE_WIDTH - 1 - tag.length);
  }
  return centered(title, {
    row,
    from: TITLE_FROM,
    width: TITLE_WIDTH,
    lean: 'left',
  });
}

function pin(code) {
  return fold(code).replace(/[^A-Z0-9]/g, '').slice(0, 4);
}

function roundLabel(roundIndex, rounds, { short = false } = {}) {
  const index = Math.max(0, Number(roundIndex) || 0);
  const total = Math.max(0, Number(rounds) || 0);
  if (!index) return '';
  if (short || !total || total < 2) return 'ROUND ' + index;
  return 'ROUND ' + index + ' OF ' + total;
}

function plural(count, word) {
  const n = Math.max(0, Number(count) || 0);
  return n + ' ' + word + (n === 1 ? '' : 'S');
}

/** MISS pluralises the awkward way, and it is the word this game says most. */
function missesLabel(count) {
  const n = Math.max(0, Number(count) || 0);
  return n + ' MISS' + (n === 1 ? '' : 'ES');
}

function shell(title = 'HANGMAN', options = {}) {
  const rows = [titleRow(title, options)];
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
 * The word, centred, with a white chip for every letter still hidden.
 * Letters get a blank flap between them while there is room for it -- spaced
 * out is how a hangman board reads from across the room -- and close up
 * again only when the word is too long to afford the gaps.
 */
function maskRow(mask) {
  const letters = [...String(mask || '')].filter((ch) => ch !== ' ');
  if (!letters.length) return blankRow(COLS);
  const spaced = letters.length * 2 - 1 <= COLS;
  const text = spaced ? letters.join(' ') : letters.join('');
  const row = blankRow(COLS);
  const start = Math.max(0, Math.floor((COLS - text.length) / 2));
  for (let i = 0; i < text.length && start + i < COLS; i += 1) {
    const ch = text[i];
    if (ch === ' ') continue;
    if (ch === '_') row[start + i] = WHITE();
    else row[start + i] = CODE_BY_CHAR.get(ch) != null ? CODE_BY_CHAR.get(ch) : WHITE();
  }
  return row;
}

/** `MISS  B J Q` -- the letters that cost a life, in the order they fell. */
function missRow(misses = []) {
  const letters = (misses || [])
    .map((ch) => fold(ch).slice(0, 1))
    .filter(Boolean)
    .slice(0, MAX_MISSES_SHOWN);
  if (!letters.length) return blankRow(COLS);
  return centreRow('MISS  ' + letters.join(' '));
}

/**
 * Six chips: green for a life still standing, red for one already spent.
 * The bar drains left to right, so a glance at the colour is the score.
 */
function livesRow(livesLeft, lives = LIVES) {
  const total = Math.max(1, Number(lives) || LIVES);
  const left = Math.min(total, Math.max(0, Number(livesLeft ?? total)));
  const label = 'LIVES';
  const width = label.length + 1 + total;
  const start = Math.max(0, Math.floor((COLS - width) / 2));
  const row = placeText(blankRow(COLS), label, start);
  for (let i = 0; i < total; i += 1) {
    const at = start + label.length + 1 + i;
    if (at < COLS) row[at] = i < left ? GREEN() : RED();
  }
  return row;
}

function inviteRows({ code = '', alias = 'WITTYGAME' } = {}) {
  const rows = shell();
  rows[2] = centreRow('JOIN THE NEXT GAME');
  rows[3] = centreRow(flapLabel(alias) || 'TINYURL.COM/WITTYGAME');
  rows[4] = centreRow('GAME CODE: ' + pin(code));
  return assertValidLayout(rows, 'hangman-invite');
}

function lobbyRows({
  code = '',
  alias = 'WITTYGAME',
  playerCount = 0,
  minPlayers = 1,
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
  return assertValidLayout(rows, 'hangman-lobby');
}

/**
 * The live card. While a player is choosing the word there is nothing to
 * mask yet, so the board says who the room is waiting on instead.
 */
function roundRows({
  category = '',
  word = '',
  revealed = [],
  mask = '',
  misses = [],
  lives = LIVES,
  livesLeft = LIVES,
  step = '',
  setterName = '',
  turnName = '',
  lastEvent = '',
  showCode = false,
  code = '',
} = {}) {
  // The code lives in the masthead for the whole round, so a latecomer can
  // read their way in without the game giving up a row for it.
  const rows = shell('HANGMAN', { code: showCode ? code : '' });
  if (step === 'pick') {
    const who = fold(setterName).slice(0, MAX_NAME);
    rows[2] = centreRow(who ? who + ' IS PICKING' : 'PICKING A WORD');
    rows[3] = centreRow('A WORD FOR YOU');
    return assertValidLayout(rows, 'hangman-round');
  }
  const cat = fold(category);
  if (cat) rows[1] = centreRow(cat);
  rows[2] = maskRow(mask || maskWord(word, revealed));
  rows[3] = missRow(misses);
  rows[4] = livesRow(livesLeft, lives);
  // TIMES UP is a turn pass, not the end of the word. Keeping it as the
  // footer for the whole next turn is what made the board say the clock
  // was dead while the phone and the simulator still had seconds left.
  const event = fold(lastEvent);
  const footer = (event && event !== 'TIMES UP' ? event : '')
    || (turnName ? fold(turnName).slice(0, MAX_NAME) + ' TO GUESS' : '');
  if (footer) rows[5] = centreRow(footer.slice(0, COLS));
  return assertValidLayout(rows, 'hangman-round');
}

function leaderLines(scores = []) {
  const entries = (scores || []).map((row) => ({
    name: fold(row?.name).slice(0, MAX_NAME),
    score: String(Math.max(0, Math.round(Number(row?.score) || 0))),
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
  return assertValidLayout(rows, 'hangman-scores');
}

/**
 * The reveal. Whether it was guessed or not, the word goes up -- a round
 * that ends without showing the answer is the one thing nobody forgives.
 */
function winnerRows({
  title = 'THE WORD WAS',
  word = '',
  name = '',
  score = 0,
  misses = 0,
  empty = 'NOBODY GOT IT',
} = {}) {
  const rows = shell(title);
  const text = fold(word);
  if (!text) {
    rows[3] = centreRow(empty);
    return assertValidLayout(rows, 'hangman-winner');
  }
  fillBody(rows, text);
  const who = fold(name).slice(0, MAX_NAME);
  rows[5] = who
    ? centreRow(who + ' - ' + Math.max(0, Math.round(Number(score) || 0)))
    : centreRow(empty);
  if (!who && Number(misses) > 0) rows[1] = centreRow(missesLabel(misses));
  return assertValidLayout(rows, 'hangman-winner');
}

function intermissionRows({
  roundIndex = 0,
  rounds = 0,
  roundWinner = null,
  word = '',
  misses = 0,
} = {}) {
  const label = roundLabel(roundIndex, rounds, { short: true });
  return winnerRows({
    title: label ? label + ' WORD' : 'THE WORD WAS',
    word: roundWinner?.word || word,
    name: roundWinner?.name || '',
    score: roundWinner?.score || 0,
    misses: roundWinner?.misses ?? misses,
    empty: 'NOBODY GOT IT',
  });
}

function bestRows({ bestWord = '', word = '', name = '', bestMisses = 0 } = {}) {
  const text = fold(bestWord || word);
  const rows = shell('TOUGHEST WORD');
  if (!text) {
    rows[3] = centreRow('NOTHING SURVIVED');
    return assertValidLayout(rows, 'hangman-best');
  }
  fillBody(rows, text);
  const who = fold(name).slice(0, MAX_NAME);
  const misses = missesLabel(bestMisses);
  rows[5] = centreRow(who ? who + ' - ' + misses : misses);
  return assertValidLayout(rows, 'hangman-best');
}

function shortRows({ minPlayers = 1, playerCount = 0 } = {}) {
  const floor = Math.max(1, Number(minPlayers) || 1);
  const rows = shell();
  rows[2] = centreRow('NOT ENOUGH PLAYERS');
  rows[3] = centreRow('NEEDS ' + floor + ' TO START');
  if (playerCount > 0) {
    rows[5] = centreRow('ONLY ' + plural(playerCount, 'PLAYER') + ' JOINED');
  }
  return assertValidLayout(rows, 'hangman-short');
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
  return one(inviteRows(payload), 'Hangman', 'invite', payload);
}

function lobbyFrames(payload = {}) {
  return one(lobbyRows(payload), 'Hangman lobby', 'lobby', payload);
}

function roundFrames(payload = {}) {
  return one(roundRows(payload), 'Hangman', 'round', payload);
}

function intermissionFrames(payload = {}) {
  return one(intermissionRows(payload), 'The word was', 'intermission', payload);
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
  return one(bestRows(payload), 'Word of the night', 'best', payload);
}

function shortFrames(payload = {}) {
  return one(shortRows(payload), 'Not enough players', 'short', payload);
}

function finalFrames(payload = {}) {
  const hold = payload.holdSeconds || payload.remainingSeconds;
  const out = scoresFrames({ ...payload, final: true });
  if (payload.bestWord) {
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
  'hangman.game': framesFor,
  'hangman.game.invite': inviteFrames,
  'hangman.game.lobby': lobbyFrames,
  'hangman.game.round': roundFrames,
  'hangman.game.intermission': intermissionFrames,
  'hangman.game.scores': scoresFrames,
  'hangman.game.best': bestFrames,
  'hangman.game.short': shortFrames,
  'hangman.game.final': finalFrames,
};

module.exports = {
  SOURCE,
  FORMATTERS,
  framesFor,
  titleRow,
  maskRow,
  missRow,
  livesRow,
  leaderLines,
  roundLabel,
  inviteRows,
  lobbyRows,
  roundRows,
  intermissionRows,
  scoresRows,
  bestRows,
  shortRows,
};
