const test = require('node:test');
const assert = require('node:assert/strict');

const {
  COLS,
  BLANK,
  CHIPS,
  validate,
  blankRow,
  placeText,
  placeCodes,
  encodeText,
} = require('../src/vestaboard/encoder');
const { parseLayout, formatLayout } = require('../src/vestaboard/notation');
const {
  lr,
  centered,
  pageCounter,
  badgeFrame,
  borderFrame,
  gauge,
  blockTime,
  dwellFor,
  BODY_FROM,
} = require('../src/vestaboard/frames');

/**
 * Compare a built layout against the notation drawing from the spec. On
 * failure both are printed as drawings, because diffing 132 integers by eye
 * tells you nothing.
 */
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

test('the shopping list badge frame matches the spec drawing', () => {
  const frame = badgeFrame({
    color: 'green',
    title: 'SHOPPING LIST',
    rows: ['COMPANY Q. TEN', 'EGGS'],
    footerLeft: '2 ITEMS',
  });

  assertLayout(frame, [
    'gg SHOPPING LIST    gg',
    ' COMPANY Q. TEN',
    ' EGGS',
    '',
    '',
    'gg 2 ITEMS          gg',
  ].join('\n'), 'shopping list');
});

test('a badge frame right-aligns the header extra, like a category or page', () => {
  const frame = badgeFrame({
    color: 'yellow',
    title: 'THE UPSIDE',
    titleRight: '1/5',
    rows: [],
  });

  assertLayout(frame, [
    'yy THE UPSIDE   1/5 yy',
    '',
    '',
    '',
    '',
    'yy                  yy',
  ].join('\n'), 'upside header');
});

test('the tesla dashboard composes label-and-value rows against flush ones', () => {
  const frame = badgeFrame({
    color: 'red',
    title: 'TESLA MODEL Y',
    rows: [
      { left: 'BATT 73%', right: 'RANGE 201MI', indent: 0, to: COLS - 2 },
      { left: 'PARKED - NOT PLUGGED', indent: 0 },
      lr('IN 88\u00b0', 'OUT 91\u00b0', { from: 0, to: 14 }),
      { left: 'LOCKED - SENTRY ON', indent: 0 },
    ],
    footerLeft: '2:38PM',
  });

  assertLayout(frame, [
    'rr TESLA MODEL Y    rr',
    'BATT 73%  RANGE 201MI',
    'PARKED - NOT PLUGGED',
    'IN 88\u00b0  OUT 91\u00b0',
    'LOCKED - SENTRY ON',
    'rr 2:38PM           rr',
  ].join('\n'), 'tesla dashboard');
});

test('the timer list right-aligns countdowns into a clean column', () => {
  const frame = badgeFrame({
    color: 'orange',
    title: 'TIMERS',
    rows: [
      { left: 'PIZZA', right: '12:34' },
      { left: 'LAUNDRY', right: '48:10' },
      { left: 'SOUS VIDE', right: '1:22:05' },
    ],
    footerLeft: '3 RUNNING',
  });

  assertLayout(frame, [
    'oo TIMERS           oo',
    ' PIZZA          12:34',
    ' LAUNDRY        48:10',
    ' SOUS VIDE    1:22:05',
    '',
    'oo 3 RUNNING        oo',
  ].join('\n'), 'timer list');
});

test('folding collapses runs of spaces, so columns must be placed not padded', () => {
  // Writing "IN 88°  OUT 91°" with two spaces does not survive folding, which
  // is why every aligned column in a formatter goes through lr() or explicit
  // placement instead of padded strings.
  const padded = badgeFrame({ color: 'red', rows: ['IN 88\u00b0  OUT 91\u00b0'] });
  assert.equal(formatLayout(padded).split('\n')[1], ' IN 88\u00b0 OUT 91\u00b0');

  const placed = badgeFrame({ color: 'red', rows: [lr('IN 88\u00b0', 'OUT 91\u00b0', { from: 1, to: 15 })] });
  assert.equal(formatLayout(placed).split('\n')[1], ' IN 88\u00b0  OUT 91\u00b0');
});

test('air quality places a band chip inline with the reading', () => {
  // The reading block is "<score><chip> <temp>°" right-aligned as a unit, so
  // a four-character temperature shifts the whole block one column left.
  const row = (label, score, band, temp) => {
    const built = blankRow(COLS);
    placeText(built, label, BODY_FROM);
    const block = [
      ...encodeText(score),
      CHIPS[band],
      BLANK,
      ...encodeText(`${temp}\u00b0`),
    ];
    placeCodes(built, block, COLS - 1 - block.length);
    return built;
  };

  const frame = badgeFrame({
    color: 'green',
    title: 'AIR QUALITY',
    rows: [
      row('MAIN FLOOR', '99', 'green', '76'),
      row('MACHINE ROOM', '99', 'green', '71'),
      row('DOME', '66', 'yellow', '114'),
    ],
    footerLeft: 'DOME RUNNING HOT',
  });

  assertLayout(frame, [
    'gg AIR QUALITY      gg',
    ' MAIN FLOOR   99g 76\u00b0',
    ' MACHINE ROOM 99g 71\u00b0',
    ' DOME        66y 114\u00b0',
    '',
    'gg DOME RUNNING HOT gg',
  ].join('\n'), 'air quality');
});

test('a header label yields room rather than running into the right-hand text', () => {
  const frame = badgeFrame({
    color: 'yellow',
    title: 'A VERY LONG TITLE INDEED',
    titleRight: 'GENERAL',
  });

  assert.equal(validate(frame).ok, true);
  const drawn = formatLayout(frame).split('\n')[0];
  assert.equal(drawn.length, COLS);
  assert.match(drawn, /GENERAL yy$/);
  // Cut to fit, with a blank between the label and the category.
  assert.match(drawn, /^yy A VERY L{0,1}\s+GENERAL yy$/);
});

test('a short broadcast centres on the middle row with the device named', () => {
  const frame = borderFrame({
    color: 'violet',
    lines: [null, { center: 'KYLIE' }, null, 'MOVIE THEATER ECHO'],
  });

  assert.equal(validate(frame).ok, true);
});

test('border frame centring puts the odd blank on the left', () => {
  const frame = borderFrame({
    color: 'violet',
    lines: ['', 'KYLIE', '', 'MOVIE THEATER ECHO'],
    align: 'center',
  });

  // Centring every line is wrong for the device row, so the real formatter
  // mixes alignment; this proves where a centred line lands.
  const drawn = formatLayout(frame).split('\n')[2];
  assert.equal(drawn, 'v        KYLIE       v');
});

test('the reminder alert indents its lines inside the border', () => {
  const frame = borderFrame({
    color: 'white',
    lines: ['REMINDER:', 'CHECK ON CORN', 'IN SMOKER', 'KITCHEN ECHO'],
    indent: 1,
  });

  assertLayout(frame, [
    'wwwwwwwwwwwwwwwwwwwwww',
    'w  REMINDER:         w',
    'w  CHECK ON CORN     w',
    'w  IN SMOKER         w',
    'w  KITCHEN ECHO      w',
    'wwwwwwwwwwwwwwwwwwwwww',
  ].join('\n'), 'reminder');
});

test('the timer fire alert leaves its blank rows blank', () => {
  const frame = borderFrame({
    color: 'orange',
    lines: ['', 'PIZZA TIMER DONE', "TIME'S UP!", ''],
    indent: 1,
  });

  assertLayout(frame, [
    'oooooooooooooooooooooo',
    'o                    o',
    'o  PIZZA TIMER DONE  o',
    "o  TIME'S UP!        o",
    'o                    o',
    'oooooooooooooooooooooo',
  ].join('\n'), 'timer fire');
});

test('an unfinished alert flags itself with a yellow corner chip', () => {
  const first = borderFrame({
    color: 'violet',
    lines: ['TOMMY WHEN', 'WHENEVER YOU GUYS', 'ARE DONE WITH', 'MINECRAFT COME'],
    more: true,
  });

  assertLayout(first, [
    'vvvvvvvvvvvvvvvvvvvvvv',
    'v TOMMY WHEN         v',
    'v WHENEVER YOU GUYS  v',
    'v ARE DONE WITH      v',
    'v MINECRAFT COME     v',
    'vvvvvvvvvvvvvvvvvvvvvy',
  ].join('\n'), 'broadcast continuation');

  const last = borderFrame({
    color: 'violet',
    lines: ['COME TO THE MOVIE'],
    more: false,
  });
  assert.equal(last[5][COLS - 1], CHIPS.violet, 'the final frame keeps its border colour');
});

test('the battery gauge fills proportionally inside its parens', () => {
  const codes = gauge(Math.round((73 / 100) * 18), 18);
  const row = new Array(COLS).fill(0);
  codes.forEach((code, i) => { row[BODY_FROM + i] = code; });

  assert.equal(formatLayout([row]), ' (ggggggggggggg     )');
  assert.equal(codes.filter((code) => code === CHIPS.green).length, 13);
});

test('the gauge clamps rather than overflowing its track', () => {
  assert.equal(gauge(99, 18).filter((code) => code === CHIPS.green).length, 18);
  assert.equal(gauge(-5, 18).filter((code) => code === CHIPS.green).length, 0);
});

test('the clock draws block digits with a yellow colon', () => {
  const frame = blockTime(new Date(2026, 7, 23, 21, 5), { footer: 'SUNDAY AUG 23' });

  assertLayout(frame, [
    '    www   www www',
    '    w w y w w w',
    '    www   w w www',
    '      w y w w   w PM',
    '    www   www www',
    'ww SUNDAY AUG 23    ww',
  ].join('\n'), 'clock');
});

test('the clock shows a two digit hour without a leading zero before ten', () => {
  const morning = formatLayout(blockTime(new Date(2026, 7, 23, 9, 5)));
  assert.ok(morning.split('\n')[0].startsWith('    '), 'no tens digit before ten');
  assert.match(morning.split('\n')[3], /AM$/);

  const midday = formatLayout(blockTime(new Date(2026, 7, 23, 12, 30)));
  assert.ok(!midday.split('\n')[0].startsWith('    '), 'twelve shows its tens digit');
  assert.match(midday.split('\n')[3], /PM$/);

  const midnight = formatLayout(blockTime(new Date(2026, 7, 23, 0, 15)));
  assert.match(midnight.split('\n')[3], /AM$/);
});

test('the clock face honours an IANA zone', () => {
  const drawn = formatLayout(blockTime('2026-08-24T22:09:00.000Z', {
    timeZone: 'America/Denver',
  }));
  assert.match(drawn.split('\n')[3], /PM$/);
  assert.ok(drawn.split('\n')[0].startsWith('    '), '4:09pm has no tens digit');
});

test('page counters only appear once there is more than one page', () => {
  assert.equal(pageCounter(1, 3), '1/3');
  assert.equal(pageCounter(1, 1), '');
  assert.equal(pageCounter(2, 0), '');
});

test('a row that would collide throws instead of quietly overlapping', () => {
  assert.throws(
    () => lr('A REALLY LONG LABEL HERE', '12:34'),
    /overflows/,
  );
  assert.doesNotThrow(() => lr('PIZZA', '12:34'));
});

test('a frame with more rows than the board has is refused', () => {
  assert.throws(
    () => badgeFrame({ color: 'green', rows: ['a', 'b', 'c', 'd', 'e'] }),
    /at most 4 rows/,
  );
  assert.throws(
    () => borderFrame({ color: 'red', lines: ['a', 'b', 'c', 'd', 'e'] }),
    /at most 4 lines/,
  );
});

test('an unknown chip colour is a loud failure', () => {
  assert.throws(() => badgeFrame({ color: 'chartreuse' }), /unknown chip colour/);
});

test('dwell grows with how much there is to read, within limits', () => {
  const sparse = badgeFrame({ color: 'green', title: 'TIMERS', rows: [] });
  assert.equal(dwellFor(sparse, { base: 15 }), 15, 'a near-empty frame holds the base dwell');

  const busy = badgeFrame({
    color: 'green',
    title: 'AIR QUALITY',
    rows: [
      { left: 'MAIN FLOOR', right: '99 76\u00b0' },
      { left: 'MACHINE ROOM', right: '99 71\u00b0' },
      { left: 'DOME', right: '66 114\u00b0' },
    ],
    footerLeft: 'DOME RUNNING HOT',
  });
  assert.ok(dwellFor(busy, { base: 15 }) >= 15);
  assert.ok(dwellFor(busy, { base: 15 }) <= 30, 'never longer than the cap');

  // Every flap lit is 132 characters, which reads as 14 seconds and so still
  // sits under a base dwell of 15.
  const packed = Array.from({ length: 6 }, () => new Array(COLS).fill(CHIPS.green));
  assert.equal(dwellFor(packed, { base: 15 }), 15);
  assert.equal(dwellFor(packed, { base: 5 }), 14);
  assert.equal(dwellFor(packed, { base: 5, cap: 10 }), 10, 'the cap wins');
});

test('every builder produces something the board would accept', () => {
  const frames = [
    badgeFrame({ color: 'blue', title: 'WEATHER', rows: ['NOW 93\u00b0 SUNNY'] }),
    borderFrame({ color: 'red', lines: ['WAKE UP - 6:30AM'] }),
    blockTime(new Date(2026, 7, 23, 14, 38), { footer: 'SUNDAY AUG 23' }),
  ];
  for (const frame of frames) {
    assert.equal(validate(frame).ok, true);
    assert.equal(frame.length, 6);
    assert.ok(frame.every((row) => row.length === COLS));
  }
});
