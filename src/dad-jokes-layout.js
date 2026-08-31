/**
 * Dad Jokes — how a joke becomes board rows.
 *
 * Kept apart from `dad-jokes.js` so `tools/build-dad-jokes.js` can measure
 * candidates with the real layout without loading the corpus it is about to
 * write.
 *
 * The marketplace channel gives the setup the top of the board, leaves a row
 * of air, and lands the punchline underneath. The pause is the joke, so the
 * blank row is structural rather than decoration.
 */

const { fold, wrap } = require('./vestaboard/encoder');

const BODY_ROWS = 6;
// One column of air on the right, and a greedy fill. Both are visible on the
// rainbow card: at 22 the punchline packs onto "IT'S PRETTY", and with the
// orphan rule the setup breaks after "HOW MUCH DOES".
const BODY_WIDTH = 21;

function jokeLines(setup, punchline) {
  const top = wrap(fold(String(setup || '').replace(/\s+/g, ' ').trim()), BODY_WIDTH, { orphans: false });
  const bottom = wrap(fold(String(punchline || '').replace(/\s+/g, ' ').trim()), BODY_WIDTH, { orphans: false });
  if (!top.length) {
    return bottom;
  }
  if (!bottom.length) {
    return top;
  }
  return [...top, '', ...bottom];
}

module.exports = {
  BODY_ROWS,
  BODY_WIDTH,
  jokeLines,
};
