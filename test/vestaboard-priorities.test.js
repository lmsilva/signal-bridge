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
    'party.prompts',
    'wheel.fortune',
    'huupe.session',
    'autodarts.match',
  ]);
  assert.ok(defaults.every((rule) => rule.jump));
  assert.ok(defaults.every((rule) => rule.immediate));
  assert.deepEqual(
    defaults.filter((rule) => rule.hold).map((rule) => rule.source),
    ['word.scramble', 'party.prompts', 'wheel.fortune', 'huupe.session', 'autodarts.match'],
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
  assert.equal(hold.immediate, true);
  assert.equal(hold.hold, false);
  assert.equal(hold.live, false);
  assert.ok(hold.rank > 0);
});

test('immediate false keeps jump but does not cut in', () => {
  const hold = classify(
    { type: 'alarm.fired' },
    'alarm.fired',
    null,
    {
      priorities: [
        { source: 'alarm.fired', jump: true, immediate: false, hold: false, holdMinutes: 15 },
      ],
    },
  );
  assert.equal(hold.jump, true);
  assert.equal(hold.immediate, false);
  assert.equal(hold.lane, 'alert');
});

test('omitted immediate on a saved rule still means cut in', () => {
  const list = normalisePriorities([
    { source: 'alarm.fired', jump: true, hold: false, holdMinutes: 15 },
  ]);
  assert.equal(list[0].immediate, true);
  const off = normalisePriorities([
    { source: 'alarm.fired', jump: true, immediate: false, hold: false, holdMinutes: 15 },
  ]);
  assert.equal(off[0].immediate, false);
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
    'party.prompts',
    'wheel.fortune',
    'word.scramble',
    'roll-credits.tour',
  ]) {
    assert.ok(sources.has(source), `missing ${source}`);
  }
  assert.ok(catalog.events.length >= 40, `expected a full catalog, got ${catalog.events.length}`);
  assert.ok(catalog.groups.some((group) => group.id === 'language'));
});

test('the add-event catalog hides phase cards and command aliases', () => {
  const catalog = catalogForClient();
  for (const item of catalog.events) {
    assert.doesNotMatch(
      item.source,
      /^(party\.prompts|wheel\.fortune|word\.scramble)\./,
      `${item.source} is a card of a game, not its own event`,
    );
    assert.notEqual(item.source, 'credits.show');
    assert.notEqual(item.label, item.source, `${item.source} needs a friendly name`);
  }
  const rollCredits = catalog.events.find((item) => item.source === 'roll-credits.tour');
  assert.equal(rollCredits?.label, 'Roll Credits');
});

test('priority labels match Push command titles', () => {
  const { COMMANDS, kindsOf } = require('../src/command-registry');
  const { COMMAND_SOURCE } = require('../src/vestaboard/priorities');
  const bySource = new Map(catalogForClient().events.map((item) => [item.source, item.label]));

  assert.equal(bySource.get('ring.doorbell'), 'Ring Doorbell');
  assert.equal(bySource.get('steam.now-playing'), 'Steam');
  assert.equal(bySource.get('psn.now-playing'), 'PSN');
  assert.equal(bySource.get('youtube.now-playing'), 'YouTube');
  assert.equal(bySource.get('plex.now-playing'), 'Feature Presentation');
  assert.equal(bySource.get('huupe.session'), 'Huupe Live');
  assert.equal(bySource.get('autodarts.match'), 'Autodarts');
  assert.equal(bySource.get('word.scramble'), 'Word Scramble');
  assert.equal(bySource.get('wheel.fortune'), 'Wheel of Fortune');
  assert.equal(bySource.get('guest.book'), 'Guest Book');

  for (const command of COMMANDS) {
    if (!kindsOf(command).includes('vestaboard')) continue;
    if (command.pushable === false) continue;
    if (/\.(last-played|last-match|last-game)$/.test(command.id)) continue;
    const source = COMMAND_SOURCE[command.id] || command.id;
    const label = bySource.get(source);
    // First pushable title for a shared source wins (Next Flight before Trip Board).
    if (!label) continue;
    const primary = COMMANDS.find((candidate) => (
      kindsOf(candidate).includes('vestaboard')
      && candidate.pushable !== false
      && !/\.(last-played|last-match|last-game)$/.test(candidate.id)
      && (COMMAND_SOURCE[candidate.id] || candidate.id) === source
    ));
    if (primary && primary.id === command.id) {
      assert.equal(label, command.title, `${source} should be titled like ${command.id}`);
    }
  }
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
