/**
 * Daily Bucket Fillers — how a kindness challenge becomes board rows.
 *
 * Marketplace layout (6 rows, no title row):
 *   - Short one- or two-liners are centred on the full 22 columns
 *     (the "Donate toys you no longer use." card).
 *   - Longer challenges wrap with two columns of air on the left
 *     (the playlist and library-note cards).
 *   - A slightly tighter wrap (18) is preferred so longer text uses
 *     more of the six rows instead of packing a 22-wide flush block.
 *
 * The whole block is vertically centred across all six rows.
 */

const { fold, wrap, blankRow, placeText, COLS } = require('./vestaboard/encoder');
const { centered } = require('./vestaboard/frames');

const BODY_ROWS = 6;
const INDENT = 2;
const INDENT_WIDTH = COLS - INDENT;
const TIGHT_WIDTH = 18;
const CENTERED_MAX_LINES = 2;
const CENTERED_MAX_CHARS = 20;

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function fillerLines(text) {
  const folded = fold(cleanText(text));
  if (!folded) {
    return null;
  }
  const full = wrap(folded, COLS, { orphans: true });
  if (!full.length || full.length > BODY_ROWS) {
    return null;
  }
  if (full.length <= CENTERED_MAX_LINES && full.every((line) => line.length <= CENTERED_MAX_CHARS)) {
    return { lines: full, mode: 'centered' };
  }
  const tight = wrap(folded, TIGHT_WIDTH, { orphans: true });
  if (tight.length && tight.length <= BODY_ROWS
    && tight.every((line) => line.length <= TIGHT_WIDTH)) {
    return { lines: tight, mode: 'indent' };
  }
  const indented = wrap(folded, INDENT_WIDTH, { orphans: true });
  if (indented.length && indented.length <= BODY_ROWS
    && indented.every((line) => line.length <= INDENT_WIDTH)) {
    return { lines: indented, mode: 'indent' };
  }
  return { lines: full, mode: 'flush' };
}

function fillerRows(text) {
  const parsed = fillerLines(text);
  if (!parsed) {
    return [];
  }
  const { lines, mode } = parsed;
  const top = Math.floor((BODY_ROWS - lines.length) / 2);
  const rows = [];
  for (let rowIndex = 0; rowIndex < BODY_ROWS; rowIndex += 1) {
    const row = blankRow(COLS);
    const line = lines[rowIndex - top];
    if (line) {
      if (mode === 'centered') {
        centered(line, { from: 0, width: COLS, row });
      } else {
        placeText(row, line, mode === 'indent' ? INDENT : 0);
      }
    }
    rows.push(row);
  }
  return rows;
}

function fitsBoard(text) {
  return fillerRows(text).length === BODY_ROWS;
}

function layoutMode(lines, { flush = false } = {}) {
  if (!lines.length) {
    return 'none';
  }
  if (flush) {
    return 'flush';
  }
  if (lines.length <= CENTERED_MAX_LINES && lines.every((line) => line.length <= CENTERED_MAX_CHARS)) {
    return 'centered';
  }
  if (lines.every((line) => line.length <= INDENT_WIDTH)) {
    return 'indent';
  }
  return 'flush';
}

module.exports = {
  BODY_ROWS,
  COLS,
  INDENT,
  INDENT_WIDTH,
  TIGHT_WIDTH,
  CENTERED_MAX_LINES,
  CENTERED_MAX_CHARS,
  cleanText,
  layoutMode,
  fillerLines,
  fillerRows,
  fitsBoard,
};
