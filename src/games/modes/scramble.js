/**
 * Word Scramble as a session mode.
 *
 * Everything the shell used to know about grids, found words, and the
 * duplicate rule lives here, so `games/sessions.js` can run a second game
 * without growing a branch for every phase.
 */

const scramble = require('../../word-scramble');
const { hardestWord, scoreWord } = require('../../word-scramble');

/** One player cannot bank more than this in a round; a runaway script would. */
const SUBMIT_CAP = 80;

/** Rank a round's per-player totals, best first, ties broken by name. */
function rank(rows) {
  return rows.slice().sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

module.exports = {
  id: 'scramble',
  title: 'Word Scramble',
  source: 'word.scramble',
  /** One person alone with a grid is still a game worth playing. */
  minPlayers: 1,
  votes: false,

  createRound({ random, settings }) {
    const round = scramble.createRound({ minSolutions: settings.minSolutions, random });
    return {
      grid: round.grid,
      solutions: round.solutions,
      wordsByPlayer: new Map(),
    };
  },

  seat(state, playerId) {
    if (!state.wordsByPlayer.has(playerId)) {
      state.wordsByPlayer.set(playerId, []);
    }
  },

  isSeated(state, playerId) {
    return state.wordsByPlayer.has(playerId);
  },

  submit({ state, playerId, action, payload }) {
    if (action !== 'word') {
      return { ok: false, error: 'Unknown action' };
    }
    const words = state.wordsByPlayer.get(playerId);
    if (words.length >= SUBMIT_CAP) {
      return { ok: false, error: 'Round word limit reached' };
    }
    const result = scramble.validateWord(state.grid, payload?.word);
    if (!result.ok) {
      return {
        ok: false,
        error: result.reason === 'not-on-board' ? 'Not on the board' : 'Not a word',
      };
    }
    if (words.includes(result.word)) {
      return { ok: false, error: 'Already found', duplicate: true };
    }
    words.push(result.word);
    return {
      ok: true,
      word: result.word,
      points: result.points,
      words: words.map((word) => ({ word, points: scoreWord(word) })),
      toast: `+${result.points} ${result.word.toUpperCase()}`,
    };
  },

  /**
   * What the open round has earned each player so far. Submitted words were
   * already checked against the board, so this only has to apply the
   * duplicate rule — no need to re-solve the grid on every keystroke.
   */
  livePoints({ state, settings }) {
    const out = new Map();
    if (!state) return out;
    const claims = new Map();
    for (const [id, words] of state.wordsByPlayer) {
      for (const word of words) {
        const list = claims.get(word) || [];
        list.push(id);
        claims.set(word, list);
      }
    }
    for (const [word, ids] of claims) {
      const points = settings.duplicateRule === 'cancel' && ids.length > 1 ? 0 : scoreWord(word);
      for (const id of ids) out.set(id, (out.get(id) || 0) + points);
    }
    return out;
  },

  closeRound({ state, players, settings, best }) {
    const seated = players.filter((p) => state.wordsByPlayer.has(p.id));
    const scored = scramble.scoreRound(
      seated.map((p) => ({ id: p.id, words: state.wordsByPlayer.get(p.id) || [] })),
      { duplicateRule: settings.duplicateRule, grid: state.grid },
    );
    const byId = new Map(scored.map((row) => [row.id, row]));

    const found = [];
    for (const [playerId, words] of state.wordsByPlayer) {
      const player = players.find((p) => p.id === playerId);
      for (const word of words) {
        found.push({ word, playerId, name: player?.name || '' });
      }
    }

    // The reveal between rounds: every word the table found, and who got it.
    const byWord = new Map();
    for (const row of found) {
      const entry = byWord.get(row.word)
        || { word: row.word, points: scoreWord(row.word), names: [] };
      if (row.name && !entry.names.includes(row.name)) entry.names.push(row.name);
      byWord.set(row.word, entry);
    }

    const hardest = hardestWord(found);
    const nextBest = hardest && (!best || hardest.word.length > best.word.length)
      ? {
        word: hardest.word,
        playerId: hardest.playerId,
        name: found.find((f) => f.word === hardest.word)?.name || '',
        points: hardest.points,
      }
      : best;

    const perPlayer = rank(seated.map((p) => ({
      id: p.id,
      name: p.name,
      score: byId.get(p.id)?.score || 0,
    })));

    return {
      perPlayer,
      winner: perPlayer[0] || null,
      best: nextBest,
      reveal: {
        words: [...byWord.values()]
          .sort((a, b) => b.points - a.points || a.word.localeCompare(b.word)),
      },
    };
  },

  publicRound({ session, state, phase, playerId }) {
    const revealing = phase === 'intermission' || phase === 'final';
    const words = state && playerId
      ? (state.wordsByPlayer.get(playerId) || []).map((word) => ({ word, points: scoreWord(word) }))
      : [];
    return {
      grid: phase === 'round' ? state?.grid || null : null,
      best: session.best || null,
      lastRound: revealing ? session.lastRound || null : null,
      you: { words },
    };
  },

  /**
   * What the board should say each phase. `sessions.js` copies these onto the
   * payload so the formatter never has to reach back into session internals.
   */
  boardExtras({ session, state }) {
    return {
      grid: state?.grid || [],
      word: session.best?.word || '',
      name: session.best?.name || '',
      points: session.best?.points || 0,
    };
  },

  /** One archive row per finished session. */
  archiveExtras(session) {
    return { topWord: session.best || null };
  },
};
