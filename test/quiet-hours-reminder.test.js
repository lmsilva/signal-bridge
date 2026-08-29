'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { validate } = require('../src/vestaboard/encoder');
const { parseLayout, formatLayout } = require('../src/vestaboard/notation');
const { quietHoursReminderFrames } = require('../src/vestaboard/formatters/feeds');
const {
  VARIANT_IDS,
  DRAWINGS,
  pickVariant,
  buildQuietHoursReminderPayload,
  layoutFor,
  formatQuietEnd,
  quietHoursPeriodId,
  minutesSinceQuietStart,
  shouldFireQuietHoursReminder,
  createQuietHoursReminder,
  createQuietHoursWatch,
} = require('../src/quiet-hours-reminder');

const OVERNIGHT = { start: '22:00', end: '07:00', enabled: true, remindOnStart: true };

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

function atHour(hour, minute = 0, day = 28) {
  return new Date(2026, 7, day, hour, minute, 0);
}

test('every Quiet Hours Reminder variant is a valid 6x22 night card', () => {
  for (const id of VARIANT_IDS) {
    const payload = {
      type: 'quiet-hours.reminder',
      variant: id,
      window: { start: '22:00', end: '07:00' },
    };
    const frames = quietHoursReminderFrames(payload);
    assert.equal(frames.length, 1, id);
    assert.equal(validate(frames[0].rows).ok, true, `${id} failed validation`);
    assert.equal(frames[0].source, 'quiet-hours.reminder');
    assert.equal(frames[0].label, 'Quiet hours');
  }
});

test('the marketplace-style moon, SHHH, and star cards match their drawings', () => {
  assertLayout(layoutFor({ variant: 'moon' }), DRAWINGS.moon, 'moon');
  assertLayout(layoutFor({ variant: 'shhh' }), DRAWINGS.shhh, 'shhh');
  assertLayout(layoutFor({ variant: 'stars' }), DRAWINGS.stars, 'stars');
});

test('the until card names the quiet-hours end in 12-hour form', () => {
  assert.equal(formatQuietEnd('07:00'), 'UNTIL 7AM');
  assert.equal(formatQuietEnd('22:30'), 'UNTIL 10:30PM');
  assertLayout(layoutFor({
    variant: 'until',
    window: { start: '22:00', end: '07:00' },
  }), [
    'vv                  vv',
    '                      ',
    '      QUIET HOURS     ',
    '       UNTIL 7AM      ',
    '                      ',
    'vv                  vv',
  ], 'until');
});

test('pickVariant skips the last card when another is available', () => {
  const picks = new Set();
  for (let i = 0; i < 40; i += 1) {
    picks.add(pickVariant('moon', { random: () => i / 40 }));
  }
  assert.equal(picks.has('moon'), false);
  assert.ok(picks.size >= 3);
  assert.equal(pickVariant(null, { random: () => 0 }), VARIANT_IDS[0]);
});

test('buildQuietHoursReminderPayload randomizes and carries the window', () => {
  const payload = buildQuietHoursReminderPayload({
    lastVariant: 'moon',
    quietHours: OVERNIGHT,
    now: atHour(22),
    random: () => 0,
  });
  assert.equal(payload.type, 'quiet-hours.reminder');
  assert.notEqual(payload.variant, 'moon');
  assert.equal(payload.window.end, '07:00');
  assert.ok(Date.parse(payload.asOf));
});

test('an overnight window keeps one period id from 22:00 through 06:59', () => {
  assert.equal(quietHoursPeriodId(atHour(21, 59), OVERNIGHT), null);
  assert.equal(quietHoursPeriodId(atHour(22), OVERNIGHT), '2026-08-28');
  assert.equal(quietHoursPeriodId(atHour(23, 30), OVERNIGHT), '2026-08-28');
  assert.equal(quietHoursPeriodId(atHour(2, 0, 29), OVERNIGHT), '2026-08-28');
  assert.equal(quietHoursPeriodId(atHour(6, 59, 29), OVERNIGHT), '2026-08-28');
  assert.equal(quietHoursPeriodId(atHour(7, 0, 29), OVERNIGHT), null);
  assert.equal(minutesSinceQuietStart(atHour(22, 2), OVERNIGHT), 2);
  assert.equal(minutesSinceQuietStart(atHour(0, 10, 29), OVERNIGHT), 130);
});

test('shouldFire is the rising edge, never a 3am first sample', () => {
  assert.equal(shouldFireQuietHoursReminder({
    nowIn: true,
    wasIn: undefined,
    periodId: '2026-08-28',
    lastPeriodId: null,
    minutesSinceStart: 1,
  }), false, 'first boot in-window does not flip');

  assert.equal(shouldFireQuietHoursReminder({
    nowIn: true,
    wasIn: false,
    periodId: '2026-08-28',
    lastPeriodId: '2026-08-27',
    minutesSinceStart: 0,
  }), true, '22:00 rising edge fires');

  assert.equal(shouldFireQuietHoursReminder({
    nowIn: true,
    wasIn: true,
    periodId: '2026-08-28',
    lastPeriodId: '2026-08-28',
    minutesSinceStart: 40,
  }), false, 'already posted this period');

  assert.equal(shouldFireQuietHoursReminder({
    nowIn: true,
    wasIn: undefined,
    periodId: '2026-08-28',
    lastPeriodId: '2026-08-27',
    minutesSinceStart: 8,
  }), true, 'restart a few minutes after start still catches');

  assert.equal(shouldFireQuietHoursReminder({
    nowIn: true,
    wasIn: undefined,
    periodId: '2026-08-28',
    lastPeriodId: '2026-08-27',
    minutesSinceStart: 180,
  }), false, '3am restart does not catch');
});

test('the watcher fires once per board when quiet hours start', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qhr-'));
  const reminder = createQuietHoursReminder({
    persistPath: path.join(root, 'quiet-hours-reminder.json'),
  });
  const pushed = [];
  let clock = atHour(21, 50);
  const watch = createQuietHoursWatch({
    reminder,
    getBoards: () => [{
      id: 'kitchen',
      enabled: true,
      quietHours: OVERNIGHT,
    }],
    pushEvent: (payload, options) => pushed.push({ payload, options }),
    now: () => clock,
    timeZone: null,
    setTimer: () => 1,
    clearTimer: () => {},
  });

  watch.start();
  assert.equal(pushed.length, 0, 'first sample before the window is a seed');

  clock = atHour(22, 0);
  watch.tick(clock);
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].payload.type, 'quiet-hours.reminder');
  assert.equal(pushed[0].options.targetId, 'kitchen');
  assert.equal(pushed[0].options.quietHoursExempt, true);
  assert.ok(VARIANT_IDS.includes(pushed[0].payload.variant));

  clock = atHour(22, 15);
  watch.tick(clock);
  assert.equal(pushed.length, 1, 'the same period does not fire again');

  clock = atHour(7, 0, 29);
  watch.tick(clock);
  clock = atHour(22, 0, 29);
  watch.tick(clock);
  assert.equal(pushed.length, 2, 'the next night fires again');
  assert.notEqual(pushed[1].payload.variant, pushed[0].payload.variant);

  watch.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

test('the watcher does not fire on a boot that is already inside quiet hours', () => {
  const reminder = createQuietHoursReminder();
  const pushed = [];
  const watch = createQuietHoursWatch({
    reminder,
    getBoards: () => [{
      id: 'sim',
      enabled: true,
      quietHours: OVERNIGHT,
    }],
    pushEvent: (payload) => pushed.push(payload),
    now: () => atHour(3, 0, 29),
    timeZone: null,
    setTimer: () => 1,
    clearTimer: () => {},
  });
  watch.start();
  assert.equal(pushed.length, 0);
  watch.stop();
});

test('remindOnStart false skips a board even at 22:00', () => {
  const reminder = createQuietHoursReminder();
  const pushed = [];
  let clock = atHour(21, 50);
  const watch = createQuietHoursWatch({
    reminder,
    getBoards: () => [{
      id: 'office',
      enabled: true,
      quietHours: { ...OVERNIGHT, remindOnStart: false },
    }],
    pushEvent: (payload) => pushed.push(payload),
    now: () => clock,
    timeZone: null,
    setTimer: () => 1,
    clearTimer: () => {},
  });
  watch.start();
  clock = atHour(22, 0);
  watch.tick(clock);
  assert.equal(pushed.length, 0);
  watch.stop();
});
