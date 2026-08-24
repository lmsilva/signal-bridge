/**
 * The board send queue (01 §7).
 *
 * Everything here runs on an injected clock and a fake transport, so the
 * fifteen-second pacing rules can be checked exactly rather than approximately.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createQueue,
  inQuietHours,
  parseHhMm,
  RETRY_DELAYS_MS,
} = require('../src/vestaboard/queue');

const SECOND = 1000;

function frame(label, seed, { dwellSeconds = 15, source = null } = {}) {
  const rows = Array.from({ length: 6 }, () => new Array(22).fill(0));
  rows[0][0] = seed;
  return { rows, dwellSeconds, label, source: source || label };
}

/** A transport whose next answer the test decides. */
function fakeTransport(initial = { ok: true, reason: 'ok', status: 200 }) {
  const posts = [];
  let answer = initial;
  return {
    posts,
    answerWith(next) { answer = next; },
    async post(layout, options) {
      posts.push({ layout, options });
      return answer;
    },
  };
}

function silentLog() {
  const lines = [];
  const push = (level) => (message) => lines.push(`${level} ${message}`);
  return {
    lines, info: push('INFO'), warn: push('WARN'), error: push('ERROR'), debug: push('DEBUG'),
  };
}

/** A queue wired to a clock the test drives by hand. */
function makeQueue(boardOverrides = {}) {
  let clock = 1_000_000;
  const transport = fakeTransport();
  const log = silentLog();
  const queue = createQueue({
    board: {
      id: 'sim',
      rateWindowSeconds: 15,
      minRotationGapSeconds: 600,
      ...boardOverrides,
    },
    transport,
    log,
    now: () => clock,
  });
  return {
    queue,
    transport,
    log,
    advance(ms) { clock += ms; },
    at() { return clock; },
  };
}

test('the first frame goes straight to the board', async () => {
  const h = makeQueue();
  h.queue.submit([frame('SHOPPING', 1)]);

  assert.equal(await h.queue.tick(), 'posted');
  assert.equal(h.transport.posts.length, 1);
  assert.equal(h.queue.pending().length, 0);
});

test('a second frame waits out the board rate window', async () => {
  const h = makeQueue();
  h.queue.submit([frame('ONE', 1)]);
  await h.queue.tick();

  h.queue.submit([frame('TWO', 2)]);
  h.advance(14 * SECOND);
  assert.equal(await h.queue.tick(), null, 'too soon');
  assert.equal(h.transport.posts.length, 1);

  h.advance(1 * SECOND);
  assert.equal(await h.queue.tick(), 'posted');
  assert.equal(h.transport.posts.length, 2);
});

test('pages of one sequence turn at their own dwell, not just the rate window', async () => {
  const h = makeQueue({ rateWindowSeconds: 15 });
  h.queue.submit([
    frame('SHOPPING 1/2', 1, { dwellSeconds: 25 }),
    frame('SHOPPING 2/2', 2, { dwellSeconds: 25 }),
  ]);

  assert.equal(await h.queue.tick(), 'posted');

  // The rate window has passed but the first page has not had its time.
  h.advance(16 * SECOND);
  assert.equal(await h.queue.tick(), null);

  h.advance(10 * SECOND);
  assert.equal(await h.queue.tick(), 'posted');
  assert.equal(h.transport.posts.length, 2);
});

test('an alert jumps the line and throws away the rotation it interrupted', async () => {
  const h = makeQueue();
  h.queue.submit([frame('PAGE 1', 1), frame('PAGE 2', 2), frame('PAGE 3', 3)]);
  await h.queue.tick();

  h.queue.submit([frame('TIMER', 9)], { priority: 'alert' });

  const labels = h.queue.pending().map((item) => item.label);
  assert.deepEqual(labels, ['TIMER'], 'pending pages are dropped, not resumed later');

  h.advance(15 * SECOND);
  assert.equal(await h.queue.tick(), 'posted');
  assert.equal(h.transport.posts[1].layout[0][0], 9);
});

test('once an alert has had its time the board goes back to what it covered', async () => {
  const h = makeQueue();
  h.queue.submit([frame('WEATHER', 1)]);
  await h.queue.tick();

  h.advance(15 * SECOND);
  h.queue.submit([frame('TIMER', 9, { dwellSeconds: 20 })], { priority: 'alert' });
  await h.queue.tick();

  // Still inside the alert's dwell — nothing to restore yet.
  h.advance(10 * SECOND);
  assert.equal(await h.queue.tick(), null);
  assert.equal(h.queue.pending().length, 0);

  h.advance(11 * SECOND);
  assert.equal(await h.queue.tick(), null, 'the restore is queued, not posted, on this tick');
  assert.deepEqual(h.queue.pending().map((i) => i.label), ['WEATHER']);

  assert.equal(await h.queue.tick(), 'posted');
  assert.equal(h.transport.posts[2].layout[0][0], 1, 'the weather snapshot is back');
});

test('a layout identical to what is showing is dropped instead of posted', async () => {
  const h = makeQueue();
  h.queue.submit([frame('SAME', 1)]);
  await h.queue.tick();

  h.queue.submit([frame('SAME AGAIN', 1)]);
  h.advance(15 * SECOND);

  assert.equal(await h.queue.tick(), 'duplicate');
  assert.equal(h.transport.posts.length, 1, 'the board would not have flipped anyway');
  assert.equal(h.queue.pending().length, 0);
});

test('repeats for one device replace each other rather than stacking flips', async () => {
  const h = makeQueue();
  h.queue.submit([frame('ONE', 1)]);
  await h.queue.tick();

  h.queue.submit([frame('LIGHTS ON', 2)], { coalesceKey: 'smart-home.command:kitchen' });
  h.advance(60 * SECOND);
  h.queue.submit([frame('LIGHTS ON AGAIN', 3)], { coalesceKey: 'smart-home.command:kitchen' });

  const labels = h.queue.pending().map((item) => item.label);
  assert.deepEqual(labels, ['LIGHTS ON AGAIN'], 'one flip, carrying the newest state');

  assert.equal(await h.queue.tick(), 'posted');
  assert.equal(h.transport.posts[1].layout[0][0], 3);
});

test('a different device keeps its own place in the queue', async () => {
  const h = makeQueue();
  h.queue.submit([frame('KITCHEN', 1)], { coalesceKey: 'smart-home.command:kitchen' });
  h.queue.submit([frame('PORCH', 2)], { coalesceKey: 'smart-home.command:porch' });

  assert.deepEqual(h.queue.pending().map((i) => i.label), ['KITCHEN', 'PORCH']);
});

test('a rotation flip too soon after the last one is dropped, not delayed', async () => {
  const h = makeQueue({ minRotationGapSeconds: 600 });
  h.queue.submit([frame('TRIVIA', 1)], { scheduler: true });
  await h.queue.tick();

  h.advance(5 * 60 * SECOND);
  const second = h.queue.submit([frame('TRIVIA AGAIN', 2)], { scheduler: true });
  assert.equal(second.reason, 'gap');
  assert.equal(h.queue.pending().length, 0);

  h.advance(6 * 60 * SECOND);
  const third = h.queue.submit([frame('TRIVIA LATER', 3)], { scheduler: true });
  assert.equal(third.reason, 'queued');
});

test('an alert is exempt from the rotation gap', async () => {
  const h = makeQueue({ minRotationGapSeconds: 600 });
  h.queue.submit([frame('TRIVIA', 1)], { scheduler: true });
  await h.queue.tick();

  const alert = h.queue.submit([frame('TIMER', 9)], { priority: 'alert', scheduler: true });
  assert.equal(alert.reason, 'queued');
});

test('a 503 waits out the window and retries the very same frame', async () => {
  const h = makeQueue();
  h.queue.submit([frame('ONE', 1)]);
  await h.queue.tick();

  h.advance(15 * SECOND);
  h.queue.submit([frame('TWO', 2)]);
  h.transport.answerWith({ ok: false, reason: 'busy', retryable: true, status: 503 });

  assert.equal(await h.queue.tick(), 'busy');
  assert.deepEqual(h.queue.pending().map((i) => i.label), ['TWO'], 'the frame is kept');
  assert.equal(h.queue.state().health, 'ok', '503 is back-pressure, not a fault');

  h.transport.answerWith({ ok: true, reason: 'ok', status: 200 });
  h.advance(16 * SECOND);
  assert.equal(await h.queue.tick(), 'posted');
  assert.equal(h.transport.posts.at(-1).layout[0][0], 2);
});

test('network failures back off on the published schedule and then go unhealthy', async () => {
  const h = makeQueue();
  h.transport.answerWith({ ok: false, reason: 'network', retryable: true, status: 0 });
  h.queue.submit([frame('ONE', 1)]);

  assert.equal(await h.queue.tick(), 'failed');
  assert.equal(h.queue.state().health, 'ok', 'one miss is not yet a verdict');

  // Nothing happens until the first backoff elapses.
  h.advance(RETRY_DELAYS_MS[0] - SECOND);
  assert.equal(await h.queue.tick(), null);

  h.advance(SECOND);
  assert.equal(await h.queue.tick(), 'failed');

  h.advance(RETRY_DELAYS_MS[1]);
  assert.equal(await h.queue.tick(), 'failed');
  assert.equal(h.queue.state().health, 'unhealthy', 'three in a row');
  assert.equal(h.transport.posts.length, 3);
});

test('an unhealthy board keeps trying slowly and recovers on the first success', async () => {
  const h = makeQueue();
  h.transport.answerWith({ ok: false, reason: 'network', retryable: true, status: 0 });
  h.queue.submit([frame('ONE', 1)]);

  await h.queue.tick();
  h.advance(RETRY_DELAYS_MS[0]);
  await h.queue.tick();
  h.advance(RETRY_DELAYS_MS[1]);
  await h.queue.tick();
  assert.equal(h.queue.state().health, 'unhealthy');

  h.advance(4 * 60 * SECOND);
  assert.equal(await h.queue.tick(), null, 'slow retry, not a spin');

  h.advance(1 * 60 * SECOND);
  h.transport.answerWith({ ok: true, reason: 'ok', status: 200 });
  assert.equal(await h.queue.tick(), 'posted');
  assert.equal(h.queue.state().health, 'ok');
});

test('a refused key stops the board rather than spinning on it', async () => {
  const h = makeQueue();
  h.transport.answerWith({ ok: false, reason: 'auth', retryable: false, status: 401 });
  h.queue.submit([frame('ONE', 1)]);

  assert.equal(await h.queue.tick(), 'failed');
  assert.equal(h.queue.state().health, 'degraded');
  assert.equal(h.queue.state().healthReason, 'auth');

  h.advance(10 * 60 * SECOND);
  assert.equal(await h.queue.tick(), null, 'no retry on a bad key');
  assert.equal(h.transport.posts.length, 1);

  // A new key in settings deserves a fresh attempt, with no restart.
  h.transport.answerWith({ ok: true, reason: 'ok', status: 200 });
  h.queue.setConfig({ key: 'a-new-key' });
  assert.equal(h.queue.state().health, 'ok');
  assert.equal(await h.queue.tick(), 'posted');
});

test('a layout the board refuses is dropped so the queue behind it can move', async () => {
  const h = makeQueue();
  h.transport.answerWith({ ok: false, reason: 'layout', retryable: false, status: 400 });
  h.queue.submit([frame('BROKEN', 1)]);
  h.queue.submit([frame('FINE', 2)]);

  assert.equal(await h.queue.tick(), 'rejected');
  assert.deepEqual(h.queue.pending().map((i) => i.label), ['FINE']);

  h.transport.answerWith({ ok: true, reason: 'ok', status: 200 });
  assert.equal(await h.queue.tick(), 'posted');
});

test('health changes are announced so the picker can show them', async () => {
  const h = makeQueue();
  const seen = [];
  h.queue.onChange((event, detail) => {
    if (event === 'health') seen.push(detail.health);
  });

  h.transport.answerWith({ ok: false, reason: 'auth', retryable: false, status: 401 });
  h.queue.submit([frame('ONE', 1)]);
  await h.queue.tick();

  assert.deepEqual(seen, ['degraded']);
});

test('queue changes are announced so the simulator page can list them', () => {
  const h = makeQueue();
  const sizes = [];
  h.queue.onChange((event, detail) => {
    if (event === 'queue') sizes.push(detail.items.length);
  });

  h.queue.submit([frame('ONE', 1), frame('TWO', 2)]);
  assert.deepEqual(sizes, [2]);
});

test('the token never reaches a log line', async () => {
  const h = makeQueue({ key: 'super-secret-key' });
  h.transport.answerWith({ ok: false, reason: 'auth', retryable: false, status: 401 });
  h.queue.submit([frame('ONE', 1)]);
  await h.queue.tick();

  assert.ok(!h.log.lines.join('\n').includes('super-secret-key'));
});

test('quiet hours read as a window on the clock, including across midnight', () => {
  const quiet = { start: '22:00', end: '07:00' };
  const at = (hours, minutes = 0) => new Date(2026, 7, 24, hours, minutes);

  assert.equal(inQuietHours(at(23), quiet), true);
  assert.equal(inQuietHours(at(2), quiet), true);
  assert.equal(inQuietHours(at(6, 59), quiet), true);
  assert.equal(inQuietHours(at(7), quiet), false, 'the window ends at 07:00');
  assert.equal(inQuietHours(at(21, 59), quiet), false);
  assert.equal(inQuietHours(at(22), quiet), true, 'and starts at 22:00');

  // A window inside one day behaves the ordinary way.
  const nap = { start: '13:00', end: '15:00' };
  assert.equal(inQuietHours(at(14), nap), true);
  assert.equal(inQuietHours(at(12), nap), false);

  assert.equal(inQuietHours(at(23), null), false);
  assert.equal(inQuietHours(at(23), { start: '22:00', end: '07:00', enabled: false }), false);
  assert.equal(inQuietHours(at(23), { start: 'nope', end: '07:00' }), false);
});

test('clock strings parse only when they are real times', () => {
  assert.equal(parseHhMm('22:00'), 22 * 60);
  assert.equal(parseHhMm('7:05'), 7 * 60 + 5);
  assert.equal(parseHhMm('00:00'), 0);
  assert.equal(parseHhMm('24:00'), null);
  assert.equal(parseHhMm('22:60'), null);
  assert.equal(parseHhMm('bedtime'), null);
  assert.equal(parseHhMm(null), null);
});

test('inside quiet hours a snapshot is dropped rather than saved for morning', async () => {
  const h = makeQueue({ quietHours: { start: '00:00', end: '23:59' } });
  h.queue.submit([frame('WEATHER', 1)]);

  assert.equal(await h.queue.tick(), 'quiet');
  assert.equal(h.transport.posts.length, 0);
  assert.equal(h.queue.pending().length, 0, 'not held for later — it would be stale');
});

test('alarm and timer fires still get through quiet hours', async () => {
  const h = makeQueue({ quietHours: { start: '00:00', end: '23:59' } });

  h.queue.submit([frame('TIMER', 9, { source: 'timer.fired kitchen' })], { priority: 'alert' });
  assert.equal(await h.queue.tick(), 'posted');

  h.advance(15 * SECOND);
  h.queue.submit([frame('ALARM', 8, { source: 'alarm.fired bedroom' })], { priority: 'alert' });
  assert.equal(await h.queue.tick(), 'posted');

  h.advance(15 * SECOND);
  h.queue.submit([frame('BROADCAST', 7, { source: 'broadcast kitchen' })], { priority: 'alert' });
  assert.equal(await h.queue.tick(), 'quiet', 'an alert is not automatically exempt');
});

test('the caller can declare a frame exempt outright', async () => {
  const h = makeQueue({ quietHours: { start: '00:00', end: '23:59' } });
  h.queue.submit([frame('ANYTHING', 1)], { quietHoursExempt: true });
  assert.equal(await h.queue.tick(), 'posted');
});

test('the board state reports whether quiet hours are running', () => {
  const loud = makeQueue();
  assert.equal(loud.queue.state().quietHours, false);

  const quiet = makeQueue({ quietHours: { start: '00:00', end: '23:59' } });
  assert.equal(quiet.queue.state().quietHours, true);
});
