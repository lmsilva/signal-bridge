/**
 * Hangman as a session mode.
 *
 * A round is one word and six lives. Who chose the word depends on how many
 * people are in the room:
 *
 *   - alone, the house deals it and the round starts on a guess
 *   - with company, one player sets the word and everybody else guesses. The
 *     setter's seat rotates every round, so over a night everyone gets a go
 *     at being the one who knows.
 *
 * Turns live inside `round`, the way they do for Wheel of Fortune: a correct
 * letter keeps the turn, a miss costs a life and hands it on. The shell only
 * ever sees submit plus a "stay in this phase" timeout.
 */

const hangman = require('../../hangman');

function rank(rows) {
  return rows.slice().sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

function nameOf(players, id) {
  return players.find((p) => p.id === id)?.name || '';
}

function turnSeconds(settings) {
  return Math.max(10, Number(settings?.turnSeconds) || 25);
}

function pickSeconds(settings) {
  return Math.max(10, Number(settings?.pickSeconds) || 30);
}

function holdFor(state, settings) {
  return state?.step === 'pick' ? pickSeconds(settings) : turnSeconds(settings);
}

function pointsOf(state, id) {
  return Math.max(0, Number(state.points.get(id) || 0));
}

function addPoints(state, id, gained) {
  if (!id || !gained) return;
  state.points.set(id, pointsOf(state, id) + gained);
}

function passTurn(state) {
  if (!state.order.length) {
    state.currentPlayerId = '';
    return;
  }
  const here = Math.max(0, state.order.indexOf(state.currentPlayerId));
  state.currentPlayerId = state.order[(here + 1) % state.order.length];
}

/** Every change the phone animates gets a number, so a repaint never replays it. */
function beat(state, event) {
  state.beats = Number(state.beats || 0) + 1;
  state.beat = { id: state.beats, ...event };
}

function seatedPlayers(session) {
  return (session?.players || []).filter((player) => player.seated !== false);
}

/** The word is only settled once it exists, so the ledger is written then. */
function noteWord(session, state) {
  if (!session || !state?.word) return;
  const key = hangman.wordKey({ category: state.category, word: state.word });
  if (key && !session.usedRounds.includes(key)) session.usedRounds.push(key);
}

function dealHouseWord(state, { random, settings, session }) {
  const dealt = hangman.createRound({
    random,
    used: session?.usedRounds || [],
    categoryId: settings?.categoryId || '',
  });
  state.word = dealt.word;
  state.category = dealt.category;
  state.choices = [];
  state.step = 'guess';
  noteWord(session, state);
  return dealt;
}

function loseALife(state) {
  state.misses = Math.min(hangman.LIVES, Number(state.misses || 0) + 1);
  return hangman.livesLeft(state.misses);
}

function finishOk(state, playerId, toast, extra = {}) {
  state.solvedBy = playerId || null;
  state.step = 'done';
  return {
    ok: true,
    finishRound: true,
    refreshBoard: true,
    toast,
    ...extra,
  };
}

module.exports = {
  id: 'hangman',
  title: 'Hangman',
  source: 'hangman.game',
  /** One person and the house is a real game of Hangman, so one is enough. */
  minPlayers: 1,
  votes: false,

  createRound({ random, settings, session }) {
    const seated = seatedPlayers(session);
    const wantSetter = settings?.wordSetter !== false && seated.length >= 2;
    // The seat rotates by round, so nobody sets two nights running.
    const setter = wantSetter
      ? seated[(Math.max(1, Number(session?.roundIndex) || 1) - 1) % seated.length]
      : null;
    const state = {
      word: '',
      category: '',
      setterId: setter?.id || '',
      setterName: setter?.name || '',
      choices: [],
      revealed: new Set(),
      called: new Set(),
      misses: 0,
      order: [],
      seated: new Set(),
      currentPlayerId: '',
      step: setter ? 'pick' : 'guess',
      points: new Map(),
      lastEvent: '',
      lastLetter: '',
      solvedBy: null,
      beats: 0,
      beat: null,
      startedAt: 0,
    };
    if (setter) {
      state.choices = hangman.suggestWords({
        random,
        used: session?.usedRounds || [],
        categoryId: settings?.categoryId || '',
      });
    } else {
      dealHouseWord(state, { random, settings, session });
    }
    return state;
  },

  /**
   * A set word has no key until somebody sets it -- `submit` writes the
   * ledger then. Only a house-dealt round can answer this here.
   */
  roundKey(state) {
    return state?.word ? hangman.wordKey({ category: state.category, word: state.word }) : '';
  },

  /** A turn (or the pick), not the whole word -- the cap is in onRoundTimeout. */
  roundHoldSeconds({ settings, state }) {
    return holdFor(state, settings);
  },

  beginRound({ state, now }) {
    if (!state.currentPlayerId) {
      state.currentPlayerId = state.order[0] || '';
    }
    state.lastEvent = '';
    state.startedAt = now || Date.now();
  },

  seat(state, playerId) {
    if (state.seated.has(playerId)) return;
    state.seated.add(playerId);
    state.points.set(playerId, 0);
    // The setter knows the answer, so they sit out the guessing order.
    if (playerId !== state.setterId) state.order.push(playerId);
  },

  isSeated(state, playerId) {
    return state.seated.has(playerId);
  },

  submit({ state, session, playerId, action, payload, settings, players, random }) {
    if (state.step === 'done') {
      return { ok: false, error: 'This word is finished' };
    }
    const who = nameOf(players, playerId).toUpperCase().slice(0, 10);

    if (action === 'pick') {
      if (state.step !== 'pick') {
        return { ok: false, error: 'The word is already set' };
      }
      if (state.setterId !== playerId) {
        return { ok: false, error: `${state.setterName || 'Someone else'} is setting the word` };
      }
      const typed = payload?.word ?? payload?.text ?? '';
      const index = Number(payload?.choice);
      let chosen = null;
      if (String(typed).trim()) {
        const check = hangman.validateSetterWord(typed, { used: session?.usedRounds || [] });
        if (!check.ok) return { ok: false, error: check.error };
        // A word of their own has no category to hint at, so their name is
        // the hint: everybody knows who to blame.
        chosen = { word: check.word, category: (who || 'A PLAYER') + ' PICKED IT' };
      } else if (Number.isFinite(index) && state.choices[index]) {
        chosen = state.choices[index];
      }
      if (!chosen) return { ok: false, error: 'Pick a word or type your own' };
      state.word = chosen.word;
      state.category = chosen.category;
      state.choices = [];
      state.step = 'guess';
      state.currentPlayerId = state.order[0] || '';
      state.lastEvent = who ? who + ' SET THE WORD' : 'WORD IS SET';
      noteWord(session, state);
      beat(state, { kind: 'set' });
      return {
        ok: true,
        refreshBoard: true,
        holdSeconds: turnSeconds(settings),
        word: chosen.word,
        toast: 'Word set. Good luck to them',
      };
    }

    if (state.step === 'pick') {
      return { ok: false, error: `${state.setterName || 'Someone'} is still picking the word` };
    }
    if (state.setterId === playerId) {
      return { ok: false, error: 'You set this word. Let them work' };
    }
    if (state.currentPlayerId !== playerId) {
      return { ok: false, error: 'Wait your turn' };
    }
    const hold = turnSeconds(settings);

    if (action === 'letter' || action === 'guess') {
      const check = hangman.validateGuess(payload?.letter ?? payload?.text, {
        called: [...state.called],
      });
      if (!check.ok) {
        return { ok: false, error: check.reason === 'called' ? 'Already called' : 'Pick a letter' };
      }
      state.called.add(check.letter);
      state.lastLetter = check.letter;
      const hits = hangman.countLetter(state.word, check.letter);
      if (!hits) {
        const left = loseALife(state);
        state.lastEvent = 'NO ' + check.letter;
        beat(state, { kind: 'miss', letter: check.letter, livesLeft: left });
        if (left <= 0) {
          state.lastEvent = 'OUT OF LIVES';
          return finishOk(state, null, 'Out of lives', { letter: check.letter, hits: 0 });
        }
        passTurn(state);
        return {
          ok: true,
          refreshBoard: true,
          holdSeconds: hold,
          letter: check.letter,
          hits: 0,
          livesLeft: left,
          toast: 'No ' + check.letter,
        };
      }
      state.revealed.add(check.letter);
      const gained = hangman.letterScore(hits);
      addPoints(state, playerId, gained);
      state.lastEvent = check.letter + ' X' + hits + '  +' + gained;
      beat(state, { kind: 'hit', letter: check.letter, hits });
      if (hangman.isFullyRevealed(state.word, state.revealed)) {
        const bonus = hangman.solveScore(hangman.livesLeft(state.misses));
        addPoints(state, playerId, bonus);
        state.lastEvent = who ? who + ' GETS IT' : 'SOLVED';
        return finishOk(state, playerId, 'That is the word', {
          letter: check.letter,
          hits,
          points: gained + bonus,
        });
      }
      // Right letter, same player -- the run is the fun of it.
      return {
        ok: true,
        refreshBoard: true,
        holdSeconds: hold,
        letter: check.letter,
        hits,
        points: gained,
        toast: check.letter + ' x' + hits + '  +' + gained,
      };
    }

    if (action === 'solve') {
      const check = hangman.validateSolve(payload?.solve ?? payload?.text ?? payload?.word, state.word);
      if (!check.ok) {
        if (check.reason === 'empty') return { ok: false, error: 'Type the word first' };
        const left = loseALife(state);
        state.lastEvent = who ? who + ' MISSES' : 'WRONG WORD';
        beat(state, { kind: 'miss', letter: '', livesLeft: left });
        if (left <= 0) {
          state.lastEvent = 'OUT OF LIVES';
          return finishOk(state, null, 'Out of lives');
        }
        passTurn(state);
        return { ok: true, refreshBoard: true, holdSeconds: hold, livesLeft: left, toast: 'Not that one' };
      }
      for (const letter of hangman.lettersOf(state.word)) state.revealed.add(letter);
      const bonus = hangman.solveScore(hangman.livesLeft(state.misses));
      addPoints(state, playerId, bonus);
      state.lastEvent = who ? who + ' GETS IT' : 'SOLVED';
      return finishOk(state, playerId, 'That is the word', { points: bonus });
    }

    return { ok: false, error: 'Unknown action' };
  },

  livePoints({ state }) {
    // Letters are banked the moment they turn over -- unlike a wheel bank
    // there is nothing that can take them away, so they show as they happen.
    return new Map(state?.points || []);
  },

  closeRound({ state, players, best }) {
    const solver = state.solvedBy ? players.find((p) => p.id === state.solvedBy) : null;
    const misses = Number(state.misses || 0);
    const setterPay = hangman.setterScore(misses, Boolean(solver));
    const perPlayer = rank(players
      .filter((p) => state.seated.has(p.id))
      .map((p) => ({
        id: p.id,
        name: p.name,
        score: pointsOf(state, p.id) + (p.id === state.setterId ? setterPay : 0),
      })));

    // The word of the night is the one that came closest to winning and
    // still got guessed -- an unguessed word was just too hard.
    const nextBest = solver && misses > Number(best?.misses ?? -1)
      ? {
        word: state.word,
        category: state.category,
        name: solver.name,
        playerId: solver.id,
        misses,
        setter: state.setterName || '',
      }
      : best;

    return {
      perPlayer,
      winner: solver
        ? {
          id: solver.id,
          name: solver.name,
          score: pointsOf(state, solver.id),
          word: state.word,
          category: state.category,
          misses,
        }
        : null,
      best: nextBest,
      reveal: {
        word: state.word,
        category: state.category,
        solvedBy: solver ? solver.name : '',
        setter: state.setterName || '',
        misses,
        called: [...state.called].sort(),
      },
    };
  },

  publicRound({ session, state, phase, playerId, players }) {
    const revealing = phase === 'intermission' || phase === 'final';
    const seated = players || session?.players || [];
    const turnId = state?.currentPlayerId || '';
    const mine = Boolean(state && playerId && state.seated.has(playerId));
    const isSetter = Boolean(state && playerId && state.setterId === playerId);
    const picking = state?.step === 'pick';
    const misses = Number(state?.misses || 0);
    const out = {
      category: picking ? '' : (state?.category || ''),
      // Only the setter ever sees the word before the reveal, and they
      // already know it -- everyone else gets the mask.
      word: revealing
        ? (state?.word || session.lastRound?.word || '')
        : (isSetter ? state?.word || '' : ''),
      mask: state?.word && !revealing ? hangman.maskWord(state.word, state.revealed) : '',
      called: state ? [...state.called].sort() : [],
      misses: state ? hangman.missesOf(state.word, state.called) : [],
      lives: hangman.LIVES,
      livesLeft: state ? hangman.livesLeft(misses) : hangman.LIVES,
      step: state?.step || '',
      setterId: state?.setterId || '',
      setterName: state?.setterName || '',
      turnPlayerId: turnId,
      turnName: nameOf(seated, turnId),
      lastEvent: state?.lastEvent || '',
      beat: state?.beat || null,
      letterPoints: hangman.LETTER_POINTS,
      bestWord: session.best || null,
      lastRound: revealing ? session.lastRound || null : null,
      you: {
        points: state && playerId ? pointsOf(state, playerId) : 0,
        isSetter,
        // The menu is the setter's alone; a guesser reading it would be
        // holding the answer sheet.
        choices: isSetter && picking ? state.choices : [],
        yourTurn: Boolean(mine && !isSetter && turnId === playerId && phase === 'round' && !picking),
        canPick: Boolean(isSetter && picking && phase === 'round'),
        canGuess: false,
        canSolve: false,
      },
    };
    if (out.you.yourTurn) {
      out.you.canGuess = true;
      out.you.canSolve = true;
    }
    if (revealing && session.lastRound) {
      out.category = session.lastRound.category || out.category;
      out.word = session.lastRound.word || out.word;
      out.setterName = session.lastRound.setter || out.setterName;
    }
    return out;
  },

  onRoundTimeout({ state, settings, session, now, random }) {
    if (!state || state.step === 'done') return { finishRound: true };
    const cap = Math.max(30, Number(settings.roundSeconds) || 300) * 1000;
    const started = Number(state.startedAt) || 0;
    if (started && now - started >= cap) {
      state.lastEvent = 'TIME IS UP';
      return { finishRound: true };
    }
    if (state.step === 'pick') {
      // Nobody should stare at a blank board because one phone went quiet.
      dealHouseWord(state, { random, settings, session });
      state.currentPlayerId = state.order[0] || '';
      state.lastEvent = 'HOUSE PICKS';
      beat(state, { kind: 'set' });
      return { continue: true, holdSeconds: turnSeconds(settings) };
    }
    // A clock that runs out costs the turn, not a life -- the gallows is for
    // guesses, not for somebody who put their phone down. Alone there is
    // nobody to hand it to, so TIMES UP on the board while the same phone
    // still has a fresh clock reads as a broken timer. Just renew.
    if (state.order.length <= 1) {
      return { continue: true, holdSeconds: turnSeconds(settings) };
    }
    passTurn(state);
    state.lastEvent = 'TIMES UP';
    return { continue: true, holdSeconds: turnSeconds(settings) };
  },

  onLeave({ state, playerId, settings, session, random }) {
    if (!state) return null;
    const wasTurn = state.currentPlayerId === playerId;
    const here = state.order.indexOf(playerId);
    state.order = state.order.filter((id) => id !== playerId);
    state.seated.delete(playerId);
    if (state.setterId === playerId && state.step === 'pick') {
      // The one person who knew the word walked off before setting it.
      dealHouseWord(state, { random, settings, session });
      state.setterId = '';
      state.setterName = '';
      state.currentPlayerId = state.order[0] || '';
      state.lastEvent = 'HOUSE PICKS';
      beat(state, { kind: 'set' });
      return { refreshBoard: true, holdSeconds: turnSeconds(settings) };
    }
    if (!wasTurn || !state.order.length) return null;
    state.currentPlayerId = state.order[here >= 0 ? here % state.order.length : 0];
    state.lastEvent = 'NEXT PLAYER';
    return { refreshBoard: true, holdSeconds: turnSeconds(settings) };
  },

  boardExtras({ session, state, settings, players }) {
    const seated = players || session?.players || [];
    const misses = Number(state?.misses || 0);
    return {
      category: state?.step === 'pick' ? '' : (state?.category || session.lastRound?.category || ''),
      word: state?.word || session.lastRound?.word || '',
      mask: state?.word ? hangman.maskWord(state.word, state.revealed) : '',
      called: state ? [...state.called] : [],
      misses: state ? hangman.missesOf(state.word, state.called) : [],
      lives: hangman.LIVES,
      livesLeft: state ? hangman.livesLeft(misses) : hangman.LIVES,
      step: state?.step || '',
      setterName: state?.setterName || session.lastRound?.setter || '',
      turnName: nameOf(seated, state?.currentPlayerId || ''),
      lastEvent: state?.lastEvent || '',
      bestWord: session.best?.word || '',
      bestMisses: session.best?.misses || 0,
      turnSeconds: turnSeconds(settings),
    };
  },

  archiveExtras(session) {
    return { toughestWord: session.best || null };
  },
};
