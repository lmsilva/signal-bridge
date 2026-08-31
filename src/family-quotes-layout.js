/**
 * Family Quotes — how a quote becomes board rows.
 *
 * Kept apart from `family-quotes.js` so `tools/build-family-quotes.js` can
 * measure candidates with the real layout without loading the corpus it is
 * about to write.
 *
 * The marketplace channel shapes a quote three ways at once, and all three
 * matter: sentences start on their own row, the wrap stops one column shy of
 * the right edge, and the attribution rides on the tail of the last sentence
 * rather than being pinned to a line of its own.
 */

const { fold, wrap } = require('./vestaboard/encoder');

const BODY_ROWS = 6;
// One column of air on the right. The difference is visible: at 22 the Buffett
// card breaks after "THAT THERE" instead of after "THAT".
const BODY_WIDTH = 21;

// A period that closes a title or an initial does not close a sentence, so
// "George A. Moore" and "Dr. Seuss" stay in one piece.
const NOT_A_SENTENCE_END = /(?:\b(?:mr|mrs|ms|dr|st|jr|sr|prof|rev|gen|capt|lt|col|vs|etc)|\b[A-Za-z])\.$/i;

function sentences(text) {
  const out = [];
  let buffer = '';
  for (const piece of String(text || '').split(/(?<=[.!?])\s+/)) {
    buffer = buffer ? `${buffer} ${piece}` : piece;
    if (!NOT_A_SENTENCE_END.test(buffer)) {
      out.push(buffer);
      buffer = '';
    }
  }
  if (buffer) {
    out.push(buffer);
  }
  return out.filter(Boolean);
}

function quoteLines(text, author) {
  const parts = sentences(String(text || '').replace(/\s+/g, ' ').trim());
  if (!parts.length) {
    return [];
  }
  const credit = String(author || '').replace(/\s+/g, ' ').trim();
  if (credit) {
    parts[parts.length - 1] = `${parts[parts.length - 1]} -${credit}`;
  }
  return parts.flatMap((part) => wrap(fold(part), BODY_WIDTH, { orphans: false }));
}

module.exports = {
  BODY_ROWS,
  BODY_WIDTH,
  sentences,
  quoteLines,
};
