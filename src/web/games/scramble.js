(() => {
  'use strict';

  const gridEl = document.getElementById('gm-grid');
  const form = document.getElementById('gm-word-form');
  const input = document.getElementById('gm-word');
  const clearBtn = document.getElementById('btn-gm-clear');
  const play = document.getElementById('gm-play');

  const SIZE = 4;
  const CELLS = SIZE * SIZE;

  let letters = [];
  let cells = [];
  /** Cell indices in tap order — each tile at most once. */
  let picked = [];

  /**
   * Tiles that spell `word` from the letters on the board, or null when a
   * letter is missing. Order follows the word, not adjacency — any unused
   * matching tile is fair game.
   */
  function pathFor(word) {
    if (!word || !letters.length) return null;
    const used = new Array(CELLS).fill(false);
    const path = [];
    for (let i = 0; i < word.length; i += 1) {
      const at = letters.findIndex((letter, index) => !used[index] && letter === word[i]);
      if (at < 0) return null;
      used[at] = true;
      path.push(at);
    }
    return path;
  }

  const pickedWord = () => picked.map((i) => letters[i]).join('');

  /**
   * Letters already in this word grey out so nobody spends one twice. Tap the
   * last pick again to undo. Everything else stays live — validity is checked
   * on submit, not while you are still building the word.
   */
  function paint() {
    const last = picked.length ? picked[picked.length - 1] : -1;
    cells.forEach((cell, index) => {
      const used = picked.includes(index);
      const undo = index === last;
      cell.classList.toggle('is-used', used && !undo);
      cell.classList.toggle('is-last', undo);
      cell.classList.remove('is-far');
      cell.disabled = used && !undo;
    });
    if (clearBtn) clearBtn.hidden = !input.value;
  }

  function setWord(word) {
    input.value = word;
    paint();
  }

  function reset() {
    picked = [];
    setWord('');
  }

  let shakeTimer = null;

  function shakeCompose() {
    if (!form || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    form.classList.remove('is-shake');
    void form.offsetWidth;
    form.classList.add('is-shake');
    window.clearTimeout(shakeTimer);
    shakeTimer = window.setTimeout(() => form.classList.remove('is-shake'), 420);
  }

  /** Wrong letter while typing — wipe the attempt and the tile picks. */
  function rejectInvalidLetter() {
    picked = [];
    input.value = '';
    paint();
    shakeCompose();
  }

  /** Typed text wins; we just work out which cells it would use. */
  function syncFromInput() {
    const typed = input.value.replace(/[^A-Za-z]/g, '').toUpperCase();
    if (typed !== input.value) input.value = typed;
    if (!typed) {
      picked = [];
      paint();
      return;
    }
    const path = pathFor(typed);
    if (path) {
      picked = path;
      paint();
      return;
    }
    rejectInvalidLetter();
  }

  function tap(index) {
    if (picked.length && picked[picked.length - 1] === index) {
      picked.pop();
    } else if (picked.includes(index)) {
      return;
    } else {
      picked.push(index);
    }
    setWord(pickedWord());
  }

  /** Everything you have found this round, newest list each repaint. */
  function renderFound(session) {
    const mine = session.you?.words || [];
    const playing = session.phase === 'round';
    document.getElementById('gm-found-section').hidden = !mine.length;
    document.getElementById('gm-found-title').textContent = playing
      ? `Your words (${mine.length})`
      : `Your words last round (${mine.length})`;
    window.GameShell.renderChips('gm-found', mine);
  }

  /** The between-rounds reveal: every word the table found, and who got it. */
  function renderRecap(session) {
    const recap = session.lastRound?.words || [];
    document.getElementById('gm-recap-section').hidden = !recap.length;
    if (!recap.length) return;
    document.getElementById('gm-recap-title').textContent = `Every word found in round ${session.lastRound.index}`;
    window.GameShell.renderChips('gm-recap', recap);
  }

  function renderBoard(session) {
    const playing = session.phase === 'round' && Array.isArray(session.grid);
    gridEl.hidden = !playing;
    form.hidden = !playing;
    // Between rounds there is no board to sit beside, so a wide screen drops
    // back to one column instead of leaving half of itself empty.
    play?.classList.toggle('gm-no-board', !playing);
    if (!playing) {
      gridEl.innerHTML = '';
      letters = [];
      cells = [];
      picked = [];
      return;
    }
    const next = session.grid.join('').toUpperCase().slice(0, CELLS).split('');
    if (next.join('') === letters.join('')) return;
    letters = next;
    picked = [];
    gridEl.innerHTML = '';
    cells = letters.map((letter, index) => {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'gm-cell';
      cell.textContent = letter;
      // A tap on a letter while the keyboard is up must dismiss it and
      // keep the letter — iOS would otherwise swallow the click as the
      // keyboard animates down.
      cell.addEventListener('pointerdown', (event) => {
        if (document.activeElement !== input && !document.body.classList.contains('gm-keyboard')) {
          return;
        }
        event.preventDefault();
        leaveKeyboardMode();
        tap(index);
        cell.dataset.gmHandled = '1';
      });
      cell.addEventListener('click', () => {
        if (cell.dataset.gmHandled === '1') {
          delete cell.dataset.gmHandled;
          return;
        }
        tap(index);
      });
      gridEl.appendChild(cell);
      return cell;
    });
    setWord('');
  }

  window.GameShell.register('scramble', {
    render(session) {
      renderBoard(session);
      renderFound(session);
      renderRecap(session);
    },
    scoreLine(session) {
      // you.score only banks finished rounds; add what is still in play.
      const pending = session.phase === 'round'
        ? (session.you.words || []).reduce((sum, row) => sum + (row.points || 0), 0)
        : 0;
      return `Your score ${(session.you.score || 0) + pending}`;
    },
    teardown() {
      gridEl.innerHTML = '';
      letters = [];
      cells = [];
      picked = [];
      play?.classList.remove('gm-no-board');
    },
  });

  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    const word = String(input?.value || '').trim();
    if (!word || typeof window.gameSubmit !== 'function') return;
    // Only chase the caret back if they were typing — pulling the keyboard up
    // on someone who is tapping tiles would bury the board.
    const typing = document.activeElement === input;
    window.gameSubmit('word', { word });
    reset();
    if (typing) input.focus();
  });

  input?.addEventListener('input', syncFromInput);
  clearBtn?.addEventListener('click', () => {
    reset();
    input.focus();
  });

  /**
   * Tile taps fill the box without focusing it. When they then tap the field
   * to keep going on the keyboard, the caret has to sit after the last letter
   * — a tap in the empty half of the box would otherwise land at index 0.
   */
  function placeCaretAtEnd() {
    if (!input) return;
    const end = input.value.length;
    try {
      input.setSelectionRange(end, end);
    } catch {
      // Some mobile WebKits throw if the field is not yet a text control.
    }
  }

  /*
   * Soft keyboards eat most of a phone or tablet. The board has to shrink
   * into the visual viewport so the letters stay tappable. A hardware
   * keyboard (desktop, docked iPad) must not shrink the board just because
   * the field is focused.
   */
  const viewport = window.visualViewport;
  const stage = document.querySelector('.gm-stage');
  const meta = document.querySelector('.gm-meta');
  const status = document.getElementById('gm-play-status');

  function visibleHeight() {
    return viewport ? viewport.height : window.innerHeight;
  }

  function keyboardInset() {
    if (!viewport) return 0;
    return Math.max(0, window.innerHeight - viewport.height, viewport.offsetTop || 0);
  }

  function likelyPhone() {
    return window.matchMedia('(max-width: 759px)').matches
      && window.matchMedia('(hover: none)').matches;
  }

  function shouldCompactNow() {
    if (keyboardInset() > 80) return true;
    return likelyPhone();
  }

  function publishViewport() {
    const height = visibleHeight();
    const top = viewport ? viewport.offsetTop : 0;
    document.documentElement.style.setProperty('--gm-vh', `${Math.round(height)}px`);
    document.documentElement.style.setProperty('--gm-vv-top', `${Math.round(top)}px`);
    if (!document.body.classList.contains('gm-keyboard')) return;
    const chrome = (meta?.offsetHeight || 0)
      + (form?.offsetHeight || 0)
      + (status?.offsetHeight || 0)
      + 24;
    const width = Math.round((viewport && viewport.width) || window.innerWidth) - 32;
    const boardMax = Math.max(120, Math.min(Math.round(height - chrome), width));
    document.documentElement.style.setProperty('--gm-board-max', `${boardMax}px`);
  }

  function keepBoardInView() {
    if (!document.body.classList.contains('gm-keyboard')) return;
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    stage?.scrollTo?.(0, 0);
  }

  function syncKeyboardMode() {
    const compact = document.activeElement === input && shouldCompactNow();
    document.body.classList.toggle('gm-keyboard', compact);
    if (!compact) {
      document.documentElement.style.removeProperty('--gm-board-max');
    }
  }

  function afterKeyboard() {
    syncKeyboardMode();
    publishViewport();
    keepBoardInView();
  }

  function leaveKeyboardMode() {
    document.body.classList.remove('gm-keyboard');
    document.body.classList.remove('gm-typing');
    document.documentElement.style.removeProperty('--gm-board-max');
    if (document.activeElement === input) {
      input.blur();
    }
  }

  if (viewport) {
    viewport.addEventListener('resize', afterKeyboard);
    viewport.addEventListener('scroll', afterKeyboard);
    publishViewport();
  }

  input?.addEventListener('focus', () => {
    document.body.classList.add('gm-typing');
    if (shouldCompactNow()) document.body.classList.add('gm-keyboard');
    placeCaretAtEnd();
    afterKeyboard();
    requestAnimationFrame(() => {
      afterKeyboard();
      placeCaretAtEnd();
    });
    // iOS raises the keyboard after focus; measure again when it settles.
    window.setTimeout(afterKeyboard, 280);
  });
  input?.addEventListener('click', placeCaretAtEnd);
  input?.addEventListener('blur', () => {
    document.body.classList.remove('gm-typing');
    document.body.classList.remove('gm-keyboard');
    document.documentElement.style.removeProperty('--gm-board-max');
  });
})();
