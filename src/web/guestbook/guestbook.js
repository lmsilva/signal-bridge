(() => {
  'use strict';

  const ALLOWED_NAME = new Set(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$()+&=;:'\"%,./? -".split(''),
  );
  ALLOWED_NAME.add(' ');

  const CHIP_CODE = { R: 63, O: 64, Y: 65, G: 66, B: 67, V: 68, W: 69 };
  const NAME_KEY = 'signal.guestbook.name';

  const $ = (id) => document.getElementById(id);
  const gridApi = () => window.FLAP_GRID || {};

  const state = {
    status: null,
    rows: null,
    caret: { row: 0, col: 0 },
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

  function footerMode() {
    return state.status?.inviteFooterMode || 'off';
  }

  function footerLocked() {
    return footerMode() === 'always';
  }

  function footerOptional() {
    return footerMode() === 'whenRoom' && Boolean(state.status?.footerRows);
  }

  function syncFooterButtons() {
    const clearBtn = $('btn-gb-clear-footer');
    const restoreBtn = $('btn-gb-restore-footer');
    const show = footerOptional();
    if (clearBtn) clearBtn.hidden = !show;
    if (restoreBtn) restoreBtn.hidden = !show;
  }

  function usedInRows(rows, from, to) {
    let sum = 0;
    for (let row = from; row < to; row += 1) {
      sum += (rows?.[row] || []).filter((code) => Number(code) > 0).length;
    }
    return sum;
  }

  function footerInstalled(rows) {
    const footer = state.status?.footerRows;
    if (!footer || !rows) return false;
    for (let row = 4; row < 6; row += 1) {
      const want = footer[row] || [];
      const have = rows[row] || [];
      for (let col = 0; col < (gridApi().COLS || 22); col += 1) {
        if (Number(want[col] || 0) !== Number(have[col] || 0)) return false;
      }
    }
    return true;
  }

  function usedCount(rows) {
    // With the invite present (always, or whenRoom still showing it), only the
    // top four rows count as the guest's message so Send stays off on a bare invite.
    if (footerLocked() || (footerOptional() && footerInstalled(rows))) {
      return usedInRows(rows, 0, 4);
    }
    return usedInRows(rows, 0, editableRows());
  }

  function displayRows() {
    const out = (state.rows || blankRows()).map((row) => row.slice());
    const footer = state.status?.footerRows;
    // Always mode: house invite is locked chrome overlaid on the last two rows.
    if (footer && footerLocked()) {
      for (let row = 4; row < 6; row += 1) {
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
        focusForTyping();
      }
    }
  }

  function startCooldown(seconds) {
    stopCooldown();
    const total = Math.max(1, Math.round(Number(seconds) || 60));
    state.cooldownUntil = Date.now() + (total * 1000);
    const title = $('gb-cooldown-message');
    if (title) title.textContent = 'Rate Limit Reached';
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
        lockFrom: footerLocked() ? 4 : 6,
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
    syncFooterButtons();
  }

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

  function fillRememberedName() {
    const input = $('gb-name');
    if (!input || input.value) return;
    const saved = rememberedName();
    if (saved) input.value = saved;
  }

  function dismissKeyboard() {
    const keys = $('gb-keys');
    if (keys && document.activeElement === keys) keys.blur();
    if (keys) keys.value = '';
  }

  function focusBoard() {
    const preview = $('gb-preview');
    if (preview) preview.focus({ preventScroll: true });
    dismissKeyboard();
  }

  /** The letter box is the only thing that should raise a phone keyboard. */
  function focusForTyping() {
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    if (coarse) dismissKeyboard();
    else focusBoard();
  }

  function stampFooterIntoRows(rows) {
    const footer = state.status?.footerRows;
    if (!footer || !rows) return rows;
    const next = rows.map((row) => row.slice());
    for (let row = 4; row < 6; row += 1) {
      next[row] = Array.isArray(footer[row]) ? footer[row].slice() : new Array((gridApi().COLS || 22)).fill(0);
    }
    return next;
  }

  function clearFooterRows(rows) {
    const next = (rows || blankRows()).map((row) => row.slice());
    const cols = gridApi().COLS || 22;
    next[4] = new Array(cols).fill(0);
    next[5] = new Array(cols).fill(0);
    return next;
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
    if (state.caret.row >= editableRows()) return;
    snapshot();
    state.rows[state.caret.row][state.caret.col] = code;
    advance();
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
    // whenRoom: seed the invite so guests see it and can clear/overwrite it.
    if (footerOptional()) {
      state.rows = stampFooterIntoRows(state.rows);
    }
    state.undo = [];
    state.caret = { row: 0, col: 0 };
    paint();
  }

  function composeReady() {
    const who = state.status?.whoCanSend || 'anyone';
    if (who !== 'anyone' && !window.SIGNAL_GUESTBOOK_SKIP_UNLOCK) {
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
    fillRememberedName();
    if (!state.rows) resetBoard();
    else paint();
    focusForTyping();
  }

  async function loadStatus() {
    const status = await api('/api/guestbook/status');
    state.status = status;
    const hint = $('gb-charset-hint');
    if (hint) {
      if (status.inviteFooterMode === 'always') {
        hint.textContent = 'Select a flap, then type. The last two rows are the house invite and stay locked.';
      } else if (status.inviteFooterMode === 'whenRoom') {
        hint.textContent = 'Select a flap, then type. Clear the footer for more room, or restore it when you want the invite back.';
      } else {
        hint.textContent = 'Select a flap, then type. Color chips paint the selected flap.';
      }
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
      fillRememberedName();
      if (!state.rows) resetBoard();
      else paint();
      focusForTyping();
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
      dismissKeyboard();
      return;
    }
    const row = Number(cell.getAttribute('data-flap-row'));
    if (row >= editableRows()) {
      dismissKeyboard();
      return;
    }
    moveCaret(row, Number(cell.getAttribute('data-flap-col')));
    dismissKeyboard();
  });

  function handleBoardKeydown(event) {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      retreat();
      return true;
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      advance();
      return true;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveCaret(state.caret.row - 1, state.caret.col);
      return true;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveCaret(state.caret.row + 1, state.caret.col);
      return true;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      moveCaret(state.caret.row + 1, 0);
      return true;
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
      return true;
    }
    if (event.key === 'Delete') {
      event.preventDefault();
      snapshot();
      state.rows[state.caret.row][state.caret.col] = 0;
      paint();
      return true;
    }
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const code = codeForChar(event.key);
      if (code == null) return false;
      event.preventDefault();
      setCell(code);
      return true;
    }
    return false;
  }

  function shouldCaptureBoardKeys() {
    if ($('gb-compose')?.hidden) return false;
    const el = document.activeElement;
    if (!el || el === document.body) return true;
    if (el === $('gb-preview') || el === $('gb-keys')) return true;
    if (el.id === 'gb-name' || el.id === 'gb-unlock-input') return false;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return false;
    if (el.isContentEditable) return false;
    return true;
  }

  $('gb-keys')?.addEventListener('keydown', (event) => {
    handleBoardKeydown(event);
  });

  $('gb-preview')?.addEventListener('keydown', (event) => {
    handleBoardKeydown(event);
  });

  document.addEventListener('keydown', (event) => {
    if (!shouldCaptureBoardKeys()) return;
    if (document.activeElement === $('gb-keys') || document.activeElement === $('gb-preview')) {
      return; // those listeners already handle it
    }
    handleBoardKeydown(event);
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
    button.addEventListener('pointerdown', (event) => {
      event.preventDefault();
    });
    button.addEventListener('click', (event) => {
      event.preventDefault();
      const code = CHIP_CODE[button.getAttribute('data-chip')];
      if (code) setCell(code);
      dismissKeyboard();
    });
  });

  $('btn-gb-erase')?.addEventListener('click', () => {
    snapshot();
    state.rows[state.caret.row][state.caret.col] = 0;
    paint();
    dismissKeyboard();
  });

  $('btn-gb-undo')?.addEventListener('click', () => {
    const prev = state.undo.pop();
    if (prev) {
      state.rows = prev;
      paint();
    }
    dismissKeyboard();
  });

  $('btn-gb-clear')?.addEventListener('click', () => {
    if (!usedCount(state.rows) && !footerOptional()) return;
    snapshot();
    const next = blankRows();
    const lockAt = editableRows();
    for (let row = 0; row < lockAt; row += 1) {
      next[row] = new Array((gridApi().COLS || 22)).fill(0);
    }
    state.rows = footerOptional() ? stampFooterIntoRows(next) : next;
    paint();
    dismissKeyboard();
  });

  $('btn-gb-clear-footer')?.addEventListener('click', () => {
    if (!footerOptional()) return;
    snapshot();
    state.rows = clearFooterRows(state.rows);
    paint();
    dismissKeyboard();
  });

  $('btn-gb-restore-footer')?.addEventListener('click', () => {
    if (!footerOptional()) return;
    snapshot();
    state.rows = stampFooterIntoRows(state.rows || blankRows());
    paint();
    dismissKeyboard();
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
      const name = String(window.SIGNAL_GUESTBOOK_NAME || $('gb-name')?.value || '').trim();
      rememberName(name);
      const result = await api(window.SIGNAL_GUESTBOOK_SEND || '/api/guestbook/send', {
        rows: state.rows,
        name,
      });
      if (typeof window.renderFlapGrid === 'function') {
        window.renderFlapGrid($('gb-done-preview'), result.rows);
      }
      const message = $('gb-done-message');
      if (message) {
        message.textContent = result.status === 'waiting'
          ? 'Message will be displayed once it is approved.'
          : (result.message || 'Your message has been pushed and will be displayed if outside quiet hours.');
      }
      const hint = $('gb-done-hint');
      if (hint) {
        hint.textContent = '';
        hint.hidden = true;
      }
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
        startCooldown(error.data.retryAfterSeconds);
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
    fillRememberedName();
    if ($('gb-send-status')) {
      $('gb-send-status').textContent = '';
      $('gb-send-status').className = 'gb-status';
    }
    resetBoard();
    showPane('gb-compose');
    paint();
    focusForTyping();
  });

  $('btn-gb-cooldown-back')?.addEventListener('click', () => {
    showPane('gb-compose');
    paint();
    syncCooldownUi();
    focusForTyping();
  });

  loadStatus().catch((error) => {
    const reason = $('gb-closed-reason');
    if (reason) reason.textContent = error.message || 'The guest book is closed right now.';
    showPane('gb-closed');
  });
})();
