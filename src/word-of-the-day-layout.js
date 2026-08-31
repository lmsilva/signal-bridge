/**
 * Word of the Day — how a vocabulary entry becomes board rows.
 *
 * Marketplace layout (6 rows):
 *   [YY] WORD OF THE DAY [YY]
 *   {WORD}, {POS}.
 *   [blank]
 *   {definition — two columns of air, up to three lines}
 *
 * Kept apart from `word-of-the-day.js` so the build tool can measure
 * candidates without loading the corpus it writes.
 */

const { fold, wrap, blankRow, placeText, COLS } = require('./vestaboard/encoder');
const { centered, chipCode } = require('./vestaboard/frames');

const BODY_ROWS = 6;
const TITLE = 'WORD OF THE DAY';
const INDENT = 2;
const TEXT_WIDTH = COLS - INDENT;
const DEF_ROWS = 3;

const POS_LABELS = Object.freeze({
  noun: 'N.',
  verb: 'V.',
  adj: 'ADJ.',
  adjective: 'ADJ.',
  adverb: 'ADV.',
  prep: 'PREP.',
  preposition: 'PREP.',
  conj: 'CONJ.',
  conjunction: 'CONJ.',
  pronoun: 'PRON.',
  interjection: 'INTERJ.',
  phrase: 'PHR.',
  other: 'OTHER',
});

function cleanText(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[\u2018\u2019\u2032]/g, "'")
    .replace(/[\u201c\u201d\u2033]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function posLabel(pos) {
  const key = String(pos || '').trim().toLowerCase();
  return POS_LABELS[key] || POS_LABELS.other;
}

function withPeriod(text) {
  const next = cleanText(text);
  if (!next) {
    return '';
  }
  return /[.!?]$/.test(next) ? next : `${next}.`;
}

function wordHeadline(word, pos) {
  const label = posLabel(pos);
  const folded = fold(word);
  if (!folded) {
    return '';
  }
  let headline = `${folded}, ${label}`;
  if (headline.length <= COLS) {
    return headline;
  }
  const suffix = `, ${label}`;
  const room = COLS - suffix.length;
  if (room <= 0) {
    return headline.slice(0, COLS);
  }
  return `${folded.slice(0, room)}${suffix}`;
}

function definitionLines(definition) {
  const text = withPeriod(definition);
  if (!text) {
    return [];
  }
  return wrap(fold(text), TEXT_WIDTH);
}

function wordLines(word, pos, definition) {
  const headline = wordHeadline(word, pos);
  const definitionRows = definitionLines(definition);
  if (!headline || !definitionRows.length || definitionRows.length > DEF_ROWS) {
    return null;
  }
  return {
    headline,
    definition: definitionRows,
    preview: (() => {
      const lines = [TITLE, headline, '', ...definitionRows];
      while (lines.length < BODY_ROWS) {
        lines.push('');
      }
      return lines.slice(0, BODY_ROWS);
    })(),
  };
}

function wordOfTheDayChipRow(text = TITLE) {
  const row = blankRow(COLS);
  row[0] = chipCode('yellow');
  row[1] = chipCode('yellow');
  row[COLS - 2] = chipCode('yellow');
  row[COLS - 1] = chipCode('yellow');
  if (text) {
    centered(fold(text), { from: 2, width: 18, row });
  }
  return row;
}

function wordRows(word, pos, definition) {
  const parsed = wordLines(word, pos, definition);
  if (!parsed) {
    return [];
  }
  const rows = [wordOfTheDayChipRow(TITLE)];
  const headlineRow = blankRow(COLS);
  centered(parsed.headline, { from: 0, width: COLS, row: headlineRow });
  rows.push(headlineRow);
  rows.push(blankRow(COLS));

  const defLines = parsed.definition.slice(0, DEF_ROWS);
  const top = Math.floor((DEF_ROWS - defLines.length) / 2);
  for (let slot = 0; slot < DEF_ROWS; slot += 1) {
    const row = blankRow(COLS);
    const line = defLines[slot - top];
    if (line) {
      placeText(row, line, INDENT);
    }
    rows.push(row);
  }
  return rows.length === BODY_ROWS ? rows : [];
}

function fitsBoard(word, pos, definition) {
  return wordRows(word, pos, definition).length === BODY_ROWS;
}

module.exports = {
  BODY_ROWS,
  COLS,
  TITLE,
  INDENT,
  TEXT_WIDTH,
  DEF_ROWS,
  POS_LABELS,
  cleanText,
  posLabel,
  withPeriod,
  wordHeadline,
  definitionLines,
  wordLines,
  wordOfTheDayChipRow,
  wordRows,
  fitsBoard,
};
