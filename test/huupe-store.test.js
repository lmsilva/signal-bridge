const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createHuupeSettings,
  sanitiseHost,
  DEFAULTS,
  INACTIVITY_OPTIONS,
  MODES,
} = require('../src/huupe-settings');
const { createHuupeArchive, monthFileName } = require('../src/huupe-archive');
const {
  createHuupeAggregates,
  recomputeFromSessions,
  playerKey,
  wasPlayed,
  isRankedSession,
  ZONES,
} = require('../src/huupe-aggregates');

function silentLog() {
  const lines = [];
  const push = (level) => (message) => lines.push(`${level} ${message}`);
  return {
    lines, info: push('INFO'), warn: push('WARN'), error: push('ERROR'), debug: push('DEBUG'),
  };
}

function withTempRoot(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huupe-'));
  try {
    return run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function zone(made, attempts) {
  return { made, attempts, pct: attempts ? Math.round((100 * made) / attempts) : 0 };
}

/** Shaped exactly like the row the live state machine archives. */
function sessionRow(overrides = {}) {
  return {
    sessionId: 'huupe-20260826T021000-aaaaaa',
    mode: 'justhuupe',
    startedAt: '2026-08-26T02:00:00.000Z',
    endedAt: '2026-08-26T02:10:00.000Z',
    durationSec: 600,
    aborted: false,
    endReason: 'inactivity',
    winner: null,
    uniqueScoreId: null,
    combination: null,
    truncated: false,
    players: [],
    stats: {
      made: 8,
      attempts: 36,
      points: 21,
      fgPct: 22,
      threes: 6,
      bestStreak: 2,
      byZone: {
        layup: zone(0, 1), one: zone(1, 5), two: zone(1, 7), three: zone(6, 23),
      },
    },
    ...overrides,
  };
}

/** A real 1v1v1: Unity names the shooters, so this one can be ranked. */
function familyRow(overrides = {}) {
  return sessionRow({
    sessionId: 'huupe-20260827T014500-bbbbbb',
    mode: 'family',
    startedAt: '2026-08-27T01:45:00.000Z',
    endedAt: '2026-08-27T01:50:00.000Z',
    durationSec: 300,
    endReason: 'final-screen',
    winner: 'trashpanda',
    players: [
      {
        name: 'trashpanda',
        score: 15.1,
        position: 0,
        isWinner: true,
        made: 7,
        attempts: 15,
        fgPct: 47,
        threes: 4,
        bestStreak: 4,
        byZone: {
          layup: zone(1, 2), one: zone(1, 3), two: zone(1, 4), three: zone(4, 6),
        },
      },
      {
        name: 'Player 2',
        score: 11,
        position: 1,
        isWinner: false,
        made: 5,
        attempts: 15,
        fgPct: 33,
        threes: 2,
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
      // The house streak breaks on anyone's miss, so it sits below the best
      // individual run in a game with more than one shooter.
      bestStreak: 3,
      byZone: {
        layup: zone(1, 2), one: zone(2, 5), two: zone(3, 8), three: zone(6, 15),
      },
    },
    ...overrides,
  });
}

test('a hoop that has never been configured reads back the shipped defaults', () => {
  withTempRoot((root) => {
    const settingsPath = path.join(root, 'huupe-settings.json');
    const settings = createHuupeSettings({ huupeSettingsPath: settingsPath }, silentLog());

    assert.deepEqual(settings.get(), JSON.parse(JSON.stringify(DEFAULTS)));
    assert.deepEqual(INACTIVITY_OPTIONS, [2, 5, 10, 15, 30]);
    // Reading settings must not create a file — an unconfigured install stays
    // unconfigured until somebody actually saves something.
    assert.equal(fs.existsSync(settingsPath), false);
  });
});

test('saving one field leaves every other field alone', () => {
  withTempRoot((root) => {
    const settings = createHuupeSettings({
      huupeSettingsPath: path.join(root, 'huupe-settings.json'),
    }, silentLog());
    const before = settings.get();

    const after = settings.update({ live: { finalHoldSeconds: 45 } });
    assert.equal(after.live.finalHoldSeconds, 45);
    assert.equal(after.live.inactivityMinutes, before.live.inactivityMinutes);
    assert.equal(after.live.autoPush, before.live.autoPush);
    assert.equal(after.live.minShotsToOpen, before.live.minShotsToOpen);
    assert.deepEqual(after.dashboard, before.dashboard);
    assert.deepEqual(after.lastGame, before.lastGame);
    assert.deepEqual(after.modes, before.modes);

    const next = settings.update({ modes: { fitness: false } });
    assert.equal(next.live.finalHoldSeconds, 45);
    assert.equal(next.modes.fitness, false);
    assert.equal(next.modes.family, true);
    assert.equal(settings.modeEnabled('fitness'), false);
    assert.equal(settings.modeEnabled('family'), true);
  });
});

test('an inactivity timeout the settings page does not offer is refused', () => {
  withTempRoot((root) => {
    const settings = createHuupeSettings({
      huupeSettingsPath: path.join(root, 'huupe-settings.json'),
    }, silentLog());

    assert.equal(settings.update({ live: { inactivityMinutes: 15 } }).live.inactivityMinutes, 15);

    // The timeout is a fixed menu, not a free number: anything off the menu is
    // dropped rather than stored, because a value nobody can pick again is
    // impossible to correct from the UI.
    const rejected = settings.update({ live: { inactivityMinutes: 12 } });
    assert.ok(INACTIVITY_OPTIONS.includes(rejected.live.inactivityMinutes));
    assert.equal(rejected.live.inactivityMinutes, DEFAULTS.live.inactivityMinutes);

    assert.equal(settings.update({ live: { inactivityMinutes: 999 } }).live.inactivityMinutes, 30);
    assert.equal(settings.update({ live: { inactivityMinutes: 0 } }).live.inactivityMinutes, 2);
  });
});

test('values outside their legal range are pulled back to the nearest one that works', () => {
  withTempRoot((root) => {
    const settings = createHuupeSettings({
      huupeSettingsPath: path.join(root, 'huupe-settings.json'),
    }, silentLog());

    const high = settings.update({
      device: { host: 'adb://192.168.200.216:5555', port: 99_999 },
      live: { finalHoldSeconds: 1, minShotsToOpen: 40 },
      dashboard: { leaderboardSize: 99, displaySeconds: 5 },
      lastGame: { displaySeconds: 9_000 },
    });
    assert.equal(high.device.port, 65_535);
    assert.equal(high.device.host, '192.168.200.216');
    assert.equal(high.live.finalHoldSeconds, 15);
    assert.equal(high.live.minShotsToOpen, 10);
    assert.equal(high.dashboard.leaderboardSize, 16);
    assert.equal(high.dashboard.displaySeconds, 30);
    assert.equal(high.lastGame.displaySeconds, 600);

    const low = settings.update({
      device: { port: 0 },
      live: { minShotsToOpen: 0 },
      dashboard: { leaderboardSize: 1 },
    });
    assert.equal(low.device.port, 1);
    assert.equal(low.live.minShotsToOpen, 1);
    assert.equal(low.dashboard.leaderboardSize, 3);

    // A port that is not a number at all keeps ADB's default instead of NaN.
    assert.equal(settings.update({ device: { port: 'not-a-port' } }).device.port, 5555);
    assert.equal(sanitiseHost('  10.0.0.5  '), '10.0.0.5');
    assert.equal(sanitiseHost(null), '');
  });
});

test('a key the settings page does not know about never reaches disk', () => {
  withTempRoot((root) => {
    const settingsPath = path.join(root, 'huupe-settings.json');
    const settings = createHuupeSettings({ huupeSettingsPath: settingsPath }, silentLog());

    const result = settings.update({
      device: { host: '10.0.0.9', bogus: true },
      modes: { pinball: true },
      telemetry: { enabled: true },
    });
    assert.equal(result.device.host, '10.0.0.9');
    assert.equal(result.device.bogus, undefined);
    assert.equal(result.telemetry, undefined);
    assert.equal(result.modes.pinball, undefined);
    assert.deepEqual(Object.keys(result.modes), [...MODES]);

    const onDisk = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(onDisk.telemetry, undefined);
    assert.equal(onDisk.device.bogus, undefined);
    assert.equal(onDisk.modes.pinball, undefined);
  });
});

test('settings written by one run are what the next run starts with', () => {
  withTempRoot((root) => {
    const settingsPath = path.join(root, 'huupe-settings.json');
    const first = createHuupeSettings({ huupeSettingsPath: settingsPath }, silentLog());
    first.update({
      device: { host: '192.168.200.216', autoDiscover: false, port: 5556 },
      live: { autoPush: false, inactivityMinutes: 10 },
      dashboard: { leaderboardSize: 5 },
      modes: { dailyprize: false },
    });

    const second = createHuupeSettings({ huupeSettingsPath: settingsPath }, silentLog());
    assert.deepEqual(second.get(), first.get());
    assert.equal(second.get().device.host, '192.168.200.216');
    assert.equal(second.get().device.autoDiscover, false);
    assert.equal(second.get().device.port, 5556);
    assert.equal(second.get().live.autoPush, false);
    assert.equal(second.get().live.inactivityMinutes, 10);
    assert.equal(second.get().dashboard.leaderboardSize, 5);
    assert.equal(second.modeEnabled('dailyprize'), false);
  });
});

test('a settings file that got mangled falls back to defaults instead of throwing', () => {
  withTempRoot((root) => {
    const settingsPath = path.join(root, 'huupe-settings.json');
    fs.writeFileSync(settingsPath, '{ "device": { "host": "10.0.0.9"', 'utf8');
    const log = silentLog();

    const settings = createHuupeSettings({ huupeSettingsPath: settingsPath }, log);
    assert.deepEqual(settings.get(), JSON.parse(JSON.stringify(DEFAULTS)));
    assert.ok(log.lines.some((line) => line.startsWith('WARN')));
  });
});

test('a finished session lands in the file for the UTC month it ended in', () => {
  withTempRoot((root) => {
    const archiveRoot = path.join(root, 'huupe-games');
    const archive = createHuupeArchive({ huupeArchivePath: archiveRoot }, silentLog());

    archive.append(sessionRow({ sessionId: 's-jan', endedAt: '2026-01-15T12:00:00.000Z' }));
    // Late evening of 31 January where the hoop lives, but already February in
    // UTC — partitioning follows UTC so the month files never overlap.
    archive.append(sessionRow({ sessionId: 's-turn', endedAt: '2026-02-01T02:00:00.000Z' }));

    assert.deepEqual(fs.readdirSync(archiveRoot).sort(), ['2026-01.jsonl', '2026-02.jsonl']);
    const january = fs.readFileSync(path.join(archiveRoot, '2026-01.jsonl'), 'utf8').trim();
    assert.equal(january.split('\n').length, 1);
    assert.equal(JSON.parse(january).sessionId, 's-jan');
    assert.equal(archive.count(), 2);
    assert.equal(monthFileName('2026-12-31T23:59:59.999Z'), '2026-12.jsonl');
  });
});

test('the same session replayed twice is stored once, even after a restart', () => {
  withTempRoot((root) => {
    const archiveRoot = path.join(root, 'huupe-games');
    const archive = createHuupeArchive({ huupeArchivePath: archiveRoot }, silentLog());

    assert.deepEqual(archive.append(sessionRow()), { ok: true, deduped: false });
    assert.deepEqual(archive.append(sessionRow()), { ok: true, deduped: true });
    assert.equal(archive.count(), 1);
    assert.equal(archive.listAll().length, 1);
    assert.equal(archive.has(sessionRow().sessionId), true);

    const reopened = createHuupeArchive({ huupeArchivePath: archiveRoot }, silentLog());
    assert.equal(reopened.has(sessionRow().sessionId), true);
    assert.deepEqual(reopened.append(sessionRow()), { ok: true, deduped: true });
    assert.equal(reopened.listAll().length, 1);

    assert.equal(archive.append({ endedAt: '2026-08-01T00:00:00.000Z' }).ok, false);
  });
});

test('the newest session comes back first no matter which month file it is in', () => {
  withTempRoot((root) => {
    const archive = createHuupeArchive({
      huupeArchivePath: path.join(root, 'huupe-games'),
    }, silentLog());

    archive.append(sessionRow({ sessionId: 's-mar', endedAt: '2026-03-04T18:00:00.000Z' }));
    archive.append(sessionRow({ sessionId: 's-jan', endedAt: '2026-01-04T18:00:00.000Z' }));
    archive.append(sessionRow({ sessionId: 's-feb', endedAt: '2026-02-04T18:00:00.000Z' }));

    assert.deepEqual(
      archive.latest(3).map((row) => row.sessionId),
      ['s-mar', 's-feb', 's-jan'],
    );
    assert.equal(archive.latest().length, 1);
    assert.equal(archive.latest()[0].sessionId, 's-mar');
    assert.equal(archive.count(), 3);
  });
});

test('a half-written line does not cost us the rest of the month', () => {
  withTempRoot((root) => {
    const archiveRoot = path.join(root, 'huupe-games');
    fs.mkdirSync(archiveRoot, { recursive: true });
    // logcat killed mid-write leaves a torn final line behind.
    fs.writeFileSync(
      path.join(archiveRoot, '2026-05.jsonl'),
      [
        JSON.stringify(sessionRow({ sessionId: 's-a', endedAt: '2026-05-01T00:00:00.000Z' })),
        '{"sessionId":"s-torn","stats":{"made":3,"att',
        JSON.stringify(sessionRow({ sessionId: 's-b', endedAt: '2026-05-02T00:00:00.000Z' })),
        '',
      ].join('\n'),
      'utf8',
    );

    const archive = createHuupeArchive({ huupeArchivePath: archiveRoot }, silentLog());
    assert.deepEqual(archive.listAll().map((row) => row.sessionId), ['s-a', 's-b']);
    assert.equal(archive.count(), 2);
    assert.equal(archive.has('s-torn'), false);

    assert.deepEqual(
      archive.append(sessionRow({ sessionId: 's-c', endedAt: '2026-05-03T00:00:00.000Z' })),
      { ok: true, deduped: false },
    );
    assert.equal(archive.count(), 3);
    assert.equal(archive.latest()[0].sessionId, 's-c');
  });
});

test('career totals add up across every archived session', () => {
  const data = recomputeFromSessions([sessionRow(), familyRow()]);

  assert.deepEqual(data.totals, {
    sessions: 2,
    games: 1,
    freePlaySessions: 1,
    shots: 66,
    makes: 20,
    fgPct: 30,
    points: 47.1,
    playSeconds: 900,
  });
  assert.deepEqual(data.byZone.layup, { made: 1, attempts: 3, pct: 33 });
  assert.deepEqual(data.byZone.one, { made: 3, attempts: 10, pct: 30 });
  assert.deepEqual(data.byZone.two, { made: 4, attempts: 15, pct: 27 });
  assert.deepEqual(data.byZone.three, { made: 12, attempts: 38, pct: 32 });
  assert.deepEqual(data.byMonth, [{ key: '2026-08', label: 'Aug', count: 2 }]);
  assert.deepEqual(
    data.recent.map((row) => row.sessionId),
    [familyRow().sessionId, sessionRow().sessionId],
  );
  assert.equal(data.recent[0].points, 26.1);
});

test('a free-play session counts for the house but never for the leaderboard', () => {
  const data = recomputeFromSessions([sessionRow(), familyRow()]);

  // Free play never says who is shooting, so its 36 shots belong to the house
  // totals; crediting them to whoever played last would invent a career.
  assert.equal(isRankedSession(sessionRow()), false);
  assert.equal(data.totals.freePlaySessions, 1);
  assert.equal(data.totals.games, 1);
  assert.equal(data.totals.shots, 66);
  assert.deepEqual(data.players.map((row) => row.displayName), ['trashpanda', 'Player 2']);
  assert.equal(data.players.reduce((sum, row) => sum + row.attempts, 0), 30);
  assert.equal(data.players.every((row) => row.games === 1), true);
});

test('the same shooter under different capitalisation is one person', () => {
  const data = recomputeFromSessions([
    familyRow({
      sessionId: 'g1',
      endedAt: '2026-07-01T00:00:00.000Z',
      winner: 'trashpanda',
      players: [{ name: 'trashpanda', score: 10, position: 0, made: 4, attempts: 8 }],
      stats: { made: 4, attempts: 8, points: 10 },
    }),
    familyRow({
      sessionId: 'g2',
      endedAt: '2026-08-01T00:00:00.000Z',
      winner: 'TrashPanda',
      players: [{ name: 'TrashPanda', score: 6, position: 0, made: 2, attempts: 4 }],
      stats: { made: 2, attempts: 4, points: 6 },
    }),
  ]);

  assert.equal(playerKey('  TrashPanda '), 'trashpanda');
  assert.equal(data.players.length, 1);
  assert.equal(data.players[0].games, 2);
  assert.equal(data.players[0].wins, 2);
  assert.equal(data.players[0].points, 16);
  assert.equal(data.players[0].bestScore, 10);
  assert.equal(data.players[0].firstSeenAt, '2026-07-01T00:00:00.000Z');
  assert.equal(data.players[0].lastPlayedAt, '2026-08-01T00:00:00.000Z');
  assert.deepEqual(data.byMonth, [
    { key: '2026-07', label: 'Jul', count: 1 },
    { key: '2026-08', label: 'Aug', count: 1 },
  ]);
});

test('career shooting percentage is recomputed, never copied off the row', () => {
  // Per-session FG% is a percentage of that session; averaging or reusing them
  // would give a career number that does not match the career makes.
  const data = recomputeFromSessions([
    familyRow({
      sessionId: 'g1',
      players: [{
        name: 'trashpanda', score: 9, position: 0, made: 1, attempts: 10, fgPct: 99,
      }],
      stats: { made: 1, attempts: 10, points: 9, fgPct: 99 },
    }),
    familyRow({
      sessionId: 'g2',
      players: [{
        name: 'trashpanda', score: 9, position: 0, made: 9, attempts: 10, fgPct: 99,
      }],
      stats: { made: 9, attempts: 10, points: 9, fgPct: 99 },
    }),
  ]);

  assert.equal(data.players[0].fgPct, 50);
  assert.equal(data.totals.fgPct, 50);
});

test('each record names the session or the shooter that actually holds it', () => {
  const data = recomputeFromSessions([sessionRow(), familyRow()]);

  assert.deepEqual(data.records.bestSessionScore, {
    value: 26.1,
    mode: 'family',
    at: '2026-08-27T01:50:00.000Z',
  });
  // The house streak of 3 is beaten by trashpanda's own run of 4, so the record
  // gets a name on it rather than staying anonymous.
  assert.deepEqual(data.records.bestStreak, {
    value: 4,
    player: 'trashpanda',
    at: '2026-08-27T01:50:00.000Z',
  });
  assert.equal(data.records.bestFgPct.displayName, 'trashpanda');
  assert.equal(data.records.bestFgPct.fgPct, 47);
});

test('a walk-past that nudged the sensor once is not a session', () => {
  assert.equal(wasPlayed(null), false);
  assert.equal(wasPlayed({ stats: { attempts: 1 } }), false);
  assert.equal(wasPlayed({ stats: { attempts: 2 } }), true);

  const data = recomputeFromSessions([
    sessionRow({ sessionId: 'walk-by', stats: { made: 1, attempts: 1, points: 3 } }),
    sessionRow(),
  ]);
  assert.equal(data.totals.sessions, 1);
  assert.equal(data.totals.shots, 36);
  assert.deepEqual(data.recent.map((row) => row.sessionId), [sessionRow().sessionId]);
});

test('a career with nothing in it reads as zeroes rather than blanks', () => {
  const data = recomputeFromSessions([]);

  assert.deepEqual(data.totals, {
    sessions: 0,
    games: 0,
    freePlaySessions: 0,
    shots: 0,
    makes: 0,
    fgPct: 0,
    points: 0,
    playSeconds: 0,
  });
  assert.deepEqual(data.players, []);
  assert.deepEqual(data.byMonth, []);
  assert.deepEqual(data.recent, []);
  assert.deepEqual(data.records, {
    bestSessionScore: null,
    bestStreak: null,
    bestFgPct: null,
  });
  for (const name of ZONES) {
    assert.deepEqual(data.byZone[name], { made: 0, attempts: 0, pct: 0 });
  }
  assert.ok(!Number.isNaN(Date.parse(data.updatedAt)));
});

test('the career table is rebuilt from the archive and read back next run', () => {
  withTempRoot((root) => {
    const playersPath = path.join(root, 'huupe-players.json');
    const archive = createHuupeArchive({
      huupeArchivePath: path.join(root, 'huupe-games'),
    }, silentLog());
    archive.append(sessionRow());
    archive.append(familyRow());

    const aggregates = createHuupeAggregates({ huupePlayersPath: playersPath }, silentLog());
    assert.equal(aggregates.get(), null);

    const built = aggregates.recompute(archive.listAll());
    assert.equal(built.totals.sessions, 2);
    assert.equal(built.players.length, 2);

    const reopened = createHuupeAggregates({ huupePlayersPath: playersPath }, silentLog());
    assert.deepEqual(reopened.get(), built);
  });
});
