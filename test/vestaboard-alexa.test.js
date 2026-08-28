'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { validate } = require('../src/vestaboard/encoder');
const { parseLayout, formatLayout } = require('../src/vestaboard/notation');
const {
  toDate,
  clockLabel,
  dateLabel,
  dayPhrase,
  countdown,
  durationLabel,
  partOfDay,
  shortDate,
} = require('../src/vestaboard/clock');
const alexa = require('../src/vestaboard/formatters/alexa');

/**
 * Compare a formatter's layout against the drawing from 03 §A. On failure both
 * are printed as drawings, because diffing 132 integers by eye tells you
 * nothing.
 */
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

const DEG = '\u00b0';

// Sunday 23 Aug 2026, 9:05pm local — the instant the spec's clock drawing shows.
const SUNDAY_NIGHT = new Date(2026, 7, 23, 21, 5);

// ---------------------------------------------------------------------------
// Clock helpers
// ---------------------------------------------------------------------------

test('clock labels drop the space a board cannot afford', () => {
  assert.equal(clockLabel(new Date(2026, 7, 23, 21, 56)), '9:56PM');
  assert.equal(clockLabel(new Date(2026, 7, 23, 9, 46)), '9:46AM');
  assert.equal(clockLabel(new Date(2026, 7, 23, 22, 37)), '10:37PM');
  assert.equal(clockLabel(new Date(2026, 7, 23, 0, 5)), '12:05AM');
  assert.equal(clockLabel(new Date(2026, 7, 23, 12, 0)), '12:00PM');
  assert.equal(clockLabel(null), '');
  assert.equal(clockLabel('not a date'), '');
});

test('clock labels honour an IANA zone so a UTC host still prints Utah time', () => {
  const utc = '2026-08-24T22:09:00.000Z';
  assert.equal(clockLabel(utc, { timeZone: 'America/Denver' }), '4:09PM');
  assert.equal(clockLabel(utc, { timeZone: 'UTC' }), '10:09PM');
  assert.equal(shortDate(utc, { timeZone: 'America/Denver' }), 'AUG 24');
  assert.equal(dateLabel(utc, { timeZone: 'America/Denver' }), 'MONDAY AUG 24');
});

test('the clock footer names the weekday and the date', () => {
  assert.equal(dateLabel(SUNDAY_NIGHT), 'SUNDAY AUG 23');
});

test('countdowns only grow an hours column once there are hours', () => {
  assert.equal(countdown(754), '12:34');
  assert.equal(countdown(2890), '48:10');
  assert.equal(countdown(4925), '1:22:05');
  assert.equal(countdown(5), '0:05');
  assert.equal(countdown(0), '0:00');
  assert.equal(countdown(null), '');
  assert.equal(countdown(-30), '');
});

test('durations stop at two units, because a third never fits the footer', () => {
  assert.equal(durationLabel(86227), '23H 57M');
  assert.equal(durationLabel(3420), '57M');
  assert.equal(durationLabel(45), '45S');
  assert.equal(durationLabel(7200), '2H');
  assert.equal(durationLabel(97200), '1D 3H');
  assert.equal(durationLabel(172800), '2D');
  assert.equal(durationLabel(null), '');
});

test('day phrases prefer a weekday name inside the week and a date past it', () => {
  const now = new Date(2026, 7, 24, 7, 3);
  assert.equal(dayPhrase(new Date(2026, 7, 24, 23, 0), now), 'TODAY');
  assert.equal(dayPhrase(new Date(2026, 7, 25, 7, 0), now), 'TOMORROW');
  assert.equal(dayPhrase(new Date(2026, 7, 23, 7, 0), now), 'YESTERDAY');
  assert.equal(dayPhrase(new Date(2026, 7, 27, 7, 0), now), 'THURSDAY');
  assert.equal(dayPhrase(new Date(2026, 8, 4, 7, 0), now), 'SEP 4');
});

test('part of day splits the afternoon from the evening', () => {
  assert.equal(partOfDay(new Date(2026, 7, 24, 8, 0)), 'AM');
  assert.equal(partOfDay(new Date(2026, 7, 24, 15, 0)), 'PM');
  assert.equal(partOfDay(new Date(2026, 7, 24, 20, 0)), 'TONIGHT');
});

// ---------------------------------------------------------------------------
// A1. Broadcast
// ---------------------------------------------------------------------------

function broadcast(message, sender) {
  return {
    version: 2, type: 'broadcast', message, sender, destination: 'All devices',
  };
}

test('a one word broadcast becomes a centred poster', () => {
  const frames = alexa.broadcastFrames(broadcast('Kylie', 'Movie Theater Echo'));

  assert.equal(frames.length, 1);
  assert.equal(frames[0].priority, 'alert');
  assert.equal(frames[0].dwellSeconds, 60);
  assertLayout(frames[0].rows, [
    'vvvvvvvvvvvvvvvvvvvvvv',
    'v                    v',
    'v        KYLIE       v',
    'v                    v',
    'v MOVIE THEATER ECHO v',
    'vvvvvvvvvvvvvvvvvvvvvv',
  ], 'broadcast (one word)');
});

test('a three line broadcast names the room on the last row', () => {
  const frames = alexa.broadcastFrames(broadcast(
    "'I love you daddy take care of my teddy bear'",
    'Master Bathroom Echo',
  ));

  assert.equal(frames.length, 1);
  assertLayout(frames[0].rows, [
    'vvvvvvvvvvvvvvvvvvvvvv',
    "v 'I LOVE YOU DADDY  v",
    'v TAKE CARE OF MY    v',
    "v TEDDY BEAR'        v",
    'v MASTER BATH ECHO   v',
    'vvvvvvvvvvvvvvvvvvvvvv',
  ], 'broadcast (three lines)');
});

test('a long broadcast pages, and the first page flags the continuation', () => {
  const frames = alexa.broadcastFrames(broadcast(
    'Tommy when whenever you guys are done with minecraft come come to the '
    + 'movie theater and bring the extra game by that you have',
    'Kitchen Echo',
  ));

  assert.equal(frames.length, 2);
  assert.equal(frames[0].more, true);
  assert.equal(frames[1].more, false);

  assertLayout(frames[0].rows, [
    'vvvvvvvvvvvvvvvvvvvvvv',
    'v TOMMY WHEN         v',
    'v WHENEVER YOU GUYS  v',
    'v ARE DONE WITH      v',
    'v MINECRAFT COME     v',
    'vvvvvvvvvvvvvvvvvvvvvy',
  ], 'broadcast page 1');

  assertLayout(frames[1].rows, [
    'vvvvvvvvvvvvvvvvvvvvvv',
    'v COME TO THE MOVIE  v',
    'v THEATER AND BRING  v',
    'v THE EXTRA GAME BY  v',
    'v THAT YOU HAVE      v',
    'vvvvvvvvvvvvvvvvvvvvvv',
  ], 'broadcast page 2');
});

test('a broadcast that fills four lines gives up the room name, not the words', () => {
  // Four wrapped lines exactly fill the frame; dropping a word to keep the
  // device row would lose the message, so the device row goes instead.
  const frames = alexa.broadcastFrames(broadcast(
    'dinner is ready everyone please come downstairs to the kitchen now',
    'Kitchen Echo',
  ));

  assert.equal(frames.length, 1);
  assert.equal(frames[0].more, false);
  assert.ok(
    !formatLayout(frames[0].rows).includes('KITCHEN ECHO'),
    'the four line tier has no room for the device',
  );
});

test('an empty broadcast is not worth flipping the board for', () => {
  assert.deepEqual(alexa.broadcastFrames(broadcast('', 'Kitchen Echo')), []);
  assert.deepEqual(alexa.broadcastFrames(broadcast(null, 'Kitchen Echo')), []);
  // Emoji fold away to nothing, which must not produce a blank alert.
  assert.deepEqual(alexa.broadcastFrames(broadcast('\u2728\u{1f389}', 'Kitchen Echo')), []);
});

test('room names abbreviate before they are cut', () => {
  assert.equal(alexa.fitDevice('Master Bathroom Echo'), 'MASTER BATH ECHO');
  assert.equal(alexa.fitDevice('Kylie Bedroom'), 'KYLIE BEDROOM');
  assert.equal(alexa.fitDevice('Movie Theater Echo'), 'MOVIE THEATER ECHO');
  assert.equal(alexa.fitDevice('Downstairs Living Room Echo'), 'DOWN LIVING ECHO');
  assert.equal(alexa.fitDevice(null), '');
});

// ---------------------------------------------------------------------------
// A2. Time
// ---------------------------------------------------------------------------

test('the time query draws the block clock with a dated footer', () => {
  const frames = alexa.timeFrames({
    version: 2,
    type: 'time.query',
    timestamp: SUNDAY_NIGHT.toISOString(),
  });

  assert.equal(frames.length, 1);
  assert.equal(frames[0].dwellSeconds, 15);
  assert.equal(frames[0].priority, 'snapshot');
  assertLayout(frames[0].rows, [
    '    www   www www',
    '    w w y w w w',
    '    www   w w www',
    '      w y w w   w PM',
    '    www   www www',
    'ww SUNDAY AUG 23    ww',
  ], 'time');
});

test('the parsed spoken time wins over the moment the event was logged', () => {
  const frames = alexa.timeFrames({
    type: 'time.query',
    timestamp: new Date(2026, 7, 23, 3, 0).toISOString(),
    parsedTime: { iso: SUNDAY_NIGHT.toISOString(), timeLabel: '9:05 PM' },
  });
  assert.match(formatLayout(frames[0].rows).split('\n')[3], /PM$/);
});

test('the text time style falls back to a plain badge frame', () => {
  const frames = alexa.timeFrames(
    { type: 'time.query', timestamp: SUNDAY_NIGHT.toISOString() },
    { timeStyle: 'text' },
  );

  const drawn = formatLayout(frames[0].rows).split('\n');
  assert.match(drawn[0], /^ww TIME/);
  assert.match(drawn[2], /9:05PM/);
  assert.match(drawn[5], /SUNDAY AUG 23/);
});

// ---------------------------------------------------------------------------
// A3. Smart home
// ---------------------------------------------------------------------------

test('a smart home ON carries a green chip beside the state', () => {
  const frames = alexa.smartHomeFrames({
    version: 2,
    type: 'smart-home.command',
    device: 'Kylie Bedroom Echo',
    timestamp: new Date(2026, 7, 23, 21, 56).toISOString(),
    command: {
      action: 'on',
      target: 'Kylie Bedroom Lights',
      matchedName: 'Kylie Bedroom Lights',
      deviceType: 'light',
    },
  });

  assertLayout(frames[0].rows, [
    'ww SMART HOME       ww',
    '',
    ' KYLIE BEDROOM',
    ' LIGHTS: ON g',
    '',
    'ww 9:56PM           ww',
  ], 'smart home on');
});

test('a smart home OFF has no chip and credits the room that heard it', () => {
  const frames = alexa.smartHomeFrames({
    type: 'smart-home.command',
    device: 'Office Echo',
    timestamp: new Date(2026, 7, 23, 9, 46).toISOString(),
    command: { action: 'off', matchedName: 'Movie Poster', deviceType: 'plug' },
  });

  assertLayout(frames[0].rows, [
    'ww SMART HOME       ww',
    '',
    ' MOVIE POSTER: OFF',
    ' VIA OFFICE ECHO',
    '',
    'ww 9:46AM           ww',
  ], 'smart home off');
});

test('a smart home command with nothing resolved is skipped', () => {
  assert.deepEqual(alexa.smartHomeFrames({ type: 'smart-home.command', command: {} }), []);
  assert.deepEqual(
    alexa.smartHomeFrames({ type: 'smart-home.command', command: { action: 'on' } }),
    [],
  );
});

// ---------------------------------------------------------------------------
// A4. Timers
// ---------------------------------------------------------------------------

function timerPayload(timers, event = { kind: 'list' }) {
  return {
    version: 2, type: 'timer.snapshot', timers, event,
  };
}

test('running timers list soonest first with right aligned countdowns', () => {
  const frames = alexa.timerFrames(timerPayload([
    { amazonId: 't3', label: 'Sous Vide', status: 'ON', remainingSec: 4925 },
    { amazonId: 't1', label: 'Pizza', status: 'ON', remainingSec: 754 },
    { amazonId: 't2', label: 'Laundry', status: 'ON', remainingSec: 2890 },
  ]));

  assert.equal(frames.length, 1);
  assertLayout(frames[0].rows, [
    'oo TIMERS           oo',
    ' PIZZA          12:34',
    ' LAUNDRY        48:10',
    ' SOUS VIDE    1:22:05',
    '',
    'oo 3 RUNNING        oo',
  ], 'timers');
});

test('a fired timer is an orange alert that quiet hours let through', () => {
  const frames = alexa.timerFrames(timerPayload(
    [],
    { kind: 'fired', amazonId: 't1', timer: { label: 'Pizza', status: 'OFF', remainingSec: 0 } },
  ));

  assert.equal(frames[0].priority, 'alert');
  assert.equal(frames[0].dwellSeconds, 60);
  // The queue reads the first word of `source` to decide what may wake the
  // house, so this string is load-bearing.
  assert.equal(frames[0].source, 'timer.fired');

  assertLayout(frames[0].rows, [
    'oooooooooooooooooooooo',
    'o                    o',
    'o  PIZZA TIMER DONE  o',
    "o  TIME'S UP!        o",
    'o                    o',
    'oooooooooooooooooooooo',
  ], 'timer fired');
});

test('no timers says so when asked and says nothing when rotating', () => {
  const empty = timerPayload([{ amazonId: 't1', label: 'Pizza', status: 'OFF' }]);

  assert.deepEqual(alexa.timerFrames(empty), []);

  const frames = alexa.timerFrames(empty, { explicit: true });
  assertLayout(frames[0].rows, [
    'oo TIMERS           oo',
    '',
    '  NO TIMERS RUNNING',
    '',
    '',
    'oo ALL QUIET        oo',
  ], 'timers empty');
});

test('more than three timers page, and every page carries the total', () => {
  const timers = ['A', 'B', 'C', 'D', 'E'].map((label, index) => ({
    amazonId: label, label, status: 'ON', remainingSec: (index + 1) * 60,
  }));
  const frames = alexa.timerFrames(timerPayload(timers));

  assert.equal(frames.length, 2);
  assert.match(formatLayout(frames[0].rows).split('\n')[5], /5 RUNNING\s+1\/2/);
  assert.match(formatLayout(frames[1].rows).split('\n')[5], /5 RUNNING\s+2\/2/);
});

test('a timer with no label falls back to the room rather than an empty column', () => {
  const frames = alexa.timerFrames(timerPayload([
    { amazonId: 't1', label: null, device: 'Kitchen Echo', status: 'ON', remainingSec: 754 },
  ]));
  assert.match(formatLayout(frames[0].rows).split('\n')[1], /^ KITCHEN ECHO\s+12:34$/);
});

// ---------------------------------------------------------------------------
// A5. Alarms
// ---------------------------------------------------------------------------

test('a single alarm shows the day it lands on and the wait in the footer', () => {
  const frames = alexa.alarmFrames({
    version: 2,
    type: 'alarm.snapshot',
    timestamp: new Date(2026, 7, 24, 7, 3).toISOString(),
    alarms: [{
      amazonId: 'a1',
      device: 'Bedroom Echo',
      label: null,
      status: 'ON',
      triggerTime: new Date(2026, 7, 25, 7, 0).toISOString(),
      remainingSec: 86227,
      alarmType: 'standard',
    }],
    event: { kind: 'started' },
  });

  assertLayout(frames[0].rows, [
    'yy ALARMS           yy',
    ' 7:00AM  BEDROOM ECHO',
    ' TOMORROW',
    '',
    '',
    'yy NEXT IN 23H 57M  yy',
  ], 'alarms');
});

test('a fired alarm is a red alert that quiet hours let through', () => {
  const frames = alexa.alarmFrames({
    type: 'alarm.snapshot',
    event: {
      kind: 'fired',
      alarm: { label: 'Wake up', triggerTime: new Date(2026, 7, 24, 6, 30).toISOString() },
    },
  });

  assert.equal(frames[0].source, 'alarm.fired');
  assertLayout(frames[0].rows, [
    'rrrrrrrrrrrrrrrrrrrrrr',
    'r                    r',
    'r  WAKE UP - 6:30AM  r',
    'r  RISE AND SHINE!   r',
    'r                    r',
    'rrrrrrrrrrrrrrrrrrrrrr',
  ], 'alarm fired');
});

test('several alarms give up the day line so every time fits', () => {
  const frames = alexa.alarmFrames({
    type: 'alarm.snapshot',
    timestamp: new Date(2026, 7, 24, 7, 3).toISOString(),
    alarms: [
      {
        amazonId: 'a2',
        device: 'Kitchen Echo',
        status: 'ON',
        triggerTime: new Date(2026, 7, 25, 8, 30).toISOString(),
        remainingSec: 91620,
      },
      {
        amazonId: 'a1',
        device: 'Bedroom Echo',
        status: 'ON',
        triggerTime: new Date(2026, 7, 25, 7, 0).toISOString(),
        remainingSec: 86227,
      },
    ],
  });

  const drawn = formatLayout(frames[0].rows).split('\n');
  assert.match(drawn[1], /^ 7:00AM\s+BEDROOM ECHO$/);
  assert.match(drawn[2], /^ 8:30AM\s+KITCHEN ECHO$/);
  assert.match(drawn[5], /NEXT IN 23H 57M/);
});

test('no alarms is silent in rotation and explicit when asked', () => {
  assert.deepEqual(alexa.alarmFrames({ type: 'alarm.snapshot', alarms: [] }), []);
  const frames = alexa.alarmFrames({ type: 'alarm.snapshot', alarms: [] }, { explicit: true });
  assert.match(formatLayout(frames[0].rows).split('\n')[2], /NO ALARMS SET/);
});

// ---------------------------------------------------------------------------
// A6. Reminder
// ---------------------------------------------------------------------------

test('a fired reminder wraps its label between the header and the room', () => {
  const frames = alexa.reminderFrames({
    version: 2,
    type: 'reminder.fired',
    event: {
      kind: 'fired',
      reminder: {
        amazonId: null,
        label: 'Check on corn in smoker',
        device: 'Kitchen Echo',
        triggerTime: new Date(2026, 7, 24, 18, 30).toISOString(),
      },
    },
  });

  assert.equal(frames[0].priority, 'alert');
  assert.equal(frames[0].source, 'reminder.fired');
  assertLayout(frames[0].rows, [
    'wwwwwwwwwwwwwwwwwwwwww',
    'w  REMINDER:         w',
    'w  CHECK ON CORN IN  w',
    'w  SMOKER            w',
    'w  KITCHEN ECHO      w',
    'wwwwwwwwwwwwwwwwwwwwww',
  ], 'reminder');
});

test('a reminder with the default label still renders, an unlabelled one does not', () => {
  const framed = alexa.reminderFrames({
    type: 'reminder.fired',
    event: { kind: 'fired', reminder: { label: 'Reminder', device: null } },
  });
  assert.equal(framed.length, 1);

  assert.deepEqual(
    alexa.reminderFrames({ type: 'reminder.fired', event: { kind: 'fired', reminder: {} } }),
    [],
  );
});

// ---------------------------------------------------------------------------
// A7. Shopping list
// ---------------------------------------------------------------------------

test('the shopping list renders voice artefacts exactly as they were heard', () => {
  const frames = alexa.shoppingListFrames({
    version: 2,
    type: 'shopping-list.snapshot',
    listName: 'Shopping List',
    items: [
      { id: 'i1', value: 'Company Q. Ten', createdAt: '2026-08-24T02:00:00.000Z' },
      { id: 'i2', value: 'Eggs', createdAt: '2026-08-23T02:00:00.000Z' },
    ],
  });

  assertLayout(frames[0].rows, [
    'gg SHOPPING LIST    gg',
    ' COMPANY Q. TEN',
    ' EGGS',
    '',
    '',
    'gg 2 ITEMS          gg',
  ], 'shopping list');
});

test('a five item list pages and counts every item, not the page', () => {
  const items = ['MILK', 'EGGS', 'BREAD', 'BUTTER', 'JAM'].map((value, i) => ({ id: `i${i}`, value }));
  const frames = alexa.shoppingListFrames({ type: 'shopping-list.snapshot', items });

  assert.equal(frames.length, 2);
  assert.match(formatLayout(frames[0].rows).split('\n')[5], /5 ITEMS\s+1\/2/);
  assert.match(formatLayout(frames[1].rows).split('\n')[1], /^ JAM$/);
});

test('one item is singular, and an empty list only speaks when asked', () => {
  const one = alexa.shoppingListFrames({ type: 'shopping-list.snapshot', items: [{ value: 'Milk' }] });
  assert.match(formatLayout(one[0].rows).split('\n')[5], /1 ITEM\s/);

  assert.deepEqual(alexa.shoppingListFrames({ type: 'shopping-list.snapshot', items: [] }), []);
  const empty = alexa.shoppingListFrames({ type: 'shopping-list.snapshot', items: [] }, { explicit: true });
  assert.match(formatLayout(empty[0].rows).split('\n')[2], /LIST IS EMPTY/);
});

// ---------------------------------------------------------------------------
// A8. Weather
// ---------------------------------------------------------------------------

test('weather leaves a blank row under the title and above the footer', () => {
  const frames = alexa.weatherFrames({
    version: 2,
    type: 'weather.query',
    weather: {
      current: {
        temperatureF: 93, condition: 'sunny', windSpeedMph: 9, humidity: 18,
      },
      next24Hours: [
        {
          time: '2026-08-24T13:00', temperatureF: 95, precipitationProbability: 0, windSpeedMph: 11, condition: 'sunny',
        },
        {
          time: '2026-08-24T15:00', temperatureF: 96, precipitationProbability: 4, windSpeedMph: 28, condition: 'sunny',
        },
      ],
      next7Days: [
        {
          date: '2026-08-24', highF: 96, lowF: 66, precipitationProbability: 4, condition: 'sunny',
        },
        {
          date: '2026-08-25', highF: 93, lowF: 64, precipitationProbability: 6, condition: 'rainy',
        },
      ],
    },
  });

  assertLayout(frames[0].rows, [
    'bb WEATHER          bb',
    '',
    ` NOW 93${DEG} SUNNY`,
    ` HIGH 96${DEG} LOW 66${DEG}`,
    '',
    `bb TUE 93${DEG} RAIN 6%  bb`,
  ], 'weather');
});

test('a calm forecast leaves the notable row empty rather than inventing news', () => {
  const hourlies = [
    {
      time: '2026-08-24T13:00', precipitationProbability: 5, windSpeedMph: 6, condition: 'sunny',
    },
  ];
  assert.equal(alexa.notableHourly(hourlies), '');

  const rainy = [{ time: '2026-08-24T15:00', precipitationProbability: 60, windSpeedMph: 4 }];
  assert.equal(alexa.notableHourly(rainy), 'RAIN PM - 60%');
});

test('weather with no cache behind it renders nothing', () => {
  assert.deepEqual(alexa.weatherFrames({ type: 'weather.query', weather: null }), []);
  assert.deepEqual(alexa.weatherFrames({ type: 'weather.query', weather: {} }), []);
});

// ---------------------------------------------------------------------------
// A9. Indoor temperature
// ---------------------------------------------------------------------------

test('indoor temperature gives every named sensor its own row', () => {
  const frames = alexa.indoorTemperatureFrames({
    version: 2,
    type: 'indoor-temperature.query',
    metric: 'temperature',
    reading: {},
  }, {
    monitors: [
      { id: 'top', label: 'Top Floor', reading: { temperatureF: 75 } },
      { id: 'main', label: 'Main Floor', reading: { temperatureF: 76, humidity: 34 } },
      { id: 'machine', label: 'Machine Room', reading: { temperatureF: 71 } },
    ],
  });

  assertLayout(frames[0].rows, [
    'bb INDOOR TEMP      bb',
    ` TOP FLOOR        75${DEG}`,
    ` MAIN FLOOR       76${DEG}`,
    ` MACHINE ROOM     71${DEG}`,
    '',
    'bb HUMIDITY 34%     bb',
  ], 'indoor temperature');
});

test('a single spoken reading still fills the frame', () => {
  const frames = alexa.indoorTemperatureFrames({
    type: 'indoor-temperature.query',
    location: { label: 'Main Floor' },
    reading: {
      temperatureF: 76.4, humidity: 34, comfort: 'comfortable', source: 'smarthome',
    },
  });

  const drawn = formatLayout(frames[0].rows).split('\n');
  assert.match(drawn[2], new RegExp(`^ MAIN FLOOR\\s+76${DEG}$`));
  assert.match(drawn[5], /HUMIDITY 34%/);
});

test('an indoor query with no temperature anywhere renders nothing', () => {
  assert.deepEqual(
    alexa.indoorTemperatureFrames({ type: 'indoor-temperature.query', reading: { humidity: 34 } }),
    [],
  );
});

// ---------------------------------------------------------------------------
// A10. Air quality
// ---------------------------------------------------------------------------

test('air quality pairs each score with a band chip and a temperature', () => {
  const frames = alexa.airQualityFrames({
    version: 2,
    type: 'air-quality.query',
    monitors: [
      {
        id: 'main', label: 'Main Floor', iaqScore: 99, band: 'good', reading: { temperatureF: 76, humidity: 34 },
      },
      {
        id: 'machine', label: 'Machine Room', iaqScore: 99, band: 'good', reading: { temperatureF: 71 },
      },
      {
        id: 'dome', label: 'Dome', iaqScore: 66, band: 'fair', reading: { temperatureF: 114 },
      },
    ],
  });

  assertLayout(frames[0].rows, [
    'gg AIR QUALITY      gg',
    ` MAIN FLOOR   99g 76${DEG}`,
    ` MACHINE ROOM 99g 71${DEG}`,
    ` DOME        66y 114${DEG}`,
    '',
    'gg DOME RUNNING HOT gg',
  ], 'air quality');
});

test('the air quality footer says all clear only when nothing is wrong', () => {
  const one = (label, band, temperatureF) => ([{ label, band, temperatureF }]);

  assert.equal(alexa.airQualityInsight(one('MAIN FLOOR', 'good', 72)), 'ALL CLEAR');
  assert.equal(alexa.airQualityInsight(one('MAIN FLOOR', 'fair', 72)), 'MAIN FLOOR FAIR');
  assert.equal(alexa.airQualityInsight(one('MAIN FLOOR', 'poor', 72)), 'MAIN FLOOR POOR');
  // Heat outranks the band, because it is the finding you can act on.
  assert.equal(alexa.airQualityInsight(one('DOME', 'good', 114)), 'DOME RUNNING HOT');
  // Sixteen columns is the whole footer, so the phrase shortens before the
  // room name is cut to something meaningless.
  assert.equal(alexa.airQualityInsight(one('MAIN FLOOR', 'good', 96)), 'MAIN FLOOR HOT');
  assert.equal(alexa.airQualityInsight(one('BASEMENT WORKSHOP', 'good', 96)), 'BASEMENT WOR HOT');
});

test('every band has a chip, including the one the spec did not name', () => {
  // The parser emits five bands; the spec drawing only showed four.
  assert.deepEqual(alexa.BAND_CHIPS, {
    good: 'green',
    fair: 'yellow',
    moderate: 'orange',
    poor: 'red',
    unknown: 'white',
  });
});

test('monitors parsed from speech have no reading object and must not crash', () => {
  const frames = alexa.airQualityFrames({
    type: 'air-quality.query',
    monitors: [{
      id: 'main', label: 'Main Floor', iaqScore: 99, band: 'good', summary: 'good',
    }],
  });
  assert.equal(validate(frames[0].rows).ok, true);
  assert.match(formatLayout(frames[0].rows).split('\n')[1], /^ MAIN FLOOR\s+99g$/);
});

// ---------------------------------------------------------------------------
// A11. Music
// ---------------------------------------------------------------------------

test('now playing reads artist, album, track, room', () => {
  const frames = alexa.musicFrames({
    version: 2,
    type: 'music.playing',
    music: {
      song: 'May Ninth',
      artist: 'Khruangbin',
      album: 'A La Sala',
      provider: 'Amazon Music',
      state: 'PLAYING',
      device: 'Sonos Kitchen',
    },
  });

  assertLayout(frames[0].rows, [
    'vv NOW PLAYING      vv',
    ' KHRUANGBIN',
    ' A LA SALA',
    " 'MAY NINTH'",
    '',
    'vv SONOS KITCHEN    vv',
  ], 'music');
});

test('an idle or empty player is not now playing anything', () => {
  assert.deepEqual(alexa.musicFrames({ type: 'music.playing', music: null }), []);
  assert.deepEqual(
    alexa.musicFrames({
      type: 'music.playing',
      music: {
        song: null, artist: null, state: 'IDLE', empty: true,
      },
    }),
    [],
  );
});

test('a spoken now playing with no album closes up rather than leaving a hole', () => {
  const frames = alexa.musicFrames({
    type: 'music.playing',
    music: {
      song: 'Roygbiv', artist: 'Boards Of Canada', album: null, state: 'PLAYING', device: 'Office Echo', source: 'spoken',
    },
  });

  const drawn = formatLayout(frames[0].rows).split('\n');
  assert.match(drawn[1], /^ BOARDS OF CANADA$/);
  assert.match(drawn[2], /^ 'ROYGBIV'$/);
});

// ---------------------------------------------------------------------------
// A12. Notifications
// ---------------------------------------------------------------------------

test('notifications count first, then wrap the newest one', () => {
  const frames = alexa.notificationFrames({
    version: 2,
    type: 'alexa-notifications.query',
    notifications: {
      items: ['Amazon: package delivered today', 'Your order has shipped'],
      empty: false,
      summary: '2 notifications',
    },
  });

  assertLayout(frames[0].rows, [
    'yy NOTIFICATIONS    yy',
    ' 2 NEW',
    ' AMAZON: PACKAGE',
    ' DELIVERED TODAY',
    '',
    'yy                  yy',
  ], 'notifications');
});

test('no notifications means no frame', () => {
  assert.deepEqual(
    alexa.notificationFrames({ type: 'alexa-notifications.query', notifications: { items: [], empty: true } }),
    [],
  );
  assert.deepEqual(alexa.notificationFrames({ type: 'alexa-notifications.query' }), []);
});

test('delivery notifications use AMAZON DELIVERY title', () => {
  const frames = alexa.notificationFrames({
    type: 'alexa-notifications.query',
    notifications: {
      items: ['Your package was delivered today'],
      empty: false,
      summary: '1 delivery update',
      category: 'delivery',
      source: 'amazon-shopping',
    },
  });

  assertLayout(frames[0].rows, [
    'yy AMAZON DELIVERY  yy',
    ' 1 NEW',
    ' YOUR PACKAGE WAS',
    ' DELIVERED TODAY',
    '',
    'yy                  yy',
  ], 'amazon-delivery');
});

// ---------------------------------------------------------------------------
// A13. Vivint
// ---------------------------------------------------------------------------

test('an armed system shows a green chip at the edge of the row', () => {
  const frames = alexa.vivintFrames({
    version: 2,
    type: 'vivint-alarm.query',
    timestamp: new Date(2026, 7, 23, 22, 37).toISOString(),
    alarm: {
      status: 'armed',
      mode: 'stay',
      provider: 'Vivint',
      label: 'Alarm System Armed \u2014 Stay',
      modeLabel: 'Stay Mode',
    },
  });

  assertLayout(frames[0].rows, [
    'ww VIVINT           ww',
    '',
    ' SYSTEM: ARMED STAY g',
    '',
    '',
    'ww 10:37PM          ww',
  ], 'vivint armed');
});

test('a disarmed system is orange, because that is the state worth catching', () => {
  const frames = alexa.vivintFrames({
    type: 'vivint-alarm.query',
    timestamp: new Date(2026, 7, 23, 22, 37).toISOString(),
    alarm: { status: 'disarmed', mode: null, provider: 'Vivint' },
  });

  assertLayout(frames[0].rows, [
    'ww VIVINT           ww',
    '',
    ' SYSTEM: DISARMED   o',
    '',
    '',
    'ww 10:37PM          ww',
  ], 'vivint disarmed');
});

test('an unresolved alarm state is not reported as a state', () => {
  assert.deepEqual(
    alexa.vivintFrames({ type: 'vivint-alarm.query', alarm: { status: 'unknown' } }),
    [],
  );
  assert.deepEqual(alexa.vivintFrames({ type: 'vivint-alarm.query', alarm: null }), []);
});

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

test('every Alexa payload type the bridge sends has a formatter', () => {
  assert.deepEqual(Object.keys(alexa.FORMATTERS).sort(), [
    'air-quality.query',
    'alarm.snapshot',
    'alexa-notifications.query',
    'broadcast',
    'indoor-temperature.query',
    'music.playing',
    'reminder.fired',
    'shopping-list.snapshot',
    'smart-home.command',
    'time.query',
    'timer.snapshot',
    'vivint-alarm.query',
    'weather.query',
  ]);
});

test('framesFor dispatches on payload type and ignores everything else', () => {
  const frames = alexa.framesFor(broadcast('Kylie', 'Movie Theater Echo'));
  assert.equal(frames.length, 1);

  assert.deepEqual(alexa.framesFor({ type: 'steam.now-playing' }), []);
  assert.deepEqual(alexa.framesFor(null), []);
  assert.deepEqual(alexa.framesFor({}), []);
});

test('every formatter produces a valid layout for a bare payload', () => {
  // A formatter that throws on a thin payload takes the whole board offline,
  // so the contract is "frames or nothing", never an exception.
  for (const [type, formatter] of Object.entries(alexa.FORMATTERS)) {
    for (const ctx of [{}, { explicit: true }]) {
      const frames = formatter({ type }, ctx);
      assert.ok(Array.isArray(frames), `${type} returned a non-array`);
      for (const frame of frames) {
        assert.equal(validate(frame.rows).ok, true, `${type} produced an invalid layout`);
        assert.ok(frame.dwellSeconds > 0, `${type} has no dwell`);
        assert.ok(frame.source, `${type} has no source`);
      }
    }
  }
});

test('dates that cannot be parsed do not become Invalid Date on the board', () => {
  assert.equal(toDate('nonsense'), null);
  assert.equal(toDate(undefined), null);
  const frames = alexa.smartHomeFrames({
    type: 'smart-home.command',
    device: 'Office Echo',
    timestamp: 'nonsense',
    command: { action: 'off', matchedName: 'Movie Poster' },
  });
  assert.match(formatLayout(frames[0].rows).split('\n')[5], /^ww\s+ww$/);
});
