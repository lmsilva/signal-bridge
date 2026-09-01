/**
 * Scheduler targets, rotation gap, and the replay tool (05 §8).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createVestaboardHub } = require('../src/vestaboard/index');
const { createVestaboardSimulator } = require('../src/vestaboard/simulator');
const { payloadFromLog, replayEvents } = require('../src/vestaboard/replay');

function silentLog() {
  const lines = [];
  return {
    lines,
    info: (message) => lines.push(String(message)),
    warn: (message) => lines.push(String(message)),
    error: (message) => lines.push(String(message)),
    debug() {},
  };
}

function weatherPayload() {
  return {
    type: 'weather.query',
    weather: {
      current: { temperatureF: 72, condition: 'sunny' },
      next7Days: [{ date: '2026-08-24', highF: 80, lowF: 60, condition: 'sunny' }],
    },
  };
}

async function makeHub({ minRotationGapSeconds = 600 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-sched-'));
  const config = {
    ROOT: root,
    vestaboardSimulator: { port: 0, host: '127.0.0.1', rateWindowSeconds: 0 },
  };
  const log = silentLog();
  const simulator = createVestaboardSimulator({ config, log });
  const hub = createVestaboardHub({ config, log, simulator });
  await simulator.start();
  await hub.start();
  hub.settings.upsert({
    id: 'sim',
    quietHours: null,
    rateWindowSeconds: 0,
    minRotationGapSeconds,
  });
  return {
    hub,
    simulator,
    log,
    root,
    async stop() {
      hub.stop();
      await simulator.stop();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test('a log line with a spoken message becomes a broadcast payload', () => {
  const payload = payloadFromLog({
    ts: '2026-08-24T19:00:00.000Z',
    type: 'broadcast',
    device: 'Kitchen Echo',
    message: 'dinner is ready',
  });
  assert.equal(payload.type, 'broadcast');
  assert.equal(payload.message, 'dinner is ready');
  assert.equal(payload.sender, 'Kitchen Echo');
});

test('a 5-minute scheduled rule flips at most once per rotation gap', async () => {
  const h = await makeHub({ minRotationGapSeconds: 600 });
  try {
    const first = h.hub.pushEvent(weatherPayload(), {
      targetId: 'sim',
      scheduler: true,
      explicit: false,
    });
    assert.equal(first.boards[0].reason, 'queued');
    const queue = h.hub.queueFor('sim');
    for (let i = 0; i < 20 && (queue.pending()?.length || 0); i += 1) {
      await queue.tick();
    }

    const second = h.hub.pushEvent(weatherPayload(), {
      targetId: 'sim',
      scheduler: true,
      explicit: false,
    });
    assert.equal(second.boards[0].reason, 'gap');
    const messagePosts = h.simulator.calls().filter((entry) => String(entry.method).includes('POST message'));
    assert.equal(messagePosts.length, 1);
  } finally {
    await h.stop();
  }
});

test('an alert still posts during the rotation gap', async () => {
  const h = await makeHub({ minRotationGapSeconds: 600 });
  try {
    h.hub.pushEvent(weatherPayload(), { targetId: 'sim', scheduler: true });
    const queue = h.hub.queueFor('sim');
    for (let i = 0; i < 20 && (queue.pending()?.length || 0); i += 1) {
      await queue.tick();
    }

    const alert = h.hub.pushEvent({
      type: 'broadcast',
      sender: 'Kitchen',
      message: 'timer done',
    }, { targetId: 'sim', scheduler: true });
    assert.equal(alert.boards[0].reason, 'queued');
    await h.hub.queueFor('sim').tick();
    const messagePosts = h.simulator.calls().filter((entry) => String(entry.method).includes('POST message'));
    assert.ok(messagePosts.length >= 2, 'the alert landed on the board');
  } finally {
    await h.stop();
  }
});

test('a scheduler target of sim still lands on the house line', async () => {
  const h = await makeHub({ minRotationGapSeconds: 0 });
  try {
    h.hub.settings.upsert({
      id: 'kitchen',
      name: 'Kitchen',
      baseUrl: 'http://127.0.0.1:1',
      key: 'a-key',
      quietHours: null,
    });
    assert.equal(h.hub.queueFor('kitchen'), h.hub.queueFor('sim'));
    const outcome = h.hub.pushEvent(weatherPayload(), {
      targetId: 'sim',
      scheduler: true,
      explicit: false,
    });
    assert.ok(outcome.boards.some((row) => row.boardId === 'kitchen'));
    assert.ok(outcome.boards.every((row) => row.reason === 'queued' || row.accepted > 0));
  } finally {
    await h.stop();
  }
});

test('replaying broadcasts through the router exits cleanly against the simulator', async () => {
  const h = await makeHub({ minRotationGapSeconds: 0 });
  try {
    const entries = [
      { ts: '2026-08-24T19:00:00.000Z', type: 'broadcast', device: 'Kitchen', message: 'hello' },
      { ts: '2026-08-24T19:00:10.000Z', type: 'photo.slideshow' },
      { ts: '2026-08-24T19:00:20.000Z', type: 'broadcast', device: 'Kitchen', message: 'second' },
    ];
    const summary = await replayEvents({
      entries,
      hub: h.hub,
      boardId: 'sim',
      speed: 1000,
      wait: async () => {},
      log: silentLog(),
    });
    assert.equal(summary.failed, 0);
    assert.ok(summary.accepted >= 1);
    assert.ok(summary.results.some((row) => row.reason === 'no-formatter'));
  } finally {
    await h.stop();
  }
});
