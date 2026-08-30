/**
 * Shared 6×22 flap-grid painter used by the Guest Book page and (later) admin.
 * Codes match the Vestaboard encoder: 0 blank, 1–26 A–Z, then digits / punct / chips.
 */
(function (root) {
  const FLAP_CHARS = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890!@#$() - +&=;: \'"%,.  /? \u00b0';
  const FLAP_CHIPS = ['red', 'orange', 'yellow', 'green', 'blue', 'violet', 'white', 'black', 'filled'];
  const FLAP_CHIP_BY_CODE = new Map(FLAP_CHIPS.map((name, index) => [63 + index, name]));
  const FLAP_CODE_BY_CHAR = (() => {
    const map = new Map();
    for (let code = 0; code < FLAP_CHARS.length; code += 1) {
      const char = FLAP_CHARS[code];
      if (char !== ' ' && !map.has(char)) {
        map.set(char, code);
      }
    }
    map.set(' ', 0);
    return map;
  })();
  const ROWS = 6;
  const COLS = 22;

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function blankRows() {
    return Array.from({ length: ROWS }, () => new Array(COLS).fill(0));
  }

  function renderFlapGrid(host, rows, { slots = false, caret = null, lockFrom = ROWS } = {}) {
    if (!host) {
      return;
    }
    const grid = Array.isArray(rows) && rows.length ? rows : blankRows();
    const lockAt = Number.isFinite(Number(lockFrom)) ? Number(lockFrom) : ROWS;
    host.innerHTML = grid.map((row, rowIndex) => {
      const cells = Array.from({ length: COLS }, (_, col) => {
        const code = Number(row?.[col] ?? 0);
        const chip = FLAP_CHIP_BY_CODE.get(code);
        const locked = rowIndex >= lockAt;
        const classes = [
          chip ? `is-chip-${chip}` : '',
          locked ? 'is-locked' : '',
          !locked && caret && caret.row === rowIndex && caret.col === col ? 'is-caret' : '',
        ].filter(Boolean).join(' ');
        const char = chip ? '' : (FLAP_CHARS[code] || ' ');
        return `<span class="${classes}" data-flap-row="${rowIndex}" data-flap-col="${col}">${escapeHtml(char === ' ' ? '' : char)}</span>`;
      }).join('');
      return `<div class="cn-preview-row">${cells}</div>`;
    }).join('');
  }

  root.renderFlapGrid = renderFlapGrid;
  root.FLAP_GRID = { FLAP_CHARS, FLAP_CHIP_BY_CODE, FLAP_CODE_BY_CHAR, ROWS, COLS, blankRows };
})(typeof window !== 'undefined' ? window : globalThis);
