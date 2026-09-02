'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { classify, LANES, CLOSE_TO_SOURCE } = require('../src/vestaboard/holds');

test('alarms, timers, reminders, the doorbell and a spoken announce are the alert lane', () => {
  for (const type of ['alarm.fired', 'timer.fired', 'reminder.fired', 'ring.doorbell', 'broadcast']) {
    const hold = classify({ type }, type);
    assert.equal(hold.lane, 'alert');
    assert.equal(hold.jump, true);
    assert.equal(hold.hold, false);
    assert.ok(hold.rank > LANES.game);
    assert.equal(hold.source, type);
  }

  const firedAlarm = classify({
    type: 'alarm.snapshot',
    event: { kind: 'fired', alarm: { label: 'Bedroom' } },
  }, 'alarm.snapshot');
  assert.equal(firedAlarm.lane, 'alert');
  assert.equal(firedAlarm.source, 'alarm.fired');

  const list = classify({ type: 'alarm.snapshot', alarms: [] }, 'alarm.snapshot');
  assert.equal(list.lane, 'rotation');
});

test('weather alerts and space-launch cards are rotation, not alarms', () => {
  assert.equal(classify({ type: 'weather.alerts' }, 'weather.alerts').lane, 'rotation');
  assert.equal(classify({ type: 'launch.alert' }, 'launch.alert').lane, 'rotation');
});

test('word scramble, party prompts, huupe live and autodarts live are games', () => {
  assert.equal(classify({ type: 'word.scramble' }, 'word.scramble').lane, 'game');
  assert.equal(classify({ type: 'word.scramble' }, 'word.scramble').coalesceKey, null);

  const prompts = classify({ type: 'party.prompts' }, 'party.prompts');
  assert.equal(prompts.lane, 'game');
  assert.equal(prompts.source, 'party.prompts');
  // Prompt, ballot, winner — collapsing them would skip the reveal.
  assert.equal(prompts.coalesceKey, null);

  const wheel = classify({ type: 'wheel.fortune' }, 'wheel.fortune');
  assert.equal(wheel.lane, 'game');
  assert.equal(wheel.source, 'wheel.fortune');
  assert.equal(wheel.coalesceKey, null);

  // Every letter called repaints the word; coalescing would eat the misses.
  const hangman = classify({ type: 'hangman.game' }, 'hangman.game');
  assert.equal(hangman.lane, 'game');
  assert.equal(hangman.source, 'hangman.game');
  assert.equal(hangman.coalesceKey, null);

  const huupe = classify({ type: 'huupe.session', session: { status: 'live' } }, 'huupe.session');
  assert.equal(huupe.lane, 'game');
  assert.equal(huupe.live, true);
  assert.equal(huupe.coalesceKey, 'huupe.session');

  const darts = classify({ type: 'autodarts.match', match: { status: 'live' } }, 'autodarts.match');
  assert.equal(darts.lane, 'game');
  assert.equal(darts.live, true);
});

test('a finished huupe or autodarts card stays a game so the final can hold', () => {
  const huupe = classify({ type: 'huupe.session', session: { status: 'finished' } }, 'huupe.session');
  assert.equal(huupe.lane, 'game');
  assert.equal(huupe.live, false);

  const darts = classify({ type: 'autodarts.match', match: { status: 'finished' } }, 'autodarts.match');
  assert.equal(darts.lane, 'game');
  assert.equal(darts.live, false);
});

test('a missing session status still counts as live so score updates coalesce', () => {
  const huupe = classify({ type: 'huupe.session' }, 'huupe.session');
  assert.equal(huupe.live, true);
  assert.equal(huupe.coalesceKey, 'huupe.session');
});

test('detected now-playing just queues; last-played is rotation too', () => {
  const yt = classify({ type: 'youtube.now-playing', youtube: { mode: 'playing' } }, 'youtube.now-playing');
  assert.equal(yt.lane, 'rotation');
  assert.equal(yt.hold, false);
  assert.equal(yt.live, false);

  const ytLast = classify({ type: 'youtube.now-playing', youtube: { mode: 'last-played' } }, 'youtube.now-playing');
  assert.equal(ytLast.lane, 'rotation');
  assert.equal(ytLast.live, false);

  const plex = classify({ type: 'plex.now-playing', plex: { mode: 'now-playing' } }, 'plex.now-playing');
  assert.equal(plex.lane, 'rotation');

  const plexLast = classify({ type: 'plex.now-playing', plex: { mode: 'last-played' } }, 'plex.now-playing');
  assert.equal(plexLast.lane, 'rotation');

  const steam = classify({ type: 'steam.now-playing', steam: { mode: 'playing' } }, 'steam.now-playing');
  assert.equal(steam.lane, 'rotation');

  const psn = classify({ type: 'psn.now-playing', psn: { mode: 'playing' } }, 'psn.now-playing');
  assert.equal(psn.lane, 'rotation');
});

test('close payloads name the source they release', () => {
  for (const [type, source] of Object.entries(CLOSE_TO_SOURCE)) {
    const hold = classify({ type }, type);
    assert.equal(hold.close, true);
    assert.equal(hold.source, source);
    assert.equal(hold.live, false);
  }
});

test('a tesla battery ask shares one waiting page', () => {
  const battery = classify({ type: 'tesla-battery.query' }, 'tesla-battery.query');
  assert.equal(battery.lane, 'rotation');
  assert.equal(battery.coalesceKey, 'tesla-battery.query');
  const dashboard = classify({ type: 'tesla-dashboard.query' }, 'tesla-dashboard.query');
  assert.equal(dashboard.coalesceKey, 'tesla-dashboard.query');
});

test('dashboards, guest book and clocks just queue', () => {
  for (const type of [
    'huupe.dashboard',
    'autodarts.dashboard',
    'guest.book',
    'weather.query',
    'calendar.clock',
    'music.playing',
    'overhead.round',
  ]) {
    assert.equal(classify({ type }, type).lane, 'rotation', type);
  }
});

test('a frame source is enough when tests submit without a payload', () => {
  const hold = classify({}, 'huupe.session', 'huupe.session');
  assert.equal(hold.lane, 'game');
  assert.equal(hold.live, true);
});
