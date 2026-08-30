/**
 * Game types the session framework can run. Word Scramble is the only entry
 * today; Wheel of Fortune drops in here later without touching the shell.
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

module.exports = {
  GAME_TYPES,
  gameOf,
};
