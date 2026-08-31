/**
 * US State Facts — how a state becomes board rows.
 *
 * Marketplace "State Capitals, Birds & Flowers" (6×22):
 *   [chip] NAME [chip]   centred
 *   [blank when the facts leave a row]
 *   CAPITAL:  {city}
 *   BIRD:     {bird…}
 *             {wrap aligns under the value}
 *   FLOWER:   {flower…}
 *
 * The physical bezel already says VESTABOARD — do not spend a flap row on it.
 */

const { blankRow, COLS, fold, wrap, placeText, encodeText } = require('./vestaboard/encoder');
const { chipCode } = require('./vestaboard/frames');

const BODY_ROWS = 6;
const FACTS = Object.freeze([
  { key: 'capital', label: 'CAPITAL' },
  { key: 'bird', label: 'BIRD' },
  { key: 'flower', label: 'FLOWER' },
]);
const VALUE_COL = Math.max(...FACTS.map((fact) => fact.label.length + 1)) + 2;
const VALUE_WIDTH = COLS - VALUE_COL;
const CHIP_COLORS = Object.freeze(['red', 'orange', 'yellow', 'green', 'blue', 'violet']);

function cleanChip(color) {
  const key = String(color || '').trim().toLowerCase();
  return CHIP_COLORS.includes(key) ? key : 'blue';
}

function titleInnerWidth(name) {
  const folded = fold(name);
  if (!folded) {
    return 0;
  }
  return folded.length + 4;
}

function titleRow(name, color) {
  const folded = fold(name);
  const row = blankRow(COLS);
  if (!folded) {
    return row;
  }
  const codes = encodeText(folded);
  const inner = 2 + codes.length + 2;
  const start = Math.max(0, Math.floor((COLS - inner) / 2));
  const chip = chipCode(cleanChip(color));
  row[start] = chip;
  for (let i = 0; i < codes.length; i += 1) {
    row[start + 2 + i] = codes[i];
  }
  row[start + inner - 1] = chip;
  return row;
}

function factBlocks(state = {}) {
  const blocks = [];
  for (const fact of FACTS) {
    const value = fold(state[fact.key] || '');
    if (!value) {
      return [];
    }
    const lines = wrap(value, VALUE_WIDTH, { orphans: false });
    if (!lines.length) {
      return [];
    }
    blocks.push({
      label: `${fact.label}:`,
      lines,
    });
  }
  return blocks;
}

function factRows(state = {}) {
  const blocks = factBlocks(state);
  if (!blocks.length) {
    return [];
  }
  const rows = [];
  for (const block of blocks) {
    block.lines.forEach((line, index) => {
      const row = blankRow(COLS);
      if (index === 0) {
        placeText(row, block.label, 0);
      }
      placeText(row, line, VALUE_COL);
      rows.push(row);
    });
  }
  return rows;
}

function stateRows(state = {}) {
  const name = fold(state.name || '');
  if (!name || titleInnerWidth(name) > COLS) {
    return [];
  }
  const facts = factRows(state);
  if (!facts.length || facts.length > BODY_ROWS - 1) {
    return [];
  }
  const rows = [titleRow(name, state.color)];
  if (rows.length + facts.length < BODY_ROWS) {
    rows.push(blankRow(COLS));
  }
  rows.push(...facts);
  while (rows.length < BODY_ROWS) {
    rows.push(blankRow(COLS));
  }
  return rows.length === BODY_ROWS ? rows.slice(0, BODY_ROWS) : [];
}

function fitsBoard(state = {}) {
  return stateRows(state).length === BODY_ROWS;
}

module.exports = {
  BODY_ROWS,
  COLS,
  FACTS,
  VALUE_COL,
  VALUE_WIDTH,
  CHIP_COLORS,
  cleanChip,
  titleRow,
  factBlocks,
  factRows,
  stateRows,
  fitsBoard,
};
