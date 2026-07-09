const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  zonedLocalToUtcMs,
  resolveAlarmTimeZone,
} = require('../src/alarm-timezone');

test('zonedLocalToUtcMs converts Denver local time to UTC', () => {
  const utcMs = zonedLocalToUtcMs('2026-07-09', '08:00:00.000', 'America/Denver');
  assert.ok(utcMs);

  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Denver',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(utcMs));
  assert.match(formatted, /8:00/);
});

test('resolveAlarmTimeZone prefers notification timeZoneId', () => {
  assert.equal(
    resolveAlarmTimeZone({ timeZoneId: 'America/Los_Angeles' }, { localTimeZone: 'America/Denver' }),
    'America/Los_Angeles',
  );
});

test('resolveAlarmTimeZone falls back to configured localTimeZone', () => {
  assert.equal(resolveAlarmTimeZone({}, { localTimeZone: 'America/Chicago' }), 'America/Chicago');
});
