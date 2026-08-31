/**
 * Game types the session framework can run. Word Scramble is the only entry
 * today; Wheel of Fortune drops in here later without touching the shell.
 *
 * **Vestaboard requirement:** any game that takes the board must register its
 * `source` here and route its cards through `games/sessions.js`, which takes
 * a board lock (`hub.setGameLock`) on the first card and releases it only
 * when the session ends — finished, stopped by an admin, or abandoned by the
 * last player. While that lock is held every other page waits in queue:
 * manual Push, Air now, scheduler ticks, and alerts alike.
 */

const scramble = require('../word-scramble');
const {
  inviteRows,
  lobbyRows,
  roundRows,
  scoresRows,
  bestRows,
} = require('../vestaboard/formatters/games');

const GAME_TYPES = Object.freeze({
  scramble: Object.freeze({
    id: 'scramble',
    title: 'Word Scramble',
    source: 'word.scramble',
    createRound: (options) => scramble.createRound(options),
    validateAction: (round, action, payload) => {
      if (action !== 'word') {
        return { ok: false, reason: 'unknown-action' };
      }
      return scramble.validateWord(round?.grid, payload?.word);
    },
    scoreRound: (players, options) => scramble.scoreRound(players, options),
    boardFrames: {
      invite: inviteRows,
      lobby: lobbyRows,
      round: roundRows,
      scores: scoresRows,
      best: bestRows,
    },
  }),
});

function gameOf(id) {
  return GAME_TYPES[String(id || '').trim()] || null;
}

/** Vestaboard `frame.source` values owned by live game sessions. */
const BOARD_SOURCES = Object.freeze(
  new Set(Object.values(GAME_TYPES).map((row) => row.source).filter(Boolean)),
);

module.exports = {
  GAME_TYPES,
  gameOf,
  BOARD_SOURCES,
};
