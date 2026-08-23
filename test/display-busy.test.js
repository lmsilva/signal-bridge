/**
 * `display.isBusy()` — the scheduler's §6 precedence check.
 *
 * The bridge had no busy concept before this; precedence was emergent from
 * whichever page overwrote the last one. These tests pin the contract the
 * scheduler relies on.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDisplayBusy, PERSISTENT_HOLD_SECONDS } = require('../src/display-busy');

function build(startAt = 1_000_000) {
  const clock = { t: startAt };
  return { clock, busy: createDisplayBusy({ now: () => clock.t }) };
}

test('a fresh bridge is not busy', () => {
  const { busy } = build();
  assert.equal(busy.isBusy(), false);
  assert.equal(busy.snapshot().busy, false);
});

test('a timed page holds the display for exactly its countdown', () => {
  const { clock, busy } = build();
  busy.noteSent({ type: 'weather.query', displaySeconds: 60 });
  assert.equal(busy.isBusy(), true);

  clock.t += 59 * 1000;
  assert.equal(busy.isBusy(), true, 'never interrupt a page mid-dismiss');
  clock.t += 2 * 1000;
  assert.equal(busy.isBusy(), false);
});

test('a variable-duration round holds for the whole sequence, not one card', () => {
  const { clock, busy } = build();
  // The bridge sizes a trivia round's displaySeconds to intro + n×(q+a) + summary.
  busy.noteSent({ type: 'trivia.round', displaySeconds: 274 });
  clock.t += 120 * 1000;
  assert.equal(busy.isBusy(), true, 'nothing may air between trivia question 2 and 3');
  clock.t += 160 * 1000;
  assert.equal(busy.isBusy(), false);
});

test('an explicit hold override beats the payloads own displaySeconds', () => {
  const { clock, busy } = build();
  busy.noteSent({ type: 'trivia.round', displaySeconds: 30 }, { holdSeconds: 300 });
  clock.t += 60 * 1000;
  assert.equal(busy.isBusy(), true);
});

test('a persistent page stays busy but cannot wedge the display forever', () => {
  const { clock, busy } = build();
  busy.noteSent({ type: 'steam.now-playing', persistent: true, displaySeconds: 0 });
  clock.t += 60 * 60 * 1000;
  assert.equal(
    busy.isBusy(), false,
    'a client that dies without sending a close must not lock the scheduler out',
  );
  assert.ok(PERSISTENT_HOLD_SECONDS > 0);
});

test('a close payload frees the display immediately', () => {
  const { busy } = build();
  busy.noteSent({ type: 'steam.now-playing', persistent: true });
  assert.equal(busy.isBusy(), true);
  busy.noteSent({ type: 'steam.now-playing.close' });
  assert.equal(busy.isBusy(), false);
});

test('a close for a different page does not free the current one', () => {
  const { busy } = build();
  busy.noteSent({ type: 'psn.now-playing', persistent: true });
  busy.noteSent({ type: 'steam.now-playing.close' });
  assert.equal(busy.isBusy(), true);
});

test('announces, heartbeats and remote input are not pages', () => {
  const { busy } = build();
  for (const type of [
    'display.announce', 'display.discover', 'bridge.hello',
    'input.click', 'input.key', 'input.text', 'system.command',
  ]) {
    busy.noteSent({ type, displaySeconds: 60 });
    assert.equal(busy.isBusy(), false, `${type} must not mark the display busy`);
  }
});

test('a later page extends the hold from its own start', () => {
  const { clock, busy } = build();
  busy.noteSent({ type: 'weather.query', displaySeconds: 30 });
  clock.t += 20 * 1000;
  busy.noteSent({ type: 'timer.snapshot', displaySeconds: 45 });
  clock.t += 30 * 1000;
  assert.equal(busy.isBusy(), true, 'the newer page has its own countdown');
  assert.equal(busy.snapshot().type, 'timer.snapshot');
});

test('the snapshot reports what is on screen, how it got there and for how long', () => {
  const { clock, busy } = build();
  busy.noteSent({ type: 'photo.slideshow', displaySeconds: 180 }, { source: 'manual' });
  clock.t += 30 * 1000;
  const snapshot = busy.snapshot();
  assert.equal(snapshot.busy, true);
  assert.equal(snapshot.type, 'photo.slideshow');
  assert.equal(snapshot.source, 'manual');
  assert.equal(snapshot.remainingSeconds, 150);
  assert.ok(snapshot.until);
});

test('release clears the hold for an explicit interrupt', () => {
  const { busy } = build();
  busy.noteSent({ type: 'weather.query', displaySeconds: 600 });
  busy.release();
  assert.equal(busy.isBusy(), false);
});

test('a payload with no type is ignored', () => {
  const { busy } = build();
  busy.noteSent({});
  busy.noteSent(null);
  assert.equal(busy.isBusy(), false);
});

test('a late air-quality refresh does not overwrite a newer Steam or PSN page', () => {
  // Admin sequence 2026-08-22: Indoor Air Quality (cached preview + slow
  // enrich) → Steam last-played → PSN last-played. The AQ sensor fetch
  // used to finish after Steam was already up and yank it off the display.
  const { busy } = build();
  const airQuality = busy.beginSendRequest();
  assert.equal(airQuality.maySend(), true);
  busy.noteSent({ type: 'air-quality.query', displaySeconds: 120 });
  airQuality.rememberSent();
  assert.equal(airQuality.maySend(), true, 'the same command may refresh its own preview');

  busy.noteSent({ type: 'steam.now-playing', displaySeconds: 90 });
  assert.equal(airQuality.maySend(), false, 'Steam took the display — drop the stale AQ enrich');

  busy.noteSent({ type: 'psn.now-playing', displaySeconds: 90 });
  assert.equal(airQuality.maySend(), false);
  assert.equal(busy.snapshot().type, 'psn.now-playing');
});

test('an unsent slow command is dropped if another page landed first', () => {
  const { busy } = build();
  const airQuality = busy.beginSendRequest();
  busy.noteSent({ type: 'steam.now-playing', displaySeconds: 90 });
  assert.equal(airQuality.maySend(), false);
});
