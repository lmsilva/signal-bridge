/**
 * The board HTTP client (01 §2, 04 §1).
 *
 * The last test is the one that matters: the real queue, the real transport
 * and the real simulator, wired together over a socket. If that passes, the
 * only thing a physical board changes is which host the transport points at.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createTransport,
  classify,
  joinPath,
  KEY_HEADER,
  ENABLEMENT_HEADER,
} = require('../src/vestaboard/transport');
const { createQueue } = require('../src/vestaboard/queue');
const { createVestaboardSimulator } = require('../src/vestaboard/simulator');
const { badgeFrame } = require('../src/vestaboard/frames');
const { blankRow, COLS } = require('../src/vestaboard/encoder');

function layout(seed) {
  const rows = Array.from({ length: 6 }, () => blankRow(COLS));
  rows[0][0] = seed;
  return rows;
}

/** A fetch stand-in that answers however the test says. */
function fakeFetch(answer) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    const reply = typeof answer === 'function' ? await answer(url, options) : answer;
    return {
      status: reply.status,
      json: async () => {
        if (reply.body === undefined) throw new Error('no body');
        return reply.body;
      },
    };
  };
  impl.calls = calls;
  return impl;
}

test('the message path is appended once, however the base url was written', () => {
  assert.equal(joinPath('http://board.local:7000', '/local-api/message'), 'http://board.local:7000/local-api/message');
  assert.equal(joinPath('http://board.local:7000/', '/local-api/message'), 'http://board.local:7000/local-api/message');
  assert.equal(joinPath('http://board.local:7000///', '/local-api/message'), 'http://board.local:7000/local-api/message');
  // Someone pasting the full endpoint out of the docs should still work.
  assert.equal(joinPath('http://board.local:7000/local-api/message', '/local-api/message'), 'http://board.local:7000/local-api/message');
});

test('every status maps to the one thing the queue needs to know', () => {
  assert.equal(classify(200), 'ok');
  assert.equal(classify(201), 'ok');
  assert.equal(classify(503), 'busy');
  assert.equal(classify(401), 'auth');
  assert.equal(classify(403), 'auth');
  assert.equal(classify(400), 'layout');
  assert.equal(classify(500), 'server');
  assert.equal(classify(502), 'server');
  assert.equal(classify(404), 'layout');
});

test('a plain flip posts the bare grid the local api expects', async () => {
  const impl = fakeFetch({ status: 200, body: { status: 'ok' } });
  const transport = createTransport({ baseUrl: 'http://board:7000', key: 'k1', fetchImpl: impl });

  const outcome = await transport.post(layout(5));
  assert.equal(outcome.ok, true);
  assert.equal(outcome.reason, 'ok');

  const sent = JSON.parse(impl.calls[0].options.body);
  assert.ok(Array.isArray(sent), 'no wrapper object when there is nothing to animate');
  assert.equal(sent[0][0], 5);
  assert.equal(impl.calls[0].options.headers[KEY_HEADER], 'k1');
});

test('a transition turns the post into the animated form', async () => {
  const impl = fakeFetch({ status: 200, body: { status: 'ok' } });
  const transport = createTransport({ baseUrl: 'http://board:7000', key: 'k1', fetchImpl: impl });

  await transport.post(layout(5), { strategy: 'edges-to-center', stepIntervalMs: 3000, stepSize: 2 });

  const sent = JSON.parse(impl.calls[0].options.body);
  assert.equal(sent.strategy, 'edges-to-center');
  assert.equal(sent.step_interval_ms, 3000);
  assert.equal(sent.step_size, 2);
  assert.equal(sent.characters[0][0], 5);
});

test('failures come back classified rather than thrown', async () => {
  const cases = [
    [401, 'auth', false],
    [400, 'layout', false],
    [503, 'busy', true],
    [500, 'server', true],
  ];
  for (const [status, reason, retryable] of cases) {
    const transport = createTransport({
      baseUrl: 'http://board:7000',
      key: 'k1',
      fetchImpl: fakeFetch({ status, body: { message: 'nope' } }),
    });
    const outcome = await transport.post(layout(1));
    assert.equal(outcome.reason, reason, `status ${status}`);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.retryable, retryable, `status ${status} retryable`);
  }
});

test('a board that never answers is a network failure, not a crash', async () => {
  const transport = createTransport({
    baseUrl: 'http://board:7000',
    key: 'k1',
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  });
  const outcome = await transport.post(layout(1));
  assert.equal(outcome.reason, 'network');
  assert.equal(outcome.retryable, true);
  assert.equal(outcome.status, 0);
});

test('a board that answers too slowly is abandoned', async () => {
  const transport = createTransport({
    baseUrl: 'http://board:7000',
    key: 'k1',
    timeoutMs: 20,
    fetchImpl: (url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
  });
  const outcome = await transport.post(layout(1));
  assert.equal(outcome.reason, 'network');
});

test('reading the board gives back the grid it is showing', async () => {
  const grid = layout(7);
  const transport = createTransport({
    baseUrl: 'http://board:7000',
    key: 'k1',
    fetchImpl: fakeFetch({ status: 200, body: grid }),
  });
  const outcome = await transport.read();
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.layout, grid);
});

test('enablement trades the emailed token for the key', async () => {
  const impl = fakeFetch({ status: 200, body: { message: 'Local API enabled', apiKey: 'issued-key' } });
  const transport = createTransport({ baseUrl: 'http://board:7000', fetchImpl: impl });

  const outcome = await transport.enable('emailed-token');
  assert.equal(outcome.apiKey, 'issued-key');
  assert.equal(impl.calls[0].options.headers[ENABLEMENT_HEADER], 'emailed-token');
});

/** Bring up a real simulator and hand back a transport already pointed at it. */
async function liveBoard({ rateWindowSeconds = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-tx-'));
  const simulator = createVestaboardSimulator({
    config: {
      ROOT: root,
      vestaboardSimulator: { port: 0, host: '127.0.0.1', rateWindowSeconds },
    },
    log: { info() {}, warn() {}, error() {}, debug() {} },
  });
  await simulator.start();
  const baseUrl = `http://127.0.0.1:${simulator.address().port}`;

  const enabler = createTransport({ baseUrl });
  const { apiKey } = await enabler.enable(simulator.enablementToken());

  return {
    simulator,
    baseUrl,
    apiKey,
    transport: createTransport({ baseUrl, key: apiKey }),
    async stop() {
      await simulator.stop();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test('against a live board the client walks the whole contract', async () => {
  const board = await liveBoard({ rateWindowSeconds: 0 });
  try {
    const frame = badgeFrame({ color: 'green', title: 'SHOPPING LIST', rows: ['MILK'] });

    assert.equal((await board.transport.post(frame)).reason, 'ok');
    assert.deepEqual((await board.transport.read()).layout, frame);

    // Same content again: accepted, and the board does not move.
    assert.equal((await board.transport.post(frame)).reason, 'ok');

    const broken = layout(1);
    broken[0][0] = 99;
    assert.equal((await board.transport.post(broken)).reason, 'layout');

    const wrongKey = createTransport({ baseUrl: board.baseUrl, key: 'not-the-key' });
    assert.equal((await wrongKey.post(layout(2))).reason, 'auth');

    board.simulator.setOnline(false);
    assert.equal((await board.transport.post(layout(3))).reason, 'busy');
  } finally {
    await board.stop();
  }
});

test('the queue drives a real board over HTTP with nothing board-specific in between', async () => {
  // This is the invariant the simulator exists to protect: swapping in
  // hardware changes the base URL and the key, and nothing else.
  const board = await liveBoard({ rateWindowSeconds: 0 });
  let clock = 5_000_000;
  try {
    const queue = createQueue({
      board: { id: 'sim', rateWindowSeconds: 0 },
      transport: board.transport,
      log: { info() {}, warn() {}, error() {}, debug() {} },
      now: () => clock,
    });

    const first = badgeFrame({ color: 'blue', title: 'WEATHER', rows: ['SUNNY'] });
    const alert = badgeFrame({ color: 'red', title: 'TIMER', rows: ['PASTA'] });

    queue.submit([{ rows: first, dwellSeconds: 15, label: 'Weather', source: 'weather' }]);
    assert.equal(await queue.tick(), 'posted');
    assert.deepEqual((await board.transport.read()).layout, first);

    clock += 15_000;
    queue.submit([{ rows: alert, dwellSeconds: 20, label: 'Timer', source: 'timer.fired' }], { priority: 'alert' });
    assert.equal(await queue.tick(), 'posted');
    assert.deepEqual((await board.transport.read()).layout, alert);

    // After the alert's dwell the board returns to the weather by itself.
    clock += 21_000;
    await queue.tick();
    assert.equal(await queue.tick(), 'posted');
    assert.deepEqual((await board.transport.read()).layout, first);

    assert.equal(queue.state().health, 'ok');

    const results = board.simulator.calls().map((call) => call.result);
    assert.deepEqual(results.filter((r) => r.startsWith('200 flipped')).length, 3);
  } finally {
    await board.stop();
  }
});

test('a board switched off mid-run holds its frame and posts it on return', async () => {
  const board = await liveBoard({ rateWindowSeconds: 0 });
  let clock = 9_000_000;
  try {
    const queue = createQueue({
      board: { id: 'sim', rateWindowSeconds: 0 },
      transport: board.transport,
      log: { info() {}, warn() {}, error() {}, debug() {} },
      now: () => clock,
    });

    board.simulator.setOnline(false);
    queue.submit([{ rows: badgeFrame({ color: 'green', title: 'HELLO', rows: [] }), dwellSeconds: 15, label: 'Hello', source: 'test' }]);

    // Offline reads as back-pressure, so the frame is kept and retried.
    assert.equal(await queue.tick(), 'busy');
    assert.deepEqual(queue.pending().map((i) => i.label), ['Hello']);

    board.simulator.setOnline(true);
    clock += 16_000;
    assert.equal(await queue.tick(), 'posted');
    assert.equal(queue.state().health, 'ok');
  } finally {
    await board.stop();
  }
});
