(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const NAME_KEY = 'signal.games.name';
  const SEAT_KEY = 'signal.games.seat';
  let session = null;
  let playerId = '';
  let source = null;
  let clock = null;
  let statusBeat = '';

  /**
   * Per-game modules register here and the shell hands each session to the
   * one that matches `session.gameType`. Everything the games have in common
   * — the join form, the code line, the scoreboard, the clock — stays in this
   * file; anything shaped like one particular game belongs in its module.
   */
  const games = new Map();
  let activeGame = '';

  if ('scrollRestoration' in history) {
    history.scrollRestoration = 'manual';
  }

  /** Nobody should have to type their name again the next time they play. */
  function rememberedName() {
    try { return localStorage.getItem(NAME_KEY) || ''; } catch { return ''; }
  }

  function rememberName(name) {
    try {
      if (name) localStorage.setItem(NAME_KEY, name);
    } catch {
      // A locked-down browser just means they type it again.
    }
  }

  /**
   * Which seat this tab is playing. Deliberately `sessionStorage`: two people
   * on one laptop open two windows, and a cookie is shared between them — the
   * second player used to land on the first one's seat, so both screens drove
   * one turn. Per-tab storage keeps them apart; a refresh still comes back to
   * the same seat.
   */
  function storedSeat() {
    try {
      const raw = JSON.parse(sessionStorage.getItem(SEAT_KEY) || '{}');
      return { sessionId: raw.sessionId || '', playerId: raw.playerId || '' };
    } catch {
      return { sessionId: '', playerId: '' };
    }
  }

  function rememberSeat(sessionId, id) {
    playerId = id || '';
    try {
      sessionStorage.setItem(SEAT_KEY, JSON.stringify({ sessionId: sessionId || '', playerId: playerId }));
    } catch {
      // Without storage the cookie still carries this tab; only a second tab
      // on the same browser loses its own seat.
    }
  }

  function forgetSeat() {
    playerId = '';
    try { sessionStorage.removeItem(SEAT_KEY); } catch { /* nothing to clear */ }
  }

  function show(id) {
    $('gm-join').hidden = id !== 'gm-join';
    $('gm-play').hidden = id !== 'gm-play';
    if (id === 'gm-play') resetPageScroll();
  }

  function resetPageScroll() {
    $('gm-code')?.blur();
    $('gm-name')?.blur();
    if (document.activeElement && document.activeElement !== document.body) {
      document.activeElement.blur();
    }
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    // iOS sometimes applies scroll after the layout swap lands.
    requestAnimationFrame(() => {
      window.scrollTo(0, 0);
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
    });
  }

  function setStatus(id, text) {
    const node = $(id);
    if (node) node.textContent = text || '';
  }

  async function api(route, { method = 'GET', body } = {}) {
    const response = await fetch(route, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try { data = await response.json(); } catch { data = {}; }
    if (!response.ok) {
      throw new Error(data.error || `Request failed (${response.status})`);
    }
    return data;
  }

  /**
   * Only the active game's panels take part in the layout. A separate
   * attribute from `hidden` so a module can keep showing and hiding its own
   * pieces without the shell fighting it.
   */
  function showGamePanels(type) {
    document.querySelectorAll('[data-game]').forEach((node) => {
      node.toggleAttribute('data-off', node.dataset.game !== type);
    });
    document.body.dataset.game = type || '';
  }

  /**
   * One list, never two: everybody who has joined, with the score they have
   * right now — the server folds the open round in, so points show up as they
   * are found instead of at the end of the round.
   */
  function renderStandings(next) {
    const rows = next.scores || [];
    const waiting = next.phase === 'invited' || next.phase === 'lobby';
    $('gm-list-title').textContent = waiting
      ? `Players (${rows.length})`
      : `Scores (${rows.length})`;
    const list = $('gm-list');
    list.innerHTML = '';
    rows.forEach((row, index) => {
      const li = document.createElement('li');
      if (next.you && row.id === next.you.id) li.className = 'is-you';
      const rank = document.createElement('span');
      rank.className = 'gm-rank';
      rank.textContent = waiting ? '' : `${index + 1}`;
      li.appendChild(rank);
      const name = document.createElement('span');
      name.className = 'gm-who';
      name.textContent = row.name;
      li.appendChild(name);
      const score = document.createElement('span');
      score.className = 'gm-points';
      score.textContent = waiting ? '' : String(row.score || 0);
      li.appendChild(score);
      list.appendChild(li);
    });
  }

  /** A list of `{ word, points, names }` — Word Scramble's found and recap lists. */
  function renderChips(hostId, words = []) {
    const host = $(hostId);
    if (!host) return;
    host.innerHTML = '';
    for (const entry of words) {
      const li = document.createElement('li');
      li.className = 'gm-chip';
      const word = document.createElement('span');
      word.className = 'gm-chip-word';
      word.textContent = String(entry.word || '').toUpperCase();
      const points = document.createElement('span');
      points.className = 'gm-chip-points';
      points.textContent = `+${entry.points || 0}`;
      li.append(word, points);
      if (entry.names && entry.names.length) {
        const who = document.createElement('span');
        who.className = 'gm-chip-who';
        who.textContent = entry.names.join(', ');
        li.appendChild(who);
      }
      host.appendChild(li);
    }
  }

  function roundOf(next) {
    return next.rounds > 1
      ? `Round ${next.roundIndex} of ${next.rounds}`
      : `Round ${next.roundIndex}`;
  }

  /**
   * A lobby that is only waiting on the clock reads very differently from one
   * that is waiting on people, so say which it is.
   */
  function phaseLabel(next) {
    const custom = games.get(next.gameType)?.phaseLabel?.(next);
    if (custom) return custom;
    if (next.phase === 'invited' || next.phase === 'lobby') {
      const short = next.needPlayers || 0;
      if (short > 0) {
        return `Waiting — ${short} more player${short === 1 ? '' : 's'} needed`;
      }
      return 'Waiting to start';
    }
    if (next.phase === 'round') return roundOf(next);
    if (next.phase === 'voting') return `${roundOf(next)} · voting`;
    if (next.phase === 'final') return 'Final scores';
    return `${roundOf(next)} done`;
  }

  /**
   * The code stays up all game when latecomers are allowed in, so nobody has
   * to catch the board at the right moment to read it.
   */
  function renderCodeLine(next) {
    const line = $('gm-code-line');
    const waiting = next.phase === 'invited' || next.phase === 'lobby';
    if (next.phase === 'closed' || (!waiting && !next.allowLateJoin)) {
      line.hidden = true;
      return;
    }
    line.hidden = false;
    line.innerHTML = '';
    const label = document.createElement('span');
    label.className = 'gm-code-label';
    label.textContent = 'Game code';
    const value = document.createElement('strong');
    value.className = 'gm-code-value';
    value.textContent = next.code || '';
    line.append(label, value);
    if (!waiting) {
      const note = document.createElement('span');
      note.className = 'gm-code-note';
      note.textContent = 'Friends can still join';
      line.appendChild(note);
    }
  }

  function renderScore(next) {
    if (!next.you) return;
    const game = games.get(next.gameType);
    $('gm-score').textContent = game?.scoreLine
      ? game.scoreLine(next)
      : `Your score ${next.you.score || 0}`;
  }

  /**
   * A toast belongs to the beat it happened in. Leaving "Bankrupt" on screen
   * while the wheel has moved on two players later reads like the game is
   * stuck, so the line clears as soon as the round or the turn moves.
   */
  function clearStaleStatus(next) {
    const beat = `${next.phase}|${next.roundIndex}|${next.turnPlayerId || ''}`;
    if (statusBeat && beat !== statusBeat) {
      setStatus('gm-play-status', '');
    }
    statusBeat = beat;
  }

  function applySession(next) {
    session = next;
    if (!next) return;
    clearStaleStatus(next);
    if (next.gameType !== activeGame) {
      games.get(activeGame)?.teardown?.();
      activeGame = next.gameType || '';
      showGamePanels(activeGame);
    }
    $('gm-title').textContent = next.title || 'Games';
    $('gm-phase').textContent = phaseLabel(next);
    $('gm-timer').textContent = next.remainingSeconds
      ? `${next.remainingSeconds}s`
      : '';
    renderCodeLine(next);
    renderStandings(next);
    renderScore(next);
    games.get(activeGame)?.render?.(next);
  }

  function listen(sessionId) {
    if (source) source.close();
    // The seat rides on the URL so this tab's stream is its own, even when a
    // second window on the same browser is playing a different seat.
    source = new EventSource(
      `/api/games/events?sessionId=${encodeURIComponent(sessionId)}&playerId=${encodeURIComponent(playerId)}`,
    );
    source.addEventListener('session', (event) => {
      try {
        const data = JSON.parse(event.data);
        applySession(data.session);
        if (data.reason === 'closed') {
          setStatus('gm-play-status', 'This game has ended.');
        }
      } catch {
        // ignore
      }
    });
    source.onerror = () => {};
  }

  async function join() {
    setStatus('gm-join-status', '');
    try {
      const typed = $('gm-name').value;
      const seat = storedSeat();
      const data = await api('/api/games/join', {
        method: 'POST',
        body: {
          code: $('gm-code').value,
          name: typed,
          // No seat in this tab means a new player is sitting down, even if
          // the browser still holds somebody else's cookie.
          playerId: seat.playerId,
          newSeat: !seat.playerId,
        },
      });
      rememberName(String(typed || '').trim());
      rememberSeat(data.session?.sessionId, data.player?.id);
      applySession(data.session);
      show('gm-play');
      listen(data.session.sessionId);
      window.setTimeout(resetPageScroll, 300);
    } catch (error) {
      setStatus('gm-join-status', error.message);
    }
  }

  $('btn-gm-join')?.addEventListener('click', join);
  $('gm-code')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') join();
  });
  $('gm-name')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') join();
  });
  $('btn-gm-leave')?.addEventListener('click', async () => {
    try {
      await api('/api/games/leave', {
        method: 'POST',
        body: { sessionId: session?.sessionId || '', playerId },
      });
    } catch {
      // still leave the UI
    }
    if (source) source.close();
    games.get(activeGame)?.teardown?.();
    activeGame = '';
    session = null;
    statusBeat = '';
    forgetSeat();
    show('gm-join');
  });

  /**
   * Every game submits through here. The server decides what an action means
   * and hands back a one-line toast, so the shell never has to know whether a
   * word scored or a vote landed.
   */
  window.gameSubmit = async (action, payload) => {
    if (!session) return null;
    try {
      const data = await api('/api/games/submit', {
        method: 'POST',
        body: {
          action,
          payload,
          sessionId: session.sessionId,
          playerId,
        },
      });
      // The server returns the whole session, so a submit repaints exactly
      // like an SSE frame and the two can never disagree. Repaint first: the
      // toast describes what just happened, so it must outlive the repaint
      // that moves the beat on.
      if (data.session) {
        applySession(data.session);
      } else if (Array.isArray(data.scores) && session) {
        session.scores = data.scores;
        renderStandings(session);
      }
      setStatus('gm-play-status', data.toast || '');
      return data;
    } catch (error) {
      setStatus('gm-play-status', error.message);
      return null;
    }
  };

  window.GameShell = {
    register(id, handlers) {
      games.set(id, handlers || {});
    },
    submit: (action, payload) => window.gameSubmit(action, payload),
    setStatus,
    renderChips,
    $,
  };

  const params = new URLSearchParams(location.search);
  const codeParam = String(params.get('code') || '').trim();
  const nameParam = String(params.get('name') || '').trim();
  if (codeParam && $('gm-code')) {
    $('gm-code').value = codeParam.toUpperCase();
  }
  const saved = rememberedName();
  const joinName = nameParam || saved;
  if (joinName && $('gm-name')) {
    $('gm-name').value = joinName;
  }
  if (joinName && !codeParam && $('gm-code')) {
    $('gm-code').focus();
  }
  // Household "Join now" opens /games/?code=&name= — skip the form and sit down.
  // Modules register synchronously below this file, so wait a tick or the
  // first session would arrive before its game had signed up.
  if (codeParam && joinName) {
    setStatus('gm-join-status', 'Joining…');
    window.setTimeout(join, 0);
  }

  if (clock) clearInterval(clock);
  clock = setInterval(() => {
    if (!session || !session.remainingSeconds) return;
    session.remainingSeconds = Math.max(0, session.remainingSeconds - 1);
    $('gm-timer').textContent = session.remainingSeconds ? `${session.remainingSeconds}s` : '';
  }, 1000);
})();
