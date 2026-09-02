/**
 * Game types the session framework can run.
 *
 * A game is a *mode* (`games/modes/*.js`) — how a round is built, what a phone
 * may submit, how a round is scored, and what the board should be told — plus
 * the Vestaboard `source` that owns the board while it is live.
 *
 * **Vestaboard requirement:** any game that takes the board must register its
 * `source` here and route its cards through `games/sessions.js`, which takes
 * a board lock (`hub.setGameLock`) on the first card and releases it only
 * when the session ends — finished, stopped by an admin, or abandoned by the
 * last player. While that lock is held every other page waits in queue:
 * manual Push, Air now, scheduler ticks, and alerts alike.
 */

const scramble = require('./modes/scramble');
const prompts = require('./modes/prompts');
const wheel = require('./modes/wheel');
const hangman = require('./modes/hangman');

const GAME_TYPES = Object.freeze({
  scramble: Object.freeze(scramble),
  prompts: Object.freeze(prompts),
  wheel: Object.freeze(wheel),
  hangman: Object.freeze(hangman),
});

function gameOf(id) {
  return GAME_TYPES[String(id || '').trim()] || null;
}

/** Vestaboard `frame.source` values owned by live game sessions. */
const BOARD_SOURCES = Object.freeze(
  new Set(Object.values(GAME_TYPES).map((row) => row.source).filter(Boolean)),
);

/** Board source -> game id, for the push and priority wiring. */
const GAME_BY_SOURCE = Object.freeze(
  Object.fromEntries(Object.values(GAME_TYPES).map((row) => [row.source, row.id])),
);

module.exports = {
  GAME_TYPES,
  gameOf,
  BOARD_SOURCES,
  GAME_BY_SOURCE,
};
