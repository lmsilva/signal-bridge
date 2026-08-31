/**
 * Periodic Table — how an element becomes board rows.
 *
 * Marketplace layout (6 rows, all centred on 22 columns):
 *   PERIODIC TABLE
 *   [blank]
 *   {n} - {NAME} ({SYMBOL})
 *   [blank]
 *   {CATEGORY}
 *   {WEIGHT}
 *
 * Kept apart from `periodic-table.js` so the build tool can measure
 * candidates without loading the corpus it writes.
 */

const { blankRow, COLS, fold, truncate } = require('./vestaboard/encoder');
const { centered } = require('./vestaboard/frames');

const BODY_ROWS = 6;
const TITLE = 'PERIODIC TABLE';

const CATEGORY_LABELS = Object.freeze({
  'alkali-metal': 'ALKALI METAL',
  'alkaline-earth-metal': 'ALKALINE EARTH METAL',
  'transition-metal': 'TRANSITION METAL',
  'post-transition-metal': 'POST-TRANSITION METAL',
  metalloid: 'METALLOID',
  nonmetal: 'NONMETAL',
  halogen: 'HALOGEN',
  'noble-gas': 'NOBLE GAS',
  lanthanide: 'LANTHANIDE',
  actinide: 'ACTINIDE',
  unknown: 'UNKNOWN',
});

function categoryLabel(category) {
  return CATEGORY_LABELS[String(category || '').trim()] || 'UNKNOWN';
}

function formatWeight(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return '';
  }
  if (Number.isInteger(number)) {
    return String(number);
  }
  const text = number.toFixed(3);
  return text.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

function elementHeadline(element = {}) {
  const number = Number(element.number);
  const name = fold(String(element.name || ''));
  const symbol = fold(String(element.symbol || ''));
  if (!Number.isFinite(number) || !name || !symbol) {
    return '';
  }
  const prefix = `${number} - `;
  const credit = ` (${symbol})`;
  let headline = `${prefix}${name}${credit}`;
  if (headline.length <= COLS) {
    return headline;
  }
  headline = `${prefix}${name}`;
  if (headline.length <= COLS) {
    return headline;
  }
  const room = COLS - prefix.length;
  if (room <= 0) {
    return truncate(String(number), COLS);
  }
  return `${prefix}${truncate(name, room)}`;
}

function elementLines(element = {}) {
  const headline = elementHeadline(element);
  const category = categoryLabel(element.category);
  const weight = formatWeight(element.weight);
  if (!headline || !category || !weight) {
    return [];
  }
  return [TITLE, '', headline, '', category, weight];
}

function elementRows(element = {}) {
  const lines = elementLines(element);
  if (lines.length !== BODY_ROWS) {
    return [];
  }
  return lines.map((line) => {
    const row = blankRow(COLS);
    if (line) {
      centered(line, { from: 0, width: COLS, row });
    }
    return row;
  });
}

function fitsBoard(element = {}) {
  const lines = elementLines(element);
  if (lines.length !== BODY_ROWS) {
    return false;
  }
  return lines.every((line) => !line || line.length <= COLS);
}

module.exports = {
  BODY_ROWS,
  COLS,
  TITLE,
  CATEGORY_LABELS,
  categoryLabel,
  formatWeight,
  elementHeadline,
  elementLines,
  elementRows,
  fitsBoard,
};
