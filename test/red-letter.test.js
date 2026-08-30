const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { validate } = require('../src/vestaboard/encoder');
const { parseLayout, formatLayout } = require('../src/vestaboard/notation');
const { redLetterFrames } = require('../src/vestaboard/formatters/feeds');
const { typeOf } = require('../src/vestaboard/router');
const {
  parseYmdParts,
  parseTime,
  zonedMidnightMs,
  sanitiseEvent,
  sanitiseEvents,
  nextOccurrence,
  nthWeekdayOfMonth,
  upcomingEvents,
  pickEvent,
  createDateBook,
} = require('../src/date-book');
const {
  TYPE,
  MESSAGE_CELL,
  DEFAULT_SETTINGS,
  sanitiseSettings,
  sanitiseLayout,
  messageRuns,
  flowMessage,
  centreRuns,
  paintedRows,
  countdownFitsCompact,
  countdownRows,
  dayOfDefaultRows,
  buildRedLetterPayload,
  createRedLetter,
} = require('../src/red-letter');

const ZONE = 'America/Denver';
const NOON = new Date('2026-08-29T12:00:00-06:00');

function assertLayout(actual, drawing, label) {
  assert.equal(validate(actual).ok, true, `${label} failed validation`);
  const expected = parseLayout(drawing.join('\n'), { label });
  if (formatLayout(actual) !== formatLayout(expected)) {
    assert.fail(
      `${label} does not match the spec drawing\n\n`
      + `--- expected ---\n${formatLayout(expected)}\n\n`
      + `--- actual ---\n${formatLayout(actual)}\n`,
    );
  }
}

let tempDir;

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'red-letter-'));
});

after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function bookConfig(name) {
  return {
    ROOT: tempDir,
    dateBookPath: path.join(tempDir, `${name}-events.json`),
    redLetterSettingsPath: path.join(tempDir, `${name}-settings.json`),
    voiceEvents: { localTimeZone: ZONE },
  };
}

const quiet = { info() {}, warn() {}, error() {} };

// ---------------------------------------------------------------- date book

test('a date is only a date when it is a real calendar day', () => {
  assert.deepEqual(parseYmdParts('2026-11-27'), { year: 2026, month: 11, day: 27 });
  assert.deepEqual(parseYmdParts('2024-02-29'), { year: 2024, month: 2, day: 29 });
  assert.equal(parseYmdParts('2025-02-29'), null, 'Feb 29 is not a day in 2025');
  assert.equal(parseYmdParts('2026-13-01'), null);
  assert.equal(parseYmdParts('27/11/2026'), null);
  assert.equal(parseYmdParts(''), null);
});

test('midnight is local midnight, not UTC midnight', () => {
  // Denver is UTC-6 in August, so local midnight is 06:00Z the same morning.
  assert.equal(
    new Date(zonedMidnightMs(2026, 8, 29, ZONE)).toISOString(),
    '2026-08-29T06:00:00.000Z',
  );
  // Standard time is UTC-7, and the offset has to follow the date.
  assert.equal(
    new Date(zonedMidnightMs(2026, 12, 25, ZONE)).toISOString(),
    '2026-12-25T07:00:00.000Z',
  );
});

test('an event needs a name and a date, and keeps its own id', () => {
  const event = sanitiseEvent({ name: '  Amanda   visits ', date: '2026-11-27', message: ' Welcome home ' });
  assert.equal(event.name, 'Amanda visits');
  assert.equal(event.message, 'Welcome home');
  assert.equal(event.date, '2026-11-27');
  assert.equal(event.time, '');
  assert.equal(event.schedule, 'date');
  assert.equal(event.recurring, false);
  assert.equal(event.enabled, true);
  assert.equal(event.layout, null);
  assert.equal(event.id, 'amanda-visits-1127');

  assert.equal(sanitiseEvent({ name: 'No date' }), null);
  assert.equal(sanitiseEvent({ date: '2026-11-27' }), null);

  const ids = sanitiseEvents([
    { name: 'Party', date: '2026-11-27' },
    { name: 'Party', date: '2026-11-27' },
  ]).map((row) => row.id);
  assert.deepEqual(ids, ['party-1127', 'party-1127-2'], 'two events on a day must not share an id');
});

test('a one-off expires and a yearly event rolls to the next year', () => {
  const options = { asOf: NOON, timeZone: ZONE };

  const visit = nextOccurrence({ name: 'Visit', date: '2026-11-27' }, options);
  assert.equal(visit.date, '2026-11-27');
  assert.equal(visit.daysAway, 90);
  assert.equal(visit.expired, false);

  const gone = nextOccurrence({ name: 'Gone', date: '2026-08-28' }, options);
  assert.equal(gone.expired, true, 'yesterday is behind us');

  // June is behind August, so the next one is next year.
  const past = nextOccurrence({ name: 'Anniversary', date: '2019-06-14', recurring: true }, options);
  assert.equal(past.date, '2027-06-14');
  assert.equal(past.expired, false, 'a yearly event never expires');

  // December is still ahead, so it stays in this year.
  const ahead = nextOccurrence({ name: 'Christmas', date: '2001-12-25', recurring: true }, options);
  assert.equal(ahead.date, '2026-12-25');

  const today = nextOccurrence({ name: 'Today', date: '2019-08-29', recurring: true }, options);
  assert.equal(today.date, '2026-08-29');
  assert.equal(today.isToday, true);
  assert.equal(today.daysAway, 0);
});

test('a leap-day anniversary is observed on the 28th in a common year', () => {
  const leap = nextOccurrence(
    { name: 'Leap', date: '2020-02-29', recurring: true },
    { asOf: NOON, timeZone: ZONE },
  );
  assert.equal(leap.date, '2027-02-28');
  assert.equal(leap.observed, true, 'the board should be able to say it moved');

  const real = nextOccurrence(
    { name: 'Leap', date: '2020-02-29', recurring: true },
    { asOf: new Date('2028-01-01T12:00:00-07:00'), timeZone: ZONE },
  );
  assert.equal(real.date, '2028-02-29');
  assert.equal(real.observed, false);
});

test('the countdown splits the real remaining time, not whole sleeps', () => {
  // 19 days and change out, mid-evening, is the marketplace card's example.
  const at = new Date('2026-12-12T12:05:00-07:00');
  const occurrence = nextOccurrence({ name: 'New Year', date: '2027-01-01' }, { asOf: at, timeZone: ZONE });
  assert.equal(occurrence.daysAway, 20, '20 sleeps');
  assert.equal(occurrence.days, 19, 'but 19 whole days of clock time');
  assert.equal(occurrence.hours, 11);
  assert.equal(occurrence.minutes, 55);
});

test('a clock time is when the hours and minutes count down to', () => {
  assert.equal(parseTime('18:00'), '18:00');
  assert.equal(parseTime('9:05:00'), '09:05');
  assert.equal(parseTime(''), '');
  assert.equal(parseTime('25:00'), '');

  const at = new Date('2026-12-12T12:05:00-07:00');
  const dinner = nextOccurrence(
    { name: 'Dinner', date: '2026-12-25', time: '18:00' },
    { asOf: at, timeZone: ZONE },
  );
  assert.equal(dinner.daysAway, 13, 'still 13 sleeps to Christmas Day');
  assert.equal(dinner.days, 13);
  assert.equal(dinner.hours, 5, 'to 6pm, not midnight');
  assert.equal(dinner.minutes, 55);

  const today = nextOccurrence(
    { name: 'Tonight', date: '2026-12-12', time: '18:00' },
    { asOf: at, timeZone: ZONE },
  );
  assert.equal(today.isToday, true);
  assert.equal(today.days, 0);
  assert.equal(today.hours, 5);
  assert.equal(today.minutes, 55);
});

test('Thanksgiving is the last Thursday of November and Labor Day is the first Monday of September', () => {
  assert.deepEqual(nthWeekdayOfMonth(2026, 11, 4, 'last'), { year: 2026, month: 11, day: 26 });
  assert.deepEqual(nthWeekdayOfMonth(2026, 9, 1, 1), { year: 2026, month: 9, day: 7 });
  assert.deepEqual(nthWeekdayOfMonth(2025, 11, 4, 'last'), { year: 2025, month: 11, day: 27 });

  const options = { asOf: NOON, timeZone: ZONE };
  const thanks = nextOccurrence({
    name: 'Thanksgiving',
    schedule: 'weekday',
    ordinal: 'last',
    weekday: 4,
    month: 11,
    recurring: true,
  }, options);
  assert.equal(thanks.date, '2026-11-26');
  assert.equal(thanks.expired, false);

  const labor = sanitiseEvent({
    name: 'Labor Day',
    schedule: 'weekday',
    ordinal: 1,
    weekday: 1,
    month: 9,
  });
  assert.equal(labor.recurring, true, 'a weekday holiday repeats unless you say otherwise');
  assert.equal(labor.id, 'labor-day-n1-mon-sep');
  assert.equal(nextOccurrence(labor, options).date, '2026-09-07');

  const lastYear = nextOccurrence({
    name: 'Thanksgiving',
    schedule: 'weekday',
    ordinal: 'last',
    weekday: 4,
    month: 11,
    recurring: true,
  }, { asOf: new Date('2026-11-27T12:00:00-07:00'), timeZone: ZONE });
  assert.equal(lastYear.date, '2027-11-25', 'the day after Thanksgiving looks to next year');

  const oneOff = nextOccurrence({
    name: 'This Labor Day',
    schedule: 'weekday',
    ordinal: 1,
    weekday: 1,
    month: 9,
    date: '2025-09-01',
    recurring: false,
  }, options);
  assert.equal(oneOff.expired, true, 'a one-off weekday date that already passed is gone');
});

test('selection skips what is disabled or gone; next prefers today, random does not', () => {
  const events = [
    { id: 'a', name: 'Gone', date: '2020-01-01' },
    { id: 'b', name: 'Off', date: '2026-09-01', enabled: false },
    { id: 'c', name: 'Later', date: '2026-12-25' },
    { id: 'd', name: 'Sooner', date: '2026-09-05' },
    { id: 'e', name: 'Today', date: '2026-08-29' },
  ];
  const options = { asOf: NOON, timeZone: ZONE };

  assert.deepEqual(
    upcomingEvents(events, options).map((row) => row.id),
    ['e', 'd', 'c'],
    'soonest first, expired and disabled dropped',
  );

  assert.equal(pickEvent(events, { ...options, mode: 'next' }).id, 'e');
  // Random draws from every upcoming event, so it can skip today's card.
  assert.equal(pickEvent(events, { ...options, mode: 'random', random: () => 0.99 }).id, 'c');
  assert.equal(pickEvent(events, { ...options, mode: 'random', random: () => 0 }).id, 'e');

  const noneToday = events.filter((event) => event.id !== 'e');
  assert.equal(pickEvent(noneToday, { ...options, mode: 'next' }).id, 'd');
  assert.equal(pickEvent(noneToday, { ...options, mode: 'random', random: () => 0.99 }).id, 'c');
  assert.equal(pickEvent(noneToday, { ...options, mode: 'random', random: () => 0 }).id, 'd');
  assert.equal(pickEvent([], options), null);
});

test('the store persists, edits and deletes events', () => {
  const config = bookConfig('store');
  const book = createDateBook(config, quiet);
  assert.deepEqual(book.list(), []);

  const added = book.add({ name: 'Amanda visits', date: '2026-11-27', message: 'Welcome home' });
  assert.equal(added.id, 'amanda-visits-1127');

  book.update(added.id, { message: 'Welcome home, Amanda', recurring: true });
  assert.equal(book.get(added.id).message, 'Welcome home, Amanda');
  assert.equal(book.get(added.id).recurring, true);
  assert.equal(book.get(added.id).name, 'Amanda visits', 'a partial edit keeps the rest');

  const reopened = createDateBook(config, quiet);
  assert.equal(reopened.list().length, 1);
  assert.equal(reopened.list()[0].message, 'Welcome home, Amanda');
  assert.equal(reopened.withNext()[0].next.date, '2026-11-27');

  assert.equal(reopened.remove(added.id), true);
  assert.equal(reopened.remove(added.id), false);
  assert.deepEqual(createDateBook(config, quiet).list(), []);

  assert.throws(() => reopened.add({ name: 'No date' }), /name and a YYYY-MM-DD date/);
});

// ------------------------------------------------------------------- boards

test('a short name gets the hourglass card', () => {
  assert.equal(countdownFitsCompact('NEW YEAR'), true);
  assert.equal(countdownFitsCompact('ANNIVERSARY'), false);

  assertLayout(
    countdownRows({
      name: 'New Year', days: 19, hours: 11, minutes: 55, showTime: true,
    }),
    [
      'rrrrrrrr  COUNTDOWN',
      ' rrrrrr   TO NEW YEAR',
      '  rrrr',
      '  wwww    19 DAYS',
      ' wwwwww   11 HOURS',
      'wwwwwwww  55 MINUTES',
    ],
    'red letter countdown',
  );
});

test('a long name drops the hourglass rather than being cut', () => {
  assertLayout(
    countdownRows({
      name: 'Our Wedding Anniversary', days: 1, hours: 1, minutes: 1, showTime: true,
    }),
    [
      'rr   COUNTDOWN TO   rr',
      '     OUR WEDDING',
      '     ANNIVERSARY',
      '        1 DAY',
      '        1 HOUR',
      '       1 MINUTE',
    ],
    'red letter wide countdown',
  );
});

test('switching the clock off leaves whole sleeps on one line', () => {
  assertLayout(
    countdownRows({
      name: 'New Year', days: 20, hours: 11, minutes: 55, showTime: false,
    }),
    [
      'rrrrrrrr  COUNTDOWN',
      ' rrrrrr   TO NEW YEAR',
      '  rrrr',
      '  wwww',
      ' wwwwww   20 DAYS',
      'wwwwwwww',
    ],
    'red letter days only',
  );
});

test('a short day-of message gets confetti and a long one gets the whole board', () => {
  const short = dayOfDefaultRows({ message: 'Happy anniversary, Amanda', seed: 'amanda-2026-11-27' });
  assert.equal(validate(short).ok, true);
  assert.deepEqual(short[1], new Array(22).fill(0), 'the message never touches the confetti rows');
  assert.deepEqual(short[4], new Array(22).fill(0));
  assert.ok(short[0].every((code) => code >= 63), 'row 0 is all chips');
  assert.ok(short[5].every((code) => code >= 63), 'row 5 is all chips');
  assert.deepEqual(
    dayOfDefaultRows({ message: 'Happy anniversary, Amanda', seed: 'amanda-2026-11-27' }),
    short,
    'the same event shakes out the same confetti every year',
  );
  assert.notDeepEqual(
    dayOfDefaultRows({ message: 'Happy anniversary, Amanda', seed: 'someone-else' })[0],
    short[0],
    'a different event gets its own confetti',
  );

  assertLayout(
    dayOfDefaultRows({
      message: "I don't know how you do what you do. I'm so in love with you. It just keeps gettin' better, Jonathan.",
      seed: 'jonathan',
    }),
    [
      " I DON'T KNOW HOW YOU",
      " DO WHAT YOU DO. I'M",
      ' SO IN LOVE WITH YOU.',
      '    IT JUST KEEPS',
      "   GETTIN' BETTER,",
      '      JONATHAN.',
    ],
    'red letter long day-of',
  );
});

// -------------------------------------------------------- painted layouts

const HEART = [
  '  rrr  rrr            ',
  ' rrwrrrrrrr           ',
  ' rrrrrrrrrr           ',
  '  rrrrrrrr            ',
  '   rrrrrr             ',
  '     rr               ',
];

function heartLayout() {
  return {
    cells: HEART.map((line, row) => Array.from({ length: 22 }, (_, col) => {
      if (line[col] === 'r') return 63;
      if (line[col] === 'w') return 69;
      return row >= 1 && row <= 4 && col >= 12 ? MESSAGE_CELL : 0;
    })),
  };
}

test('a painted grid keeps only codes the board can draw', () => {
  assert.equal(sanitiseLayout(null), null);
  assert.equal(sanitiseLayout({ cells: [] }), null, 'an empty grid is the same as no grid');
  assert.equal(sanitiseLayout({ cells: [new Array(22).fill(0)] }), null, 'so is an all-blank one');

  const ragged = sanitiseLayout({ cells: [[63, 999, -1, 43]] });
  assert.equal(ragged.cells.length, 6, 'short grids pad to six rows');
  assert.equal(ragged.cells[0].length, 22, 'and to twenty-two columns');
  assert.deepEqual(ragged.cells[0].slice(0, 4), [63, 0, MESSAGE_CELL, 0], '999 and reserved 43 become blanks');
});

test('the message flows through the marked cells and reports overflow', () => {
  const runs = messageRuns(heartLayout().cells);
  assert.deepEqual(runs, [
    { row: 1, from: 12, width: 10 },
    { row: 2, from: 12, width: 10 },
    { row: 3, from: 12, width: 10 },
    { row: 4, from: 12, width: 10 },
  ]);

  assert.deepEqual(
    flowMessage(runs, 'Love you always & forever, Christina'),
    { lines: ['LOVE YOU', 'ALWAYS &', 'FOREVER,', 'CHRISTINA'], overflow: false },
  );

  const spilled = flowMessage(runs, 'Love you always and forever and ever and ever, Christina my dear');
  assert.equal(spilled.overflow, true, 'the designer needs to be told the text did not fit');

  // A word wider than its run is broken rather than dropped on the floor.
  const broken = flowMessage([{ row: 0, from: 0, width: 6 }, { row: 1, from: 0, width: 6 }], 'ANTIDISESTABLISH');
  assert.deepEqual(broken.lines, ['ANTIDI', 'SESTAB']);
  assert.equal(broken.overflow, true);
});

test('a short message sits in the middle of the region it was given', () => {
  // Four marked rows and two lines of message should not leave two rows of
  // dead air under the text.
  const cells = Array.from({ length: 6 }, (_, row) => (
    Array.from({ length: 22 }, () => (row >= 1 && row <= 4 ? MESSAGE_CELL : 63))
  ));
  const painted = paintedRows(sanitiseLayout({ cells }), 'Happy anniversary, Amanda');
  assertLayout(
    painted.rows,
    [
      'rrrrrrrrrrrrrrrrrrrrrr',
      '',
      '  HAPPY ANNIVERSARY,',
      '        AMANDA',
      '',
      'rrrrrrrrrrrrrrrrrrrrrr',
    ],
    'red letter centred region',
  );

  const runs = [
    { row: 1, from: 0, width: 22 }, { row: 2, from: 0, width: 22 },
    { row: 3, from: 0, width: 22 }, { row: 4, from: 0, width: 22 },
  ];
  assert.deepEqual(centreRuns(runs, ['ONE', '', '', '']), ['', 'ONE', '', '']);
  assert.deepEqual(centreRuns(runs, ['ONE', 'TWO', 'THREE', 'FOUR']), ['ONE', 'TWO', 'THREE', 'FOUR']);
  // Mixed widths stay put: a line wrapped for a wide run would be cut by a narrow one.
  const ragged = [{ row: 1, from: 0, width: 22 }, { row: 2, from: 0, width: 8 }];
  assert.deepEqual(centreRuns(ragged, ['A LONG LINE OF WORDS', '']), ['A LONG LINE OF WORDS', '']);
});

test('the heart card matches the marketplace drawing', () => {
  const painted = paintedRows(sanitiseLayout(heartLayout()), 'Love you always & forever, Christina');
  assert.equal(painted.overflow, false);
  assertLayout(
    painted.rows,
    [
      '  rrr  rrr',
      ' rrwrrrrrrr  LOVE YOU',
      ' rrrrrrrrrr  ALWAYS &',
      '  rrrrrrrr   FOREVER,',
      '   rrrrrr   CHRISTINA',
      '     rr',
    ],
    'red letter painted heart',
  );
});

// ------------------------------------------------------------- payload wiring

test('settings only accept the two selections and default to next', () => {
  assert.deepEqual(sanitiseSettings({}), DEFAULT_SETTINGS);
  assert.deepEqual(
    sanitiseSettings({ pushSelection: 'RANDOM', scheduleSelection: 'nonsense', showTime: false }),
    { pushSelection: 'random', scheduleSelection: 'next', showTime: false },
  );
});

test('auto mode reads the calendar and the formatter takes the rows', () => {
  const event = {
    id: 'anniversary-0829', name: 'Anniversary', date: '2019-08-29', recurring: true, message: 'Love you',
  };
  const dayOf = buildRedLetterPayload(event, { asOf: NOON, timeZone: ZONE });
  assert.equal(dayOf.type, TYPE);
  assert.equal(dayOf.card, 'day-of');
  assert.equal(dayOf.occurrence.isToday, true);
  assert.equal(dayOf.custom, false);
  assert.equal(typeOf(dayOf, 'redletter.show'), TYPE);

  const frames = redLetterFrames(dayOf);
  assert.equal(frames.length, 1);
  assert.equal(validate(frames[0].rows || frames[0].layout || dayOf.rows).ok, true);
  assert.deepEqual(redLetterFrames({ type: TYPE }), [], 'no rows means no frame');

  const countdown = buildRedLetterPayload(
    { ...event, date: '2019-12-25', name: 'Christmas' },
    { asOf: NOON, timeZone: ZONE },
  );
  assert.equal(countdown.card, 'countdown');
  assert.equal(countdown.occurrence.date, '2026-12-25');
});

test('a forced countdown preview on today looks a year ahead instead of showing zeroes', () => {
  const recurring = {
    id: 'a', name: 'Anniversary', date: '2019-08-29', recurring: true, message: 'Love you',
  };
  const preview = buildRedLetterPayload(recurring, { asOf: NOON, timeZone: ZONE, mode: 'countdown' });
  assert.equal(preview.card, 'countdown');
  assert.equal(preview.occurrence.date, '2027-08-29');

  // A one-off happening today has no next year to look at, so it stays honest.
  const once = buildRedLetterPayload(
    { id: 'b', name: 'Party', date: '2026-08-29', message: 'Party time' },
    { asOf: NOON, timeZone: ZONE, mode: 'countdown' },
  );
  assert.equal(once.card, 'day-of');
});

test('a one-field settings save does not reset the other selection', () => {
  const config = bookConfig('partial-settings');
  const dateBook = createDateBook(config, quiet);
  const redLetter = createRedLetter(config, quiet, { dateBook });

  redLetter.updateSettings({ pushSelection: 'random', scheduleSelection: 'random', showTime: false });
  assert.deepEqual(redLetter.getSettings(), {
    pushSelection: 'random',
    scheduleSelection: 'random',
    showTime: false,
  });

  // Same shape the admin sends when you tap Push Now → "The next one".
  redLetter.updateSettings({ pushSelection: 'next', scheduleSelection: undefined, showTime: undefined });
  assert.deepEqual(redLetter.getSettings(), {
    pushSelection: 'next',
    scheduleSelection: 'random',
    showTime: false,
  });

  redLetter.updateSettings({ scheduleSelection: 'next' });
  assert.deepEqual(redLetter.getSettings(), {
    pushSelection: 'next',
    scheduleSelection: 'next',
    showTime: false,
  });
});

test('the service honours push and schedule selections separately', () => {
  const config = bookConfig('service');
  const dateBook = createDateBook(config, quiet);
  const redLetter = createRedLetter(config, quiet, { dateBook });

  assert.equal(redLetter.nextPayload({ asOf: NOON }), null, 'an empty Date Book has nothing to say');
  assert.equal(redLetter.statusSnapshot({ asOf: NOON }).upcoming, 0);

  dateBook.add({ name: 'Sooner', date: '2026-09-05', message: 'Soon' });
  dateBook.add({ name: 'Later', date: '2026-12-25', message: 'Later' });

  redLetter.updateSettings({ pushSelection: 'next', scheduleSelection: 'random' });
  assert.equal(redLetter.selectionFor('push'), 'next');
  assert.equal(redLetter.selectionFor('schedule'), 'random');

  assert.equal(redLetter.nextPayload({ asOf: NOON, trigger: 'push' }).event.name, 'Sooner');
  assert.equal(
    redLetter.nextPayload({ asOf: NOON, trigger: 'schedule', random: () => 0.99 }).event.name,
    'Later',
  );

  const status = redLetter.statusSnapshot({ asOf: NOON });
  assert.equal(status.total, 2);
  assert.equal(status.upcoming, 2);
  assert.equal(status.today, 0);
  assert.deepEqual(status.nextUp, {
    id: 'sooner-0905', name: 'Sooner', date: '2026-09-05', daysAway: 7,
  });

  const preview = redLetter.preview({ eventId: 'sooner-0905', asOf: NOON });
  assert.equal(preview.countdown.card, 'countdown');
  assert.equal(preview.dayOf.card, 'day-of');
  assert.equal(preview.countdown.rows.length, 6);
  assert.equal(redLetter.preview({ eventId: 'nope' }), null);

  // The designer previews an edit that has not been saved yet.
  const inline = redLetter.preview({
    event: { name: 'Draft', date: '2026-10-01', message: 'Drafted' },
    asOf: NOON,
  });
  assert.equal(inline.dayOf.event.name, 'Draft');

  dateBook.add({ name: 'Today', date: '2026-08-29', message: 'Happy birthday' });
  redLetter.updateSettings({ pushSelection: 'next' });
  const nextToday = redLetter.nextPayload({ asOf: NOON, trigger: 'push' });
  assert.equal(nextToday.event.name, 'Today');
  assert.equal(nextToday.card, 'day-of');

  redLetter.updateSettings({ pushSelection: 'random' });
  const randomLater = redLetter.nextPayload({ asOf: NOON, trigger: 'push', random: () => 0.99 });
  assert.equal(randomLater.event.name, 'Later');
  assert.equal(randomLater.card, 'countdown');
});

test('the designer types the same flaps the encoder does', () => {
  // The designer needs a code table in the browser to turn keystrokes into
  // flaps. It is the one copy of the encoder that lives outside Node, and a
  // one-slot drift silently types "&" when you press "+".
  const { CHAR_BY_CODE, LEGAL_CODES, UNUSED_CODES } = require('../src/vestaboard/encoder');
  const js = fs.readFileSync(path.join(__dirname, '../src/web/admin/app.js'), 'utf8');
  const declared = /const FLAP_CHARS = '(.*)';/.exec(js);
  assert.ok(declared, 'app.js should declare FLAP_CHARS');
  const table = declared[1].replace(/\\'/g, "'").replace(/\\u00b0/g, '\u00b0');

  assert.equal(table.length, 63, 'codes 0-62 are characters; 63-71 are chips');
  for (let code = 0; code <= 62; code += 1) {
    const usable = LEGAL_CODES.has(code) && !UNUSED_CODES.has(code);
    assert.equal(
      table[code],
      usable ? (CHAR_BY_CODE.get(code) ?? ' ') : ' ',
      `flap code ${code} differs between the admin table and the encoder`,
    );
  }

  // Chip codes start where the character table ends.
  assert.match(js, /const FLAP_CHIPS = \['red', 'orange', 'yellow', 'green', 'blue', 'violet', 'white', 'black', 'filled'\]/);
  assert.match(js, /const RL_MESSAGE_CELL = -1;/);
});

test('a saved layout only shows up on the day-of card', () => {
  const config = bookConfig('layout');
  const dateBook = createDateBook(config, quiet);
  const redLetter = createRedLetter(config, quiet, { dateBook });
  const event = dateBook.add({ name: 'Anniversary', date: '2019-08-29', recurring: true, message: 'Love you always & forever, Christina' });
  dateBook.update(event.id, { layout: heartLayout() });

  const preview = redLetter.preview({ eventId: event.id, asOf: NOON });
  assert.equal(preview.dayOf.custom, true);
  assert.equal(preview.countdown.custom, false, 'the countdown keeps the house hourglass');

  const pushed = redLetter.nextPayload({ asOf: NOON, trigger: 'push' });
  assert.equal(pushed.card, 'day-of');
  assert.equal(pushed.custom, true);

  // Clearing the artwork falls back to the confetti card.
  dateBook.update(event.id, { layout: null });
  assert.equal(redLetter.preview({ eventId: event.id, asOf: NOON }).dayOf.custom, false);
});
