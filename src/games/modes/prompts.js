/**
 * Party Prompts as a session mode.
 *
 * A round is two phases. In `round` everyone writes one answer to the prompt
 * the board is showing; in `voting` everyone picks somebody else's. Answers
 * are anonymous on the ballot — that is most of the fun — so each one carries
 * a throwaway `answerId` rather than the player id the client already knows
 * how to turn into a name.
 */

const crypto = require('crypto');
const prompts = require('../../party-prompts');

/** Rank per-player totals, best first, ties broken by name. */
function rank(rows) {
  return rows.slice().sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

/** Fisher-Yates, so the ballot does not simply list players in join order. */
function shuffled(items, random) {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor((typeof random === 'function' ? random() : Math.random()) * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function writtenAnswers(state) {
  return [...state.answers.entries()]
    .filter(([, entry]) => entry && entry.text)
    .map(([playerId, entry]) => ({ playerId, ...entry }));
}

/** Every seated player has locked a line — waiting out the clock is wasted time. */
function allAnswered(state) {
  return Boolean(state?.answers?.size) && writtenAnswers(state).length >= state.answers.size;
}

module.exports = {
  id: 'prompts',
  title: 'Party Prompts',
  source: 'party.prompts',
  /**
   * Three is the floor. With two, voting is not a vote — each player can only
   * pick the other one, so every round ends 1-1 and nothing is decided.
   */
  minPlayers: 3,
  votes: true,

  createRound({ random, session }) {
    const round = prompts.createRound({ random, used: session?.usedRounds || [] });
    return {
      prompt: round.prompt,
      answers: new Map(),
      votes: new Map(),
      order: [],
    };
  },

  /** The prompt already used this session, so a three-round game never repeats. */
  roundKey(state) {
    return state?.prompt || '';
  },

  seat(state, playerId) {
    if (!state.answers.has(playerId)) {
      state.answers.set(playerId, { text: '', answerId: '' });
    }
  },

  isSeated(state, playerId) {
    return state.answers.has(playerId);
  },

  submit({ state, playerId, action, payload, phase, random }) {
    if (action === 'answer') {
      if (phase !== 'round') {
        return { ok: false, error: 'The writing round is over' };
      }
      const mine = state.answers.get(playerId);
      if (mine && mine.text) {
        return { ok: false, error: 'You already answered this prompt' };
      }
      const taken = writtenAnswers(state).map((row) => row.text);
      const result = prompts.validateAnswer(payload?.answer ?? payload?.text, { taken });
      if (!result.ok) {
        return {
          ok: false,
          error: result.reason === 'duplicate'
            ? 'Somebody already wrote that'
            : result.reason === 'too-long'
              ? 'Too long for the board — try fewer words'
              : 'Type an answer first',
        };
      }
      state.answers.set(playerId, {
        text: result.answer,
        answerId: crypto.randomUUID(),
      });
      return {
        ok: true,
        answer: result.answer,
        toast: 'Answer locked in',
        advance: allAnswered(state),
      };
    }

    if (action === 'vote') {
      if (phase !== 'voting') {
        return { ok: false, error: 'Voting is not open' };
      }
      const wanted = String(payload?.answerId || '').trim();
      const target = writtenAnswers(state).find((row) => row.answerId === wanted);
      if (!target) {
        return { ok: false, error: 'That answer is gone' };
      }
      if (target.playerId === playerId) {
        return { ok: false, error: 'You cannot vote for yourself' };
      }
      state.votes.set(playerId, target.playerId);
      return { ok: true, answerId: wanted, toast: 'Vote counted' };
    }

    return { ok: false, error: 'Unknown action' };
  },

  /**
   * Nothing shows until the reveal. A live vote tally would let the room watch
   * a winner pull ahead and turn the last votes into a bandwagon.
   */
  livePoints() {
    return new Map();
  },

  closeRound({ state, players, best }) {
    const written = writtenAnswers(state);
    const nameOf = (id) => players.find((p) => p.id === id)?.name || '';
    const scored = prompts.scoreRound(
      written.map((row) => ({ playerId: row.playerId })),
      [...state.votes.entries()].map(([voterId, answerPlayerId]) => ({ voterId, answerPlayerId })),
    );
    const byId = new Map(scored.map((row) => [row.id, row.score]));

    const reveal = {
      prompt: state.prompt,
      answers: written
        .map((row) => ({
          name: nameOf(row.playerId),
          answer: row.text,
          votes: byId.get(row.playerId) || 0,
        }))
        .sort((a, b) => b.votes - a.votes || a.answer.localeCompare(b.answer)),
    };

    const perPlayer = rank(written.map((row) => ({
      id: row.playerId,
      name: nameOf(row.playerId),
      score: byId.get(row.playerId) || 0,
      answer: row.text,
    })));

    // The night's best line, kept the same way Word Scramble keeps its
    // hardest word: only replaced when this round actually beat it.
    const top = perPlayer[0];
    const nextBest = top && top.score > 0 && (!best || top.score > best.votes)
      ? { answer: top.answer, name: top.name, votes: top.score, playerId: top.id }
      : best;

    return {
      perPlayer,
      winner: top && top.score > 0 ? top : null,
      best: nextBest,
      reveal,
    };
  },

  publicRound({ session, state, phase, playerId }) {
    const revealing = phase === 'intermission' || phase === 'final';
    const mine = state && playerId ? state.answers.get(playerId) : null;
    const written = state ? writtenAnswers(state) : [];
    const out = {
      prompt: phase === 'round' || phase === 'voting' ? state?.prompt || '' : '',
      answerCount: written.length,
      seatedCount: state ? state.answers.size : 0,
      voteCount: state ? state.votes.size : 0,
      bestAnswer: session.best || null,
      lastRound: revealing ? session.lastRound || null : null,
      you: {
        answer: mine?.text || '',
        vote: state && playerId ? state.votes.get(playerId) || '' : '',
      },
    };
    if (phase === 'voting' && state) {
      // Names are withheld until the reveal. The ballot order is fixed for the
      // whole phase so the list does not reshuffle under a thumb mid-tap.
      const byId = new Map(written.map((row) => [row.answerId, row]));
      const order = state.order.length
        ? state.order
        : written.map((row) => row.answerId);
      out.ballot = order
        .map((answerId) => byId.get(answerId))
        .filter(Boolean)
        .map((row) => ({
          answerId: row.answerId,
          answer: row.text,
          mine: row.playerId === playerId,
        }));
      const votedFor = state.votes.get(playerId);
      out.you.vote = votedFor
        ? written.find((row) => row.playerId === votedFor)?.answerId || ''
        : '';
    }
    return out;
  },

  onLeave({ state, playerId }) {
    if (!state) return null;
    state.answers.delete(playerId);
    state.votes.delete(playerId);
    if (state.order && state.order.length) {
      const kept = new Set(writtenAnswers(state).map((row) => row.answerId));
      state.order = state.order.filter((id) => kept.has(id));
    }
    return allAnswered(state) ? { advance: true } : null;
  },

  /** Fix the ballot order once, on the way into the voting phase. */
  beginVoting({ state, random }) {
    state.order = shuffled(writtenAnswers(state).map((row) => row.answerId), random);
  },

  /** With fewer than two answers there is nothing to choose between. */
  canVote({ state }) {
    return writtenAnswers(state).length >= 2;
  },

  boardExtras({ session, state }) {
    return {
      prompt: state?.prompt || '',
      answerCount: state ? writtenAnswers(state).length : 0,
      answer: session.best?.answer || '',
      name: session.best?.name || '',
      votes: session.best?.votes || 0,
    };
  },

  archiveExtras(session) {
    return { topAnswer: session.best || null };
  },
};
