/**
 * Warm Fuzzies — how a compliment becomes board rows.
 *
 * Marketplace layout (6 rows, no title row):
 *   - Short one- or two-liners are centred on the full 22 columns.
 *   - Longer messages that need the full width wrap flush left at 22.
 *   - When every line fits in 20 columns, the block gets two columns
 *     of air on the left (matching the "Who raised you?" card).
 *
 * The whole block is vertically centred across all six rows.
 */

const { fold, wrap, blankRow, placeText, COLS } = require('./vestaboard/encoder');
const { centered } = require('./vestaboard/frames');

const BODY_ROWS = 6;
const INDENT = 2;
const INDENT_WIDTH = COLS - INDENT;
const CENTERED_MAX_LINES = 2;
const CENTERED_MAX_CHARS = 20;
const FLUSH_LINE = COLS;

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function splitSentences(folded) {
  const parts = [];
  let rest = cleanText(folded);
  while (rest) {
    const match = rest.match(/([.!?])\s+/);
    if (!match || match.index == null) {
      parts.push(rest);
      break;
    }
    const end = match.index + match[1].length;
    parts.push(rest.slice(0, end).trim());
    rest = rest.slice(end).trim();
  }
  return parts.filter(Boolean);
}

function wrapSentences(folded, width, options = {}) {
  const lines = [];
  for (const sentence of splitSentences(folded)) {
    lines.push(...wrap(sentence, width, options));
  }
  return lines;
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

function fuzzyLines(text) {
  const folded = fold(cleanText(text));
  if (!folded) {
    return null;
  }
  const full = wrap(folded, COLS, { orphans: false });
  if (!full.length || full.length > BODY_ROWS) {
    return null;
  }
  if (full.length <= CENTERED_MAX_LINES && full.every((line) => line.length <= CENTERED_MAX_CHARS)) {
    return { lines: full, mode: 'centered' };
  }
  const useFlush = full.some((line) => line.length >= FLUSH_LINE);
  if (!useFlush) {
    const indented = wrapSentences(folded, INDENT_WIDTH);
    if (indented.length && indented.length <= BODY_ROWS
      && indented.every((line) => line.length <= INDENT_WIDTH)) {
      return { lines: indented, mode: 'indent' };
    }
  }
  return { lines: full, mode: 'flush' };
}

function fuzzyRows(text) {
  const parsed = fuzzyLines(text);
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
  return fuzzyRows(text).length === BODY_ROWS;
}

module.exports = {
  BODY_ROWS,
  COLS,
  INDENT,
  INDENT_WIDTH,
  FLUSH_LINE,
  cleanText,
  layoutMode,
  fuzzyLines,
  fuzzyRows,
  fitsBoard,
};
