/**
 * Party Prompts board frames — invite, lobby, the prompt, the voting call,
 * the round winner, high scores, and the night's best answer.
 *
 * The house style is set by the title row: violet chips own the first and last
 * two flaps and the title centres in what is left. Everything under it is
 * centred too, and every card ends on the row that tells a phone what to do
 * next — the join link, or who won.
 */

const { COLS, fold, wrap, blankRow, placeText, assertValidLayout } = require('../encoder');
const { chipCode, centered } = require('../frames');
const { snapshotFrame } = require('./common');
const { flapLabel } = require('../../shortlinks');

const SOURCE = 'party.prompts';
const VIOLET = () => chipCode('violet');

/** Chips own the first and last two flaps; the title centres in what is left. */
const TITLE_FROM = 2;
const TITLE_WIDTH = COLS - 4;

/**
 * Body text starts on row 2 so the title always has a blank row under it.
 * That gap is what makes the card readable from the far side of a room.
 */
const BODY_FROM_ROW = 2;
const BODY_LAST_ROW = 4;
const BODY_ROWS = BODY_LAST_ROW - BODY_FROM_ROW + 1;

/** The narrowest leaderboard block; wider only when a name demands it. */
const LEADER_MIN_WIDTH = 11;
const LEADER_MAX_WIDTH = 20;
const MAX_NAME = 10;

/**
 * Every centred line on these cards leans the same way, so a title and the
 * rows under it start in the same column instead of shimmering a flap apart.
 */
function centreRow(text, options = {}) {
  return centered(fold(text), { from: 0, width: COLS, lean: 'left', ...options });
}

function titleRow(text = 'PARTY PROMPTS') {
  const row = blankRow(COLS);
  row[0] = VIOLET();
  row[1] = VIOLET();
  row[COLS - 2] = VIOLET();
  row[COLS - 1] = VIOLET();
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

/**
 * `ROUND 2 OF 3` where there is room for it. The winner card only has the 18
 * flaps between the chips, and `ROUND 2 OF 3 WINNER` is one too many, so that
 * card asks for the short form — the round count is on the scoreboard anyway.
 */
function roundLabel(roundIndex, rounds, { short = false } = {}) {
  const index = Math.max(0, Number(roundIndex) || 0);
  if (!index) return '';
  const total = Math.max(0, Number(rounds) || 0);
  return !short && total > 1 ? `ROUND ${index} OF ${total}` : `ROUND ${index}`;
}

/** `JOIN AT TINYURL.COM/AB` when the alias leaves room, otherwise the bare link. */
function joinLine(alias) {
  const url = flapLabel(alias) || 'TINYURL.COM/WITTYGAME';
  const prefixed = `JOIN AT ${url}`;
  return prefixed.length <= COLS ? prefixed : url;
}

function plural(count, word) {
  const n = Math.max(0, Number(count) || 0);
  return `${n} ${word}${n === 1 ? '' : 'S'}`;
}

/**
 * Lay text into the body rows of an otherwise finished card, vertically
 * centred so a one-line answer floats rather than hanging off the title.
 * Anything past the third line is dropped rather than pushing the footer off
 * the board — the corpus gate in `party-prompts.js` keeps that from happening.
 */
function fillBody(rows, text, { from = BODY_FROM_ROW, limit = BODY_ROWS } = {}) {
  const lines = wrap(text, COLS).slice(0, limit);
  const top = from + Math.floor((limit - lines.length) / 2);
  lines.forEach((line, index) => {
    rows[top + index] = centreRow(line);
  });
  return rows;
}

function shell(title = 'PARTY PROMPTS') {
  const rows = [titleRow(title)];
  for (let r = 1; r < 6; r += 1) rows.push(blankRow(COLS));
  return rows;
}

function inviteRows({ code = '', alias = 'WITTYGAME' } = {}) {
  const rows = shell();
  rows[2] = centreRow('JOIN THE NEXT GAME');
  rows[3] = centreRow(flapLabel(alias) || 'TINYURL.COM/WITTYGAME');
  rows[4] = centreRow(`GAME CODE: ${pin(code)}`);
  return assertValidLayout(rows, 'party-prompts-invite');
}

/**
 * The lobby keeps the invite card so the link and code stay readable, and
 * only fills the two blank rows: how many are seated, and how many more the
 * game still needs. Rewriting the whole card would cascade every flap.
 */
function lobbyRows({
  code = '',
  alias = 'WITTYGAME',
  playerCount = 0,
  minPlayers = 3,
} = {}) {
  const seated = Math.max(0, Number(playerCount) || 0);
  const floor = Math.max(1, Number(minPlayers) || 1);
  const rows = inviteRows({ code, alias });
  if (seated) {
    rows[1] = centreRow(plural(seated, 'PLAYER'));
  }
  if (seated && seated < floor) {
    rows[5] = centreRow(`NEED ${floor - seated} MORE`);
  } else if (seated) {
    rows[5] = centreRow('STARTING SOON');
  }
  return assertValidLayout(rows, 'party-prompts-lobby');
}

/**
 * The prompt itself, which is the whole point of the card. The code sits
 * under the title while phones may still join; the link always closes it out.
 */
function roundRows({
  prompt = '',
  code = '',
  alias = 'WITTYGAME',
  showCode = false,
} = {}) {
  const rows = shell();
  if (showCode && pin(code)) {
    rows[1] = centreRow(`CODE ${pin(code)}`);
  }
  fillBody(rows, prompt);
  rows[5] = centreRow(joinLine(alias));
  return assertValidLayout(rows, 'party-prompts-round');
}

/** Voting keeps the prompt up — you cannot judge an answer you have forgotten. */
function votingRows({ prompt = '' } = {}) {
  const rows = shell();
  fillBody(rows, prompt);
  rows[5] = centreRow('VOTE ON YOUR PHONE');
  return assertValidLayout(rows, 'party-prompts-voting');
}

/** Name, dots, score — all rows the same width so the numbers line up. */
function leaderLines(scores = []) {
  const entries = (scores || []).map((row) => ({
    name: fold(row?.name).slice(0, MAX_NAME),
    score: String(Math.max(0, Number(row?.score) || 0)),
  }));
  if (!entries.length) return { lines: [], start: 0 };
  const width = Math.min(
    LEADER_MAX_WIDTH,
    Math.max(LEADER_MIN_WIDTH, ...entries.map((row) => row.name.length + 2 + row.score.length)),
  );
  const lines = entries.map((row) => {
    const dots = Math.max(2, width - row.name.length - row.score.length);
    return `${row.name}${'.'.repeat(dots)}${row.score}`.slice(0, COLS);
  });
  return { lines, start: Math.floor((COLS - width) / 2) };
}

/**
 * The scoreboard. The last row is the code when phones may still join, so the
 * board never leaves a latecomer guessing between rounds; without it the fifth
 * score fits.
 */
function scoresRows({
  scores = [],
  code = '',
  showCode = false,
  final = false,
} = {}) {
  const footer = showCode && pin(code) ? `GAME CODE: ${pin(code)}` : '';
  const capacity = footer ? 4 : 5;
  const { lines, start } = leaderLines((scores || []).slice(0, capacity));
  const rows = [titleRow(final ? 'FINAL SCORES' : 'HIGH SCORES')];
  for (let i = 0; i < capacity; i += 1) {
    const line = lines[i];
    rows.push(line ? placeText(blankRow(COLS), line, start) : blankRow(COLS));
  }
  if (footer) rows.push(centreRow(footer));
  return assertValidLayout(rows, 'party-prompts-scores');
}

/**
 * One answer, big, with the name under it. Used for the round winner and for
 * the night's best line on the final card — the answer is the star either way.
 */
function answerRows({
  title = 'ROUND WINNER',
  answer = '',
  name = '',
  votes = 0,
  empty = 'NOBODY ANSWERED',
} = {}) {
  const rows = shell(title);
  const text = fold(answer);
  if (!text) {
    rows[3] = centreRow(empty);
    return assertValidLayout(rows, 'party-prompts-answer');
  }
  fillBody(rows, text);
  const who = fold(name).slice(0, MAX_NAME);
  if (who) {
    rows[5] = centreRow(`${who} - ${plural(votes, 'VOTE')}`);
  }
  return assertValidLayout(rows, 'party-prompts-answer');
}

function intermissionRows({
  roundIndex = 0,
  rounds = 0,
  roundWinner = null,
} = {}) {
  const label = roundLabel(roundIndex, rounds, { short: true });
  return answerRows({
    title: label ? `${label} WINNER` : 'ROUND WINNER',
    answer: roundWinner?.answer || '',
    name: roundWinner?.name || '',
    votes: roundWinner?.score || 0,
    empty: 'NO VOTES THIS ROUND',
  });
}

function bestRows({ answer = '', name = '', votes = 0 } = {}) {
  return answerRows({
    title: 'BEST ANSWER',
    answer,
    name,
    votes,
    empty: 'NO ANSWERS TONIGHT',
  });
}

/** The lobby ran out with too few people. Say so rather than just vanishing. */
function shortRows({ minPlayers = 3, playerCount = 0 } = {}) {
  const floor = Math.max(1, Number(minPlayers) || 1);
  const rows = shell();
  rows[2] = centreRow('NOT ENOUGH PLAYERS');
  rows[3] = centreRow(`NEEDS ${floor} TO START`);
  if (playerCount > 0) {
    rows[5] = centreRow(`ONLY ${plural(playerCount, 'PLAYER')} JOINED`);
  }
  return assertValidLayout(rows, 'party-prompts-short');
}

function withHold(frame, holdSeconds, card) {
  const seconds = Number(holdSeconds);
  if (Number.isFinite(seconds) && seconds > 0) {
    frame.holdSeconds = seconds;
  }
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
  return one(inviteRows(payload), 'Party Prompts', 'invite', payload);
}

function lobbyFrames(payload = {}) {
  return one(lobbyRows(payload), 'Party Prompts lobby', 'lobby', payload);
}

function roundFrames(payload = {}) {
  return one(roundRows(payload), 'Party Prompts', 'round', payload);
}

function votingFrames(payload = {}) {
  return one(votingRows(payload), 'Party Prompts voting', 'voting', payload);
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
  return one(bestRows(payload), 'Best answer', 'best', payload);
}

function shortFrames(payload = {}) {
  return one(shortRows(payload), 'Not enough players', 'short', payload);
}

/** Final scores first, then the line of the night, as one sequence. */
function finalFrames(payload = {}) {
  const hold = payload.holdSeconds || payload.remainingSeconds;
  const out = scoresFrames({ ...payload, final: true });
  if (payload.answer && payload.name) {
    out.push(...bestFrames(payload));
  }
  for (const frame of out) {
    withHold(frame, hold, 'final');
  }
  return out;
}

function framesFor(payload = {}) {
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
    case 'voting':
      return votingFrames(payload);
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
  'party.prompts': framesFor,
  'party.prompts.invite': inviteFrames,
  'party.prompts.lobby': lobbyFrames,
  'party.prompts.round': roundFrames,
  'party.prompts.voting': votingFrames,
  'party.prompts.intermission': intermissionFrames,
  'party.prompts.scores': scoresFrames,
  'party.prompts.best': bestFrames,
  'party.prompts.short': shortFrames,
  'party.prompts.final': finalFrames,
};

module.exports = {
  SOURCE,
  FORMATTERS,
  framesFor,
  joinLine,
  roundLabel,
  leaderLines,
  titleRow,
  inviteRows,
  lobbyRows,
  roundRows,
  votingRows,
  intermissionRows,
  scoresRows,
  answerRows,
  bestRows,
  shortRows,
  inviteFrames,
  lobbyFrames,
  roundFrames,
  votingFrames,
  intermissionFrames,
  scoresFrames,
  bestFrames,
  shortFrames,
  finalFrames,
};
