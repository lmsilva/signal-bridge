/**
 * Misheard Lyrics — how a mondegreen becomes board rows.
 *
 * Kept apart from `misheard-lyrics.js` so `tools/build-misheard-lyrics.js`
 * can measure candidates with the real layout without loading the corpus
 * it is about to write.
 *
 * The marketplace card is left-aligned with two columns of air, vertically
 * centred, lyric first (period on the last lyric line) and the artist on
 * its own line as `- NAME`. A long name wraps; the hyphen stays on the
 * first credit line only.
 */

const { fold, wrap, blankRow, placeText } = require('./vestaboard/encoder');

const BODY_ROWS = 6;
const COLS = 22;
/** Two empty flaps on the left, matching the marketplace drawings. */
const INDENT = 2;
const TEXT_WIDTH = COLS - INDENT;

function cleanLine(value) {
  return String(value || '')
    .replace(/[\u2018\u2019\u2032]/g, "'")
    .replace(/[\u201c\u201d\u2033]/g, '"')
    .replace(/\s*[\u2012-\u2015]\s*/g, ' - ')
    .replace(/[\u2010\u2011]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\s+/g, ' ')
    .replace(/^["']+|["']+$/g, '')
    .trim();
}

/** A lyric without a stop looks unfinished on the board. */
function withStop(text) {
  const next = cleanLine(text);
  if (!next) {
    return '';
  }
  return /[.!?]$/.test(next) ? next : `${next}.`;
}

/**
 * Wrapped lyric lines, then wrapped credit lines. No indent here — the
 * formatter and the admin preview both place the block at column 2.
 */
function lyricLines(text, artist) {
  const lyric = withStop(text);
  if (!lyric) {
    return [];
  }
  const body = wrap(fold(lyric), TEXT_WIDTH);
  const credit = cleanLine(artist);
  if (credit) {
    body.push(...wrap(fold(`- ${credit}`), TEXT_WIDTH));
  }
  return body;
}

function lyricRows(text, artist) {
  const lines = lyricLines(text, artist);
  if (!lines.length || lines.length > BODY_ROWS) {
    return [];
  }
  const chunk = lines.slice(0, BODY_ROWS);
  const top = Math.floor((BODY_ROWS - chunk.length) / 2);
  const rows = [];
  for (let rowIndex = 0; rowIndex < BODY_ROWS; rowIndex += 1) {
    const row = blankRow(COLS);
    const line = chunk[rowIndex - top];
    if (line) {
      placeText(row, line, INDENT);
    }
    rows.push(row);
  }
  return rows;
}

module.exports = {
  BODY_ROWS,
  COLS,
  INDENT,
  TEXT_WIDTH,
  cleanLine,
  withStop,
  lyricLines,
  lyricRows,
};
