/**
 * The (event type, kind) table and the fan-out that uses it (01 §6, 05 §7).
 *
 * A push to All Displays is safe because each board looks up its own
 * formatter. Content a board cannot show never becomes an HTTP call, and the
 * skip line is written once per board — never silent, never a blank flip.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  FORMATTERS,
  COMMAND_TO_TYPE,
  formatterFor,
  typeOf,
  matchBoards,
  coalesceKeyFor,
  routeEvent,
} = require('../src/vestaboard/router');
const { BOARD_COMMAND_IDS } = require('../src/command-registry');
const { createVestaboardHub } = require('../src/vestaboard/index');
const { createVestaboardSimulator } = require('../src/vestaboard/simulator');

function silentLog() {
  const lines = [];
  return {
    lines,
    debug: (message) => lines.push(String(message)),
    info() {},
    warn() {},
    error() {},
  };
}

const WEATHER = {
  type: 'weather.query',
  weather: {
    current: { temperatureF: 93, condition: 'sunny' },
    next7Days: [{ date: '2026-08-24', highF: 96, lowF: 66, condition: 'sunny' }],
  },
};

const PHOTO = {
  type: 'photo.slideshow',
  slideshow: { photos: [{ url: 'https://example.test/a.jpg' }], secondsPerPhoto: 8 },
};

const SMART_HOME = {
  type: 'smart-home.command',
  device: 'Kitchen Echo',
  timestamp: '2026-08-24T19:00:00',
  command: { action: 'off', matchedName: 'Kitchen Lights', target: 'kitchen lights' },
};

function twoBoards() {
  return [
    { board: { id: 'sim', events: 'all' } },
    { board: { id: 'kitchen', events: 'all' } },
  ];
}

test('every board-capable command id maps to a registered formatter', () => {
  for (const id of BOARD_COMMAND_IDS) {
    const type = COMMAND_TO_TYPE[id] || id;
    assert.ok(FORMATTERS[type], `${id} maps to ${type}, which has no formatter`);
  }
});

test('command ids that differ from the UDP type still find their formatter', () => {
  assert.equal(typeOf({}, 'tesla.dashboard'), 'tesla-dashboard.query');
  assert.equal(typeOf({}, 'goodnews.show'), 'upside-news.round');
  assert.equal(typeOf({}, 'alexa.timers'), 'timer.snapshot');
  assert.ok(formatterFor('tesla.dashboard'));
  assert.ok(formatterFor('credits.show'));
  assert.ok(formatterFor('roll-credits.tour'));
  assert.equal(formatterFor('signal.slideshow'), null);
  assert.equal(formatterFor('photo.slideshow'), null);
});

test('a roll credits tour posts instead of skipping as no-formatter', () => {
  const submitted = [];
  const results = routeEvent({
    payload: {
      type: 'roll-credits.tour',
      count: 3,
      stats: {
        total: 3,
        latest: {
          title: 'Celeste', system: 'switch', systemLabel: 'Switch', beatenAt: '2026-08-22',
        },
        bySystem: [{ id: 'switch', label: 'Switch', count: 3 }],
      },
    },
    boards: [{ board: { id: 'sim', events: 'all' } }],
    submit: (_boardId, frames) => {
      submitted.push(frames);
      return { ok: true, accepted: frames.length };
    },
  });
  assert.equal(results[0].reason, 'posted');
  assert.equal(submitted.length, 1);
});

test('matchBoards treats all / vestaboard as every board and full as none', () => {
  const boards = twoBoards();
  assert.equal(matchBoards(boards, 'all').length, 2);
  assert.equal(matchBoards(boards, '*').length, 2);
  assert.equal(matchBoards(boards, '').length, 2);
  assert.equal(matchBoards(boards, 'vestaboard').length, 2);
  assert.deepEqual(matchBoards(boards, 'full'), []);
  assert.deepEqual(matchBoards(boards, 'kitchen').map((entry) => entry.board.id), ['kitchen']);
});

test('a photo push never submits frames and logs one skip line per board', () => {
  const log = silentLog();
  const submitted = [];
  const results = routeEvent({
    payload: PHOTO,
    boards: twoBoards(),
    targetId: 'all',
    submit: (boardId, frames) => {
      submitted.push({ boardId, frames });
      return { ok: true, accepted: frames.length };
    },
    log,
  });

  assert.equal(submitted.length, 0);
  assert.equal(results.length, 2);
  assert.ok(results.every((row) => row.reason === 'no-formatter'));
  assert.deepEqual(
    log.lines,
    [
      'no board formatter for photo.slideshow, skipped sim',
      'no board formatter for photo.slideshow, skipped kitchen',
    ],
  );
});

test('a weather push posts to every board that allows it', () => {
  const submitted = [];
  const results = routeEvent({
    payload: WEATHER,
    boards: twoBoards(),
    submit: (boardId, frames, options) => {
      submitted.push({ boardId, frames, options });
      return { ok: true, accepted: frames.length };
    },
  });

  assert.equal(results.length, 2);
  assert.ok(results.every((row) => row.reason === 'posted'));
  assert.equal(submitted.length, 2);
  assert.ok(submitted[0].frames.length >= 1);
  assert.equal(submitted[0].options.priority, 'snapshot');
});

test('an allowlist board skips types it did not subscribe to', () => {
  const log = silentLog();
  const submitted = [];
  routeEvent({
    payload: WEATHER,
    boards: [
      { board: { id: 'sim', events: ['broadcast'] } },
      { board: { id: 'kitchen', events: 'all' } },
    ],
    submit: (boardId, frames) => {
      submitted.push(boardId);
      return { ok: true, accepted: frames.length };
    },
    log,
  });

  assert.deepEqual(submitted, ['kitchen']);
  assert.equal(log.lines.length, 1);
  assert.match(log.lines[0], /skip \(allowlist\) weather\.query/);
});

test('empty content is skipped silently, even when someone asked', () => {
  const log = silentLog();
  const submitted = [];
  const emptyTimers = { type: 'timer.snapshot', event: { kind: 'list' }, timers: [] };

  const rotation = routeEvent({
    payload: emptyTimers,
    boards: [{ board: { id: 'sim', events: 'all' } }],
    explicit: false,
    submit: (boardId, frames) => {
      submitted.push(frames);
      return { ok: true, accepted: frames.length };
    },
    log,
  });
  assert.equal(rotation[0].reason, 'empty');
  assert.equal(submitted.length, 0);
  assert.equal(log.lines.length, 0);

  const asked = routeEvent({
    payload: emptyTimers,
    boards: [{ board: { id: 'sim', events: 'all' } }],
    explicit: true,
    submit: (boardId, frames) => {
      submitted.push(frames);
      return { ok: true, accepted: frames.length };
    },
    log,
  });
  assert.equal(asked[0].reason, 'posted');
  assert.equal(submitted.length, 1);
});

test('a smart-home command coalesces per device, not per room that heard it', () => {
  assert.equal(
    coalesceKeyFor(SMART_HOME, 'smart-home.command'),
    'smart-home:Kitchen Lights',
  );

  let options = null;
  routeEvent({
    payload: SMART_HOME,
    boards: [{ board: { id: 'sim', events: 'all' } }],
    submit: (_boardId, _frames, submitted) => {
      options = submitted;
      return { ok: true, accepted: 1 };
    },
  });
  assert.equal(options.coalesceKey, 'smart-home:Kitchen Lights');
});

test('an explicit push is exempt from quiet hours; a rotation is not', () => {
  let options = null;
  routeEvent({
    payload: WEATHER,
    boards: [{ board: { id: 'sim', events: 'all' } }],
    explicit: true,
    submit: (_boardId, _frames, submitted) => {
      options = submitted;
      return { ok: true, accepted: 1 };
    },
  });
  assert.equal(options.quietHoursExempt, true);

  routeEvent({
    payload: WEATHER,
    boards: [{ board: { id: 'sim', events: 'all' } }],
    explicit: false,
    scheduler: true,
    submit: (_boardId, _frames, submitted) => {
      options = submitted;
      return { ok: true, accepted: 1 };
    },
  });
  assert.equal(options.quietHoursExempt, false);
});

test('targeting full never offers frames to a board', () => {
  const log = silentLog();
  const results = routeEvent({
    payload: WEATHER,
    boards: twoBoards(),
    targetId: 'full',
    submit: () => {
      throw new Error('a full-display target must not reach a board');
    },
    log,
  });
  assert.deepEqual(results, []);
  assert.deepEqual(log.lines, []);
});

test('a photo push to the live simulator never produces a board HTTP call', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-router-'));
  const config = {
    ROOT: root,
    vestaboardSimulator: { port: 0, host: '127.0.0.1', rateWindowSeconds: 0 },
  };
  const log = silentLog();
  const simulator = createVestaboardSimulator({ config, log });
  const hub = createVestaboardHub({ config, log, simulator });
  await simulator.start();
  await hub.start();

  try {
    const messagePosts = (calls) => calls.filter((entry) => String(entry.method).includes('POST message'));
    const postsBefore = messagePosts(simulator.calls()).length;
    const outcome = hub.pushEvent(PHOTO, { targetId: 'all', explicit: true });
    assert.equal(outcome.boards.length, 1);
    assert.equal(outcome.boards[0].reason, 'no-formatter');
    assert.match(log.lines.join('\n'), /no board formatter for photo.slideshow, skipped sim/);
    assert.equal(
      log.lines.filter((line) => line.includes('no board formatter for photo.slideshow')).length,
      1,
    );
    assert.equal(
      messagePosts(simulator.calls()).length,
      postsBefore,
      'the simulator call log must not gain a message POST',
    );
  } finally {
    hub.stop();
    await simulator.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the admin Push grid filters by the selected display kind', () => {
  const appJs = fs.readFileSync(
    path.join(__dirname, '../src/web/admin/app.js'),
    'utf8',
  );
  assert.match(appJs, /function commandSupportsSelectedKind/);
  assert.match(appJs, /showing board-capable pushes only/);
  assert.match(appJs, /entry\.kind !== 'vestaboard'/);
});
