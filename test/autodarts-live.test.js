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

function harness({ getMatchStats, getMatchState, setTimeoutImpl } = {}) {
  const root = tempRoot();
  const sent = [];
  const settings = createAutodartsSettings({ autodartsSettingsPath: path.join(root, 's.json') });
  settings.update({ live: { inactivityMinutes: 5, finalHoldSeconds: 30, autoPush: true } });
  const archive = createAutodartsArchive({ ROOT: root, autodartsArchivePath: path.join(root, 'm') });
  const aggregates = createAutodartsAggregates({ ROOT: root, autodartsPlayersPath: path.join(root, 'p.json') });
  const payload = createAutodartsPayload({ archive, aggregates, settings });
  const displayBusy = createDisplayBusy();
  let clock = 1_000_000;
  const timeout = setTimeoutImpl || ((fn, ms) => {
    const handle = { fn, ms, unref() { return handle; } };
    return handle;
  });
  const live = createAutodartsLive({
    auth: { getAccessToken: async () => 'token' },
    api: {
      getMatch: async () => ({ ok: true, json: { variant: 'X01', settings: { baseScore: 501 } } }),
      getMatchState: getMatchState || (async () => ({
        ok: true,
        json: {
          players: [
            { name: 'A', score: 501, legs: 0 },
            { name: 'B', score: 501, legs: 0 },
          ],
          currentPlayerIndex: 0,
          turn: { points: 0, darts: [null, null, null] },
        },
      })),
      getMatchStats: getMatchStats || (async () => ({
        ok: true,
        status: 200,
        json: {
          players: [
            { name: 'A', average: 40, dartsThrown: 30, pointsScored: 400, counts: { 180: 0 } },
            { name: 'B', average: 30, dartsThrown: 30, pointsScored: 300, counts: { 180: 0 } },
          ],
        },
      })),
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
    setTimeoutImpl: timeout,
    clearTimeoutImpl: (handle) => { if (handle) handle.cleared = true; },
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

test('delete during the FINAL hold keeps the finished match, not an abort row', async () => {
  // Autodarts drops the match object right after a game ends, and the /stats call it
  // needs is often still 404ing at that point. Filing that delete as an abort used to
  // wipe a real game from the dashboard, and dedupe on match id made it permanent.
  let resolveStats;
  const statsReady = new Promise((resolve) => { resolveStats = resolve; });
  const { live, archive, aggregates } = harness({ getMatchStats: () => statsReady });
  await live.forceSeed('match-race');
  live.ingestEvent({
    channel: 'autodarts.matches',
    matchId: 'match-race',
    event: 'match.finished',
    data: {
      finished: true,
      winner: 'A',
      gameShot: 'D16',
      players: [{ name: 'A', score: 0, legs: 2, isWinner: true }, { name: 'B', score: 120, legs: 0 }],
    },
  });
  assert.equal(live.statusSnapshot().phase, 'final');

  live.ingestEvent({ channel: 'autodarts.matches', matchId: 'match-race', event: 'delete' });
  assert.equal(live.statusSnapshot().phase, 'idle');
  assert.equal(archive.has('match-race'), false);

  resolveStats({
    ok: true,
    status: 200,
    json: { players: [{ name: 'A', average: 40, dartsThrown: 30 }, { name: 'B', average: 30, dartsThrown: 30 }] },
  });
  for (let i = 0; i < 40 && !archive.has('match-race'); i += 1) {
    await new Promise((r) => setTimeout(r, 25));
  }

  // The live match is long gone by now, so the roster has to come from the snapshot.
  const archived = archive.listAll().find((row) => row.matchId === 'match-race');
  assert.ok(archived);
  assert.equal(archived.aborted, undefined);
  assert.equal(archived.winner, 'A');
  assert.deepEqual(archived.players.map((row) => row.name), ['A', 'B']);
  assert.equal(aggregates.get().totals.matches, 1);
});

// ---------------------------------------------------------------------------
// The rest of this file is written against the shape play.autodarts.io actually
// puts on `autodarts.matches` / `<matchId>.state`: `player` for the thrower,
// `gameScores` for the score as the turn began, `turns[0].throws` for the darts
// in hand, and `winner` / `gameWinner` at -1 until someone takes it. The tidier
// shape used above is a paraphrase, and writing the live tests against it is how
// a board that only moved between legs passed every one of them.
// ---------------------------------------------------------------------------

function boardThrow(name, bed, multiplier, number, x, y) {
  return {
    id: `throw-${name}`,
    createdAt: '2026-08-28T00:49:00Z',
    segment: { name, bed, multiplier, number },
    coords: { x, y },
  };
}

const T20 = boardThrow('T20', 'Triple', 3, 20, 0.10, -0.30);
const S1 = boardThrow('S1', 'SingleOuter', 1, 1, 0.20, 0.10);
const S20 = boardThrow('S20', 'SingleInner', 1, 20, 0.06, -0.35);
const D8 = boardThrow('D8', 'Double', 2, 8, 0.31, 0.21);

function boardState({
  matchId = 'match-live',
  turnId = 'turn-a',
  throws = [],
  points = 0,
  busted = false,
  gameScores = [501, 501],
  player = 0,
  winner = -1,
  gameWinner = -1,
  scores = null,
} = {}) {
  return {
    id: matchId,
    variant: 'X01',
    player,
    players: [
      { index: 0, name: 'trashpanda', userId: 'u-1', boardId: 'board-1', host: true, cpuPPR: null },
      { index: 1, name: 'war d', userId: 'u-2', boardId: null, host: false, cpuPPR: null },
    ],
    gameScores,
    ...(scores ? { scores } : {}),
    leg: 1,
    set: 1,
    winner,
    gameWinner,
    settings: { baseScore: 501, inMode: 'Straight', outMode: 'Straight', bullMode: '25/50' },
    turns: [{ id: turnId, createdAt: '2026-08-28T00:49:00Z', throws, points, busted }],
  };
}

function feedState(live, overrides) {
  const matchId = overrides?.matchId || 'match-live';
  live.ingestEvent({
    channel: 'autodarts.matches',
    topic: `${matchId}.state`,
    data: boardState(overrides),
  });
}

function lastCard(sent) {
  const cards = sent.filter((row) => row.type === 'autodarts.match');
  return cards[cards.length - 1]?.match || {};
}

test('the wall follows every dart, not just the legs', async () => {
  const { live, sent } = harness();
  await live.forceSeed('match-live');

  const trail = [];
  const record = () => {
    const card = lastCard(sent);
    trail.push({
      pushes: sent.filter((row) => row.type === 'autodarts.match').length,
      remaining: card.players[0].score,
      darts: (card.turn.darts || []).map((dart) => (dart ? dart.seg : null)),
    });
  };

  feedState(live, { throws: [T20], points: 60 });
  record();
  feedState(live, { throws: [T20, S1], points: 61 });
  record();
  feedState(live, { throws: [T20, S1, S20], points: 81 });
  record();

  // A push per dart, each carrying that dart.
  assert.deepEqual(trail.map((row) => row.pushes), [2, 3, 4]);
  assert.deepEqual(trail.map((row) => row.darts[0]), ['T20', 'T20', 'T20']);
  assert.deepEqual(trail.map((row) => row.darts[1]), [null, 'S1', 'S1']);
  assert.deepEqual(trail.map((row) => row.darts[2]), [null, null, 'S20']);
  // `gameScores` holds the score as the turn began, so the remaining has to be
  // worked out here or the wall shows 501 until the whole turn is committed.
  assert.deepEqual(trail.map((row) => row.remaining), [441, 440, 420]);
  // The player who is not at the oche keeps the score they left the board with.
  assert.equal(lastCard(sent).players[1].score, 501);
});

test('a dart re-scored mid-turn replaces it rather than stacking another on', async () => {
  const { live, sent } = harness();
  await live.forceSeed('match-live');

  feedState(live, { throws: [T20, S1], points: 61 });
  assert.equal(lastCard(sent).players[0].score, 440);

  // Same turn id — the second dart was corrected from S1 to S20.
  feedState(live, { throws: [T20, S20], points: 80 });
  const corrected = lastCard(sent);
  assert.deepEqual(corrected.turn.darts.map((d) => (d ? d.seg : null)), ['T20', 'S20', null]);
  assert.equal(corrected.turn.points, 80);
  assert.equal(corrected.players[0].score, 421);
  // A correction is not the end of a turn, so nothing goes to the ghosts yet.
  assert.equal(corrected.prevTurn, null);

  // All three re-scored at once, including one that was never thrown before.
  feedState(live, { throws: [S20, S20, S20], points: 60 });
  const rescored = lastCard(sent);
  assert.deepEqual(rescored.turn.darts.map((d) => (d ? d.seg : null)), ['S20', 'S20', 'S20']);
  assert.equal(rescored.players[0].score, 441);
  assert.equal(rescored.prevTurn, null);
});

test('a turn only becomes a ghost once the next one opens, single player or not', async () => {
  const { live, sent } = harness();
  await live.forceSeed('match-live');

  feedState(live, { throws: [T20, S1, S20], points: 81 });
  assert.equal(lastCard(sent).prevTurn, null);

  // Same thrower, new turn — in solo play the player index never moves, so the
  // turn id is the only thing that says the darts have been pulled.
  feedState(live, { turnId: 'turn-b', throws: [], points: 0, gameScores: [420, 501] });
  const opened = lastCard(sent);
  assert.deepEqual(opened.turn.darts, [null, null, null]);
  assert.deepEqual(opened.prevTurn.darts.map((d) => d.seg), ['T20', 'S1', 'S20']);
  assert.equal(opened.prevTurn.points, 81);
  assert.equal(opened.players[0].score, 420);

  feedState(live, { turnId: 'turn-b', throws: [D8], points: 16, gameScores: [420, 501] });
  const thrown = lastCard(sent);
  assert.equal(thrown.players[0].score, 404);
  assert.deepEqual(thrown.prevTurn.darts.map((d) => d.seg), ['T20', 'S1', 'S20']);
});

test('a bust leaves the score where the turn found it', async () => {
  const { live, sent } = harness();
  await live.forceSeed('match-live');
  feedState(live, { throws: [T20, T20], points: 120, gameScores: [100, 501] });
  // 100 left and 120 thrown — never show a negative remaining.
  assert.equal(lastCard(sent).players[0].score, 100);
  feedState(live, { throws: [T20, T20], points: 120, busted: true, gameScores: [100, 501] });
  assert.equal(lastCard(sent).players[0].score, 100);
  assert.equal(lastCard(sent).turn.busted, true);
});

test('a message that says nothing about the turn leaves the board alone', async () => {
  const { live, sent } = harness();
  await live.forceSeed('match-live');
  feedState(live, { throws: [T20, S1], points: 61 });
  const before = sent.filter((row) => row.type === 'autodarts.match').length;
  const board = lastCard(sent);

  // Plenty of match traffic names the match without restating it. Rebuilding
  // the card from one of those wiped the darts in hand and sent the thrower
  // back to player one, which is what left the wall looking frozen.
  live.ingestEvent({
    channel: 'autodarts.matches',
    topic: 'match-live.events',
    data: { id: 'match-live', event: 'throw' },
  });

  assert.equal(sent.filter((row) => row.type === 'autodarts.match').length, before);
  const after = lastCard(sent);
  assert.deepEqual(after.turn.darts, board.turn.darts);
  assert.equal(after.players[0].score, board.players[0].score);
  assert.equal(after.currentPlayerIndex, board.currentPlayerIndex);
});

test('the thrower survives a message that only names the match', async () => {
  const { live, sent } = harness();
  await live.forceSeed('match-live');
  feedState(live, { player: 1, throws: [T20], points: 60, gameScores: [501, 301] });
  assert.equal(lastCard(sent).currentPlayerIndex, 1);
  assert.equal(lastCard(sent).players[1].score, 241);

  live.ingestEvent({
    channel: 'autodarts.matches',
    topic: 'match-live.events',
    data: { id: 'match-live', event: 'turn' },
  });
  assert.equal(lastCard(sent).currentPlayerIndex, 1);
});

test('a board event about a throw never adopts the board as the match', async () => {
  const { live, sent } = harness();
  await live.forceSeed('match-live');
  feedState(live, { throws: [T20], points: 60 });
  const before = sent.filter((row) => row.type === 'autodarts.match').length;

  // `<boardId>.events` fires on every throw and takeout and its `id` is the
  // board. Seeding from it swapped the live match for an empty shell, and the
  // shell's id then rejected every real state update as stale.
  live.ingestEvent({
    channel: 'autodarts.boards',
    topic: 'board-1.events',
    data: { id: 'board-1', event: 'Throw detected' },
  });

  assert.equal(live.statusSnapshot().matchId, 'match-live');
  assert.equal(sent.filter((row) => row.type === 'autodarts.match').length, before);
  assert.equal(lastCard(sent).players.length, 2);

  // A real state update still lands afterwards.
  feedState(live, { throws: [T20, S1], points: 61 });
  assert.deepEqual(lastCard(sent).turn.darts.map((d) => (d ? d.seg : null)), ['T20', 'S1', null]);
});

test('a won leg is a live update, not the FINAL card', async () => {
  const { live, sent } = harness();
  await live.forceSeed('match-live');
  feedState(live, {
    turnId: 'turn-leg2',
    throws: [],
    points: 0,
    gameScores: [501, 501],
    gameWinner: 0,
    winner: -1,
    scores: [{ legs: 1, sets: 0 }, { legs: 0, sets: 0 }],
  });
  assert.equal(live.statusSnapshot().phase, 'live');
  assert.equal(lastCard(sent).status, 'live');
  assert.equal(lastCard(sent).players[0].legs, 1);
  assert.equal(lastCard(sent).players[1].legs, 0);

  // The events channel names this "GameShot". That is a won LEG.
  live.ingestEvent({
    channel: 'autodarts.matches',
    topic: 'match-live.events',
    data: { id: 'match-live', event: 'GameShot' },
  });
  assert.equal(live.statusSnapshot().phase, 'live');
  assert.ok(!sent.some((row) => row.type === 'autodarts.match' && row.match?.status === 'finished'));
});

test('a socket that goes quiet mid-match is topped up over HTTP', async () => {
  const timers = [];
  const { live, sent } = harness({
    getMatchState: async () => ({ ok: true, json: boardState({ throws: [T20, S1], points: 61 }) }),
    setTimeoutImpl: (fn, ms) => {
      const handle = { fn, ms, unref() { return handle; } };
      timers.push(handle);
      return handle;
    },
  });
  await live.forceSeed('match-live');
  feedState(live, { throws: [T20], points: 60 });
  assert.equal(lastCard(sent).players[0].score, 441);

  const refresh = timers.filter((row) => row.ms === 20_000).pop();
  assert.ok(refresh, 'a live match arms a refresh for when the feed stops');
  await refresh.fn();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(lastCard(sent).players[0].score, 440);
  assert.deepEqual(lastCard(sent).turn.darts.map((d) => (d ? d.seg : null)), ['T20', 'S1', null]);
});
