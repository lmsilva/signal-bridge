/**
 * Shared Vestaboard simulator board + house queue.
 * Admin Board uses actorLabel(); /user/ Board calls mount().
 */
(function (root) {
  'use strict';

  function actorLabel(actor) {
    if (!actor || typeof actor !== 'object') return '';
    const name = String(actor.name || '').trim();
    if (actor.kind === 'scheduler') return name || 'Scheduled';
    if (actor.kind === 'guest') return name ? `Guest · ${name}` : 'Guest';
    if (actor.kind === 'system') return name || 'System';
    return name || 'User';
  }

  function clockOf(iso) {
    if (!iso) return '';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function statusOf(item) {
    if (item.notBefore) return `not before ${clockOf(item.notBefore)}`;
    if (item.status === 'held') return 'held';
    if (item.status === 'cutting-in') return 'cutting in';
    return 'waiting';
  }

  function createVestaboardSimUi(options = {}) {
    const $ = (id) => document.getElementById(id);
    const fetchJson = options.fetchJson || (async (path, body) => {
      const response = await fetch(path, {
        method: body ? 'POST' : 'GET',
        credentials: 'same-origin',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Request failed');
      return data;
    });
    const toast = options.toast || (() => {});
    const SOUND_KEY = 'signal.vbSound';
    const CHIP_MIN = 63;
    const FLAP_MS = 100;
    const MAX_DRUM_STEPS = 24;
    const CASCADE_MS = 5616;
    const COLS = 22;
    const ROWS = 6;
    let items = [];
    let dragging = false;
    let pending = null;
    let revision = 0;
    let events = null;
    let shown = [];
    let current = [];
    let gen = [];
    let drum = [];
    let settleTimer = null;
    let soundOn = (() => {
      try { return window.localStorage.getItem(SOUND_KEY) !== '0'; } catch { return true; }
    })();
    let flipSample = null;
    let flipReady = false;
    let pendingReplay = null;
    let rateTimer = null;
    let rateUntil = 0;
    let rateGame = false;

    function isWatching() {
      if (typeof options.watching === 'function') return options.watching();
      return Boolean($('tab-board')?.classList.contains('active')) && !document.hidden;
    }

    function reducedMotion() {
      return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
    }

    function flatten(layout) {
      const out = [];
      const rows = Array.isArray(layout) ? layout : [];
      for (let row = 0; row < 6; row += 1) {
        const line = rows[row] || [];
        for (let col = 0; col < 22; col += 1) {
          out.push(Number(line[col]) || 0);
        }
      }
      return out;
    }

    function glyphFor(code) {
      const chars = root.FLAP_GRID?.FLAP_CHARS || '';
      if (code >= CHIP_MIN) return '';
      const ch = chars[code] || '';
      return ch === ' ' ? '' : ch;
    }

    function paintTile(tile, code) {
      if (!tile) return;
      const glyph = tile.querySelector('.vb-glyph');
      if (code >= CHIP_MIN) {
        tile.classList.add('is-chip');
        tile.dataset.chip = String(code);
        if (glyph) glyph.textContent = '';
        return;
      }
      tile.classList.remove('is-chip');
      delete tile.dataset.chip;
      if (glyph) glyph.textContent = glyphFor(code);
    }

    function tiles() {
      return [...($('vb-grid')?.querySelectorAll('.vb-tile') || [])];
    }

    function ensureTiles(layout) {
      const host = $('vb-grid');
      if (!host) return [];
      if (tiles().length !== 132 && typeof root.renderFlapGrid === 'function') {
        root.renderFlapGrid(host, layout || [], { interactive: false });
      }
      return tiles();
    }

    function syncSoundButton() {
      const btn = $('btn-vb-sound');
      if (btn) btn.textContent = soundOn ? 'Sound on' : 'Sound off';
    }

    function loadFlipSample() {
      if (flipSample) return flipSample;
      try {
        flipSample = new Audio('/admin/vb-flip.wav?v=signal89');
        flipSample.preload = 'auto';
        flipSample.addEventListener('canplaythrough', () => { flipReady = true; }, { once: true });
        flipSample.load();
      } catch {
        flipSample = null;
      }
      return flipSample;
    }

    function stopCascade() {
      if (!flipSample) return;
      try {
        flipSample.pause();
        flipSample.currentTime = 0;
      } catch {
        // ignore
      }
    }

    function playCascade() {
      if (!soundOn || reducedMotion() || !isWatching()) return;
      const sample = loadFlipSample();
      if (sample && (flipReady || sample.readyState >= 2)) {
        try {
          sample.pause();
          sample.currentTime = 0;
          sample.volume = 0.78;
          const played = sample.play();
          if (played && typeof played.catch === 'function') played.catch(() => {});
        } catch {
          // browsers stay silent until a tap
        }
      }
    }

    function snapLayout(layout) {
      const flat = flatten(layout);
      const cells = ensureTiles(layout);
      current = flat.slice();
      shown = flat.slice();
      gen = cells.map((_, index) => (gen[index] || 0) + 1);
      cells.forEach((tile, index) => {
        tile.classList.remove('is-flipping');
        paintTile(tile, flat[index] || 0);
      });
    }

    function faceMatches(index, code) {
      return (current[index] ?? 0) === code && (shown[index] ?? 0) === code;
    }

    function settleBoard() {
      tiles().forEach((tile, index) => {
        const code = current[index] ?? 0;
        if ((shown[index] ?? 0) === code || tile.classList.contains('is-flipping')) return;
        shown[index] = code;
        paintTile(tile, code);
      });
    }

    function drumSteps(from, to) {
      if (!Array.isArray(drum) || drum.length < 2 || from === to) return [to];
      let fromIdx = drum.indexOf(from);
      let toIdx = drum.indexOf(to);
      if (fromIdx < 0) fromIdx = 0;
      if (toIdx < 0) toIdx = 0;
      const len = drum.length;
      const distance = (toIdx - fromIdx + len) % len;
      if (distance === 0) return [to];
      const stride = distance > MAX_DRUM_STEPS
        ? Math.ceil(distance / MAX_DRUM_STEPS)
        : 1;
      const steps = [];
      for (let walked = stride; walked < distance; walked += stride) {
        steps.push(drum[(fromIdx + walked) % len]);
      }
      steps.push(to);
      return steps;
    }

    function flipDelay(index, strategy) {
      const row = Math.floor(index / COLS);
      const col = index % COLS;
      const walk = MAX_DRUM_STEPS * FLAP_MS;
      const budget = Math.max(400, CASCADE_MS - walk);
      const jitter = Math.random() * 40;
      switch (strategy) {
        case 'reverse-column':
          return ((COLS - 1 - col) / (COLS - 1)) * budget + jitter;
        case 'row':
          return (row / Math.max(1, ROWS - 1)) * budget + jitter;
        case 'diagonal':
          return ((row + col) / (ROWS + COLS - 2)) * budget + jitter;
        case 'random':
          return Math.random() * budget;
        case 'column':
        default:
          return (col / (COLS - 1)) * budget + jitter;
      }
    }

    function runFlips(index, codes, startDelay) {
      const tile = tiles()[index];
      if (!tile || !codes.length) return;
      const token = (gen[index] = (gen[index] || 0) + 1);
      const flapMs = reducedMotion() ? 1 : FLAP_MS;
      const swapAt = Math.max(1, Math.floor(flapMs * 0.48));
      const run = (step) => {
        if (gen[index] !== token) return;
        if (step >= codes.length) {
          tile.classList.remove('is-flipping');
          const target = current[index] ?? 0;
          paintTile(tile, target);
          shown[index] = target;
          return;
        }
        tile.classList.remove('is-flipping');
        void tile.offsetWidth;
        tile.classList.add('is-flipping');
        window.setTimeout(() => {
          if (gen[index] !== token) return;
          paintTile(tile, codes[step]);
          shown[index] = codes[step];
        }, swapAt);
        window.setTimeout(() => run(step + 1), flapMs);
      };
      window.setTimeout(() => {
        if (gen[index] !== token) return;
        run(0);
      }, startDelay);
    }

    function applyLayout(layout, animate, strategy) {
      const flat = flatten(layout);
      const cells = ensureTiles(layout);
      if (!cells.length) return;
      if (gen.length !== cells.length) gen = cells.map((_, index) => gen[index] || 0);
      if (animate && !isWatching()) {
        let changing = 0;
        cells.forEach((_, index) => {
          const code = flat[index] || 0;
          if ((current[index] ?? 0) !== code) changing += 1;
          current[index] = code;
        });
        if (changing) pendingReplay = { layout, strategy: strategy || 'column' };
        return;
      }
      if (!animate || reducedMotion()) {
        cells.forEach((tile, index) => {
          const code = flat[index] || 0;
          if ((current[index] ?? 0) === code) return;
          gen[index] = (gen[index] || 0) + 1;
          tile.classList.remove('is-flipping');
          current[index] = code;
          shown[index] = code;
          paintTile(tile, code);
        });
        return;
      }
      let starting = 0;
      cells.forEach((_, index) => {
        const code = flat[index] || 0;
        if (faceMatches(index, code)) return;
        current[index] = code;
        starting += 1;
        runFlips(index, drumSteps(shown[index] ?? 0, code), flipDelay(index, strategy || 'column'));
      });
      if (starting) {
        pendingReplay = null;
        playCascade();
        window.clearTimeout(settleTimer);
        settleTimer = window.setTimeout(settleBoard, CASCADE_MS + (MAX_DRUM_STEPS * FLAP_MS) + 250);
      }
    }

    function paintGrid(layout) {
      applyLayout(layout, false);
    }

    function syncClear() {
      const btn = $('btn-vb-queue-clear');
      if (btn) btn.hidden = items.length === 0;
    }

    function idsFromDom() {
      return [...document.querySelectorAll('#vb-queue .vb-queue-row')]
        .map((row) => row.dataset.id)
        .filter(Boolean);
    }

    function flushPending() {
      if (!pending) return;
      const next = pending;
      pending = null;
      applyQueue(next.items, next.revision);
    }

    function applyQueue(nextItems, nextRevision) {
      if (nextRevision != null && nextRevision < revision) return;
      if (nextRevision != null) revision = nextRevision;
      if (dragging) {
        pending = { items: nextItems, revision: nextRevision };
        return;
      }
      renderQueue(nextItems);
    }

    async function cancel(id) {
      const data = await fetchJson('/api/vestaboard-sim/queue/cancel', { id });
      applyQueue(data.queue, data.queueRevision);
    }

    async function commitOrder() {
      const ids = idsFromDom();
      const before = items.map((item) => item.id).filter(Boolean);
      if (!ids.length || ids.join('\0') === before.join('\0')) {
        flushPending();
        return;
      }
      try {
        const data = await fetchJson('/api/vestaboard-sim/queue/reorder', { ids });
        applyQueue(data.queue, data.queueRevision);
      } catch (error) {
        toast(error.message || 'Could not reorder the queue');
      }
      flushPending();
    }

    function startDrag(event, row) {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      if (event.target.closest?.('.vb-queue-cancel')) return;
      event.preventDefault();
      dragging = true;
      row.classList.add('dragging');
      const pointerId = event.pointerId;
      const onMove = (move) => {
        if (move.pointerId !== pointerId) return;
        const host = $('vb-queue');
        if (!host) return;
        const others = [...host.querySelectorAll('.vb-queue-row')].filter((node) => node !== row);
        let before = null;
        for (const other of others) {
          const box = other.getBoundingClientRect();
          if (move.clientY < box.top + box.height / 2) {
            before = other;
            break;
          }
        }
        if (before) host.insertBefore(row, before);
        else host.appendChild(row);
      };
      const onUp = (up) => {
        if (up && up.pointerId !== pointerId) return;
        row.classList.remove('dragging');
        dragging = false;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        commitOrder();
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    }

    function renderQueue(nextItems) {
      const host = $('vb-queue');
      if (!host) return;
      items = Array.isArray(nextItems) ? nextItems : [];
      syncClear();
      if (!items.length) {
        host.innerHTML = '<p class="hint">Nothing queued.</p>';
        return;
      }
      host.innerHTML = '';
      items.forEach((item) => {
        const row = document.createElement('div');
        row.className = 'vb-row vb-queue-row';
        row.dataset.id = item.id || '';
        const label = actorLabel(item.actor);
        row.innerHTML = `
          <span class="vb-queue-handle" aria-hidden="true">⋮⋮</span>
          <span class="vb-queue-source"></span>
          <span class="vb-queue-title"></span>
          <span class="vb-queue-status${item.status === 'held' ? ' is-held' : ''}${item.status === 'cutting-in' ? ' is-now' : ''}"></span>
          <button type="button" class="vb-queue-cancel" aria-label="Cancel this page">×</button>`;
        row.querySelector('.vb-queue-source').textContent = label || item.source || '—';
        row.querySelector('.vb-queue-title').textContent = item.label || 'Frame';
        row.querySelector('.vb-queue-status').textContent = statusOf(item);
        row.querySelector('.vb-queue-cancel').addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (item.id) cancel(item.id).catch((error) => toast(error.message));
        });
        row.addEventListener('pointerdown', (event) => startDrag(event, row));
        host.appendChild(row);
      });
    }

    function formatRemain(ms) {
      const sec = Math.max(0, Math.ceil(ms / 1000));
      const minutes = Math.floor(sec / 60);
      const seconds = sec % 60;
      return `${minutes}:${String(seconds).padStart(2, '0')}`;
    }

    function formatClock(ts) {
      return new Date(ts).toLocaleTimeString([], {
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
      });
    }

    function startRateCountdown(cooldownMs, { game = false } = {}) {
      const nextUntil = Date.now() + Math.max(0, Number(cooldownMs) || 0);
      if (rateTimer && Math.abs(nextUntil - rateUntil) <= 1500 && Boolean(game) === rateGame) {
        return;
      }
      window.clearInterval(rateTimer);
      rateGame = Boolean(game);
      rateUntil = nextUntil;
      const tick = () => {
        const left = rateUntil - Date.now();
        const rate = $('vb-pill-rate');
        const clock = $('vb-flip-clock');
        const label = $('vb-flip-label');
        const remain = $('vb-flip-remain');
        const when = $('vb-flip-when');
        if (left > 0) {
          const remainText = formatRemain(left);
          if (rate) {
            rate.textContent = rateGame ? `Next card in ${remainText}` : `Next flip in ${remainText}`;
            rate.className = 'status-pill warn';
          }
          if (label) label.textContent = rateGame ? 'Next card' : 'Next flip';
          if (remain) remain.textContent = remainText;
          if (when) when.textContent = `at ${formatClock(rateUntil)}`;
          clock?.classList.add('is-waiting');
          clock?.classList.remove('is-ready');
          return;
        }
        if (rate) {
          rate.textContent = rateGame ? 'Holding' : 'Next flip now';
          rate.className = `status-pill ${rateGame ? 'warn' : 'ok'}`;
        }
        if (label) label.textContent = rateGame ? 'Holding' : 'Ready to flip';
        if (remain) remain.textContent = rateGame ? '—' : 'now';
        if (when) when.textContent = rateGame ? 'This card holds the board' : 'The board can flip now';
        clock?.classList.toggle('is-waiting', false);
        clock?.classList.toggle('is-ready', !rateGame);
        window.clearInterval(rateTimer);
        rateTimer = null;
      };
      tick();
      rateTimer = window.setInterval(tick, 250);
    }

    function renderState(state) {
      const online = $('vb-pill-online');
      const quiet = $('vb-pill-quiet');
      if (online) {
        online.textContent = state?.online === false ? 'Offline' : 'Online';
        online.className = `status-pill${state?.online === false ? ' bad' : ' ok'}`;
      }
      $('vb-bezel')?.classList.toggle('is-offline', state?.online === false);
      startRateCountdown(state?.cooldownMs, { game: Boolean(state?.gameLock) });
      if (quiet) quiet.hidden = !state?.quietHours;
      if (state?.current) paintGrid(state.current);
    }

    async function refresh() {
      const data = await fetchJson('/api/vestaboard-sim');
      if (Array.isArray(data.drum)) {
        drum = data.drum.map((code) => Number(code) || 0);
      }
      renderState(data.state);
      applyQueue(data.queue, data.queueRevision);
      const port = $('vb-port');
      if (port && data.port) port.textContent = `Local API on port ${data.port}`;
      return data;
    }

    function connect() {
      if (events && events.readyState !== EventSource.CLOSED) return;
      try {
        events = new EventSource('/api/vestaboard-sim/events');
      } catch {
        return;
      }
      const on = (name, handler) => {
        events.addEventListener(name, (event) => {
          try { handler(JSON.parse(event.data)); } catch { /* ignore */ }
        });
      };
      on('sim.state', renderState);
      on('sim.flip', (detail) => applyLayout(detail.layout, true, detail.strategy));
      on('sim.queue', (detail) => applyQueue(
        detail.items || detail.queue,
        detail.queueRevision ?? detail.revision,
      ));
    }

    function enter() {
      syncSoundButton();
      if (soundOn) loadFlipSample();
      const replay = pendingReplay;
      pendingReplay = null;
      refresh().then(() => {
        if (replay?.layout) applyLayout(replay.layout, true, replay.strategy);
      }).catch((error) => toast(error.message));
    }

    function leave() {
      stopCascade();
      if (current.length) snapLayout(current.reduce((rows, code, index) => {
        if (index % 22 === 0) rows.push([]);
        rows[rows.length - 1].push(code);
        return rows;
      }, []));
    }

    function bind() {
      $('btn-vb-sound')?.addEventListener('click', () => {
        soundOn = !soundOn;
        try { window.localStorage.setItem(SOUND_KEY, soundOn ? '1' : '0'); } catch { /* ignore */ }
        syncSoundButton();
        if (soundOn) {
          loadFlipSample();
          const sample = flipSample;
          if (sample) {
            try { sample.volume = 0; sample.play()?.then(() => { sample.pause(); sample.currentTime = 0; sample.volume = 0.78; }).catch(() => {}); } catch { /* ignore */ }
          }
        } else {
          stopCascade();
        }
      });
      $('btn-vb-queue-clear')?.addEventListener('click', async () => {
        try {
          const data = await fetchJson('/api/vestaboard-sim/queue/clear', {});
          applyQueue(data.queue, data.queueRevision);
        } catch (error) {
          toast(error.message);
        }
      });
      $('btn-vb-release-holds')?.addEventListener('click', async () => {
        try {
          const data = await fetchJson('/api/vestaboards/release-holds', {});
          if (data?.queue) applyQueue(data.queue, data.queueRevision);
          const n = Number(data?.released) || 0;
          toast(n === 0 ? 'No holds to release' : `Released ${n} hold${n === 1 ? '' : 's'}`);
        } catch (error) {
          toast(error.message);
        }
      });
    }

    function mount() {
      bind();
      connect();
      syncSoundButton();
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) leave();
        else if (isWatching()) enter();
      });
      return refresh().catch((error) => toast(error.message));
    }

    function disconnect() {
      events?.close();
      events = null;
    }

    return { mount, refresh, disconnect, applyQueue, renderQueue, enter, leave };
  }

  root.VestaboardSimUi = { actorLabel, createVestaboardSimUi };
})(window);
