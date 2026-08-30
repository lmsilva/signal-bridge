/**
 * Shared 6×22 Vestaboard painter — Flagship bezel tiles (same as the simulator).
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

  function chipCode(name) {
    const index = FLAP_CHIPS.indexOf(String(name || '').toLowerCase());
    return index >= 0 ? 63 + index : 0;
  }

  function charCode(ch) {
    const raw = String(ch == null ? '' : ch);
    if (!raw || raw === ' ' || raw === '■') {
      return 0;
    }
    return FLAP_CODE_BY_CHAR.get(raw.toUpperCase()) || 0;
  }

  /**
   * Paint a 6×22 code grid as Vestaboard Simulator tiles (`.vb-tile` / `.vb-flap`).
   * `host` should be a `.vb-grid` inside a `.vb-bezel`.
   */
  function renderFlapGrid(host, rows, {
    slots = false,
    caret = null,
    lockFrom = ROWS,
    interactive = true,
    rowAttr = 'data-flap-row',
    colAttr = 'data-flap-col',
    messageCell = null,
  } = {}) {
    if (!host) {
      return;
    }
    const grid = Array.isArray(rows) && rows.length ? rows : blankRows();
    const lockAt = Number.isFinite(Number(lockFrom)) ? Number(lockFrom) : ROWS;
    const parts = [];
    for (let rowIndex = 0; rowIndex < ROWS; rowIndex += 1) {
      const row = grid[rowIndex] || [];
      for (let col = 0; col < COLS; col += 1) {
        const code = Number(row[col] ?? 0);
        const chip = FLAP_CHIP_BY_CODE.get(code);
        const isSlot = messageCell != null && code === messageCell;
        const locked = rowIndex >= lockAt;
        const isCaret = !locked && caret && caret.row === rowIndex && caret.col === col;
        const classes = [
          'vb-tile',
          chip ? 'is-chip' : '',
          slots && isSlot ? 'is-slot' : '',
          locked ? 'is-locked' : '',
          isCaret ? 'is-caret' : '',
        ].filter(Boolean).join(' ');
        const glyph = chip || isSlot ? '' : (FLAP_CHARS[code] || ' ');
        const chipAttr = chip ? ` data-chip="${code}"` : '';
        const posAttr = interactive
          ? ` ${rowAttr}="${rowIndex}" ${colAttr}="${col}"`
          : '';
        parts.push(
          `<div class="${classes}"${chipAttr}${posAttr}>`
          + `<div class="vb-flap"><span class="vb-glyph">${escapeHtml(glyph === ' ' ? '' : glyph)}</span></div>`
          + `</div>`,
        );
      }
    }
    host.innerHTML = parts.join('');
  }

  /** Build codes from six text lines; `decorate(row, col, ch)` may return a chip/letter code. */
  function paintPreviewLines(host, lines, decorate) {
    if (!host) {
      return;
    }
    const rows = [];
    for (let row = 0; row < ROWS; row += 1) {
      const line = String(lines?.[row] || '').padEnd(COLS, ' ').slice(0, COLS);
      const codes = [];
      for (let col = 0; col < COLS; col += 1) {
        const ch = line[col];
        const over = typeof decorate === 'function' ? decorate(row, col, ch) : null;
        codes.push(over != null ? over : charCode(ch));
      }
      rows.push(codes);
    }
    renderFlapGrid(host, rows, { interactive: false });
  }

  root.renderFlapGrid = renderFlapGrid;
  root.paintPreviewLines = paintPreviewLines;
  root.FLAP_GRID = {
    FLAP_CHARS,
    FLAP_CHIPS,
    FLAP_CHIP_BY_CODE,
    FLAP_CODE_BY_CHAR,
    ROWS,
    COLS,
    blankRows,
    chipCode,
    charCode,
  };
})(typeof window !== 'undefined' ? window : globalThis);
