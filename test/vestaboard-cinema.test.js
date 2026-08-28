const test = require('node:test');
const assert = require('node:assert/strict');

const { validate } = require('../src/vestaboard/encoder');
const { parseLayout, formatLayout } = require('../src/vestaboard/notation');
const {
  cinemaFrame,
  CINEMA_TEXT_WIDTH,
  dwellFor,
} = require('../src/vestaboard/frames');
const {
  cinemaFrames,
  fitCinemaTitle,
  dropTrailingParenthetical,
  compactTimeRange,
  rangeTimeLine,
  endedLine,
} = require('../src/vestaboard/formatters/cinema');

function assertLayout(actual, drawing, label) {
  assert.equal(validate(actual).ok, true, `${label} failed validation`);
  const expected = parseLayout(drawing, { label });
  if (formatLayout(actual) !== formatLayout(expected)) {
    assert.fail(
      `${label} does not match the spec drawing\n\n`
      + `--- expected ---\n${formatLayout(expected)}\n\n`
      + `--- actual ---\n${formatLayout(actual)}\n`,
    );
  }
}

function assertCodes(actual, expected, label) {
  assert.deepEqual(actual, expected, `${label} code array mismatch`);
}

const CINEMA_NOW_PLAYING_CODES = [
  [63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63],
  [63, 0, 0, 0, 0, 14, 15, 23, 0, 16, 12, 1, 25, 9, 14, 7, 0, 0, 0, 0, 0, 63],
  [63, 0, 0, 0, 0, 9, 14, 20, 5, 18, 19, 20, 5, 12, 12, 1, 18, 0, 0, 0, 0, 63],
  [63, 0, 0, 0, 0, 16, 7, 44, 27, 29, 0, 69, 0, 34, 56, 33, 0, 0, 0, 0, 0, 63],
  [63, 0, 35, 50, 36, 31, 16, 13, 0, 20, 15, 0, 27, 27, 50, 31, 30, 16, 13, 0, 0, 63],
  [63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63],
];

const CINEMA_TWO_LINE_CODES = [
  [63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63],
  [63, 0, 0, 0, 0, 14, 15, 23, 0, 16, 12, 1, 25, 9, 14, 7, 0, 0, 0, 0, 0, 63],
  [63, 0, 0, 0, 0, 0, 20, 8, 5, 0, 7, 18, 1, 14, 4, 0, 0, 0, 0, 0, 0, 63],
  [63, 0, 0, 0, 2, 21, 4, 1, 16, 5, 19, 20, 0, 8, 15, 20, 5, 12, 0, 0, 0, 63],
  [63, 0, 0, 18, 0, 69, 0, 33, 50, 27, 31, 44, 34, 50, 31, 31, 16, 13, 0, 0, 0, 63],
  [63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63],
];

const CINEMA_LAST_PLAYED_CODES = [
  [63, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 63],
  [63, 0, 0, 0, 0, 12, 1, 19, 20, 0, 16, 12, 1, 25, 5, 4, 0, 0, 0, 0, 0, 63],
  [63, 0, 0, 0, 0, 9, 14, 20, 5, 18, 19, 20, 5, 12, 12, 1, 18, 0, 0, 0, 0, 63],
  [63, 0, 0, 0, 0, 16, 7, 44, 27, 29, 0, 69, 0, 34, 56, 33, 0, 0, 0, 0, 0, 63],
  [63, 0, 0, 0, 5, 14, 4, 5, 4, 0, 27, 27, 50, 31, 30, 16, 13, 0, 0, 0, 0, 63],
  [63, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 63],
];

test('a full cinema curtain centres NOW PLAYING with the extra blank on the right', () => {
  const frame = cinemaFrame({
    border: 'full',
    rows: ['NOW PLAYING', 'INTERSTELLAR'],
  });
  assertLayout(frame, [
    'rrrrrrrrrrrrrrrrrrrrrr',
    'r    NOW PLAYING     r',
    'r    INTERSTELLAR    r',
    'r                    r',
    'r                    r',
    'rrrrrrrrrrrrrrrrrrrrrr',
  ].join('\n'), 'full curtain');
});

test('a sides-only cinema curtain drops the top and bottom bars', () => {
  const frame = cinemaFrame({
    border: 'sides',
    rows: ['LAST PLAYED'],
  });
  assertLayout(frame, [
    'r                    r',
    'r    LAST PLAYED     r',
    'r                    r',
    'r                    r',
    'r                    r',
    'r                    r',
  ].join('\n'), 'side rails');
});

test('cinema centering: even leftover splits evenly, odd leftover sits on the right', () => {
  // INTERSTELLAR is 12 of 20 → 4 / 4.
  const even = cinemaFrame({ border: 'sides', rows: ['INTERSTELLAR'] });
  assert.equal(even[1].slice(1, 5).every((code) => code === 0), true);
  assert.equal(even[1].slice(17, 21).every((code) => code === 0), true);

  // NOW PLAYING is 11 of 20 → 4 left / 5 right.
  const odd = cinemaFrame({ border: 'sides', rows: ['NOW PLAYING'] });
  assert.equal(odd[1].slice(1, 5).every((code) => code === 0), true);
  assert.equal(odd[1].slice(16, 21).every((code) => code === 0), true);
});

test('cinemaFrame throws on more than four rows or a row wider than 20', () => {
  assert.throws(
    () => cinemaFrame({ rows: ['A', 'B', 'C', 'D', 'E'] }),
    /at most 4/,
  );
  assert.throws(
    () => cinemaFrame({ rows: ['X'.repeat(CINEMA_TEXT_WIDTH + 1)] }),
    /overflows/,
  );
  assert.throws(
    () => cinemaFrame({ border: 'dotted', rows: [] }),
    /full.*sides/,
  );
});

test('the four golden cinema layouts match the spec drawings and code arrays', () => {
  const nowPlaying = cinemaFrames({
    type: 'plex.now-playing',
    plex: {
      mode: 'now-playing',
      title: 'Interstellar',
      contentRating: 'PG-13',
      criticScore: 8.7,
      startedAt: new Date(2026, 7, 28, 21, 5),
      endsAt: new Date(2026, 7, 28, 23, 54),
    },
  }, { now: new Date(2026, 7, 28, 21, 5) });

  assert.equal(nowPlaying.length, 1);
  assert.equal(nowPlaying[0].priority, 'snapshot');
  assertLayout(nowPlaying[0].rows, [
    'rrrrrrrrrrrrrrrrrrrrrr',
    'r    NOW PLAYING     r',
    'r    INTERSTELLAR    r',
    'r    PG-13 w 8.7     r',
    'r 9:05PM TO 11:54PM  r',
    'rrrrrrrrrrrrrrrrrrrrrr',
  ].join('\n'), 'cinema-now-playing');
  assertCodes(nowPlaying[0].rows, CINEMA_NOW_PLAYING_CODES, 'cinema-now-playing');

  const twoLine = cinemaFrames({
    type: 'plex.now-playing',
    plex: {
      mode: 'now-playing',
      title: 'The Grand Budapest Hotel',
      contentRating: 'R',
      criticScore: 8.1,
      startedAt: new Date(2026, 7, 28, 19, 15),
      endsAt: new Date(2026, 7, 28, 20, 55),
    },
  }, { now: new Date(2026, 7, 28, 19, 15) });

  assertLayout(twoLine[0].rows, [
    'rrrrrrrrrrrrrrrrrrrrrr',
    'r    NOW PLAYING     r',
    'r     THE GRAND      r',
    'r   BUDAPEST HOTEL   r',
    'r  R w 7:15-8:55PM   r',
    'rrrrrrrrrrrrrrrrrrrrrr',
  ].join('\n'), 'cinema-now-playing-two-line');
  assertCodes(twoLine[0].rows, CINEMA_TWO_LINE_CODES, 'cinema-now-playing-two-line');

  const lastPlayed = cinemaFrames({
    type: 'plex.now-playing',
    plex: {
      mode: 'last-played',
      title: 'Interstellar',
      contentRating: 'PG-13',
      criticScore: 8.7,
      endedAt: new Date(2026, 7, 28, 23, 54),
    },
  }, { now: new Date(2026, 7, 28, 23, 54) });

  assertLayout(lastPlayed[0].rows, [
    'r                    r',
    'r    LAST PLAYED     r',
    'r    INTERSTELLAR    r',
    'r    PG-13 w 8.7     r',
    'r   ENDED 11:54PM    r',
    'r                    r',
  ].join('\n'), 'cinema-last-played');
  assertCodes(lastPlayed[0].rows, CINEMA_LAST_PLAYED_CODES, 'cinema-last-played');

  const empty = cinemaFrames({
    type: 'plex.now-playing',
    plex: { mode: 'now-playing' },
  }, { explicit: true });

  assertLayout(empty[0].rows, [
    'r                    r',
    'rFEATURE PRESENTATIONr',
    'r                    r',
    'r  NOTHING SHOWING   r',
    'r                    r',
    'r                    r',
  ].join('\n'), 'cinema-empty');
});

test('an empty cinema frame is only for an explicit push', () => {
  const silent = cinemaFrames({ type: 'plex.now-playing', plex: {} }, { explicit: false });
  assert.deepEqual(silent, []);
  const scheduled = cinemaFrames({ type: 'plex.now-playing', plex: {} }, {});
  assert.deepEqual(scheduled, []);
});

test('title fit: one line, two-line split, parenthetical drop, hyphen split', () => {
  assert.deepEqual(fitCinemaTitle('Interstellar'), { lines: ['INTERSTELLAR'], layout: 'A' });
  assert.deepEqual(fitCinemaTitle('The Grand Budapest Hotel'), {
    lines: ['THE GRAND', 'BUDAPEST HOTEL'],
    layout: 'B',
  });
  assert.equal(
    dropTrailingParenthetical(
      'BIRDS OF PREY (AND THE FANTABULOUS EMANCIPATION OF ONE HARLEY QUINN)',
    ),
    'BIRDS OF PREY',
  );
  assert.deepEqual(
    fitCinemaTitle('Birds of Prey (And the Fantabulous Emancipation of One Harley Quinn)'),
    { lines: ['BIRDS OF PREY'], layout: 'A' },
  );

  const hyphen = fitCinemaTitle('Supercalifragilisticexpialidocious');
  assert.equal(hyphen.layout, 'B');
  assert.equal(hyphen.lines[0].endsWith('-'), true);
  assert.ok(hyphen.lines[0].length <= CINEMA_TEXT_WIDTH);
  assert.ok(hyphen.lines[1].length <= CINEMA_TEXT_WIDTH);
});

test('rating row omits null fields and never prints a blank placeholder', () => {
  const noRating = cinemaFrames({
    type: 'plex.now-playing',
    plex: {
      mode: 'now-playing',
      title: 'Interstellar',
      contentRating: null,
      criticScore: 8.7,
      startedAt: new Date(2026, 7, 28, 21, 5),
      endsAt: new Date(2026, 7, 28, 23, 54),
    },
  });
  assertLayout(noRating[0].rows, [
    'rrrrrrrrrrrrrrrrrrrrrr',
    'r    NOW PLAYING     r',
    'r    INTERSTELLAR    r',
    'r        8.7         r',
    'r 9:05PM TO 11:54PM  r',
    'rrrrrrrrrrrrrrrrrrrrrr',
  ].join('\n'), 'score only');

  const neither = cinemaFrames({
    type: 'plex.now-playing',
    plex: {
      mode: 'now-playing',
      title: 'Interstellar',
      startedAt: new Date(2026, 7, 28, 21, 5),
      endsAt: new Date(2026, 7, 28, 23, 54),
    },
  });
  assertLayout(neither[0].rows, [
    'rrrrrrrrrrrrrrrrrrrrrr',
    'r    NOW PLAYING     r',
    'r    INTERSTELLAR    r',
    'r                    r',
    'r 9:05PM TO 11:54PM  r',
    'rrrrrrrrrrrrrrrrrrrrrr',
  ].join('\n'), 'no rating row');

  const hiddenScore = cinemaFrames({
    type: 'plex.now-playing',
    plex: {
      mode: 'now-playing',
      title: 'Interstellar',
      contentRating: 'PG-13',
      criticScore: 8.7,
      startedAt: new Date(2026, 7, 28, 21, 5),
      endsAt: new Date(2026, 7, 28, 23, 54),
    },
  }, { showCriticScore: false });
  assertLayout(hiddenScore[0].rows, [
    'rrrrrrrrrrrrrrrrrrrrrr',
    'r    NOW PLAYING     r',
    'r    INTERSTELLAR    r',
    'r       PG-13        r',
    'r 9:05PM TO 11:54PM  r',
    'rrrrrrrrrrrrrrrrrrrrrr',
  ].join('\n'), 'rating without score');
});

test('time formats: same meridiem, different meridiem, layout B space-drop, dated ENDED', () => {
  assert.equal(
    rangeTimeLine(new Date(2026, 7, 28, 21, 5), new Date(2026, 7, 28, 23, 54)),
    '9:05PM TO 11:54PM',
  );
  assert.equal(
    compactTimeRange(new Date(2026, 7, 28, 19, 15), new Date(2026, 7, 28, 20, 55)),
    '7:15-8:55PM',
  );
  assert.equal(
    compactTimeRange(new Date(2026, 7, 28, 21, 5), new Date(2026, 7, 29, 0, 10)),
    '9:05PM-12:10AM',
  );

  const wide = cinemaFrames({
    type: 'plex.now-playing',
    plex: {
      mode: 'now-playing',
      title: 'The Grand Budapest Hotel',
      contentRating: 'PG-13',
      criticScore: 8.1,
      startedAt: new Date(2026, 7, 28, 21, 5),
      endsAt: new Date(2026, 7, 29, 0, 10),
    },
  });
  assertLayout(wide[0].rows, [
    'rrrrrrrrrrrrrrrrrrrrrr',
    'r    NOW PLAYING     r',
    'r     THE GRAND      r',
    'r   BUDAPEST HOTEL   r',
    'rPG-13w9:05PM-12:10AMr',
    'rrrrrrrrrrrrrrrrrrrrrr',
  ].join('\n'), 'layout B space-drop at 20');

  assert.equal(
    endedLine(new Date(2026, 7, 28, 23, 54), new Date(2026, 7, 28, 23, 54)),
    'ENDED 11:54PM',
  );
  assert.equal(
    endedLine(new Date(2026, 7, 22, 22, 45), new Date(2026, 7, 28, 12, 0)),
    'ENDED AUG 22 10:45PM',
  );
  assert.equal('ENDED AUG 22 10:45PM'.length, 20);
});

test('cinema dwell uses the shared reading-time helper', () => {
  const frames = cinemaFrames({
    type: 'plex.now-playing',
    plex: {
      mode: 'now-playing',
      title: 'Interstellar',
      contentRating: 'PG-13',
      criticScore: 8.7,
      startedAt: new Date(2026, 7, 28, 21, 5),
      endsAt: new Date(2026, 7, 28, 23, 54),
    },
  });
  assert.equal(frames[0].dwellSeconds, dwellFor(frames[0].rows, { base: 15 }));
  assert.ok(frames[0].dwellSeconds >= 15);
});
