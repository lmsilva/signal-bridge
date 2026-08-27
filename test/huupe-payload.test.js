const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildSessionPayload,
  buildClosePayload,
  buildDashboardPayload,
  viewFromArchivedSession,
  headlineFor,
  modeLabel,
  zoneLabel,
  zoneRows,
  formatPoints,
  formatDuration,
  relativeDay,
} = require('../src/huupe-payload');
const { recomputeFromSessions, ZONES } = require('../src/huupe-aggregates');

const NOW_ISO = '2026-08-27T03:30:00.000Z';
const NOW = Date.parse(NOW_ISO);
const clock = () => NOW;

/** Nothing on a card may reach the panel as a hole or a NaN. */
function assertRenderable(value, trail = 'payload') {
  if (value === undefined) assert.fail(`${trail} is undefined`);
  if (typeof value === 'number') {
    assert.ok(Number.isFinite(value), `${trail} is ${value}`);
    return;
  }
  if (typeof value === 'string') {
    assert.ok(!/NaN|undefined/.test(value), `${trail} reads "${value}"`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertRenderable(entry, `${trail}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) assertRenderable(entry, `${trail}.${key}`);
  }
}

function zone(made, attempts) {
  return { made, attempts, pct: attempts ? Math.round((100 * made) / attempts) : 0 };
}

function liveView(overrides = {}) {
  return {
    sessionId: 'huupe-20260827T032500-abc123',
    mode: 'family',
    status: 'live',
    revision: 7,
    startedAt: '2026-08-27T03:25:00.000Z',
    endedAt: null,
    durationSec: 300,
    players: [
      {
        name: 'trashpanda',
        score: 15.1,
        position: null,
        isWinner: false,
        made: 7,
        attempts: 15,
        fgPct: 47,
        threes: 4,
        streak: 2,
        bestStreak: 4,
        byZone: {
          layup: zone(1, 2), one: zone(1, 3), two: zone(1, 4), three: zone(4, 6),
        },
      },
      {
        name: 'Player 2',
        score: 11,
        position: null,
        isWinner: false,
        made: 5,
        attempts: 15,
        fgPct: 33,
        threes: 2,
        streak: 0,
        bestStreak: 2,
        byZone: {
          layup: zone(0, 0), one: zone(1, 2), two: zone(2, 4), three: zone(2, 9),
        },
      },
    ],
    stats: {
      made: 12,
      attempts: 30,
      points: 26.1,
      fgPct: 40,
      threes: 6,
      streak: 2,
      bestStreak: 3,
      byZone: {
        layup: zone(1, 2), one: zone(2, 5), two: zone(3, 8), three: zone(6, 15),
      },
    },
    lastShot: {
      player: 'trashpanda', made: true, zone: 'layup', points: 0.1, at: '2026-08-27T03:29:58.000Z',
    },
    winner: null,
    sensorErrors: 0,
    ...overrides,
  };
}

/** The row huupe-live writes to the archive when a game ends. */
function archivedRow(overrides = {}) {
  const view = liveView();
  return {
    sessionId: view.sessionId,
    mode: 'family',
    startedAt: view.startedAt,
    endedAt: '2026-08-27T03:30:00.000Z',
    durationSec: 300,
    aborted: false,
    endReason: 'final-screen',
    winner: 'trashpanda',
    uniqueScoreId: '8/27/2026 3:30:00 AMtrashpanda',
    combination: { gameConfiguration: '1v1v1', gameModeType: 'Classic' },
    truncated: true,
    players: view.players.map((player, index) => ({
      name: player.name,
      score: player.score,
      position: index,
      isWinner: index === 0,
      made: player.made,
      attempts: player.attempts,
      fgPct: player.fgPct,
      threes: player.threes,
      bestStreak: player.bestStreak,
      byZone: player.byZone,
    })),
    stats: {
      made: view.stats.made,
      attempts: view.stats.attempts,
      points: view.stats.points,
      fgPct: view.stats.fgPct,
      threes: view.stats.threes,
      bestStreak: view.stats.bestStreak,
      byZone: view.stats.byZone,
    },
    ...overrides,
  };
}

test('a live card holds the wall while the final card is timed to let go of it', () => {
  const live = buildSessionPayload(liveView(), {
    persistent: true, displaySeconds: 0, now: clock,
  });
  assert.equal(live.version, 2);
  assert.equal(live.type, 'huupe.session');
  assert.equal(live.timestamp, NOW_ISO);
  assert.equal(live.session.status, 'live');
  assert.equal(live.session.revision, 7);
  // A live card has no expiry because the next shot replaces it; the final card
  // must expire on its own or the scheduler never gets the wall back.
  assert.equal(live.persistent, true);
  assert.equal(live.displaySeconds, 0);

  const final = buildSessionPayload(
    liveView({ status: 'finished', endedAt: NOW_ISO, winner: 'trashpanda' }),
    { persistent: false, displaySeconds: 60, now: clock },
  );
  assert.equal(final.persistent, false);
  assert.equal(final.displaySeconds, 60);
  assert.equal(final.session.status, 'finished');
  assert.equal(final.session.endedAt, NOW_ISO);
  assert.deepEqual(final.session.headline, { primary: 'trashpanda', secondary: 'WINS' });
});

test('a layup keeps its tenth of a point all the way to the panel', () => {
  // Layups score 0.1, so "17.1" printed as "17" is simply the wrong score on a
  // board where a tenth can decide the game.
  assert.equal(formatPoints(17.1), '17.1');
  assert.equal(formatPoints(0.1), '0.1');
  assert.equal(formatPoints(15.100000000000001), '15.1');
  assert.equal(formatPoints(13), '13');
  assert.equal(formatPoints(0), '0');
  assert.equal(formatPoints(null), '0');

  const payload = buildSessionPayload(liveView(), { now: clock });
  assert.equal(payload.session.stats.pointsLabel, '26.1');
  assert.equal(payload.session.players[0].scoreLabel, '15.1');
  assert.equal(payload.session.players[1].scoreLabel, '11');
  assert.equal(payload.session.stats.shotLine, '12/30');
  assert.equal(payload.session.lastShot.pointsLabel, '0.1');
  assert.equal(payload.session.lastShot.zoneLabel, 'Layup');
  assert.deepEqual(payload.session.headline, { primary: 'trashpanda', secondary: '15.1 PTS' });
});

test('the zone strip always shows all four zones in the same order', () => {
  // The panel lays the strip out once; a hoop that only reported threes must
  // still leave the other three columns standing rather than reflow the card.
  const empty = zoneRows(undefined);
  assert.deepEqual(empty.map((row) => row.zone), ['layup', 'one', 'two', 'three']);
  assert.deepEqual(empty.map((row) => row.label), ['Layup', '1 PT', '2 PT', '3 PT']);
  assert.deepEqual(empty.map((row) => row.short), ['LAY', '1PT', '2PT', '3PT']);
  assert.equal(empty.every((row) => row.made === 0 && row.attempts === 0 && row.pct === 0), true);

  const partial = zoneRows({ three: zone(6, 23) });
  assert.equal(partial.length, ZONES.length);
  assert.deepEqual(partial[3], {
    zone: 'three', label: '3 PT', short: '3PT', made: 6, attempts: 23, pct: 26,
  });
  assert.equal(partial[0].attempts, 0);

  const payload = buildSessionPayload({ stats: {} }, { now: clock });
  assert.deepEqual(payload.session.zones.map((row) => row.zone), [...ZONES]);
  assert.equal(zoneLabel('two'), '2 PT');
  assert.equal(zoneLabel('halfCourt'), '');
});

test('a solo session leads with its own score and a called game leads with the winner', () => {
  // Free play has nobody to name, so the number being chased is the headline.
  assert.deepEqual(
    headlineFor({ status: 'live', players: [], stats: { points: 21 } }),
    { primary: '21', secondary: 'POINTS' },
  );
  assert.deepEqual(
    headlineFor({ status: 'live', players: [{ name: 'trashpanda', score: 9.1 }], stats: { points: 9.1 } }),
    { primary: '9.1', secondary: 'POINTS' },
  );
  assert.deepEqual(
    headlineFor({
      status: 'live',
      players: [{ name: 'trashpanda', score: 9.1 }, { name: 'Player 2', score: 4 }],
      stats: { points: 13.1 },
    }),
    { primary: 'trashpanda', secondary: '9.1 PTS' },
  );
  assert.deepEqual(
    headlineFor({ status: 'finished', winner: 'Player 2', players: [], stats: { points: 13 } }),
    { primary: 'Player 2', secondary: 'WINS' },
  );

  const solo = buildSessionPayload(
    { mode: 'justhuupe', status: 'live', players: [], stats: { points: 21, made: 8, attempts: 36 } },
    { now: clock },
  );
  assert.deepEqual(solo.session.headline, { primary: '21', secondary: 'POINTS' });
  assert.equal(solo.session.modeLabel, 'Free Play');
  assert.equal(modeLabel('family'), 'Family Mode');
  assert.equal(modeLabel('JUSTHUUPE'), 'Free Play');
  assert.equal(modeLabel('something-new'), 'Session');
});

test('the dashboard shows only as many shooters as the board has room for', () => {
  const players = Array.from({ length: 14 }, (unused, index) => ({
    displayName: `P${index}`,
    games: 14 - index,
    wins: 14 - index,
    winPct: 50,
    points: 20.1,
    bestScore: 10,
    made: 5,
    attempts: 10,
    fgPct: 50,
    threes: 2,
    bestStreak: 3,
    lastPlayedAt: '2026-08-26T03:30:00.000Z',
  }));

  const tight = buildDashboardPayload({ players }, {
    leaderboardSize: 5, displaySeconds: 120, now: clock,
  });
  assert.equal(tight.type, 'huupe.dashboard');
  assert.equal(tight.persistent, false);
  assert.equal(tight.displaySeconds, 120);
  assert.equal(tight.leaderboard.length, 5);
  assert.deepEqual(tight.leaderboard.map((row) => row.rank), [1, 2, 3, 4, 5]);
  assert.deepEqual(tight.leaderboard.map((row) => row.name), ['P0', 'P1', 'P2', 'P3', 'P4']);
  assert.equal(tight.leaderboard[0].crown, true);
  assert.equal(tight.leaderboard.slice(1).every((row) => row.crown === false), true);
  // The card says "+N more", so the count has to be everyone who was cut.
  assert.equal(tight.moreCount, 9);

  const roomy = buildDashboardPayload({ players }, { leaderboardSize: 16, now: clock });
  assert.equal(roomy.leaderboard.length, 14);
  assert.equal(roomy.moreCount, 0);

  const nobody = buildDashboardPayload({}, { leaderboardSize: 10, now: clock });
  assert.deepEqual(nobody.leaderboard, []);
  assert.equal(nobody.moreCount, 0);
  assertRenderable(nobody);
});

test('the dashboard reports the career table it was handed', () => {
  const freePlay = {
    sessionId: 'free-1',
    mode: 'justhuupe',
    startedAt: '2026-08-26T02:00:00.000Z',
    endedAt: '2026-08-26T02:10:00.000Z',
    durationSec: 600,
    players: [],
    stats: {
      made: 8,
      attempts: 36,
      points: 21,
      threes: 6,
      bestStreak: 2,
      byZone: {
        layup: zone(0, 1), one: zone(1, 5), two: zone(1, 7), three: zone(6, 23),
      },
    },
  };
  const aggregate = recomputeFromSessions([freePlay, archivedRow()]);
  const payload = buildDashboardPayload(aggregate, {
    displaySeconds: 120,
    leaderboardSize: 10,
    device: { host: '192.168.200.216', online: true },
    now: clock,
  });

  assert.equal(payload.totals.sessions, 2);
  assert.equal(payload.totals.games, 1);
  assert.equal(payload.totals.freePlaySessions, 1);
  assert.equal(payload.totals.shots, 66);
  assert.equal(payload.totals.makes, 20);
  assert.equal(payload.totals.pointsLabel, '47.1');
  assert.equal(payload.totals.playLabel, '15:00');
  assert.equal(payload.totals.lastPlayedAt, '2026-08-27T03:30:00.000Z');
  assert.equal(payload.totals.lastPlayedLabel, 'Today');

  assert.deepEqual(payload.leaderboard.map((row) => row.name), ['trashpanda', 'Player 2']);
  assert.equal(payload.leaderboard[0].pointsLabel, '15.1');
  assert.equal(payload.leaderboard[0].lastPlayedLabel, 'Today');
  assert.equal(payload.records.bestSessionScore.valueLabel, '26.1');
  assert.equal(payload.records.bestSessionScore.modeLabel, 'Family Mode');
  assert.deepEqual(payload.records.bestFgPct, { player: 'trashpanda', value: 47 });
  assert.equal(payload.records.bestStreak.player, 'trashpanda');
  assert.deepEqual(payload.byMonth, [{ key: '2026-08', label: 'Aug', count: 2 }]);
  assert.deepEqual(payload.zones.map((row) => row.zone), [...ZONES]);
  assert.deepEqual(payload.zones[3], {
    zone: 'three', label: '3 PT', short: '3PT', made: 12, attempts: 38, pct: 32,
  });
  assert.equal(payload.recent[0].modeLabel, 'Family Mode');
  assert.equal(payload.recent[0].pointsLabel, '26.1');
  assert.equal(payload.recent[0].whenLabel, 'Today');
  assert.equal(payload.recent[1].modeLabel, 'Free Play');
  assert.deepEqual(payload.device, { host: '192.168.200.216', online: true });
  assertRenderable(payload);
});

test('an archived game replays as a finished card with nothing missing', () => {
  const view = viewFromArchivedSession(archivedRow());
  assert.equal(view.status, 'finished');
  assert.equal(view.sessionId, archivedRow().sessionId);
  assert.equal(view.winner, 'trashpanda');
  assert.equal(view.truncated, true);
  assert.equal(view.uniqueScoreId, archivedRow().uniqueScoreId);

  const payload = buildSessionPayload(view, {
    persistent: false, displaySeconds: 90, now: clock,
  });
  assertRenderable(payload);
  assert.equal(payload.session.status, 'finished');
  assert.equal(payload.session.modeLabel, 'Family Mode');
  assert.equal(payload.session.durationLabel, '5:00');
  assert.equal(payload.session.stats.pointsLabel, '26.1');
  assert.equal(payload.session.stats.shotLine, '12/30');
  assert.deepEqual(payload.session.headline, { primary: 'trashpanda', secondary: 'WINS' });
  assert.deepEqual(payload.session.players.map((row) => row.rank), [1, 2]);
  assert.equal(payload.session.players[0].scoreLabel, '15.1');
  assert.deepEqual(payload.session.players[0].zones.map((row) => row.zone), [...ZONES]);
  assert.deepEqual(payload.session.zones.map((row) => row.zone), [...ZONES]);
  assert.equal(payload.session.lastShot, null);

  // A row from before a field existed still has to render.
  assertRenderable(buildSessionPayload(
    viewFromArchivedSession({ sessionId: 'sparse' }),
    { persistent: false, displaySeconds: 90, now: clock },
  ));
});

test('the close message names the session it is clearing and why', () => {
  assert.deepEqual(
    buildClosePayload('huupe-20260827T032500-abc123', 'final-hold-elapsed', { now: clock }),
    {
      version: 2,
      type: 'huupe.session.close',
      timestamp: NOW_ISO,
      sessionId: 'huupe-20260827T032500-abc123',
      reason: 'final-hold-elapsed',
    },
  );

  const anonymous = buildClosePayload(null, undefined, { now: clock });
  assert.equal(anonymous.sessionId, null);
  assert.equal(anonymous.reason, 'ended');
});

test('durations and dates read the way somebody across the room would say them', () => {
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(59), '0:59');
  assert.equal(formatDuration(600), '10:00');
  assert.equal(formatDuration(3_660), '1h 01m');
  assert.equal(formatDuration(-5), '0:00');
  assert.equal(formatDuration(null), '0:00');

  assert.equal(relativeDay('2026-08-27T01:00:00.000Z', NOW), 'Today');
  assert.equal(relativeDay('2026-08-26T01:00:00.000Z', NOW), 'Yesterday');
  assert.equal(relativeDay('2026-08-23T03:00:00.000Z', NOW), '4d ago');
  assert.equal(relativeDay('2026-08-10T03:00:00.000Z', NOW), '2w ago');
  assert.equal(relativeDay('2026-05-01T00:00:00.000Z', NOW), '3mo ago');
  // A hoop with a skewed clock must not report a game from the future.
  assert.equal(relativeDay('2026-08-28T03:00:00.000Z', NOW), 'Today');
  assert.equal(relativeDay(null, NOW), '');
  assert.equal(relativeDay('not-a-date', NOW), '');
});
