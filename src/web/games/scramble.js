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

  /** Typed text wins; we just work out which cells it would use. */
  function syncFromInput() {
    const typed = input.value.replace(/[^A-Za-z]/g, '').toUpperCase();
    if (typed !== input.value) input.value = typed;
    if (typed !== pickedWord()) picked = pathFor(typed) || [];
    paint();
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

  window.scrambleRender = (session) => {
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
      cell.addEventListener('click', () => tap(index));
      gridEl.appendChild(cell);
      return cell;
    });
    setWord('');
  };

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
   * The on-screen keyboard eats most of a phone. Publishing the visible
   * height lets the board shrink to what is left instead of scrolling off.
   * Safari still scrolls a focused field to the top of the visual viewport,
   * so we lock the page and push the scroll back to the board.
   */
  const viewport = window.visualViewport;
  const stage = document.querySelector('.gm-stage');
  const meta = document.querySelector('.gm-meta');
  const status = document.getElementById('gm-play-status');

  function publishViewport() {
    const height = viewport ? viewport.height : window.innerHeight;
    document.documentElement.style.setProperty('--gm-vh', `${Math.round(height)}px`);
    if (!document.body.classList.contains('gm-typing')) return;
    const chrome = (meta?.offsetHeight || 0)
      + (form?.offsetHeight || 0)
      + (status?.offsetHeight || 0)
      + 28;
    const boardMax = Math.max(140, Math.round(height - chrome));
    document.documentElement.style.setProperty('--gm-board-max', `${boardMax}px`);
  }

  function keepBoardInView() {
    if (!document.body.classList.contains('gm-typing')) return;
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    stage?.scrollTo?.(0, 0);
  }

  function afterKeyboard() {
    publishViewport();
    keepBoardInView();
  }

  if (viewport) {
    viewport.addEventListener('resize', afterKeyboard);
    viewport.addEventListener('scroll', afterKeyboard);
    publishViewport();
  }

  input?.addEventListener('focus', () => {
    document.body.classList.add('gm-typing');
    placeCaretAtEnd();
    afterKeyboard();
    requestAnimationFrame(() => {
      afterKeyboard();
      placeCaretAtEnd();
    });
  });
  input?.addEventListener('click', placeCaretAtEnd);
  input?.addEventListener('blur', () => {
    document.body.classList.remove('gm-typing');
    document.documentElement.style.removeProperty('--gm-board-max');
  });
})();
