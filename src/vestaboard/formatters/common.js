// Shared frame envelope helpers for the Vestaboard formatter families.
//
// Each family file stays about its layouts; this file is only the bits that
// would otherwise be copied four times: how a frame is labelled, how a list
// becomes pages, and which titles are provider placeholders rather than games.

const { fold } = require('../encoder');
const { MAX_BODY_ROWS, ALERT_DWELL_SECONDS, dwellFor } = require('../frames');

function snapshotFrame(rows, label, source, { base = 15 } = {}) {
  return {
    rows,
    dwellSeconds: dwellFor(rows, { base }),
    label,
    source,
    priority: 'snapshot',
  };
}

function alertFrame(rows, label, source, { more = false, dwellSeconds = ALERT_DWELL_SECONDS } = {}) {
  return {
    rows,
    dwellSeconds,
    label,
    source,
    priority: 'alert',
    more,
  };
}

function paginate(list, perPage) {
  const pages = [];
  for (let index = 0; index < list.length; index += perPage) {
    pages.push(list.slice(index, index + perPage));
  }
  return pages.length ? pages : [[]];
}

function padRows(rows) {
  const padded = rows.slice(0, MAX_BODY_ROWS);
  while (padded.length < MAX_BODY_ROWS) {
    padded.push('');
  }
  return padded;
}

/**
 * Titles that mean "we do not actually know the name".
 *
 * Steam invents `App 123`; PSN falls back to `PlayStation Game`; Roll Credits
 * uses `Unknown game`. None of those are worth a flip.
 */
function isPlaceholderTitle(name) {
  const folded = fold(name);
  return !folded
    || folded === 'PLAYSTATION GAME'
    || folded === 'UNKNOWN GAME'
    || /^APP \d+$/.test(folded);
}

module.exports = {
  snapshotFrame,
  alertFrame,
  paginate,
  padRows,
  isPlaceholderTitle,
};
