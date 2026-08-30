(() => {
  'use strict';

  const gridEl = document.getElementById('gm-grid');
  const form = document.getElementById('gm-word-form');
  const input = document.getElementById('gm-word');

  window.scrambleRender = (session) => {
    const playing = session.phase === 'round' && Array.isArray(session.grid);
    gridEl.hidden = !playing;
    form.hidden = !playing;
    if (!playing) {
      gridEl.innerHTML = '';
      return;
    }
    gridEl.innerHTML = '';
    for (const row of session.grid) {
      for (const letter of String(row || '')) {
        const cell = document.createElement('div');
        cell.className = 'gm-cell';
        cell.textContent = letter.toUpperCase();
        gridEl.appendChild(cell);
      }
    }
  };

  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    const word = String(input?.value || '').trim();
    if (!word || typeof window.gameSubmit !== 'function') return;
    window.gameSubmit('word', { word });
    input.value = '';
    input.focus();
  });
})();
