/**
 * Shared 6×22 flap painter — drag to paint chips, type to lay in letters.
 *
 * Wraps `renderFlapGrid` with the editing behaviour the Date Book designer
 * proved out: pointer capture plus a coordinate lookup so a drag keeps painting
 * after the browser stops firing enter/leave, an undo stack, and a caret that
 * lets you type a word straight onto the board.
 *
 * Used by the Vestaboard Artwork editor on both the household and admin sites.
 */
(function (root) {
  const GRID = root.FLAP_GRID;

  const UNDO_DEPTH = 40;

  function cloneCells(cells) {
    return cells.map((row) => [...row]);
  }

  /**
   * @param {HTMLElement} host a `.vb-grid` inside a `.vb-bezel`
   * @param {{ onChange?: function, onToolChange?: function }} options
   */
  function createFlapPainter(host, { onChange = null, onToolChange = null } = {}) {
    if (!host || !GRID || typeof root.renderFlapGrid !== 'function') {
      return null;
    }
    const { ROWS, COLS, FLAP_CHIPS, FLAP_CODE_BY_CHAR } = GRID;

    let cells = GRID.blankRows();
    let baseline = cloneCells(cells);
    let tool = { kind: 'chip', chip: 'red' };
    let caret = null;
    let undo = [];
    let painting = false;
    let destroyed = false;

    // The grid takes arrow keys and typing, so it has to be focusable.
    if (!host.hasAttribute('tabindex')) {
      host.setAttribute('tabindex', '0');
    }

    function render() {
      root.renderFlapGrid(host, cells, {
        interactive: true,
        caret,
        rowAttr: 'data-fp-row',
        colAttr: 'data-fp-col',
      });
    }

    function changed() {
      render();
      if (typeof onChange === 'function') {
        onChange();
      }
    }

    function pushUndo() {
      undo.push(cloneCells(cells));
      if (undo.length > UNDO_DEPTH) {
        undo.shift();
      }
    }

    function codeForTool() {
      if (tool.kind === 'erase') {
        return 0;
      }
      if (tool.kind === 'char') {
        return FLAP_CODE_BY_CHAR.get(String(tool.char || '').toUpperCase()) ?? 0;
      }
      return 63 + Math.max(0, FLAP_CHIPS.indexOf(tool.chip));
    }

    function advanceCaret(row, col) {
      let nextRow = row;
      let nextCol = col + 1;
      if (nextCol >= COLS) {
        nextCol = 0;
        nextRow = Math.min(ROWS - 1, row + 1);
      }
      caret = { row: nextRow, col: nextCol };
    }

    function paint(row, col, { moveCaret = true, advance = false } = {}) {
      if (!cells[row] || col < 0 || col >= COLS) {
        return;
      }
      cells[row][col] = codeForTool();
      if (advance) {
        advanceCaret(row, col);
      } else if (moveCaret) {
        caret = { row, col };
      }
      changed();
    }

    function cellFromPoint(x, y) {
      const cell = document.elementFromPoint(x, y)?.closest?.('[data-fp-row]');
      if (!cell) {
        return null;
      }
      return { row: Number(cell.dataset.fpRow), col: Number(cell.dataset.fpCol) };
    }

    function onPointerDown(event) {
      const cell = event.target.closest?.('[data-fp-row]');
      if (!cell) {
        return;
      }
      event.preventDefault();
      host.focus();
      const row = Number(cell.dataset.fpRow);
      const col = Number(cell.dataset.fpCol);
      // A letter is placed one at a time and walks the caret on; chips and the
      // eraser are dragged across the board.
      if (tool.kind === 'char') {
        painting = false;
        pushUndo();
        paint(row, col, { advance: true });
        return;
      }
      painting = true;
      pushUndo();
      host.setPointerCapture?.(event.pointerId);
      paint(row, col);
    }

    function onPointerMove(event) {
      if (!painting) {
        return;
      }
      const at = cellFromPoint(event.clientX, event.clientY);
      if (at) {
        paint(at.row, at.col, { moveCaret: false });
      }
    }

    function stopPainting() {
      painting = false;
    }

    function onKeyDown(event) {
      if (!caret) {
        return;
      }
      const { row, col } = caret;
      const move = (nextRow, nextCol) => {
        caret = {
          row: Math.min(ROWS - 1, Math.max(0, nextRow)),
          col: Math.min(COLS - 1, Math.max(0, nextCol)),
        };
        render();
      };
      if (event.key === 'ArrowLeft') { event.preventDefault(); move(row, col - 1); return; }
      if (event.key === 'ArrowRight') { event.preventDefault(); move(row, col + 1); return; }
      if (event.key === 'ArrowUp') { event.preventDefault(); move(row - 1, col); return; }
      if (event.key === 'ArrowDown') { event.preventDefault(); move(row + 1, col); return; }
      if (event.key === 'Backspace') {
        event.preventDefault();
        pushUndo();
        const back = col > 0 ? col - 1 : 0;
        cells[row][back] = 0;
        caret = { row, col: back };
        changed();
        return;
      }
      if (event.key.length === 1) {
        const code = FLAP_CODE_BY_CHAR.get(event.key.toUpperCase());
        if (code === undefined) {
          return;
        }
        event.preventDefault();
        pushUndo();
        cells[row][col] = code;
        advanceCaret(row, col);
        changed();
      }
    }

    host.addEventListener('pointerdown', onPointerDown);
    host.addEventListener('pointermove', onPointerMove);
    host.addEventListener('pointerup', stopPainting);
    host.addEventListener('pointercancel', stopPainting);
    host.addEventListener('keydown', onKeyDown);

    render();

    return {
      getCells: () => cloneCells(cells),
      setCells(next, { resetUndo = true } = {}) {
        cells = Array.isArray(next) && next.length === ROWS
          ? next.map((row) => (Array.isArray(row) ? [...row] : new Array(COLS).fill(0)))
          : GRID.blankRows();
        if (resetUndo) {
          undo = [];
          baseline = cloneCells(cells);
        }
        caret = null;
        changed();
      },
      getTool: () => ({ ...tool }),
      setTool(next = {}) {
        tool = { kind: next.kind || 'chip', chip: next.chip || 'red', char: next.char };
        if (typeof onToolChange === 'function') {
          onToolChange({ ...tool });
        }
      },
      /** Lay text in from the caret, wrapping at the edge. */
      writeText(text) {
        if (!caret) {
          caret = { row: 0, col: 0 };
        }
        pushUndo();
        let { row, col } = caret;
        for (const raw of String(text || '')) {
          const code = FLAP_CODE_BY_CHAR.get(raw.toUpperCase());
          if (code === undefined) {
            continue;
          }
          cells[row][col] = code;
          col += 1;
          if (col >= COLS) {
            col = 0;
            row = Math.min(ROWS - 1, row + 1);
          }
        }
        caret = { row, col };
        changed();
      },
      canUndo: () => undo.length > 0,
      undo() {
        if (!undo.length) {
          return;
        }
        cells = undo.pop();
        caret = null;
        changed();
      },
      clear() {
        pushUndo();
        cells = GRID.blankRows();
        caret = null;
        changed();
      },
      revert() {
        pushUndo();
        cells = cloneCells(baseline);
        caret = null;
        changed();
      },
      isDirty: () => JSON.stringify(cells) !== JSON.stringify(baseline),
      isBlank: () => cells.every((row) => row.every((code) => code === 0)),
      render,
      destroy() {
        if (destroyed) {
          return;
        }
        destroyed = true;
        host.removeEventListener('pointerdown', onPointerDown);
        host.removeEventListener('pointermove', onPointerMove);
        host.removeEventListener('pointerup', stopPainting);
        host.removeEventListener('pointercancel', stopPainting);
        host.removeEventListener('keydown', onKeyDown);
      },
    };
  }

  root.createFlapPainter = createFlapPainter;
})(typeof window !== 'undefined' ? window : globalThis);
