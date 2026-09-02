/**
 * Wheel of Fortune as a session mode.
 *
 * A round is one puzzle. Turns live inside `round`: spin, then guess a
 * consonant (or solve), then spin / buy a vowel / solve again. The shell
 * only sees submit + an optional "stay in this phase" timeout, so the
 * other games do not grow a branch for every letter.
 */

const wheel = require('../../wheel-of-fortune');

function rank(rows) {
  return rows.slice().sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

function nameOf(players, id) {
  return players.find((p) => p.id === id)?.name || '';
}

function bankOf(state, id) {
  return Math.max(0, Number(state.banks.get(id) || 0));
}

function setBank(state, id, value) {
  state.banks.set(id, Math.max(0, Number(value) || 0));
}

function turnSeconds(settings) {
  return Math.max(10, Number(settings?.turnSeconds) || 30);
}

function passTurn(state) {
  if (!state.order.length) {
    state.currentPlayerId = '';
    state.step = 'spin';
    state.wedge = null;
    return;
  }
  const here = Math.max(0, state.order.indexOf(state.currentPlayerId));
  state.currentPlayerId = state.order[(here + 1) % state.order.length];
  state.step = 'spin';
  state.wedge = null;
}

function useFreeSpin(state, playerId) {
  const left = Math.max(0, Number(state.freeSpins.get(playerId) || 0));
  if (left <= 0) return false;
  state.freeSpins.set(playerId, left - 1);
  state.step = 'spin';
  state.wedge = null;
  state.lastEvent = 'USED FREE SPIN';
  return true;
}

function loseTurn(state, playerId) {
  if (useFreeSpin(state, playerId)) return { stayed: true };
  passTurn(state);
  return { stayed: false };
}

function revealLetter(state, letter) {
  state.called.add(letter);
  const hits = wheel.countLetter(state.puzzle, letter);
  if (hits) state.revealed.add(letter);
  return hits;
}

function solvedNow(state) {
  return wheel.isFullyRevealed(state.puzzle, state.revealed);
}

function finishOk(state, playerId, toast) {
  state.solvedBy = playerId;
  state.step = 'solved';
  return {
    ok: true,
    solved: true,
    finishRound: true,
    refreshBoard: true,
    toast,
  };
}

module.exports = {
  id: 'wheel',
  title: 'Wheel of Fortune',
  source: 'wheel.fortune',
  /** Two people can take turns. One person waiting on themselves is not a game. */
  minPlayers: 2,
  votes: false,

  createRound({ random, session }) {
    const puzzle = wheel.createRound({ random, used: session?.usedRounds || [] });
    return {
      puzzle: puzzle.puzzle,
      category: puzzle.category,
      revealed: new Set(),
      called: new Set(),
      banks: new Map(),
      freeSpins: new Map(),
      order: [],
      currentPlayerId: '',
      step: 'spin',
      wedge: null,
      // Every spin gets a number so a phone can tell a fresh spin from a
      // repaint and only animate the wheel once per throw.
      spin: null,
      spins: 0,
      lastEvent: '',
      solvedBy: null,
      startedAt: 0,
    };
  },

  roundKey(state) {
    return state ? wheel.puzzleKey({ category: state.category, puzzle: state.puzzle }) : '';
  },

  /** A turn, not the whole puzzle -- the puzzle cap is handled in onRoundTimeout. */
  roundHoldSeconds({ settings }) {
    return turnSeconds(settings);
  },

  beginRound({ state, now }) {
    if (!state.currentPlayerId) {
      state.currentPlayerId = state.order[0] || '';
    }
    state.step = 'spin';
    state.wedge = null;
    state.lastEvent = '';
    state.startedAt = now || Date.now();
  },

  seat(state, playerId) {
    if (!state.banks.has(playerId)) {
      state.banks.set(playerId, 0);
      state.freeSpins.set(playerId, 0);
      state.order.push(playerId);
    }
  },

  isSeated(state, playerId) {
    return state.banks.has(playerId);
  },

  submit({ state, playerId, action, payload, settings, players, random }) {
    if (state.solvedBy) {
      return { ok: false, error: 'The puzzle is already solved' };
    }
    if (state.currentPlayerId !== playerId) {
      return { ok: false, error: 'Wait your turn' };
    }
    const hold = turnSeconds(settings);
    const who = nameOf(players, playerId).toUpperCase().slice(0, 10);

    if (action === 'spin') {
      if (state.step === 'guess') {
        return { ok: false, error: 'Guess a consonant first' };
      }
      const wedge = wheel.spinWheel(random);
      state.wedge = wedge;
      state.spins = Number(state.spins || 0) + 1;
      state.spin = { id: state.spins, index: wedge.index || 0, playerId };
      if (wedge.type === 'bankrupt') {
        setBank(state, playerId, 0);
        state.freeSpins.set(playerId, 0);
        state.lastEvent = who ? who + ' BANKRUPT' : 'BANKRUPT';
        loseTurn(state, playerId);
        return { ok: true, refreshBoard: true, holdSeconds: hold, toast: 'Bankrupt' };
      }
      if (wedge.type === 'lose') {
        state.lastEvent = who ? who + ' LOSES A TURN' : 'LOSE A TURN';
        loseTurn(state, playerId);
        return { ok: true, refreshBoard: true, holdSeconds: hold, toast: 'Lose a turn' };
      }
      if (wedge.type === 'free') {
        state.freeSpins.set(playerId, (state.freeSpins.get(playerId) || 0) + 1);
        state.step = 'spin';
        state.wedge = null;
        state.lastEvent = who ? who + ' FREE SPIN' : 'FREE SPIN';
        return { ok: true, refreshBoard: true, holdSeconds: hold, toast: 'Free spin. Spin again' };
      }
      state.step = 'guess';
      state.lastEvent = who ? who + ' SPINS ' + wedge.value : 'SPINS ' + wedge.value;
      return {
        ok: true,
        refreshBoard: true,
        holdSeconds: hold,
        wedge,
        toast: '$' + wedge.value,
      };
    }

    if (action === 'letter' || action === 'vowel') {
      const wantVowel = action === 'vowel';
      if (wantVowel && state.step !== 'play') {
        return { ok: false, error: 'Spin and land a letter before buying a vowel' };
      }
      if (!wantVowel && state.step !== 'guess') {
        return { ok: false, error: state.step === 'play' ? 'Spin again first' : 'Spin the wheel first' };
      }
      const check = wheel.validateLetter(payload?.letter ?? payload?.text, {
        called: [...state.called],
        vowel: wantVowel,
      });
      if (!check.ok) {
        return {
          ok: false,
          error: check.reason === 'called'
            ? 'Already called'
            : check.reason === 'not-vowel'
              ? 'That is not a vowel'
              : check.reason === 'not-consonant'
                ? 'Guess a consonant. Buy a vowel separately'
                : 'Pick a letter',
        };
      }
      if (wantVowel) {
        if (bankOf(state, playerId) < wheel.VOWEL_COST) {
          return { ok: false, error: 'Need $' + wheel.VOWEL_COST + ' to buy a vowel' };
        }
        setBank(state, playerId, bankOf(state, playerId) - wheel.VOWEL_COST);
      }
      const hits = revealLetter(state, check.letter);
      if (!hits) {
        state.lastEvent = 'NO ' + check.letter;
        loseTurn(state, playerId);
        return {
          ok: true,
          refreshBoard: true,
          holdSeconds: hold,
          letter: check.letter,
          hits: 0,
          toast: 'No ' + check.letter,
        };
      }
      if (!wantVowel) {
        const value = Number(state.wedge?.value) || 0;
        const gained = value * hits;
        setBank(state, playerId, bankOf(state, playerId) + gained);
        state.lastEvent = check.letter + ' X' + hits + '  +' + gained;
      } else {
        state.lastEvent = who ? who + ' BUYS ' + check.letter : 'BUYS ' + check.letter;
      }
      if (solvedNow(state)) {
        state.lastEvent = who ? who + ' SOLVES IT' : 'SOLVED';
        return finishOk(state, playerId, 'You solved it');
      }
      state.step = 'play';
      return {
        ok: true,
        refreshBoard: true,
        holdSeconds: hold,
        letter: check.letter,
        hits,
        toast: wantVowel
          ? check.letter + ' x' + hits
          : '+' + ((Number(state.wedge?.value) || 0) * hits),
      };
    }

    if (action === 'solve') {
      const check = wheel.validateSolve(payload?.solve ?? payload?.text ?? payload?.puzzle, state.puzzle);
      if (!check.ok) {
        if (check.reason === 'empty') {
          return { ok: false, error: 'Type the puzzle first' };
        }
        state.lastEvent = who ? who + ' WRONG SOLVE' : 'WRONG SOLVE';
        loseTurn(state, playerId);
        return {
          ok: true,
          refreshBoard: true,
          holdSeconds: hold,
          toast: 'Not quite',
        };
      }
      for (const letter of wheel.lettersOf(state.puzzle)) state.revealed.add(letter);
      state.lastEvent = who ? who + ' SOLVES IT' : 'SOLVED';
      return finishOk(state, playerId, 'You solved it');
    }

    return { ok: false, error: 'Unknown action' };
  },

  livePoints() {
    // Round banks are not earned until someone solves. Showing them as
    // live score would inflate the board, then vanish on a miss or bankrupt.
    return new Map();
  },

  closeRound({ state, players, best }) {
    const name = (id) => nameOf(players, id);
    const solver = state.solvedBy
      ? players.find((p) => p.id === state.solvedBy)
      : null;
    const amount = solver ? wheel.winAmount(bankOf(state, solver.id)) : 0;
    const perPlayer = rank(players
      .filter((p) => state.banks.has(p.id))
      .map((p) => ({
        id: p.id,
        name: p.name,
        score: solver && p.id === solver.id ? amount : 0,
      })));

    const nextBest = solver && amount > 0 && (!best || amount > (best.amount || 0))
      ? {
        puzzle: state.puzzle,
        category: state.category,
        name: solver.name,
        amount,
        playerId: solver.id,
      }
      : best;

    return {
      perPlayer,
      winner: solver
        ? { id: solver.id, name: solver.name, score: amount, puzzle: state.puzzle, category: state.category }
        : null,
      best: nextBest,
      reveal: {
        puzzle: state.puzzle,
        category: state.category,
        solvedBy: solver ? solver.name : '',
        amount,
        called: [...state.called].sort(),
      },
    };
  },

  publicRound({ session, state, phase, playerId, players }) {
    const revealing = phase === 'intermission' || phase === 'final';
    const seated = players || session?.players || [];
    const turnId = state?.currentPlayerId || '';
    const mine = state && playerId && state.banks.has(playerId);
    const called = state ? [...state.called].sort() : [];
    const out = {
      category: state?.category || '',
      puzzle: revealing ? (state?.puzzle || session.lastRound?.puzzle || '') : '',
      mask: state && !revealing ? wheel.maskPuzzle(state.puzzle, state.revealed) : '',
      called,
      step: state?.step || '',
      turnPlayerId: turnId,
      turnName: nameOf(seated, turnId),
      wedge: state?.wedge ? { type: state.wedge.type, value: state.wedge.value || 0, label: wheel.wedgeLabel(state.wedge) } : null,
      wheel: wheel.wheelLayout(),
      spin: state?.spin || null,
      lastEvent: state?.lastEvent || '',
      vowelCost: wheel.VOWEL_COST,
      bestWin: session.best || null,
      lastRound: revealing ? session.lastRound || null : null,
      you: {
        bank: state && playerId ? bankOf(state, playerId) : 0,
        freeSpins: state && playerId ? (state.freeSpins.get(playerId) || 0) : 0,
        yourTurn: Boolean(mine && turnId === playerId && phase === 'round'),
        canSpin: false,
        canGuess: false,
        canVowel: false,
        canSolve: false,
      },
    };
    if (out.you.yourTurn) {
      out.you.canSpin = state.step === 'spin' || state.step === 'play';
      out.you.canGuess = state.step === 'guess';
      out.you.canVowel = state.step === 'play' && bankOf(state, playerId) >= wheel.VOWEL_COST;
      out.you.canSolve = true;
    }
    if (revealing && session.lastRound) {
      out.category = session.lastRound.category || out.category;
      out.puzzle = session.lastRound.puzzle || out.puzzle;
    }
    return out;
  },

  onRoundTimeout({ state, settings, now, session }) {
    if (!state || state.solvedBy) return { finishRound: true };
    const cap = Math.max(30, Number(settings.roundSeconds) || 300) * 1000;
    const started = Number(state.startedAt) || 0;
    if (started && now - started >= cap) {
      state.lastEvent = 'TIME IS UP';
      return { finishRound: true };
    }
    const who = state.currentPlayerId;
    if (who && !useFreeSpin(state, who)) {
      passTurn(state);
    }
    state.lastEvent = state.lastEvent && state.lastEvent === 'USED FREE SPIN'
      ? 'USED FREE SPIN'
      : 'TIMES UP';
    return { continue: true, holdSeconds: turnSeconds(settings) };
  },

  onLeave({ state, playerId, settings }) {
    if (!state) return null;
    const wasTurn = state.currentPlayerId === playerId;
    const here = state.order.indexOf(playerId);
    state.order = state.order.filter((id) => id !== playerId);
    state.banks.delete(playerId);
    state.freeSpins.delete(playerId);
    if (!wasTurn || !state.order.length) return null;
    state.currentPlayerId = state.order[here >= 0 ? here % state.order.length : 0];
    state.step = 'spin';
    state.wedge = null;
    state.lastEvent = 'NEXT PLAYER';
    return { refreshBoard: true, holdSeconds: turnSeconds(settings) };
  },

  boardExtras({ session, state, settings, players }) {
    const seated = players || session?.players || [];
    const revealed = state ? [...state.revealed] : [];
    return {
      category: state?.category || session.lastRound?.category || '',
      puzzle: state?.puzzle || session.lastRound?.puzzle || '',
      revealed,
      called: state ? [...state.called] : [],
      mask: state ? wheel.maskPuzzle(state.puzzle, state.revealed) : '',
      turnName: nameOf(seated, state?.currentPlayerId || ''),
      step: state?.step || '',
      wedgeLabel: wheel.wedgeLabel(state?.wedge),
      lastEvent: state?.lastEvent || '',
      amount: session.best?.amount || 0,
      puzzleWin: session.best?.puzzle || '',
      vowelCost: wheel.VOWEL_COST,
      turnSeconds: turnSeconds(settings),
    };
  },

  archiveExtras(session) {
    return { topWin: session.best || null };
  },
};
