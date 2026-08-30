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

  function renderRoster(players = []) {
    const list = $('gm-roster');
    list.innerHTML = '';
    for (const player of players) {
      const li = document.createElement('li');
      li.textContent = player.name;
      const score = document.createElement('span');
      score.textContent = String(player.score || 0);
      li.appendChild(score);
      list.appendChild(li);
    }
  }

  function renderScores(scores = []) {
    const list = $('gm-scores');
    list.innerHTML = '';
    for (const row of scores) {
      const li = document.createElement('li');
      li.innerHTML = `<span>${row.name}</span><span>${row.score}</span>`;
      list.appendChild(li);
    }
  }

  function applySession(next) {
    session = next;
    if (!next) return;
    $('gm-title').textContent = next.title || 'Word Scramble';
    const waiting = next.phase === 'invited' || next.phase === 'lobby';
    $('gm-phase').textContent = waiting
      ? `Lobby — code ${next.code}`
      : next.phase === 'round'
        ? `Round ${next.roundIndex} of ${next.rounds}`
        : next.phase === 'final' ? 'Final scores' : 'High scores';
    $('gm-timer').textContent = next.remainingSeconds
      ? `${next.remainingSeconds}s`
      : '';
    renderRoster(next.players || []);
    renderScores(next.scores || []);
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
      setStatus('gm-play-status', data.duplicate ? 'Already found' : `+${data.points} ${data.word}`);
      if (data.liveScore != null) {
        $('gm-score').textContent = `Your score ${data.liveScore}`;
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
