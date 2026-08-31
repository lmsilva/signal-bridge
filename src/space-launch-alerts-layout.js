/**
 * Space Launch Alerts — marketplace layout.
 *
 * Row 1: two coloured chips on each end + centred `SPACE LAUNCH`
 * Rows 2–6: up to five body lines, flush left and top-aligned
 */

const { fold, wrap, blankRow, placeText, COLS } = require('./vestaboard/encoder');
const { chipCode, centered } = require('./vestaboard/frames');

const TITLE = 'SPACE LAUNCH';
const BODY_ROWS = 5;
const BODY_START = 1;
const BOARD_ROWS = 6;
const DEFAULT_CHIP = 'blue';

function cleanChip(value) {
  const chip = String(value || DEFAULT_CHIP).trim().toLowerCase();
  const allowed = new Set(['blue', 'green', 'white', 'yellow', 'orange', 'red', 'violet']);
  return allowed.has(chip) ? chip : DEFAULT_CHIP;
}

function alertChipRow(text, chip = DEFAULT_CHIP) {
  const colour = cleanChip(chip);
  const row = blankRow(COLS);
  row[0] = chipCode(colour);
  row[1] = chipCode(colour);
  row[COLS - 2] = chipCode(colour);
  row[COLS - 1] = chipCode(colour);
  if (text) {
    centered(fold(text), { from: 2, width: 18, row });
  }
  return row;
}

function alertLines(text) {
  const folded = fold(String(text || '').replace(/\s+/g, ' ').trim());
  if (!folded) {
    return null;
  }
  const lines = wrap(folded, COLS, { orphans: false });
  if (!lines.length || lines.length > BODY_ROWS) {
    return null;
  }
  return lines;
}

function alertRows(text, { chip = DEFAULT_CHIP } = {}) {
  const lines = alertLines(text);
  if (!lines) {
    return [];
  }
  const rows = [alertChipRow(TITLE, chip)];
  for (let index = 0; index < BODY_ROWS; index += 1) {
    const row = blankRow(COLS);
    const line = lines[index];
    if (line) {
      placeText(row, line, 0);
    }
    rows.push(row);
  }
  return rows.length === BOARD_ROWS ? rows : [];
}

function fitsBoard(text) {
  return alertRows(text).length === BOARD_ROWS;
}

module.exports = {
  TITLE,
  BODY_ROWS,
  BODY_START,
  BOARD_ROWS,
  COLS,
  DEFAULT_CHIP,
  cleanChip,
  alertChipRow,
  alertLines,
  alertRows,
  fitsBoard,
};
