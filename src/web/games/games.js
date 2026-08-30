(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  let session = null;
  let playerId = '';
  let source = null;
  let clock = null;

  function show(id) {
    $('gm-join').hidden = id !== 'gm-join';
    $('gm-play').hidden = id !== 'gm-play';
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
   * One list, never two: who is here while we wait, the running score once
   * the game is on. Rendering both was what showed everybody twice.
   */
  function renderStandings(next) {
    const waiting = next.phase === 'invited' || next.phase === 'lobby';
    const rows = waiting ? next.players || [] : next.scores || [];
    $('gm-list-title').textContent = waiting
      ? `Players (${rows.length})`
      : 'Scores';
    const list = $('gm-list');
    list.innerHTML = '';
    rows.forEach((row, index) => {
      const li = document.createElement('li');
      if (next.you && row.id === next.you.id) li.className = 'is-you';
      if (!waiting) {
        const rank = document.createElement('span');
        rank.className = 'gm-rank';
        rank.textContent = `${index + 1}`;
        li.appendChild(rank);
      }
      const name = document.createElement('span');
      name.className = 'gm-who';
      name.textContent = row.name;
      li.appendChild(name);
      if (!waiting) {
        const score = document.createElement('span');
        score.className = 'gm-points';
        score.textContent = String(row.score || 0);
        li.appendChild(score);
      }
      list.appendChild(li);
    });
  }

  function renderChips(hostId, words = []) {
    const host = $(hostId);
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

  function renderFound(next) {
    const mine = next.you?.words || [];
    const playing = next.phase === 'round';
    $('gm-found-section').hidden = !mine.length;
    $('gm-found-title').textContent = playing
      ? `Your words (${mine.length})`
      : `Your words last round (${mine.length})`;
    renderChips('gm-found', mine);
  }

  function renderRecap(next) {
    const recap = next.lastRound?.words || [];
    $('gm-recap-section').hidden = !recap.length;
    if (!recap.length) return;
    $('gm-recap-title').textContent = `Every word found in round ${next.lastRound.index}`;
    renderChips('gm-recap', recap);
  }

  function phaseLabel(next) {
    if (next.phase === 'invited' || next.phase === 'lobby') return 'Waiting to start';
    if (next.phase === 'round') return `Round ${next.roundIndex} of ${next.rounds}`;
    if (next.phase === 'final') return 'Final scores';
    return `Round ${next.roundIndex} of ${next.rounds} done`;
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

  function applySession(next) {
    session = next;
    if (!next) return;
    $('gm-title').textContent = next.title || 'Word Scramble';
    $('gm-phase').textContent = phaseLabel(next);
    $('gm-timer').textContent = next.remainingSeconds
      ? `${next.remainingSeconds}s`
      : '';
    renderCodeLine(next);
    renderStandings(next);
    renderFound(next);
    renderRecap(next);
    if (next.you) {
      // you.score only banks finished rounds; add what is still in play.
      const pending = next.phase === 'round'
        ? (next.you.words || []).reduce((sum, row) => sum + (row.points || 0), 0)
        : 0;
      $('gm-score').textContent = `Your score ${(next.you.score || 0) + pending}`;
    }
    if (typeof window.scrambleRender === 'function') {
      window.scrambleRender(next);
    }
  }

  function listen(sessionId) {
    if (source) source.close();
    source = new EventSource(`/api/games/events?sessionId=${encodeURIComponent(sessionId)}`);
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
      const data = await api('/api/games/join', {
        method: 'POST',
        body: {
          code: $('gm-code').value,
          name: $('gm-name').value,
        },
      });
      playerId = data.player?.id || '';
      applySession(data.session);
      show('gm-play');
      listen(data.session.sessionId);
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
      await api('/api/games/leave', { method: 'POST', body: {} });
    } catch {
      // still leave the UI
    }
    if (source) source.close();
    session = null;
    show('gm-join');
  });

  window.gameSubmit = async (action, payload) => {
    if (!session) return;
    try {
      const data = await api('/api/games/submit', {
        method: 'POST',
        body: { action, payload },
      });
      setStatus('gm-play-status', `+${data.points} ${String(data.word || '').toUpperCase()}`);
      if (data.liveScore != null) {
        $('gm-score').textContent = `Your score ${data.liveScore}`;
      }
      if (Array.isArray(data.words) && session) {
        session.you = { ...(session.you || {}), words: data.words };
        renderFound(session);
      }
    } catch (error) {
      setStatus('gm-play-status', error.message);
    }
  };

  const params = new URLSearchParams(location.search);
  if (params.get('code')) {
    $('gm-code').value = params.get('code').toUpperCase();
  }

  if (clock) clearInterval(clock);
  clock = setInterval(() => {
    if (!session || !session.remainingSeconds) return;
    session.remainingSeconds = Math.max(0, session.remainingSeconds - 1);
    $('gm-timer').textContent = session.remainingSeconds ? `${session.remainingSeconds}s` : '';
  }, 1000);
})();
