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
const { framesFor: scrambleFrames } = require('../src/vestaboard/formatters/games');

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

test('submit stamps actor on queue items', () => {
  const h = makeQueue();
  h.queue.submit([frame('SHOPPING', 1)], {
    actor: { kind: 'user', userId: 'u1', name: 'Maya' },
  });
  assert.equal(h.queue.pending()[0].actor.name, 'Maya');
  assert.equal(h.queue.pending()[0].actor.kind, 'user');
  h.queue.submit([frame('WEATHER', 2)], { scheduler: true });
  const scheduled = h.queue.pending().find((item) => item.label === 'WEATHER');
  assert.equal(scheduled.actor.kind, 'scheduler');
  assert.equal(scheduled.actor.name, 'Scheduled');
  h.queue.submit([frame('TESLA', 3)]);
  const system = h.queue.pending().find((item) => item.label === 'TESLA');
  assert.equal(system.actor.kind, 'system');
  assert.equal(system.actor.name, 'System');
});

test('a tesla preview and the live reading share one waiting page', () => {
  const h = makeQueue();
  h.queue.submit([frame('TESLA 50', 1, { source: 'tesla-battery.query' })], {
    coalesceKey: 'tesla-battery.query',
  });
  h.queue.submit([frame('TESLA 57', 2, { source: 'tesla-battery.query' })], {
    coalesceKey: 'tesla-battery.query',
  });
  h.queue.submit([frame('TESLA 57', 3, { source: 'tesla-battery.query' })], {
    coalesceKey: 'tesla-battery.query',
  });
  const waiting = h.queue.pending().filter((item) => item.source === 'tesla-battery.query'
    || item.frame?.source === 'tesla-battery.query');
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].label, 'TESLA 57');
});

test('submit keeps command id on queue items', () => {
  const h = makeQueue();
  h.queue.submit([frame('WEATHER MAP', 3, { source: 'us.weather.map' })], {
    commandId: 'weather.us-map',
    actor: { kind: 'user', userId: 'u1', name: 'Admin' },
  });
  const row = h.queue.pending()[0];
  assert.equal(row.commandId, 'weather.us-map');
  assert.equal(row.eventTitle, 'WEATHER MAP');
  assert.equal(row.label, 'WEATHER MAP');
});

test('the first frame goes straight to the board', async () => {
  const h = makeQueue();
  h.queue.submit([frame('SHOPPING', 1)]);

  assert.equal(await h.queue.tick(), 'posted');
  assert.equal(h.transport.posts.length, 1);
  assert.equal(h.queue.pending().length, 0);
});

test('replacing the transport is what the next tick actually calls', async () => {
  const h = makeQueue();
  const next = fakeTransport();
  h.queue.setTransport(next);
  h.queue.submit([frame('SHOPPING', 1)]);
  assert.equal(await h.queue.tick(), 'posted');
  assert.equal(h.transport.posts.length, 0, 'the original client is no longer used');
  assert.equal(next.posts.length, 1);
});

test('overlapping ticks wait for the in-flight post rather than no-opping', async () => {
  let unblock;
  const gate = new Promise((resolve) => { unblock = resolve; });
  const posts = [];
  const queue = createQueue({
    board: { id: 'sim', rateWindowSeconds: 0 },
    transport: {
      async post(layout, options) {
        posts.push({ layout, options });
        await gate;
        return { ok: true, reason: 'ok', status: 200 };
      },
    },
    log: silentLog(),
    now: () => 1_000_000,
  });

  queue.submit([frame('ONE', 1)]);
  queue.submit([frame('TWO', 2)]);
  const first = queue.tick();
  const second = queue.tick();
  unblock();
  assert.equal(await first, 'posted');
  assert.equal(await second, 'posted');
  assert.equal(posts.length, 2);
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

test('a frame repeated to express a long hold is queued once, not once per copy', async () => {
  // Guest snaps emits one copy per 30s of hold. Every copy after the first is
  // byte-identical to what the flip just put on the board, so the head-of-queue
  // dedupe would drop it — but only after it had held up the line.
  const h = makeQueue();
  const result = h.queue.submit([
    frame('GUEST SNAPS', 1, { dwellSeconds: 30 }),
    frame('GUEST SNAPS', 1, { dwellSeconds: 30 }),
    frame('GUEST SNAPS', 1, { dwellSeconds: 30 }),
  ]);

  assert.equal(result.accepted, 1);
  assert.equal(h.queue.pending().length, 1);

  assert.equal(await h.queue.tick(), 'posted');
  assert.equal(h.queue.pending().length, 0, 'nothing left to drop later');
  assert.equal(h.transport.posts.length, 1);
});

test('folding a repeat keeps the hold the copies were standing in for', async () => {
  const h = makeQueue({ rateWindowSeconds: 15 });
  h.queue.submit([
    frame('GUEST SNAPS', 1, { dwellSeconds: 30 }),
    frame('GUEST SNAPS', 1, { dwellSeconds: 30 }),
    frame('AFTER', 2, { dwellSeconds: 15 }),
  ]);
  await h.queue.tick();

  // 60s of dwell, not 30 — the page behind it waits out both copies.
  h.advance(45 * SECOND);
  assert.equal(await h.queue.tick(), null);
  h.advance(20 * SECOND);
  assert.equal(await h.queue.tick(), 'posted');
});

test('only neighbouring repeats fold, so a real rotation keeps its pages', async () => {
  const h = makeQueue();
  const result = h.queue.submit([
    frame('ONE', 1), frame('TWO', 2), frame('ONE AGAIN', 1),
  ]);
  assert.equal(result.accepted, 3);
  assert.deepEqual(
    h.queue.pending().map((item) => item.label),
    ['ONE', 'TWO', 'ONE AGAIN'],
  );
});

test('an alert jumps the line and leaves the rotation waiting', async () => {
  const h = makeQueue();
  h.queue.submit([frame('PAGE 1', 1), frame('PAGE 2', 2), frame('PAGE 3', 3)]);
  await h.queue.tick();

  h.queue.submit([frame('TIMER', 9)], { priority: 'alert' });

  const labels = h.queue.pending().map((item) => item.label);
  assert.deepEqual(labels, ['TIMER', 'PAGE 2', 'PAGE 3'], 'the rest of the run stays queued');

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

test('dropPending clears the pages one feature is taking the board from', async () => {
  const h = makeQueue();
  h.queue.submit([frame('RIDDLE 1', 1, { source: 'word.riddles' }),
    frame('RIDDLE 2', 2, { source: 'word.riddles' })]);
  h.queue.submit([frame('DOORBELL', 3, { source: 'ring.doorbell' })], { priority: 'alert' });
  h.queue.submit([frame('STOCKS', 4, { source: 'stock.market' })]);

  const before = h.queue.pending().length;
  const dropped = h.queue.dropPending(
    (item, entry) => entry.priority !== 'alert' && item.source !== 'ring.doorbell',
  );

  assert.equal(dropped, before - 1);
  assert.deepEqual(h.queue.pending().map((item) => item.source), ['ring.doorbell']);
  // Nothing was posted, so whatever is showing stays showing.
  assert.equal(h.transport.posts.length, 0);
});

test('dropPending without a predicate leaves the queue alone', () => {
  const h = makeQueue();
  h.queue.submit([frame('RIDDLE', 1, { source: 'word.riddles' })]);
  assert.equal(h.queue.dropPending(null), 0);
  assert.equal(h.queue.pending().length, 1);
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

test('a remembered last post holds the next tick inside the rate window', async () => {
  const h = makeQueue();
  h.queue.noteLastPostAt(h.at());
  h.queue.submit([frame('ONE', 1)]);
  assert.equal(await h.queue.tick(), null);
  assert.equal(h.transport.posts.length, 0);

  h.advance(14 * SECOND);
  assert.equal(await h.queue.tick(), null);

  h.advance(SECOND);
  assert.equal(await h.queue.tick(), 'posted');
  assert.equal(h.transport.posts.length, 1);
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
  const revisions = [];
  h.queue.onChange((event, detail) => {
    if (event === 'queue') {
      sizes.push(detail.items.length);
      revisions.push(detail.revision);
    }
  });

  assert.equal(h.queue.state().queueRevision, 0);
  h.queue.submit([frame('ONE', 1), frame('TWO', 2)]);
  assert.deepEqual(sizes, [2]);
  assert.equal(revisions[0], 1);
  assert.equal(h.queue.state().queueRevision, 1);
  h.queue.submit([frame('THREE', 3)]);
  assert.equal(h.queue.state().queueRevision, 2);
  assert.equal(revisions[1], 2);
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

test('quiet hours follow the household timezone, not the process clock', () => {
  // 8:25pm MDT is 02:25 UTC. A UTC Docker host would treat that as 2am quiet.
  const eveningUtah = new Date('2026-08-25T02:25:00.000Z');
  const quiet = { start: '22:00', end: '07:00' };
  assert.equal(inQuietHours(eveningUtah, quiet, 'America/Denver'), false);
  assert.equal(inQuietHours(eveningUtah, quiet, 'UTC'), true);
});

test('a snapshot at 8:25pm Utah is not dropped as quiet hours on a UTC host', async () => {
  const clock = Date.parse('2026-08-25T02:25:00.000Z');
  const transport = fakeTransport();
  const log = silentLog();
  const queue = createQueue({
    board: {
      id: 'sim',
      rateWindowSeconds: 0,
      quietHours: { start: '22:00', end: '07:00', enabled: true },
    },
    transport,
    log,
    now: () => clock,
    timeZone: 'America/Denver',
  });
  queue.submit([frame('ROLL CREDITS', 1)]);
  assert.equal(await queue.tick(), 'posted');
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
  const submitted = h.queue.submit([frame('WEATHER', 1)]);
  assert.equal(submitted.accepted, 0);
  assert.equal(submitted.reason, 'quiet');
  assert.equal(h.transport.posts.length, 0);
  assert.equal(h.queue.pending().length, 0, 'not held for later — it would be stale');
});

test('a snapshot already in line is dropped once quiet hours open', async () => {
  const h = makeQueue({ quietHours: { start: '22:00', end: '07:00', enabled: false } });
  h.queue.submit([frame('WEATHER', 1)]);
  assert.equal(h.queue.pending().length, 1);
  h.queue.setConfig({ quietHours: { start: '00:00', end: '23:59', enabled: true } });
  assert.equal(await h.queue.tick(), 'quiet');
  assert.equal(h.transport.posts.length, 0);
  assert.equal(h.queue.pending().length, 0);
});

test('alarm and timer fires still get through quiet hours', async () => {
  const h = makeQueue({ quietHours: { start: '00:00', end: '23:59' } });

  h.queue.submit([frame('TIMER', 9, { source: 'timer.fired kitchen' })], { priority: 'alert' });
  assert.equal(await h.queue.tick(), 'posted');

  h.advance(15 * SECOND);
  h.queue.submit([frame('ALARM', 8, { source: 'alarm.fired bedroom' })], { priority: 'alert' });
  assert.equal(await h.queue.tick(), 'posted');

  h.advance(15 * SECOND);
  const broadcast = h.queue.submit(
    [frame('BROADCAST', 7, { source: 'broadcast kitchen' })],
    { priority: 'alert' },
  );
  assert.equal(broadcast.reason, 'quiet', 'an alert is not automatically exempt');
  assert.equal(broadcast.accepted, 0);
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

test('board dwell keeps a rotation page up longer than the rate window', async () => {
  const h = makeQueue({ rateWindowSeconds: 1, dwellSeconds: 60 });
  h.queue.submit([frame('WEATHER', 1)]);
  assert.equal(await h.queue.tick(), 'posted');
  h.queue.submit([frame('CLOCK', 2)]);
  h.advance(16 * SECOND);
  assert.equal(await h.queue.tick(), null, 'the flaps are free; the page is not');
  assert.equal(h.queue.pending().length, 1);
  assert.ok(h.queue.state().snapshotCooldownMs > 40 * SECOND);
  h.advance(44 * SECOND);
  assert.equal(await h.queue.tick(), 'posted');
  assert.equal(h.transport.posts.length, 2);
});

test('an alert does not wait out the board dwell', async () => {
  const h = makeQueue({ rateWindowSeconds: 1, dwellSeconds: 60 });
  h.queue.submit([frame('WEATHER', 1)]);
  assert.equal(await h.queue.tick(), 'posted');
  h.queue.submit([frame('ALARM', 9, { source: 'alarm.fired' })], { priority: 'alert' });
  h.advance(2 * SECOND);
  assert.equal(await h.queue.tick(), 'posted');
  assert.equal(h.transport.posts[1].layout[0][0], 9);
  assert.equal(h.queue.state().snapshotUntil, null);
});

test('a jump without Now waits for the current page dwell', async () => {
  const h = makeQueue({
    rateWindowSeconds: 1,
    dwellSeconds: 60,
    priorities: [
      { source: 'alarm.fired', jump: true, immediate: false, hold: false, holdMinutes: 15 },
    ],
  });
  h.queue.submit([frame('WEATHER', 1)]);
  assert.equal(await h.queue.tick(), 'posted');
  assert.ok(h.queue.state().snapshotUntil);
  h.queue.submit([frame('ALARM', 9, { source: 'alarm.fired' })]);
  assert.equal(h.queue.pending()[0].label, 'ALARM');
  assert.equal(h.queue.pending()[0].status, 'waiting');
  h.advance(2 * SECOND);
  assert.equal(await h.queue.tick(), null, 'still inside the weather dwell');
  h.advance(60 * SECOND);
  assert.equal(await h.queue.tick(), 'posted');
  assert.equal(h.transport.posts[1].layout[0][0], 9);
});

test('Now on a jumper clears dwell and flips as soon as the rate window allows', async () => {
  const h = makeQueue({
    rateWindowSeconds: 1,
    dwellSeconds: 60,
    priorities: [
      { source: 'alarm.fired', jump: true, immediate: true, hold: false, holdMinutes: 15 },
    ],
  });
  h.queue.submit([frame('WEATHER', 1)]);
  assert.equal(await h.queue.tick(), 'posted');
  h.queue.submit([frame('ALARM', 9, { source: 'alarm.fired' })]);
  assert.equal(h.queue.state().snapshotUntil, null);
  assert.equal(h.queue.pending()[0].status, 'cutting-in');
  h.advance(2 * SECOND);
  assert.equal(await h.queue.tick(), 'posted');
  assert.equal(h.transport.posts[1].layout[0][0], 9);
});

test('Now that arrives while a snapshot is posting does not get a 60s dwell put back', async () => {
  let unblock;
  const gate = new Promise((resolve) => { unblock = resolve; });
  let clock = 1_000_000;
  const posts = [];
  const queue = createQueue({
    board: {
      id: 'sim',
      rateWindowSeconds: 15,
      dwellSeconds: 60,
      priorities: [
        { source: 'ring.doorbell', jump: true, immediate: true, hold: false, holdMinutes: 15 },
      ],
    },
    transport: {
      async post(layout) {
        posts.push(layout);
        await gate;
        return { ok: true, reason: 'ok', status: 200 };
      },
    },
    log: silentLog(),
    now: () => clock,
  });

  queue.submit([frame('WEATHER', 1)]);
  const first = queue.tick();
  await Promise.resolve();
  assert.equal(posts.length, 1, 'weather post must be in flight');
  queue.submit([frame('MAP', 2, { source: 'us.weather-map' })]);
  queue.submit([frame('SHOP', 3, { source: 'shopping-list' })]);
  queue.submit([frame('DOORBELL', 4, { source: 'ring.doorbell' })]);
  assert.equal(queue.pending()[0].label, 'DOORBELL');
  assert.equal(queue.pending()[0].status, 'cutting-in');

  unblock();
  assert.equal(await first, 'posted');
  assert.equal(queue.state().snapshotUntil, null, 'in-flight weather must not restore dwell');
  assert.equal(queue.pending()[0].label, 'DOORBELL');
  assert.ok(
    queue.state().nextFlipCooldownMs <= 15 * SECOND,
    `Now cooldown was ${queue.state().nextFlipCooldownMs}, not the flap window`,
  );
  assert.ok(queue.state().nextFlipCooldownMs > 10 * SECOND);

  clock += 15 * SECOND;
  assert.equal(await queue.tick(), 'posted');
  assert.equal(posts[1][0][0], 4);
});

test('a live game card does not wait out the board dwell', async () => {
  const h = makeQueue({ rateWindowSeconds: 1, dwellSeconds: 60 });
  h.queue.submit([frame('WEATHER', 1)]);
  assert.equal(await h.queue.tick(), 'posted');
  h.queue.acquireGameLock('word.scramble');
  h.queue.submit([{
    ...frame('ROUND', 2, { source: 'word.scramble' }),
    holdSeconds: 120,
  }]);
  h.advance(2 * SECOND);
  assert.equal(await h.queue.tick(), 'posted');
  assert.equal(h.transport.posts[1].layout[0][0], 2);
  assert.equal(h.queue.state().snapshotUntil, null);
  assert.ok(h.queue.state().phaseCooldownMs > 100 * SECOND);
  assert.ok(h.queue.state().nextFlipCooldownMs > 100 * SECOND);
  h.queue.releaseGameLock('word.scramble');
  assert.equal(h.queue.state().phaseUntil, null);
  assert.equal(h.queue.state().nextFlipCooldownMs, 0);
});

test('holdSeconds keeps the next snapshot off the board until the hold ends', async () => {
  const h = makeQueue({ rateWindowSeconds: 1 });
  h.queue.submit([{ ...frame('GUEST', 1), dwellSeconds: 15, holdSeconds: 300 }]);
  assert.equal(await h.queue.tick(), 'posted');
  h.queue.submit([frame('WEATHER', 2)], { scheduler: true });
  h.advance(16 * SECOND);
  assert.equal(await h.queue.tick(), null);
  assert.equal(h.queue.pending().length, 1);
  h.advance(284 * SECOND);
  assert.equal(await h.queue.tick(), 'posted');
  assert.equal(h.transport.posts.length, 2);
});

test('a Word Scramble lock parks every queued page until the game clears', async () => {
  const h = makeQueue({ rateWindowSeconds: 1 });
  h.queue.acquireGameLock('word.scramble');
  h.queue.submit([{
    ...frame('SCRAMBLE', 1, { source: 'word.scramble' }),
    dwellSeconds: 15,
    holdSeconds: 180,
  }]);
  assert.equal(await h.queue.tick(), 'posted');
  h.queue.submit([frame('WEATHER', 2)], { scheduler: true });
  h.queue.submit([frame('CHUCK', 3, { source: 'chuck.facts' })]);
  h.advance(16 * SECOND);
  assert.equal(await h.queue.tick(), null);
  assert.equal(h.queue.pending().length, 2);
  assert.equal(h.queue.state().gameLock.source, 'word.scramble');
  h.queue.submit([frame('AIR NOW', 4)], { explicit: true, breakHold: true });
  assert.equal(h.queue.pending().length, 3);
  assert.equal(h.queue.pending()[2].status, 'held');
  h.advance(16 * SECOND);
  assert.equal(await h.queue.tick(), null);
  assert.equal(h.transport.posts.length, 1);
});

// The bug this covers: the lock used to be inferred from the last game
// frame's `holdSeconds`. The lobby card's hold ran out at the moment the
// round began, and everything parked behind the game rushed the board before
// the round card — queued behind them — ever got its turn.
test('the gap between two game phases does not open the line', async () => {
  const h = makeQueue({ rateWindowSeconds: 1 });
  h.queue.acquireGameLock('word.scramble');
  h.queue.submit([{
    ...frame('LOBBY', 1, { source: 'word.scramble' }),
    dwellSeconds: 15,
    holdSeconds: 10,
  }]);
  assert.equal(await h.queue.tick(), 'posted');
  h.queue.submit([frame('CHUCK', 2, { source: 'chuck.facts' })], { scheduler: true });

  // The lobby hold has long since run out when round one starts.
  h.advance(60 * SECOND);
  h.queue.submit([{
    ...frame('ROUND', 3, { source: 'word.scramble' }),
    dwellSeconds: 15,
    holdSeconds: 120,
  }]);
  assert.equal(await h.queue.tick(), 'posted');
  assert.equal(h.transport.posts[1].layout[0][0], 3, 'the round card, not the page behind it');
  assert.equal(h.queue.pending().length, 1);
});

test('an alarm preempts a live game and ends the game lock so the queue continues', async () => {
  const h = makeQueue({ rateWindowSeconds: 1 });
  const events = [];
  h.queue.onChange((event, detail) => events.push({ event, detail }));
  h.queue.acquireGameLock('word.scramble');
  h.queue.submit([{
    ...frame('ROUND', 1, { source: 'word.scramble' }),
    dwellSeconds: 15,
    holdSeconds: 120,
  }]);
  assert.equal(await h.queue.tick(), 'posted');
  h.queue.submit([frame('RIDDLE', 2, { source: 'word.riddles' })]);
  h.queue.submit([frame('ALARM', 9, { source: 'alarm.fired' })], {
    priority: 'alert',
    quietHoursExempt: true,
  });

  assert.equal(h.queue.pending()[0].label, 'ALARM');
  assert.equal(h.queue.pending().some((row) => row.label === 'RIDDLE'), true);
  assert.equal(h.queue.state().gameLock, null, 'the scramble lock ends with the interrupt');
  assert.equal(h.queue.pending().find((row) => row.label === 'RIDDLE').status, 'waiting');
  assert.ok(events.some((row) => row.event === 'lock-preempted'
    && row.detail.source === 'word.scramble'));
  h.advance(2 * SECOND);
  assert.equal(await h.queue.tick(), 'posted');
  assert.equal(h.transport.posts[1].layout[0][0], 9, 'the alarm takes the board');
});

test('doorbell cutting through Hangman frees a held Red Letter page', async () => {
  const priorities = [
    { source: 'ring.doorbell', jump: true, immediate: true, hold: false, holdMinutes: 15 },
    { source: 'hangman.game', jump: true, immediate: true, hold: true, holdMinutes: 30 },
  ];
  const h = makeQueue({ rateWindowSeconds: 1, dwellSeconds: 60, priorities });
  h.queue.acquireGameLock('hangman.game');
  h.queue.submit([{
    ...frame('INVITE', 1, { source: 'hangman.game' }),
    dwellSeconds: 15,
    holdSeconds: 120,
  }]);
  assert.equal(await h.queue.tick(), 'posted');
  h.queue.submit([frame('RED LETTER', 2, { source: 'red.letter' })]);
  assert.equal(h.queue.pending()[0].status, 'held');
  h.queue.submit([frame('DOORBELL', 9, { source: 'ring.doorbell' })]);
  assert.equal(h.queue.state().gameLock, null);
  assert.equal(h.queue.pending()[0].label, 'DOORBELL');
  assert.equal(h.queue.pending().find((row) => row.label === 'RED LETTER').status, 'waiting');
  assert.equal(
    h.queue.pending().some((row) => row.source === 'hangman.game'),
    false,
    'displaced hangman pages leave the queue',
  );
  h.advance(2 * SECOND);
  assert.equal(await h.queue.tick(), 'posted');
  assert.equal(h.transport.posts[1].layout[0][0], 9);
  // After the doorbell's own reading time, Red Letter may flip — not held forever.
  h.advance(60 * SECOND);
  assert.equal(await h.queue.tick(), 'posted');
  assert.equal(h.transport.posts[2].layout[0][0], 2);
});

test('sequence pages wait at least the house dwell, not a 15s formatter stamp', async () => {
  const h = makeQueue({ rateWindowSeconds: 1, dwellSeconds: 60 });
  h.queue.submit([
    frame('PAGE 1', 1, { dwellSeconds: 15 }),
    frame('PAGE 2', 2, { dwellSeconds: 15 }),
  ]);
  assert.equal(await h.queue.tick(), 'posted');
  h.advance(16 * SECOND);
  assert.equal(await h.queue.tick(), null, '15s stamp must not undercut a 60s dwell');
  h.advance(44 * SECOND);
  assert.equal(await h.queue.tick(), 'posted');
  assert.equal(h.transport.posts[1].layout[0][0], 2);
});

test('a game lock that is never released expires rather than wedging the board', async () => {
  const h = makeQueue({ rateWindowSeconds: 1 });
  h.queue.submit([frame('ROUND', 1, { source: 'word.scramble' })]);
  assert.equal(await h.queue.tick(), 'posted');
  // The last card already renewed the default deadline. A short remaining
  // TTL is what bounds a session that dies without another update.
  h.queue.acquireGameLock('word.scramble', { ttlMs: 60 * SECOND });
  h.queue.submit([frame('WEATHER', 2)], { scheduler: true });
  h.advance(16 * SECOND);
  assert.equal(await h.queue.tick(), null);
  h.advance(60 * SECOND);
  assert.equal(await h.queue.tick(), 'posted');
  assert.equal(h.queue.state().gameLock, null);
});

test('an explicit snapshot may post after the rate window during a guest hold', async () => {
  const h = makeQueue({ rateWindowSeconds: 1 });
  h.queue.submit([{ ...frame('GUEST', 1), dwellSeconds: 15, holdSeconds: 300 }]);
  assert.equal(await h.queue.tick(), 'posted');
  h.queue.submit([frame('REPLAY', 2)]);
  h.advance(16 * SECOND);
  assert.equal(await h.queue.tick(), 'posted');
  assert.equal(h.transport.posts.length, 2);
});

test('replaceSource drops earlier pages from the same guest book run', async () => {
  const h = makeQueue({ rateWindowSeconds: 1 });
  h.queue.submit([frame('OLD', 1, { source: 'guest.book' }), frame('OLD FOOTER', 2, { source: 'guest.book' })]);
  h.queue.submit([frame('NEW', 3, { source: 'guest.book' })], { replaceSource: 'guest.book' });
  assert.equal(h.queue.pending().length, 1);
  assert.equal(h.queue.pending()[0].label, 'NEW');
});

test('a held scheduler page keeps a later Push waiting its turn', async () => {
  const h = makeQueue({ rateWindowSeconds: 1 });
  h.queue.submit([{ ...frame('GUEST', 1), dwellSeconds: 15, holdSeconds: 300 }]);
  assert.equal(await h.queue.tick(), 'posted');
  h.queue.submit([frame('INVITE', 2)], { scheduler: true });
  h.queue.submit([frame('CLOCK', 3)]);
  assert.equal(h.queue.pending()[0].status, 'held');
  assert.equal(h.queue.pending()[1].label, 'CLOCK');
  h.advance(16 * SECOND);
  assert.equal(await h.queue.tick(), null);
  assert.equal(h.transport.posts.length, 1);
  h.advance(300 * SECOND);
  assert.equal(await h.queue.tick(), 'posted');
  assert.equal(h.transport.posts[1].layout[0][0], 2, 'the scheduler page that was already waiting');
  h.advance(16 * SECOND);
  assert.equal(await h.queue.tick(), 'posted');
  assert.equal(h.transport.posts[2].layout[0][0], 3, 'the push that joined the back');
});

test('a manual push joins the back of the queue instead of jumping it', async () => {
  const h = makeQueue({ rateWindowSeconds: 1 });
  h.queue.submit([frame('WEATHER', 1)], { scheduler: true });
  h.queue.submit([frame('CHUCK', 2)]);
  h.queue.submit([frame('AIR NOW', 3)], { explicit: true });
  assert.deepEqual(h.queue.pending().map((row) => row.label), ['WEATHER', 'CHUCK', 'AIR NOW']);
  assert.equal(await h.queue.tick(), 'posted');
  assert.equal(h.transport.posts[0].layout[0][0], 1);
});

test('a held page that is already on the board is dropped instead of parking the line', async () => {
  const h = makeQueue({ rateWindowSeconds: 1 });
  h.queue.submit([{ ...frame('INVITE', 1), holdSeconds: 300 }]);
  assert.equal(await h.queue.tick(), 'posted');
  h.queue.submit([frame('INVITE AGAIN', 1)], { scheduler: true });
  h.advance(16 * SECOND);
  assert.equal(await h.queue.tick(), 'duplicate');
  assert.equal(h.queue.pending().length, 0);
});

test('cancel drops one waiting page and leaves the rest', () => {
  const h = makeQueue();
  const events = [];
  h.queue.onChange((event, detail) => events.push({ event, detail }));
  h.queue.submit([frame('WEATHER', 1)]);
  h.queue.submit([frame('CHUCK', 2)], { sessionId: 's-1', code: 'ABCD' });
  h.queue.submit([frame('CLOCK', 3)]);
  const id = h.queue.pending()[1].id;
  assert.equal(h.queue.cancel(id), true);
  assert.deepEqual(h.queue.pending().map((row) => row.label), ['WEATHER', 'CLOCK']);
  assert.equal(h.queue.cancel('missing'), false);
  const cancelled = events.filter((row) => row.event === 'cancelled');
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0].detail.sessionId, 's-1');
  assert.equal(cancelled[0].detail.code, 'ABCD');
});

test('clear drops every waiting page and leaves an empty queue', () => {
  const h = makeQueue();
  const events = [];
  h.queue.onChange((event, detail) => events.push({ event, detail }));
  h.queue.submit([frame('WEATHER', 1)], { sessionId: 's-a', code: 'AAAA' });
  h.queue.submit([frame('CHUCK', 2)], { sessionId: 's-b', code: 'BBBB' });
  assert.equal(h.queue.clear(), 2);
  assert.deepEqual(h.queue.pending(), []);
  assert.equal(h.queue.clear(), 0);
  const cancelled = events.filter((row) => row.event === 'cancelled');
  assert.equal(cancelled.length, 2);
  assert.deepEqual(cancelled.map((row) => row.detail.code).sort(), ['AAAA', 'BBBB']);
});

test('posted events carry the game session id so the lobby clock can start', async () => {
  const h = makeQueue({ rateWindowSeconds: 0 });
  const events = [];
  h.queue.onChange((event, detail) => events.push({ event, detail }));
  h.queue.submit([{ ...frame('HANGMAN', 1), card: 'invite' }], {
    sessionId: 'sess-9',
    code: 'DLJH',
    breakHold: true,
    gameSource: 'hangman.game',
  });
  assert.equal(await h.queue.tick(), 'posted');
  const posted = events.filter((row) => row.event === 'posted').pop();
  assert.equal(posted.detail.sessionId, 'sess-9');
  assert.equal(posted.detail.code, 'DLJH');
  assert.equal(posted.detail.card, 'invite');
});

test('reorder puts waiting pages in the given order', () => {
  const h = makeQueue();
  h.queue.submit([frame('WEATHER', 1)]);
  h.queue.submit([frame('CHUCK', 2)]);
  h.queue.submit([frame('CLOCK', 3)]);
  const ids = h.queue.pending().map((row) => row.id);
  const next = h.queue.reorder([ids[2], ids[0], ids[1]]);
  assert.deepEqual(next.map((row) => row.label), ['CLOCK', 'WEATHER', 'CHUCK']);
});

test('breakHold puts an explicit snapshot in front of parked scheduler pages', async () => {
  const h = makeQueue({ rateWindowSeconds: 1 });
  h.queue.submit([{ ...frame('GUEST', 1), holdSeconds: 300 }]);
  assert.equal(await h.queue.tick(), 'posted');
  h.queue.submit([frame('PARKED', 2)], { scheduler: true });
  h.queue.submit([frame('AIR NOW', 3)], { breakHold: true });
  assert.equal(h.queue.pending()[0].label, 'AIR NOW');
  h.advance(16 * SECOND);
  assert.equal(await h.queue.tick(), 'posted');
  assert.equal(h.transport.posts[1].layout[0][0], 3);
});

test('an alert still preempts a guest hold', async () => {
  const h = makeQueue({ rateWindowSeconds: 1 });
  h.queue.submit([{ ...frame('GUEST', 1), holdSeconds: 300 }]);
  assert.equal(await h.queue.tick(), 'posted');
  h.advance(16 * SECOND);
  h.queue.submit([frame('ALARM', 9, { source: 'alarm.fired' })], { priority: 'alert' });
  assert.equal(await h.queue.tick(), 'posted');
});

test('a follow-up game card is owned even when the frame omits source', async () => {
  const h = makeQueue({ rateWindowSeconds: 1 });
  h.queue.acquireGameLock('word.scramble');
  h.queue.submit([{
    ...frame('ROUND', 1, { source: 'word.scramble' }),
    holdSeconds: 180,
  }]);
  assert.equal(await h.queue.tick(), 'posted');
  h.queue.submit([frame('WEATHER', 2)], { scheduler: true });
  h.advance(16 * SECOND);
  h.queue.submit([frame('SCORES', 3)], {
    replaceSource: 'word.scramble',
    gameSource: 'word.scramble',
    breakHold: false,
    replaceCard: 'intermission',
  });
  assert.equal(h.queue.pending()[0].label, 'SCORES');
  assert.equal(h.queue.pending()[0].status, 'waiting');
  assert.equal(h.queue.pending()[1].status, 'held');
  assert.equal(await h.queue.tick(), 'posted');
  assert.equal(h.transport.posts[1].layout[0][0], 3);
  assert.equal(h.queue.pending().length, 1);
  assert.equal(h.queue.pending()[0].status, 'held');
});

test('round two does not evict an unshown intermission score card', async () => {
  const h = makeQueue({ rateWindowSeconds: 1 });
  h.queue.acquireGameLock('word.scramble');
  h.queue.submit([{
    ...frame('ROUND 1', 1, { source: 'word.scramble' }),
    card: 'round',
    holdSeconds: 180,
  }]);
  assert.equal(await h.queue.tick(), 'posted');
  h.queue.submit([frame('WEATHER', 2)], { scheduler: true });
  h.queue.submit([frame('PSN', 3, { source: 'psn.now-playing' })]);

  const scores = { ...frame('SCORES', 4, { source: 'word.scramble' }), card: 'intermission' };
  h.queue.submit([scores], {
    replaceSource: 'word.scramble',
    gameSource: 'word.scramble',
    replaceCard: 'intermission',
    breakHold: false,
  });
  const nextRound = { ...frame('ROUND 2', 5, { source: 'word.scramble' }), card: 'round' };
  h.queue.submit([nextRound], {
    replaceSource: 'word.scramble',
    gameSource: 'word.scramble',
    replaceCard: 'round',
    breakHold: false,
  });

  assert.deepEqual(h.queue.pending().map((row) => row.label), [
    'SCORES',
    'ROUND 2',
    'WEATHER',
    'PSN',
  ]);
  assert.equal(h.queue.pending()[0].status, 'waiting');
  assert.equal(h.queue.pending()[1].status, 'waiting');
  assert.equal(h.queue.pending()[2].status, 'held');
  assert.equal(h.queue.pending()[3].status, 'held');

  h.advance(16 * SECOND);
  assert.equal(await h.queue.tick(), 'posted');
  assert.equal(h.transport.posts[1].layout[0][0], 4, 'intermission scores first');
  h.advance(16 * SECOND);
  assert.equal(await h.queue.tick(), 'posted');
  assert.equal(h.transport.posts[2].layout[0][0], 5, 'then the next grid');
  assert.equal(h.queue.pending().every((row) => row.status === 'held'), true);
});

test('a lobby refresh still replaces a pending lobby, not a later phase', async () => {
  const h = makeQueue({ rateWindowSeconds: 1 });
  h.queue.acquireGameLock('word.scramble');
  h.queue.submit([
    { ...frame('LOBBY 1', 1, { source: 'word.scramble' }), card: 'lobby' },
  ], {
    replaceSource: 'word.scramble',
    replaceCard: 'lobby',
    gameSource: 'word.scramble',
  });
  h.queue.submit([
    { ...frame('LOBBY 2', 2, { source: 'word.scramble' }), card: 'lobby' },
  ], {
    replaceSource: 'word.scramble',
    replaceCard: 'lobby',
    gameSource: 'word.scramble',
  });
  assert.equal(h.queue.pending().length, 1);
  assert.equal(h.queue.pending()[0].label, 'LOBBY 2');
});

test('formatter-built scramble follow-ups post while non-game pages stay held', async () => {
  const h = makeQueue({ rateWindowSeconds: 1 });
  h.queue.acquireGameLock('word.scramble');
  const round1 = scrambleFrames({
    card: 'round',
    phase: 'round',
    code: 'FTEJ',
    showCode: true,
    roundIndex: 1,
    rounds: 3,
    grid: ['TEGP', 'TOEE', 'RABY', 'VMNO'],
    holdSeconds: 180,
  });
  h.queue.submit(round1, {
    replaceSource: 'word.scramble',
    gameSource: 'word.scramble',
    replaceCard: 'round',
    breakHold: false,
    quietHoursExempt: true,
  });
  assert.equal(await h.queue.tick(), 'posted');
  h.queue.submit([frame('RIDDLE', 9, { source: 'word.riddles' })]);
  h.queue.submit([frame('WEATHER MAP', 8, { source: 'us.weather-map' })], { scheduler: true });

  h.advance(16 * SECOND);
  const intermission = scrambleFrames({
    card: 'intermission',
    phase: 'intermission',
    code: 'FTEJ',
    showCode: true,
    roundIndex: 1,
    rounds: 3,
    roundWinner: { name: 'Luis', score: 6 },
    scores: [{ name: 'Luis', score: 6 }, { name: 'Luis (2)', score: 5 }],
    holdSeconds: 20,
  });
  h.queue.submit(intermission, {
    replaceSource: 'word.scramble',
    gameSource: 'word.scramble',
    replaceCard: 'intermission',
    breakHold: false,
    quietHoursExempt: true,
  });
  const round2 = scrambleFrames({
    card: 'round',
    phase: 'round',
    code: 'FTEJ',
    showCode: true,
    roundIndex: 2,
    rounds: 3,
    grid: ['JYEI', 'TOUD', 'ITEP', 'EPSI'],
    holdSeconds: 180,
  });
  h.queue.submit(round2, {
    replaceSource: 'word.scramble',
    gameSource: 'word.scramble',
    replaceCard: 'round',
    breakHold: false,
    quietHoursExempt: true,
  });

  assert.equal(h.queue.pending()[0].label, 'Round winner');
  assert.equal(h.queue.pending()[1].label, 'Word Scramble');
  assert.equal(h.queue.pending().filter((row) => row.status === 'held').length, 2);
  assert.equal(await h.queue.tick(), 'posted');
  h.advance(16 * SECOND);
  assert.equal(await h.queue.tick(), 'posted');
  assert.equal(h.transport.posts.length, 3);
  assert.equal(h.queue.pending().every((row) => row.status === 'held'), true);
});

test('an in-flight post does not splice a follow-up that replaced it in line', async () => {
  let clock = 1_000_000;
  let releasePost;
  const inflight = new Promise((resolve) => { releasePost = resolve; });
  const posts = [];
  const queue = createQueue({
    board: { id: 'sim', rateWindowSeconds: 1 },
    now: () => clock,
    transport: {
      async post(layout) {
        posts.push(layout);
        if (posts.length === 1) {
          await inflight;
        }
        return { ok: true, reason: 'ok', status: 200 };
      },
    },
    log: silentLog(),
  });

  queue.acquireGameLock('word.scramble');
  queue.submit([{ ...frame('SCORES', 1, { source: 'word.scramble' }), card: 'intermission' }]);
  const first = queue.tick();
  await Promise.resolve();
  queue.submit(
    [{ ...frame('ROUND 2', 2, { source: 'word.scramble' }), card: 'round' }],
    { replaceSource: 'word.scramble', replaceCard: 'round', gameSource: 'word.scramble' },
  );
  assert.equal(queue.pending().some((row) => row.label === 'ROUND 2'), true);
  releasePost();
  assert.equal(await first, 'posted');
  assert.equal(queue.pending()[0].label, 'ROUND 2');
  clock += 16 * SECOND;
  assert.equal(await queue.tick(), 'posted');
  assert.equal(posts[1][0][0], 2);
});

test('huupe score updates replace one pending card instead of stacking', async () => {
  const h = makeQueue({ rateWindowSeconds: 1 });
  h.queue.submit([frame('HUUPE 1', 1, { source: 'huupe.session' })]);
  assert.equal(await h.queue.tick(), 'posted');
  h.queue.submit([frame('WEATHER', 2, { source: 'weather.query' })]);
  h.queue.submit([frame('HUUPE 2', 3, { source: 'huupe.session' })]);
  h.queue.submit([frame('HUUPE 3', 4, { source: 'huupe.session' })]);

  assert.equal(h.queue.pending().filter((row) => row.source === 'huupe.session').length, 1);
  assert.equal(h.queue.pending().find((row) => row.source === 'huupe.session').label, 'HUUPE 3');
  assert.equal(h.queue.pending().find((row) => row.source === 'weather.query').status, 'held');
  assert.ok(h.queue.state().gameLock);
  assert.equal(h.queue.state().gameLock.source, 'huupe.session');

  h.advance(16 * SECOND);
  assert.equal(await h.queue.tick(), 'posted');
  assert.equal(h.transport.posts[1].layout[0][0], 4);
  assert.equal(h.queue.pending().length, 1);
  assert.equal(h.queue.pending()[0].status, 'held');
});

test('a huupe close releases the board so rotation can continue', async () => {
  const h = makeQueue({ rateWindowSeconds: 1 });
  h.queue.submit([frame('HUUPE', 1, { source: 'huupe.session' })]);
  assert.equal(await h.queue.tick(), 'posted');
  h.queue.submit([frame('WEATHER', 2, { source: 'weather.query' })]);
  assert.equal(h.queue.pending()[0].status, 'held');

  const closed = h.queue.submit([], {
    hold: {
      lane: 'rotation', rank: 0, source: 'huupe.session', live: false, close: true, coalesceKey: 'huupe.session',
    },
  });
  assert.equal(closed.reason, 'closed');
  assert.equal(h.queue.state().gameLock, null);
  h.advance(16 * SECOND);
  assert.equal(await h.queue.tick(), 'posted');
  assert.equal(h.transport.posts[1].layout[0][0], 2);
});

test('youtube live does not hold the queue unless the board says so', async () => {
  const h = makeQueue({ rateWindowSeconds: 1 });
  h.queue.submit([frame('YT', 1, { source: 'youtube.now-playing' })], {
    payload: { type: 'youtube.now-playing', youtube: { mode: 'playing' } },
    type: 'youtube.now-playing',
  });
  assert.equal(await h.queue.tick(), 'posted');
  h.queue.submit([frame('WEATHER', 2, { source: 'weather.query' })]);
  assert.equal(h.queue.state().gameLock, null);
  assert.equal(h.queue.pending()[0].status, 'waiting');

  const held = makeQueue({
    rateWindowSeconds: 1,
    priorities: [
      { source: 'youtube.now-playing', jump: true, hold: true, holdMinutes: 90 },
    ],
  });
  held.queue.submit([frame('YT', 1, { source: 'youtube.now-playing' })], {
    payload: { type: 'youtube.now-playing', youtube: { mode: 'playing' } },
    type: 'youtube.now-playing',
  });
  assert.equal(await held.queue.tick(), 'posted');
  held.queue.submit([frame('WEATHER', 2, { source: 'weather.query' })]);
  assert.equal(held.queue.pending()[0].status, 'held');
  assert.equal(held.queue.state().gameLock.source, 'youtube.now-playing');
});

test('a higher-listed live game takes the board from another game', async () => {
  const h = makeQueue({
    rateWindowSeconds: 1,
    priorities: [
      { source: 'huupe.session', jump: true, hold: true, holdMinutes: 15 },
      { source: 'word.scramble', jump: true, hold: true, holdMinutes: 15 },
    ],
  });
  h.queue.submit([frame('SCRAMBLE', 1, { source: 'word.scramble' })]);
  assert.equal(await h.queue.tick(), 'posted');
  h.queue.submit([frame('HUUPE', 2, { source: 'huupe.session' })]);
  assert.equal(h.queue.pending()[0].label, 'HUUPE');
  assert.equal(h.queue.state().gameLock.source, 'huupe.session');
  h.advance(16 * SECOND);
  assert.equal(await h.queue.tick(), 'posted');
  assert.equal(h.transport.posts[1].layout[0][0], 2);
});

test('a lower-listed live game waits behind the one that is holding', async () => {
  const h = makeQueue({ rateWindowSeconds: 1 });
  h.queue.submit([frame('SCRAMBLE', 1, { source: 'word.scramble' })]);
  assert.equal(await h.queue.tick(), 'posted');
  h.queue.submit([frame('HUUPE', 2, { source: 'huupe.session' })]);
  assert.equal(h.queue.state().gameLock.source, 'word.scramble');
  assert.equal(h.queue.pending()[0].label, 'HUUPE');
  assert.equal(h.queue.pending()[0].status, 'held');
});

test('an alarm jumps then the queue continues — it does not hold', async () => {
  const h = makeQueue({ rateWindowSeconds: 1, dwellSeconds: 15 });
  h.queue.submit([frame('ALARM', 9, { source: 'alarm.fired' })], { priority: 'alert' });
  assert.equal(await h.queue.tick(), 'posted');
  assert.equal(h.queue.state().gameLock, null);
  h.queue.submit([frame('WEATHER', 2, { source: 'weather.query' })]);
  assert.equal(h.queue.pending()[0].status, 'waiting');
  h.advance(16 * SECOND);
  assert.equal(await h.queue.tick(), 'posted');
  assert.equal(h.transport.posts[1].layout[0][0], 2);
});
