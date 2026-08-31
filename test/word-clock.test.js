const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ROWS, COLS, validate } = require('../src/vestaboard/encoder');
const { formatLayout } = require('../src/vestaboard/notation');
const { wordClockFrames } = require('../src/vestaboard/formatters/feeds');
const {
  TYPE,
  DEFAULT_SETTINGS,
  sanitiseSettings,
  roundingMode,
  numberWord,
  hourWord,
  dayPartPhrase,
  announcedTime,
  timePhrase,
  layoutLines,
  wordClockRows,
  buildWordClockPayload,
  createWordClock,
} = require('../src/word-clock');

/**
 * Compare against a drawing of the whole board.
 *
 * `parseLayout` eats leading blank lines, and a centred block is mostly
 * leading blank lines, so the drawing is matched against `formatLayout`
 * directly — row for row, top blanks included.
 */
function assertBoard(rows, drawing, label) {
  assert.equal(validate(rows).ok, true, `${label} failed validation`);
  const actual = formatLayout(rows);
  const expected = drawing.join('\n');
  if (actual !== expected) {
    assert.fail(
      `${label} does not match the spec drawing\n\n`
      + `--- expected ---\n${expected}\n\n`
      + `--- actual ---\n${actual}\n`,
    );
  }
}

const denver = (iso) => buildWordClockPayload(DEFAULT_SETTINGS, {
  asOf: new Date(iso),
  timeZone: 'America/Denver',
});

let tempDir;

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'word-clock-'));
});

test('minutes and hours are spelled the way they are said', () => {
  assert.equal(numberWord(1), 'ONE');
  assert.equal(numberWord(13), 'THIRTEEN');
  assert.equal(numberWord(20), 'TWENTY');
  assert.equal(numberWord(25), 'TWENTY-FIVE');
  assert.equal(numberWord(29), 'TWENTY-NINE');
  assert.equal(numberWord(0), '');

  // Twelve is the name of both the noon and the midnight hour, and 13 is one.
  assert.equal(hourWord(0), 'TWELVE');
  assert.equal(hourWord(12), 'TWELVE');
  assert.equal(hourWord(13), 'ONE');
  assert.equal(hourWord(24), 'TWELVE');

  assert.equal(dayPartPhrase(9), 'IN THE MORNING');
  assert.equal(dayPartPhrase(12), 'IN THE AFTERNOON');
  assert.equal(dayPartPhrase(17), 'IN THE AFTERNOON');
  assert.equal(dayPartPhrase(18), 'IN THE EVENING');
  assert.equal(dayPartPhrase(21), 'AT NIGHT');
  assert.equal(dayPartPhrase(23), 'AT NIGHT');
});

test('the sentence matches the channel, including midnight and noon', () => {
  assert.equal(timePhrase(12, 15), "IT'S A QUARTER PAST TWELVE IN THE AFTERNOON.");
  assert.equal(timePhrase(13, 0), "IT'S ONE O'CLOCK IN THE AFTERNOON.");
  assert.equal(timePhrase(0, 0), "IT'S MIDNIGHT.");
  assert.equal(timePhrase(12, 0), "IT'S NOON.");
  assert.equal(timePhrase(8, 30), "IT'S HALF PAST EIGHT IN THE MORNING.");
  assert.equal(timePhrase(9, 45), "IT'S A QUARTER TO TEN IN THE MORNING.");
  assert.equal(timePhrase(23, 50), "IT'S TEN TO TWELVE AT NIGHT.");
  assert.equal(timePhrase(18, 20), "IT'S TWENTY PAST SIX IN THE EVENING.");

  // Off the five-minute marks the word MINUTES has to come back, or the board
  // reads "SEVEN PAST TWO" like a score.
  assert.equal(timePhrase(14, 7), "IT'S SEVEN MINUTES PAST TWO IN THE AFTERNOON.");
  assert.equal(timePhrase(14, 1), "IT'S ONE MINUTE PAST TWO IN THE AFTERNOON.");
  assert.equal(timePhrase(14, 59), "IT'S ONE MINUTE TO THREE IN THE AFTERNOON.");

  assert.equal(timePhrase(15, 10, { dayPart: false }), "IT'S TEN PAST THREE.");
  assert.equal(timePhrase(0, 0, { dayPart: false }), "IT'S MIDNIGHT.");
});

test('rounding to the nearest five rolls the hour rather than saying sixty', () => {
  assert.deepEqual(announcedTime(14, 7), { hour: 14, minute: 5 });
  assert.deepEqual(announcedTime(14, 8), { hour: 14, minute: 10 });
  assert.deepEqual(announcedTime(11, 58), { hour: 12, minute: 0 });
  assert.deepEqual(announcedTime(23, 59), { hour: 0, minute: 0 });
  assert.deepEqual(announcedTime(14, 7, 'exact'), { hour: 14, minute: 7 });

  assert.equal(roundingMode('EXACT'), 'exact');
  assert.equal(roundingMode('nonsense'), 'five');
  assert.deepEqual(sanitiseSettings({}), DEFAULT_SETTINGS);
  assert.deepEqual(
    sanitiseSettings({ rounding: 'exact', dayPart: 'off' }),
    { rounding: 'exact', dayPart: false },
  );
});

test('a quarter past twelve fills three centred rows', () => {
  const payload = denver('2026-08-30T12:15:00-06:00');
  assert.equal(payload.type, TYPE);
  assert.equal(payload.timeLabel, '12:15PM');
  assert.equal(payload.text, "IT'S A QUARTER PAST TWELVE IN THE AFTERNOON.");

  assertBoard(wordClockRows(payload), [
    '',
    "  IT'S A QUARTER",
    '  PAST TWELVE',
    '  IN THE AFTERNOON.',
    '',
    '',
  ], 'a quarter past twelve');

  const frames = wordClockFrames(payload);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].source, 'word.clock');
  assert.equal(frames[0].label, 'Word Clock');
});

test('midnight is one centred line and one o clock is two', () => {
  const midnight = denver('2026-08-30T00:00:00-06:00');
  assert.equal(midnight.text, "IT'S MIDNIGHT.");
  assertBoard(wordClockRows(midnight), [
    '',
    '',
    "    IT'S MIDNIGHT.",
    '',
    '',
    '',
  ], 'midnight');

  const one = denver('2026-08-30T13:00:00-06:00');
  assert.equal(one.text, "IT'S ONE O'CLOCK IN THE AFTERNOON.");
  assertBoard(wordClockRows(one), [
    '',
    '',
    "  IT'S ONE O'CLOCK",
    '  IN THE AFTERNOON.',
    '',
    '',
  ], 'one in the afternoon');
});

test('the block is squared up rather than left greedy', () => {
  // Greedy wrapping would fill row one and leave a stub: "IT'S A QUARTER PAST
  // / TWELVE IN THE / AFTERNOON.". The board has flaps to spare, so the block
  // narrows until it is roughly rectangular.
  assert.deepEqual(
    layoutLines("IT'S A QUARTER PAST TWELVE IN THE AFTERNOON."),
    ["IT'S A QUARTER", 'PAST TWELVE', 'IN THE AFTERNOON.'],
  );
  assert.deepEqual(layoutLines("IT'S MIDNIGHT."), ["IT'S MIDNIGHT."]);
  assert.deepEqual(layoutLines(''), []);
});

test('every minute of the day fits the board in both readings', () => {
  for (const rounding of ['five', 'exact']) {
    for (let hour = 0; hour < 24; hour += 1) {
      for (let minute = 0; minute < 60; minute += 1) {
        const said = announcedTime(hour, minute, rounding);
        for (const dayPart of [true, false]) {
          const text = timePhrase(said.hour, said.minute, { dayPart });
          const lines = layoutLines(text);
          const label = `${hour}:${String(minute).padStart(2, '0')} ${rounding}`;
          assert.ok(lines.length <= ROWS, `${label} needs ${lines.length} rows`);
          assert.ok(
            lines.every((line) => line.length <= COLS),
            `${label} overflows the board: ${text}`,
          );
          assert.equal(validate(wordClockRows({ text })).ok, true, label);
        }
      }
    }
  }
});

test('wordClockFrames refuse an empty payload', () => {
  assert.deepEqual(wordClockFrames({ type: TYPE }), []);
  assert.deepEqual(wordClockFrames({}), []);
});

test('createWordClock persists the reading and previews the same rows', () => {
  const settingsPath = path.join(tempDir, 'word-clock-settings.json');
  const api = createWordClock({
    wordClockSettingsPath: settingsPath,
    voiceEvents: { localTimeZone: 'America/Denver' },
  });
  assert.deepEqual(api.getSettings(), DEFAULT_SETTINGS);

  const rounded = api.nextPayload({ asOf: new Date('2026-08-30T14:07:00-06:00') });
  assert.equal(rounded.text, "IT'S FIVE PAST TWO IN THE AFTERNOON.");

  assert.deepEqual(
    api.updateSettings({ rounding: 'exact', dayPart: false }),
    { rounding: 'exact', dayPart: false },
  );
  const exact = api.nextPayload({ asOf: new Date('2026-08-30T14:07:00-06:00') });
  assert.equal(exact.text, "IT'S SEVEN MINUTES PAST TWO.");
  assert.equal(exact.actualMinute, 7);

  // A fresh service must read the file back rather than start on the defaults.
  const reopened = createWordClock({ wordClockSettingsPath: settingsPath });
  assert.deepEqual(reopened.getSettings(), { rounding: 'exact', dayPart: false });
  assert.deepEqual(reopened.resetSettings(), DEFAULT_SETTINGS);

  const snapshot = api.statusSnapshot({ asOf: new Date('2026-08-30T00:00:00-06:00') });
  assert.deepEqual(snapshot.defaults, DEFAULT_SETTINGS);
  assert.deepEqual(snapshot.boardRows, wordClockRows(snapshot.payload));
  assert.equal(snapshot.boardRows.length, ROWS);
});
