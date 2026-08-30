(() => {
  'use strict';

  const ALLOWED_NAME = new Set(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$()+&=;:'\"%,./? -".split(''),
  );
  ALLOWED_NAME.add(' ');

  const CHIP_CODE = { R: 63, O: 64, Y: 65, G: 66, B: 67, V: 68, W: 69 };

  const $ = (id) => document.getElementById(id);
  const gridApi = () => window.FLAP_GRID || {};

  const state = {
    status: null,
    rows: null,
    caret: { row: 2, col: 7 },
    undo: [],
    layoutOk: false,
    cooldownUntil: 0,
  };

  let cooldownTimer = null;

  function blankRows() {
    const { ROWS = 6, COLS = 22, blankRows } = gridApi();
    return blankRows ? blankRows() : Array.from({ length: ROWS }, () => new Array(COLS).fill(0));
  }

  function editableRows() {
    const n = Number(state.status?.editableRows);
    return n > 0 && n <= 6 ? n : 6;
  }

  function usedCount(rows) {
    const limit = editableRows();
    return (rows || []).slice(0, limit).reduce((sum, row) => (
      sum + (row || []).filter((code) => Number(code) > 0).length
    ), 0);
  }

  function displayRows() {
    const out = (state.rows || blankRows()).map((row) => row.slice());
    const footer = state.status?.footerRows;
    const lockAt = editableRows();
    if (footer && lockAt < 6) {
      for (let row = lockAt; row < 6; row += 1) {
        out[row] = Array.isArray(footer[row]) ? footer[row].slice() : out[row];
      }
    }
    return out;
  }

  function showPane(id) {
    ['gb-closed', 'gb-unlock', 'gb-compose', 'gb-done', 'gb-cooldown'].forEach((pane) => {
      const el = $(pane);
      if (el) el.hidden = pane !== id;
    });
  }

  function formatClock(total) {
    const s = Math.max(0, Math.round(Number(total) || 0));
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
  }

  function cooldownLeft() {
    if (!state.cooldownUntil) return 0;
    return Math.max(0, Math.ceil((state.cooldownUntil - Date.now()) / 1000));
  }

  function stopCooldown() {
    if (cooldownTimer) {
      clearInterval(cooldownTimer);
      cooldownTimer = null;
    }
  }

  function syncCooldownUi() {
    const left = cooldownLeft();
    const clock = $('gb-cooldown-clock');
    if (clock) clock.textContent = formatClock(left);
    const send = $('btn-gb-send');
    if (send) send.disabled = !state.layoutOk || left > 0;
    const status = $('gb-send-status');
    if (status && !$('gb-compose')?.hidden) {
      if (left > 0) {
        status.textContent = `You can send again in ${formatClock(left)}.`;
        status.className = 'gb-status';
      } else if (status.textContent.startsWith('You can send again in')) {
        status.textContent = '';
        status.className = 'gb-status';
      }
    }
    if (left <= 0) {
      stopCooldown();
      state.cooldownUntil = 0;
      if (!$('gb-cooldown')?.hidden) {
        showPane('gb-compose');
        if (status) {
          status.textContent = '';
          status.className = 'gb-status';
        }
        focusKeys();
      }
    }
  }

  function startCooldown(seconds, message) {
    stopCooldown();
    const total = Math.max(1, Math.round(Number(seconds) || 60));
    state.cooldownUntil = Date.now() + (total * 1000);
    const msg = $('gb-cooldown-message');
    if (msg) msg.textContent = message || 'Please wait before sending another.';
    showPane('gb-cooldown');
    syncCooldownUi();
    cooldownTimer = setInterval(syncCooldownUi, 1000);
  }

  function snapshot() {
    state.undo.push(state.rows.map((row) => row.slice()));
    if (state.undo.length > 40) {
      state.undo.shift();
    }
  }

  function paint() {
    if (typeof window.renderFlapGrid === 'function') {
      window.renderFlapGrid($('gb-preview'), displayRows(), {
        caret: state.caret,
        lockFrom: editableRows(),
      });
    }
    const used = usedCount(state.rows);
    const max = editableRows() * (gridApi().COLS || 22);
    state.layoutOk = used > 0;
    const counter = $('gb-counter');
    if (counter) counter.textContent = `${used} / ${max}`;
    const send = $('btn-gb-send');
    if (send) send.disabled = !state.layoutOk || cooldownLeft() > 0;
    const undo = $('btn-gb-undo');
    if (undo) undo.disabled = !state.undo.length;
  }

  function focusKeys() {
    const keys = $('gb-keys');
    if (!keys) return;
    keys.value = '';
    keys.focus({ preventScroll: true });
  }

  function moveCaret(row, col) {
    const { COLS = 22 } = gridApi();
    const maxRow = Math.max(0, editableRows() - 1);
    state.caret = {
      row: Math.max(0, Math.min(maxRow, row)),
      col: Math.max(0, Math.min(COLS - 1, col)),
    };
    paint();
  }

  function advance() {
    const { COLS = 22 } = gridApi();
    const maxRow = Math.max(0, editableRows() - 1);
    if (state.caret.col < COLS - 1) {
      moveCaret(state.caret.row, state.caret.col + 1);
      return;
    }
    if (state.caret.row < maxRow) {
      moveCaret(state.caret.row + 1, 0);
    }
  }

  function retreat() {
    if (state.caret.col > 0) {
      moveCaret(state.caret.row, state.caret.col - 1);
      return;
    }
    if (state.caret.row > 0) {
      moveCaret(state.caret.row - 1, (gridApi().COLS || 22) - 1);
    }
  }

  function setCell(code) {
    if (state.caret.row >= editableRows()) {
      focusKeys();
      return;
    }
    snapshot();
    state.rows[state.caret.row][state.caret.col] = code;
    advance();
    focusKeys();
  }

  function codeForChar(char) {
    const map = gridApi().FLAP_CODE_BY_CHAR;
    if (!map) return null;
    const upper = String(char || '').toUpperCase();
    if (!map.has(upper)) return null;
    return map.get(upper);
  }

  async function api(path, body) {
    const response = await fetch(path, {
      method: body ? 'POST' : 'GET',
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || 'Request failed');
      error.data = data;
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function resetBoard() {
    state.rows = blankRows();
    state.undo = [];
    state.caret = { row: 2, col: 7 };
    paint();
  }

  function composeReady() {
    const who = state.status?.whoCanSend || 'anyone';
    if (who !== 'anyone') {
      showPane('gb-unlock');
      const input = $('gb-unlock-input');
      if (input) {
        input.type = who === 'password' ? 'password' : 'text';
        input.inputMode = who === 'code' ? 'numeric' : 'text';
        input.maxLength = who === 'code' ? 6 : 64;
        input.placeholder = who === 'code' ? 'Board code' : 'Password';
      }
      const hint = $('gb-unlock-hint');
      if (hint) {
        hint.textContent = who === 'code'
          ? 'Enter the 6-digit code shown on the board.'
          : 'Enter the guest book password.';
      }
      return;
    }
    showPane('gb-compose');
    if (!state.rows) resetBoard();
    else paint();
    focusKeys();
  }

  async function loadStatus() {
    const status = await api('/api/guestbook/status');
    state.status = status;
    const hint = $('gb-charset-hint');
    if (hint) {
      hint.textContent = status.inviteFooter
        ? 'Tap a flap, then type in the box. The last two rows are the house invite — they stay on the board.'
        : 'Tap a flap, then type in the box. Color chips paint the selected flap.';
    }
    if (status.closed) {
      const reason = $('gb-closed-reason');
      if (reason) reason.textContent = status.closedReason || 'The guest book is closed right now.';
      showPane('gb-closed');
      return;
    }
    composeReady();
  }

  $('btn-gb-unlock')?.addEventListener('click', async () => {
    const button = $('btn-gb-unlock');
    const status = $('gb-unlock-status');
    if (button) button.disabled = true;
    if (status) status.textContent = '';
    try {
      const value = $('gb-unlock-input')?.value || '';
      const who = state.status?.whoCanSend;
      await api('/api/guestbook/unlock', who === 'code' ? { code: value } : { password: value });
      showPane('gb-compose');
      if (!state.rows) resetBoard();
      else paint();
      focusKeys();
    } catch (error) {
      if (status) {
        status.textContent = error.message;
        status.className = 'gb-status is-bad';
      }
    } finally {
      if (button) button.disabled = false;
    }
  });

  $('gb-preview')?.addEventListener('pointerdown', (event) => {
    const cell = event.target.closest('[data-flap-row]');
    if (!cell) {
      focusKeys();
      return;
    }
    const row = Number(cell.getAttribute('data-flap-row'));
    if (row >= editableRows()) {
      focusKeys();
      return;
    }
    moveCaret(row, Number(cell.getAttribute('data-flap-col')));
    focusKeys();
  });

  $('gb-keys')?.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      retreat();
      return;
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      advance();
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveCaret(state.caret.row - 1, state.caret.col);
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveCaret(state.caret.row + 1, state.caret.col);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      moveCaret(state.caret.row + 1, 0);
      return;
    }
    if (event.key === 'Backspace') {
      event.preventDefault();
      snapshot();
      if (state.rows[state.caret.row][state.caret.col]) {
        state.rows[state.caret.row][state.caret.col] = 0;
        paint();
      } else {
        retreat();
        state.rows[state.caret.row][state.caret.col] = 0;
        paint();
      }
      return;
    }
    if (event.key === 'Delete') {
      event.preventDefault();
      snapshot();
      state.rows[state.caret.row][state.caret.col] = 0;
      paint();
    }
  });

  $('gb-keys')?.addEventListener('input', (event) => {
    const typed = String(event.target.value || '');
    event.target.value = '';
    let rejected = false;
    for (const char of typed) {
      if (char === '\n') {
        moveCaret(state.caret.row + 1, 0);
        continue;
      }
      const code = codeForChar(char);
      if (code == null) {
        rejected = true;
        continue;
      }
      setCell(code);
    }
    const hint = $('gb-charset-hint');
    if (hint && rejected && state.status?.charsetHint) {
      hint.textContent = state.status.charsetHint;
    }
  });

  document.querySelectorAll('[data-chip]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      const code = CHIP_CODE[button.getAttribute('data-chip')];
      if (code) setCell(code);
    });
  });

  $('btn-gb-erase')?.addEventListener('click', () => {
    snapshot();
    state.rows[state.caret.row][state.caret.col] = 0;
    paint();
    focusKeys();
  });

  $('btn-gb-undo')?.addEventListener('click', () => {
    const prev = state.undo.pop();
    if (prev) {
      state.rows = prev;
      paint();
    }
    focusKeys();
  });

  $('btn-gb-clear')?.addEventListener('click', () => {
    if (!usedCount(state.rows)) return;
    snapshot();
    const next = blankRows();
    const lockAt = editableRows();
    for (let row = 0; row < lockAt; row += 1) {
      next[row] = new Array((gridApi().COLS || 22)).fill(0);
    }
    state.rows = next;
    paint();
    focusKeys();
  });

  $('gb-name')?.addEventListener('input', (event) => {
    let out = '';
    for (const char of String(event.target.value || '').toUpperCase()) {
      if (ALLOWED_NAME.has(char)) out += char;
    }
    if (out !== event.target.value) event.target.value = out;
  });

  $('btn-gb-send')?.addEventListener('click', async () => {
    const button = $('btn-gb-send');
    const status = $('gb-send-status');
    if (button) button.disabled = true;
    if (status) {
      status.textContent = '';
      status.className = 'gb-status';
    }
    try {
      const result = await api('/api/guestbook/send', {
        rows: state.rows,
        name: $('gb-name')?.value || '',
      });
      if (typeof window.renderFlapGrid === 'function') {
        window.renderFlapGrid($('gb-done-preview'), result.rows);
      }
      const message = $('gb-done-message');
      if (message) message.textContent = result.message || 'Your message is up.';
      showPane('gb-done');
    } catch (error) {
      if (error.data?.needsUnlock) {
        composeReady();
        return;
      }
      if (error.data?.closed) {
        const reason = $('gb-closed-reason');
        if (reason) reason.textContent = error.data.error || error.message;
        showPane('gb-closed');
        return;
      }
      if (error.status === 429 || error.data?.retryAfterSeconds > 0) {
        startCooldown(
          error.data.retryAfterSeconds,
          error.data.error || error.message,
        );
        return;
      }
      if (status) {
        status.textContent = error.message;
        status.className = 'gb-status is-bad';
      }
      if (button) button.disabled = !state.layoutOk || cooldownLeft() > 0;
    }
  });

  $('btn-gb-another')?.addEventListener('click', () => {
    if ($('gb-name')) $('gb-name').value = '';
    if ($('gb-send-status')) {
      $('gb-send-status').textContent = '';
      $('gb-send-status').className = 'gb-status';
    }
    resetBoard();
    showPane('gb-compose');
    paint();
    focusKeys();
  });

  $('btn-gb-cooldown-back')?.addEventListener('click', () => {
    showPane('gb-compose');
    paint();
    syncCooldownUi();
    focusKeys();
  });

  loadStatus().catch((error) => {
    const reason = $('gb-closed-reason');
    if (reason) reason.textContent = error.message || 'The guest book is closed right now.';
    showPane('gb-closed');
  });
})();
