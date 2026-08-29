const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { validate } = require('../src/vestaboard/encoder');
const { parseLayout, formatLayout } = require('../src/vestaboard/notation');
const { calendarClockFrames } = require('../src/vestaboard/formatters/feeds');
const {
  TYPE,
  HEADER_SUNDAY,
  HEADER_MONDAY,
  DEFAULT_SETTINGS,
  sanitiseSettings,
  weekStartIndex,
  daysInMonth,
  themeForMonth,
  formatClockTime,
  monthGrid,
  calendarClockRows,
  buildCalendarClockPayload,
  createCalendarClock,
} = require('../src/calendar-clock');

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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-clock-'));
});

test('week start and month math match a Sunday calendar', () => {
  assert.equal(weekStartIndex('monday'), 1);
  assert.equal(weekStartIndex('sunday'), 0);
  assert.equal(daysInMonth(2025, 12), 31);
  assert.equal(daysInMonth(2024, 2), 29);

  const december = monthGrid({
    year: 2025, month: 12, day: 31, weekStartsOn: 'sunday', timeZone: 'UTC',
  });
  assert.equal(december.firstWeekday, 1);
  assert.equal(december.offset, 1);
  assert.equal(december.weekRows, 5);
  assert.equal(december.showHeader, true);
  assert.equal(december.header, HEADER_SUNDAY);
  const today = december.cells.find((cell) => cell.today);
  assert.deepEqual(today, { day: 31, row: 4, col: 3, today: true });

  const march = monthGrid({
    year: 2025, month: 3, day: 14, weekStartsOn: 'sunday', timeZone: 'UTC',
  });
  assert.equal(march.firstWeekday, 6);
  assert.equal(march.offset, 6);
  assert.equal(march.weekRows, 6);
  assert.equal(march.showHeader, false);
  const fourteenth = march.cells.find((cell) => cell.day === 14);
  assert.deepEqual(fourteenth, { day: 14, row: 2, col: 5, today: true });
});

test('each month has its own chip pair and the clock matches the samples', () => {
  assert.deepEqual(themeForMonth(3), { month: 'blue', today: 'white' });
  assert.deepEqual(themeForMonth(8), { month: 'red', today: 'orange' });
  assert.deepEqual(themeForMonth(12), { month: 'violet', today: 'yellow' });
  assert.equal(formatClockTime(23, 59), '11:59  PM');
  assert.equal(formatClockTime(14, 30), '2:30  PM');
  assert.equal(formatClockTime(7, 0), '7:00  AM');
  assert.equal(formatClockTime(0, 5), '12:05  AM');
});

test('December 31 keeps SMTWTFS and highlights today in yellow', () => {
  const payload = buildCalendarClockPayload(DEFAULT_SETTINGS, {
    asOf: new Date('2025-12-31T23:59:00-07:00'),
    timeZone: 'America/Denver',
  });
  assert.equal(payload.type, TYPE);
  assert.equal(payload.showHeader, true);
  assert.equal(payload.weekdayName, 'WEDNESDAY');
  assert.equal(payload.monthName, 'DECEMBER');
  assert.equal(payload.day, 31);
  assert.equal(payload.timeLabel, '11:59  PM');
  assert.deepEqual(payload.theme, { month: 'violet', today: 'yellow' });

  assertLayout(calendarClockRows(payload), [
    'SMTWTFS',
    ' vvvvvv WEDNESDAY',
    'vvvvvvv DECEMBER  31',
    'vvvvvvv',
    'vvvvvvv 11:59  PM',
    'vvvy',
  ], 'December 31 2025 header calendar');

  const frames = calendarClockFrames(payload);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].source, 'calendar.clock');
});

test('March 14 drops the header so a Saturday-start 31-day month fits', () => {
  const payload = buildCalendarClockPayload(DEFAULT_SETTINGS, {
    asOf: new Date('2025-03-14T14:30:00-06:00'),
    timeZone: 'America/Denver',
  });
  assert.equal(payload.showHeader, false);
  assert.equal(payload.weekdayName, 'FRIDAY');
  assert.equal(payload.monthName, 'MARCH');
  assert.equal(payload.day, 14);
  assert.equal(payload.timeLabel, '2:30  PM');
  assert.deepEqual(payload.theme, { month: 'blue', today: 'white' });

  assertLayout(calendarClockRows(payload), [
    '      b',
    'bbbbbbb FRIDAY',
    'bbbbbwb MARCH  14',
    'bbbbbbb',
    'bbbbbbb 2:30  PM',
    'bb',
  ], 'March 14 2025 six-week calendar');
});

test('Monday week-start uses MTWTFSS when the month still fits five rows', () => {
  const payload = buildCalendarClockPayload({ weekStartsOn: 'monday' }, {
    asOf: new Date('2025-12-31T23:59:00-07:00'),
    timeZone: 'America/Denver',
  });
  assert.equal(payload.weekStartsOn, 'monday');
  assert.equal(payload.showHeader, true);
  assert.equal(payload.header, HEADER_MONDAY);

  assertLayout(calendarClockRows(payload), [
    'MTWTFSS',
    'vvvvvvv WEDNESDAY',
    'vvvvvvv DECEMBER  31',
    'vvvvvvv',
    'vvvvvvv 11:59  PM',
    'vvy',
  ], 'December 31 2025 Monday week');
});

test('calendarClockFrames refuse an empty payload', () => {
  assert.deepEqual(calendarClockFrames({ type: TYPE }), []);
  assert.deepEqual(calendarClockFrames({}), []);
});

test('createCalendarClock persists week-start and builds a payload', () => {
  const settingsPath = path.join(tempDir, 'calendar-clock-settings.json');
  const api = createCalendarClock({
    calendarClockSettingsPath: settingsPath,
    voiceEvents: { localTimeZone: 'America/Denver' },
  });
  assert.deepEqual(api.getSettings(), DEFAULT_SETTINGS);
  const updated = api.updateSettings({ weekStartsOn: 'monday' });
  assert.equal(updated.weekStartsOn, 'monday');
  assert.equal(sanitiseSettings({ weekStartsOn: 'MON' }).weekStartsOn, 'monday');

  const payload = api.nextPayload({
    asOf: new Date('2025-08-23T07:00:00-06:00'),
  });
  assert.equal(payload.type, TYPE);
  assert.equal(payload.weekStartsOn, 'monday');
  assert.deepEqual(payload.theme, { month: 'red', today: 'orange' });
  assert.equal(payload.timeLabel, '7:00  AM');
});
