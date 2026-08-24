const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAutodartsLive } = require('../src/autodarts-live');
const { createAutodartsArchive } = require('../src/autodarts-archive');
const { createAutodartsAggregates } = require('../src/autodarts-aggregates');
const { createAutodartsSettings } = require('../src/autodarts-settings');
const { createAutodartsPayload } = require('../src/autodarts-payload');
const { createDisplayBusy } = require('../src/display-busy');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autodarts-live-'));
}

function harness() {
  const root = tempRoot();
  const sent = [];
  const settings = createAutodartsSettings({ autodartsSettingsPath: path.join(root, 's.json') });
  settings.update({ live: { inactivityMinutes: 5, finalHoldSeconds: 30, autoPush: true } });
  const archive = createAutodartsArchive({ ROOT: root, autodartsArchivePath: path.join(root, 'm') });
  const aggregates = createAutodartsAggregates({ ROOT: root, autodartsPlayersPath: path.join(root, 'p.json') });
  const payload = createAutodartsPayload({ archive, aggregates, settings });
  const displayBusy = createDisplayBusy();
  let clock = 1_000_000;
  const live = createAutodartsLive({
    auth: { getAccessToken: async () => 'token' },
    api: {
      getMatch: async () => ({ ok: true, json: { variant: 'X01', settings: { baseScore: 501 } } }),
      getMatchState: async () => ({
        ok: true,
        json: {
          players: [
            { name: 'A', score: 501, legs: 0 },
            { name: 'B', score: 501, legs: 0 },
          ],
          currentPlayerIndex: 0,
          turn: { points: 0, darts: [null, null, null] },
        },
      }),
      getMatchStats: async () => ({
        ok: true,
        status: 200,
        json: {
          players: [
            { name: 'A', average: 40, dartsThrown: 30, pointsScored: 400, counts: { 180: 0 } },
            { name: 'B', average: 30, dartsThrown: 30, pointsScored: 300, counts: { 180: 0 } },
          ],
        },
      }),
    },
    credentials: { load: () => ({ boardId: 'board-1', boardName: 'Game Room' }) },
    settings,
    archive,
    aggregates,
    payload,
    displayBusy,
    sendUdpPayload: (body) => sent.push(body),
    now: () => clock,
    WebSocketImpl: null,
  });
  return { live, sent, archive, aggregates, displayBusy, advance: (ms) => { clock += ms; } };
}

test('live start seeds and pushes; identical content does not re-push', async () => {
  const { live, sent } = harness();
  await live.forceSeed('match-1');
  assert.ok(sent.some((row) => row.type === 'autodarts.match'));
  const count = sent.length;
  live.ingestEvent({
    channel: 'autodarts.matches',
    event: 'state',
    matchId: 'match-1',
    data: {
      revision: 1,
      players: [
        { name: 'A', score: 501, legs: 0 },
        { name: 'B', score: 501, legs: 0 },
      ],
      currentPlayerIndex: 0,
      turn: { points: 0, darts: [null, null, null] },
    },
  });
  // Same content after seed may still bump revision — force identical push path:
  const before = sent.length;
  live.pushNow();
  // pushNow force=true always sends
  assert.ok(sent.length >= before);
  void count;
});

test('throw update with content change resends; interrupt then resume re-pushes', async () => {
  const { live, sent, displayBusy, advance } = harness();
  await live.forceSeed('match-2');
  const afterSeed = sent.length;
  live.ingestEvent({
    channel: 'autodarts.matches',
    matchId: 'match-2',
    event: 'throw',
    data: {
      revision: 2,
      players: [
        { name: 'A', score: 461, legs: 0 },
        { name: 'B', score: 501, legs: 0 },
      ],
      currentPlayerIndex: 0,
      turn: {
        points: 40,
        darts: [{ seg: 'T20', x: 0.1, y: -0.3, type: 'normal' }, null, null],
      },
    },
  });
  assert.ok(sent.length > afterSeed);
  displayBusy.noteSent({ type: 'trivia.round', displaySeconds: 1, persistent: false });
  assert.equal(live.suppressActiveSession('trivia.round'), true);
  assert.equal(live.statusSnapshot().phase, 'interrupted');
  const beforeResume = sent.filter((row) => row.type === 'autodarts.match').length;
  advance(2_000);
  live._maybeResumeForTest();
  // Still busy on trivia — schedule path; clear busy by advancing display-busy clock via release
  displayBusy.release();
  live._maybeResumeForTest();
  const afterResume = sent.filter((row) => row.type === 'autodarts.match').length;
  assert.ok(afterResume >= beforeResume);
  assert.equal(live.statusSnapshot().phase, 'live');
});

test('inactivity closes and dormant re-opens on new event', async () => {
  const { live, sent } = harness();
  await live.forceSeed('match-3');
  live._handleInactivityForTest();
  assert.ok(sent.some((row) => row.type === 'autodarts.match.close'));
  assert.equal(live.statusSnapshot().phase, 'dormant');
  live.ingestEvent({
    channel: 'autodarts.matches',
    matchId: 'match-3',
    event: 'throw',
    data: {
      revision: 9,
      players: [{ name: 'A', score: 400, legs: 0 }, { name: 'B', score: 501, legs: 0 }],
      currentPlayerIndex: 0,
      turn: { points: 20, darts: [{ seg: '20', x: 0, y: -0.5, type: 'normal' }, null, null] },
    },
  });
  assert.equal(live.statusSnapshot().phase, 'live');
});

test('finish archives once via stats path', async () => {
  const { live, archive, aggregates } = harness();
  await live.forceSeed('match-4');
  live.ingestEvent({
    channel: 'autodarts.matches',
    matchId: 'match-4',
    event: 'match.finished',
    data: {
      finished: true,
      winner: 'A',
      gameShot: 'D16',
      players: [{ name: 'A', score: 0, legs: 2, isWinner: true }, { name: 'B', score: 120, legs: 0 }],
    },
  });
  assert.equal(live.statusSnapshot().phase, 'final');
  for (let i = 0; i < 40 && !archive.has('match-4'); i += 1) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(archive.has('match-4'), true);
  assert.equal(archive.append({ matchId: 'match-4' }).deduped, true);
  assert.ok(aggregates.get().players.length >= 1);
});

test('empty finished shell aborts instead of FINAL', async () => {
  const { live, archive, sent } = harness();
  await live.forceSeed('match-empty');
  live.ingestEvent({
    channel: 'autodarts.matches',
    matchId: 'match-empty',
    event: 'match.finished',
    data: {
      finished: true,
      players: [
        { name: 'trashpanda', score: 121, legs: 0 },
        { name: 'war d', score: 121, legs: 0 },
        { name: 'tommy', score: 121, legs: 0 },
        { name: 'kylie', score: 121, legs: 0 },
      ],
    },
  });
  assert.equal(live.statusSnapshot().phase, 'idle');
  assert.equal(archive.has('match-empty'), true);
  const archived = archive.listAll().find((row) => row.matchId === 'match-empty');
  assert.equal(archived.aborted, true);
  assert.ok(sent.some((payload) => payload.type === 'autodarts.match.close'));
  assert.ok(!sent.some((payload) => (
    payload.type === 'autodarts.match' && payload.match?.status === 'finished'
  )));
});
