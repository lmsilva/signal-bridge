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
  /** Cell indices in tap order — always a legal path across the board. */
  let picked = [];

  const NEIGHBOURS = (() => {
    const all = [];
    for (let row = 0; row < SIZE; row += 1) {
      for (let col = 0; col < SIZE; col += 1) {
        const near = [];
        for (let dr = -1; dr <= 1; dr += 1) {
          for (let dc = -1; dc <= 1; dc += 1) {
            if (!dr && !dc) continue;
            const r = row + dr;
            const c = col + dc;
            if (r >= 0 && r < SIZE && c >= 0 && c < SIZE) near.push(r * SIZE + c);
          }
        }
        all.push(near);
      }
    }
    return all;
  })();

  /**
   * Any legal path spelling `word`, or null. Typing still lights up the cells
   * a valid Boggle word would use; tapping is not restricted to adjacency.
   */
  function pathFor(word) {
    if (!word || !letters.length) return null;
    const used = new Array(CELLS).fill(false);
    const path = [];
    const walk = (at, depth) => {
      if (letters[at] !== word[depth]) return false;
      used[at] = true;
      path.push(at);
      if (depth === word.length - 1) return true;
      for (const next of NEIGHBOURS[at]) {
        if (!used[next] && walk(next, depth + 1)) return true;
      }
      used[at] = false;
      path.pop();
      return false;
    };
    for (let i = 0; i < CELLS; i += 1) {
      if (walk(i, 0)) return path;
    }
    return null;
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

  /*
   * The on-screen keyboard eats most of a phone. Publishing the visible
   * height lets the board shrink to what is left instead of scrolling off.
   */
  const viewport = window.visualViewport;
  if (viewport) {
    const publish = () => {
      document.documentElement.style.setProperty('--gm-vh', `${Math.round(viewport.height)}px`);
    };
    viewport.addEventListener('resize', publish);
    viewport.addEventListener('scroll', publish);
    publish();
  }
  input?.addEventListener('focus', () => document.body.classList.add('gm-typing'));
  input?.addEventListener('blur', () => document.body.classList.remove('gm-typing'));
})();
