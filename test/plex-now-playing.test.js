const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseSessions } = require('../src/plex-api');
const { sanitiseSettings } = require('../src/plex-settings');
const { createPlexNowPlaying } = require('../src/plex-now-playing');

const THEATER = '192.168.50.71';

function movie(overrides = {}) {
  const player = {
    address: THEATER,
    name: 'Movie Theater',
    product: 'Plex for Apple TV',
    state: 'playing',
    ...(overrides.player || {}),
  };
  const rest = { ...overrides };
  delete rest.player;
  return {
    sessionKey: '42',
    type: 'movie',
    title: 'Interstellar',
    contentRating: 'PG-13',
    criticScore: 8.7,
    durationMs: 10_140_000,
    viewOffsetMs: 312_000,
    player,
    ...rest,
  };
}

function fakeSettings(overrides = {}) {
  let current = sanitiseSettings({
    enabled: true,
    serverUrl: 'http://127.0.0.1:32400',
    monitoredPlayers: [THEATER],
    mediaTypes: ['movie'],
    pollIntervalMs: 15000,
    stopGraceMs: 30000,
    repushEndDriftMinutes: 5,
    pushOnStop: true,
    quietHoursExempt: true,
    showCriticScore: true,
    stateFile: 'plex-now-playing.json',
    ...overrides,
  });
  return {
    get: () => ({ ...current }),
    update(patch) {
      current = sanitiseSettings({ ...current, ...patch }, current);
      return { ...current };
    },
  };
}

function makeWatcher({
  sessions = [],
  fail = null,
  nowMs = Date.parse('2026-08-28T21:05:00-06:00'),
  settings = fakeSettings(),
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'plex-np-')),
} = {}) {
  const sent = [];
  let clock = nowMs;
  const watcher = createPlexNowPlaying({
    config: { ROOT: root, plexCredentialsPath: path.join(root, 'creds.json') },
    log: { warn() {}, info() {}, debug() {} },
    settings,
    now: () => clock,
    sendUdpPayload: (payload, options) => {
      sent.push({ payload, options });
    },
    fetchSessions: async () => {
      if (typeof fail === 'function') {
        throw fail();
      }
      if (fail) {
        throw fail;
      }
      return typeof sessions === 'function' ? sessions() : sessions;
    },
  });
  return {
    watcher,
    sent,
    settings,
    root,
    setNow: (value) => { clock = value; },
    advance: (ms) => { clock += ms; },
  };
}

test('parseSessions reads the fields Feature Presentation uses', () => {
  const sessions = parseSessions({
    MediaContainer: {
      Metadata: [{
        sessionKey: '42',
        type: 'movie',
        title: 'Interstellar',
        contentRating: 'PG-13',
        rating: 8.7,
        audienceRating: 8.6,
        duration: 10140000,
        viewOffset: 312000,
        Player: {
          address: THEATER,
          title: 'Movie Theater',
          product: 'Plex for Apple TV',
          state: 'playing',
        },
      }],
    },
  });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].title, 'Interstellar');
  assert.equal(sessions[0].criticScore, 8.7);
  assert.equal(sessions[0].player.address, THEATER);
});

test('idle to playing emits now-playing with vestaboard targeting', async () => {
  process.env.PLEX_TOKEN = 'test-token';
  const { watcher, sent } = makeWatcher({ sessions: [movie()] });
  await watcher.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.type, 'plex.now-playing');
  assert.equal(sent[0].payload.plex.mode, 'now-playing');
  assert.equal(sent[0].payload.plex.title, 'Interstellar');
  assert.equal(sent[0].options.targetId, 'vestaboard');
  assert.equal(sent[0].options.explicit, false);
  assert.equal(sent[0].options.quietHoursExempt, true);
});

test('pause does not emit', async () => {
  process.env.PLEX_TOKEN = 'test-token';
  let current = [movie()];
  const { watcher, sent } = makeWatcher({ sessions: () => current });
  await watcher.tick();
  current = [movie({ player: { state: 'paused' } })];
  await watcher.tick();
  assert.equal(sent.length, 1);
  assert.equal(watcher._debug().session.paused, true);
});

test('a short resume does not re-emit; a 5+ minute pause does', async () => {
  process.env.PLEX_TOKEN = 'test-token';
  let current = [movie({ viewOffsetMs: 312_000 })];
  const { watcher, sent, advance } = makeWatcher({ sessions: () => current });
  await watcher.tick();

  current = [movie({ viewOffsetMs: 312_000, player: { state: 'paused' } })];
  await watcher.tick();
  advance(60_000);
  current = [movie({ viewOffsetMs: 312_000 })];
  await watcher.tick();
  assert.equal(sent.length, 1, 'one-minute pause stays under the drift floor');

  current = [movie({ viewOffsetMs: 312_000, player: { state: 'paused' } })];
  await watcher.tick();
  advance(6 * 60_000);
  current = [movie({ viewOffsetMs: 312_000 })];
  await watcher.tick();
  assert.equal(sent.length, 2, 'a bathroom pause that moves the end time re-posts');
  assert.equal(sent[1].payload.plex.mode, 'now-playing');
});

test('a seek past poll interval plus slack re-emits when the end time drifts', async () => {
  process.env.PLEX_TOKEN = 'test-token';
  let current = [movie({ viewOffsetMs: 312_000 })];
  const { watcher, sent, advance } = makeWatcher({ sessions: () => current });
  await watcher.tick();
  advance(15_000);
  current = [movie({ viewOffsetMs: 312_000 + 10 * 60_000 })];
  await watcher.tick();
  assert.equal(sent.length, 2);
});

test('stop grace only counts successful empty polls', async () => {
  process.env.PLEX_TOKEN = 'test-token';
  let current = [movie()];
  let fail = null;
  const { watcher, sent, advance } = makeWatcher({
    sessions: () => {
      if (fail) {
        throw fail;
      }
      return current;
    },
  });
  await watcher.tick();
  current = [];
  advance(10_000);
  await watcher.tick();
  assert.equal(sent.length, 1, 'still inside the grace window');

  fail = Object.assign(new Error('down'), { kind: 'network' });
  advance(30_000);
  await watcher.tick();
  assert.equal(sent.length, 1, 'a failed poll is not a stop');
  assert.equal(watcher._debug().session.title, 'Interstellar');

  fail = null;
  advance(30_000);
  await watcher.tick();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].payload.plex.mode, 'last-played');
  assert.equal(watcher._debug().session, null);
});

test('a movie switch is stop then play in one poll, without a last-played flash', async () => {
  process.env.PLEX_TOKEN = 'test-token';
  let current = [movie()];
  const { watcher, sent } = makeWatcher({ sessions: () => current });
  await watcher.tick();
  current = [movie({ sessionKey: '99', title: 'Dune', viewOffsetMs: 1000 })];
  await watcher.tick();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].payload.plex.mode, 'now-playing');
  assert.equal(sent[1].payload.plex.title, 'Dune');
  assert.equal(watcher._debug().lastPlayed.title, 'Interstellar');
});

test('the newest session wins when two theater streams qualify', async () => {
  process.env.PLEX_TOKEN = 'test-token';
  const older = movie({ sessionKey: '10', title: 'Old' });
  const newer = movie({ sessionKey: '99', title: 'New' });
  const { watcher, sent } = makeWatcher({ sessions: [older, newer] });
  await watcher.tick();
  assert.equal(sent[0].payload.plex.title, 'New');
});

test('a phone on another IP is invisible', async () => {
  process.env.PLEX_TOKEN = 'test-token';
  const { watcher, sent } = makeWatcher({
    sessions: [movie({ player: { address: '192.168.50.9' } })],
  });
  await watcher.tick();
  assert.equal(sent.length, 0);
});

test('restart with the same session still playing re-emits and keeps startedAt', async () => {
  process.env.PLEX_TOKEN = 'test-token';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plex-np-'));
  const first = makeWatcher({ sessions: [movie()], root });
  await first.watcher.tick();
  const startedAt = first.sent[0].payload.plex.startedAt;

  const second = makeWatcher({ sessions: [movie()], root });
  await second.watcher.tick();
  assert.equal(second.sent.length, 1);
  assert.equal(second.sent[0].payload.plex.startedAt, startedAt);
});

test('a 401 slows polling and never looks like a stop', async () => {
  process.env.PLEX_TOKEN = 'test-token';
  let current = [movie()];
  let fail = null;
  const { watcher, sent } = makeWatcher({
    sessions: () => {
      if (fail) throw fail;
      return current;
    },
  });
  await watcher.tick();
  fail = Object.assign(new Error('nope'), { kind: 'auth', status: 401 });
  await watcher.tick();
  await watcher.tick();
  assert.equal(sent.length, 1);
  assert.equal(watcher.statusSnapshot().health, 'auth');
  assert.ok(watcher._debug().session);
});

test('pushOnStop false leaves last-played stored but does not emit', async () => {
  process.env.PLEX_TOKEN = 'test-token';
  let current = [movie()];
  const { watcher, sent, advance } = makeWatcher({
    sessions: () => current,
    settings: fakeSettings({ pushOnStop: false }),
  });
  await watcher.tick();
  current = [];
  advance(30_000);
  await watcher.tick();
  assert.equal(sent.length, 1);
  assert.equal(watcher._debug().lastPlayed.title, 'Interstellar');
});

test('manual auto preview falls back to last played, and empty is explicit', async () => {
  process.env.PLEX_TOKEN = 'test-token';
  const { watcher, sent } = makeWatcher({ sessions: [] });
  const result = await watcher.pushManualPreview({ requestedMode: 'auto' });
  assert.equal(result.ok, true);
  assert.equal(sent[0].options.explicit, true);
  assert.equal(sent[0].payload.plex.title, '');
});
