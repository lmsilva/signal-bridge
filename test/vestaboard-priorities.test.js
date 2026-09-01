'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  defaultPriorities,
  normalisePriorities,
  catalogForClient,
  applyPolicy,
  MIN_HOLD_MINUTES,
  MAX_HOLD_MINUTES,
} = require('../src/vestaboard/priorities');
const { classify } = require('../src/vestaboard/holds');

test('house defaults jump household interrupts and hold only live games', () => {
  const defaults = defaultPriorities();
  assert.deepEqual(defaults.map((rule) => rule.source), [
    'alarm.fired',
    'timer.fired',
    'reminder.fired',
    'ring.doorbell',
    'broadcast',
    'word.scramble',
    'huupe.session',
    'autodarts.match',
  ]);
  assert.ok(defaults.every((rule) => rule.jump));
  assert.deepEqual(
    defaults.filter((rule) => rule.hold).map((rule) => rule.source),
    ['word.scramble', 'huupe.session', 'autodarts.match'],
  );
});

test('null priorities become the house defaults; an empty list means nothing jumps', () => {
  assert.equal(normalisePriorities(null).length, defaultPriorities().length);
  assert.deepEqual(normalisePriorities([]), []);
  assert.equal(normalisePriorities({ nope: true }).length, defaultPriorities().length);
});

test('unknown sources, duplicates and hold-without-jump are cleaned up', () => {
  const list = normalisePriorities([
    { source: 'not.a.thing', jump: true },
    { source: 'alarm.fired', jump: true, hold: true, holdMinutes: 9 },
    { source: 'alarm.fired', jump: true },
    { source: 'huupe.session', jump: false, hold: true, holdMinutes: 999 },
  ]);
  assert.equal(list.length, 2);
  assert.equal(list[0].source, 'alarm.fired');
  assert.equal(list[0].hold, true);
  assert.equal(list[0].jump, true);
  assert.equal(list[0].holdMinutes, 9);
  assert.equal(list[1].source, 'huupe.session');
  assert.equal(list[1].jump, true);
  assert.equal(list[1].holdMinutes, MAX_HOLD_MINUTES);
});

test('hold minutes clamp to a safety window', () => {
  assert.equal(normalisePriorities([
    { source: 'word.scramble', hold: true, holdMinutes: 0 },
  ])[0].holdMinutes, MIN_HOLD_MINUTES);
  const catalog = catalogForClient();
  assert.ok(catalog.events.some((item) => item.source === 'alarm.fired' && item.holdCaution));
  assert.ok(catalog.defaults.length);
});

test('an unlisted event just queues, even when it is an alarm', () => {
  const hold = classify({ type: 'alarm.fired' }, 'alarm.fired', null, { priorities: [] });
  assert.equal(hold.lane, 'rotation');
  assert.equal(hold.jump, false);
  assert.equal(hold.hold, false);
});

test('a listed jumper that does not hold is an alert with no lock', () => {
  const hold = classify({ type: 'alarm.fired' }, 'alarm.fired');
  assert.equal(hold.lane, 'alert');
  assert.equal(hold.jump, true);
  assert.equal(hold.hold, false);
  assert.equal(hold.live, false);
  assert.ok(hold.rank > 0);
});

test('a listed hold is a game with a safety timeout', () => {
  const hold = classify({ type: 'huupe.session' }, 'huupe.session');
  assert.equal(hold.lane, 'game');
  assert.equal(hold.hold, true);
  assert.equal(hold.ttlMs, 30 * 60 * 1000);
});

test('YouTube can hold when the board asks it to', () => {
  const hold = classify(
    { type: 'youtube.now-playing', youtube: { mode: 'playing' } },
    'youtube.now-playing',
    null,
    {
      priorities: [
        { source: 'youtube.now-playing', jump: true, hold: true, holdMinutes: 90 },
      ],
    },
  );
  assert.equal(hold.lane, 'game');
  assert.equal(hold.hold, true);
  assert.equal(hold.ttlMs, 90 * 60 * 1000);
});

test('list order is relative rank — first item outranks the rest', () => {
  const alarm = classify({ type: 'alarm.fired' }, 'alarm.fired');
  const huupe = classify({ type: 'huupe.session' }, 'huupe.session');
  assert.ok(alarm.rank > huupe.rank);

  const flipped = [
    { source: 'huupe.session', jump: true, hold: true, holdMinutes: 15 },
    { source: 'alarm.fired', jump: true, hold: false, holdMinutes: 15 },
  ];
  const gameFirst = classify({ type: 'huupe.session' }, 'huupe.session', null, { priorities: flipped });
  const alarmSecond = classify({ type: 'alarm.fired' }, 'alarm.fired', null, { priorities: flipped });
  assert.ok(gameFirst.rank > alarmSecond.rank);
});

test('priority command→source aliases stay in step with the router', () => {
  const { COMMAND_TO_TYPE } = require('../src/vestaboard/router');
  const { COMMAND_SOURCE } = require('../src/vestaboard/priorities');
  for (const [id, type] of Object.entries(COMMAND_TO_TYPE)) {
    assert.equal(COMMAND_SOURCE[id], type, id);
  }
});

test('the add-event catalog includes board pushes like Roast Me and Dad Jokes', () => {
  const catalog = catalogForClient();
  const sources = new Set(catalog.events.map((item) => item.source));
  for (const source of [
    'roast.me',
    'dad.jokes',
    'chuck.facts',
    'family.quotes',
    'word.riddles',
    'weather.query',
    'trivia.round',
    'guest.book',
    'alarm.fired',
  ]) {
    assert.ok(sources.has(source), `missing ${source}`);
  }
  assert.ok(catalog.events.length >= 40, `expected a full catalog, got ${catalog.events.length}`);
  assert.ok(catalog.groups.some((group) => group.id === 'language'));
});

test('applyPolicy never lets last-played pin the board', () => {
  const hold = applyPolicy({
    kind: 'watch',
    source: 'youtube.now-playing',
    sessionLive: false,
    close: false,
    coalesceKey: 'youtube.now-playing',
  }, [{ source: 'youtube.now-playing', jump: true, hold: true, holdMinutes: 90 }]);
  assert.equal(hold.lane, 'rotation');
  assert.equal(hold.hold, false);
});
