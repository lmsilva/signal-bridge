'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { validate } = require('../src/vestaboard/encoder');
const { parseLayout, formatLayout } = require('../src/vestaboard/notation');
const gaming = require('../src/vestaboard/formatters/gaming');

function assertLayout(actual, drawing, label) {
  assert.equal(validate(actual).ok, true, `${label} failed validation`);
  const expected = parseLayout(drawing.join('\n'), { label });
  if (formatLayout(actual) !== formatLayout(expected)) {
    assert.fail(
      `${label} does not match the spec drawing\n\n`
      + `--- expected ---\n${formatLayout(expected)}\n\n`
      + `--- actual ---\n${formatLayout(actual)}\n`,
    );
  }
}

test('a steam launch is a snapshot with a game-on footer', () => {
  const frames = gaming.steamFrames({
    type: 'steam.now-playing',
    steam: {
      appId: 965680,
      name: 'Hotshot Racing',
      mode: 'playing',
      startedAt: new Date(2026, 7, 22, 19, 42).toISOString(),
    },
  });

  assert.equal(frames[0].priority, 'snapshot');
  assertLayout(frames[0].rows, [
    'bb      STEAM       bb',
    ' NOW PLAYING:',
    ' HOTSHOT RACING',
    '',
    ' LAUNCHED 7:42PM',
    'bb GAME ON!         bb',
  ], 'steam playing');
});

test('steam last-played names the library size and drops the trademark', () => {
  const frames = gaming.steamFrames({
    type: 'steam.now-playing',
    steam: {
      appId: 1273770,
      name: 'HOT WHEELS UNLEASHED\u2122',
      mode: 'last-played',
      lastPlayedAt: new Date(2026, 7, 22, 22, 45).toISOString(),
      startedAt: new Date().toISOString(),
    },
  }, { ownedCount: 707 });

  assert.equal(frames[0].priority, 'snapshot');
  assertLayout(frames[0].rows, [
    'bb      STEAM       bb',
    ' LAST PLAYED:',
    ' HOT WHEELS UNLEASHED',
    '',
    ' AUG 22 - 10:45PM',
    'bb 707 GAMES OWNED  bb',
  ], 'steam last played');
});

test('steam last-played prints America/Denver, not the UTC hour on the wire', () => {
  const frames = gaming.steamFrames({
    type: 'steam.now-playing',
    steam: {
      appId: 1,
      name: 'Boomerang Fu',
      mode: 'last-played',
      lastPlayedAt: '2026-08-24T22:09:00.000Z',
    },
  }, { timeZone: 'America/Denver' });

  assert.match(formatLayout(frames[0].rows).split('\n')[4], /AUG 24 - 4:09PM/);
});

test('steam mode is playing, not now-playing, and library tours are skipped', () => {
  const missed = gaming.steamFrames({
    type: 'steam.now-playing',
    steam: { appId: 1, name: 'Hotshot Racing', mode: 'now-playing', startedAt: new Date(2026, 7, 22, 19, 42).toISOString() },
  });
  assert.equal(missed[0].priority, 'snapshot', 'unrecognised mode collapses to playing');

  assert.deepEqual(gaming.steamFrames({
    type: 'steam.now-playing',
    steam: { appId: 1, name: 'Hotshot Racing', mode: 'library-tour' },
  }), []);
});

test('placeholder steam names are not games', () => {
  assert.deepEqual(gaming.steamFrames({
    type: 'steam.now-playing',
    steam: { appId: 42, name: 'App 42', mode: 'playing' },
  }), []);
});

test('psn last-played uses the date-only line from the spec', () => {
  const frames = gaming.psnFrames({
    type: 'psn.now-playing',
    psn: {
      titleId: 'PPSA01488',
      name: 'Split Fiction',
      mode: 'last-played',
      lastPlayedAt: new Date(2026, 7, 17, 21, 0).toISOString(),
    },
  });

  assertLayout(frames[0].rows, [
    'bb   PLAYSTATION    bb',
    ' LAST PLAYED:',
    ' SPLIT FICTION',
    '',
    ' ON AUG 17',
    'bb                  bb',
  ], 'psn last played');
});

test('the real psn placeholder is skipped; Old Game is a real title', () => {
  assert.deepEqual(gaming.psnFrames({
    type: 'psn.now-playing',
    psn: { name: 'PlayStation Game', mode: 'last-played' },
  }), []);

  const frames = gaming.psnFrames({
    type: 'psn.now-playing',
    psn: { name: 'Old Game', mode: 'last-played', lastPlayedAt: new Date(2026, 7, 17).toISOString() },
  });
  assert.equal(frames.length, 1);
});

test('an autodarts start names the mode, the pairing and the race', () => {
  const frames = gaming.autodartsMatchFrames({
    type: 'autodarts.match',
    match: {
      status: 'live',
      variant: 'X01',
      settingsLine: '501 · Straight-Double · First to 3 legs',
      players: [{ name: 'Luis' }, { name: 'Sam' }],
    },
  });

  assert.equal(frames[0].priority, 'snapshot');
  assertLayout(frames[0].rows, [
    'gg AUTODARTS        gg',
    ' GAME ON - 501',
    ' LUIS VS SAM',
    ' FIRST TO 3 LEGS',
    '',
    'gg THROW SHARP      gg',
  ], 'autodarts start');
});

test('an autodarts finish flanks the winner and reads isWinner, not match.winner', () => {
  const frames = gaming.autodartsMatchFrames({
    type: 'autodarts.match',
    match: {
      status: 'finished',
      settingsLine: '501 · First to 3 legs',
      players: [
        {
          name: 'War D', legs: 1, average: 40.1, isWinner: false,
        },
        {
          name: 'trashpanda', legs: 2, average: 26.4, highScore: 60, bestCheckout: 51, isWinner: true,
        },
      ],
    },
  });

  assertLayout(frames[0].rows, [
    'gg AUTODARTS        gg',
    ' y TRASHPANDA WINS y',
    ' VS WAR D - 2-1 LEGS',
    ' AVG 26.4  HIGH 60',
    ' CHECKOUT 51',
    'gg NICE DARTS       gg',
  ], 'autodarts finish');
});

test('the autodarts dashboard reads record objects, not the objects themselves', () => {
  const frames = gaming.autodartsDashboardFrames({
    type: 'autodarts.dashboard',
    totals: { matches: 42, legs: 57, lastPlayedAt: '2026-08-02' },
    records: {
      bestMatchAverage: { value: 68.3, player: 'trashpanda' },
      highestCheckout: { value: 51, player: 'War D' },
      total180s: 1,
    },
    rivalry: {
      a: 'trashpanda', b: 'War D', aWins: 11, bWins: 4,
    },
  });

  assertLayout(frames[0].rows, [
    'gg AUTODARTS        gg',
    ' 42 MATCHES  57 LEGS',
    ' TRASHPANDA AVG 68.3',
    ' HIGH OUT 51  180S 1',
    ' RIVALRY WAR D 11-4',
    'gg LAST GAME AUG 2  gg',
  ], 'autodarts dashboard');
});

test('the autodarts last-game date is the house day, not the UTC day', () => {
  // 2026-08-02T05:34Z is still the evening of Aug 1 in Denver. The bridge runs
  // UTC in Docker, so reading the instant without a zone printed tomorrow.
  const frames = gaming.autodartsDashboardFrames({
    type: 'autodarts.dashboard',
    totals: { matches: 42, legs: 57, lastPlayedAt: '2026-08-02T05:34:19.727444Z' },
  }, { timeZone: 'America/Denver' });

  assert.match(formatLayout(frames[0].rows), /LAST GAME AUG 1\b/);
});

test('a two-digit last-game day is not truncated by the badge footer', () => {
  const frames = gaming.autodartsDashboardFrames({
    type: 'autodarts.dashboard',
    totals: { matches: 42, legs: 57, lastPlayedAt: '2026-08-24T02:26:02.323Z' },
  }, { timeZone: 'America/Denver' });

  assert.match(formatLayout(frames[0].rows), /LAST GAME AUG 23\b/);
});

test('a bare YYYY-MM-DD last-game date does not slip a day west of UTC', () => {
  const frames = gaming.autodartsDashboardFrames({
    type: 'autodarts.dashboard',
    totals: { matches: 42, legs: 57, lastPlayedAt: '2026-08-22' },
  }, { timeZone: 'America/Denver' });

  assert.match(formatLayout(frames[0].rows), /LAST GAME AUG 22\b/);
});

test('roll credits picks the highest induction and the system label, not the id', () => {
  const frames = gaming.rollCreditsFrames({
    type: 'credits.show',
    games: [
      {
        title: 'Pac-Man', system: 'arcade', beatenAt: '2026-01-01', induction: 1,
      },
      {
        title: 'Contra: Operation Galuga', system: 'pc', beatenAt: '2026-08-22', induction: 29,
      },
      ...Array.from({ length: 17 }, (_, index) => ({
        title: `Arcade ${index}`, system: 'arcade', beatenAt: '2026-02-01', induction: index + 2,
      })),
      {
        title: 'Celeste', system: 'switch', beatenAt: '2026-03-01', induction: 19,
      },
      ...Array.from({ length: 9 }, (_, index) => ({
        title: `Other ${index}`, system: 'pc', beatenAt: '2026-04-01', induction: 20 + index,
      })),
    ],
  });

  assertLayout(frames[0].rows, [
    'ww ROLL CREDITS     ww',
    ' 29 GAMES BEATEN',
    ' LAST - AUG 22 ON PC',
    ' CONTRA: OPERATION',
    ' GALUGA',
    'ww 18 ON ARCADE     ww',
  ], 'roll credits');
});

test('the live roll-credits.tour payload formats from stats, not a missing games list', () => {
  const frames = gaming.rollCreditsFrames({
    type: 'roll-credits.tour',
    count: 29,
    stats: {
      total: 29,
      latest: {
        title: 'Contra: Operation Galuga',
        system: 'pc',
        systemLabel: 'PC',
        beatenAt: '2026-08-22',
        induction: 29,
      },
      bySystem: [
        { id: 'arcade', label: 'Arcade', count: 18 },
        { id: 'pc', label: 'PC', count: 11 },
      ],
    },
  });

  assertLayout(frames[0].rows, [
    'ww ROLL CREDITS     ww',
    ' 29 GAMES BEATEN',
    ' LAST - AUG 22 ON PC',
    ' CONTRA: OPERATION',
    ' GALUGA',
    'ww 18 ON ARCADE     ww',
  ], 'roll credits tour');
});

test('a YYYY-MM-DD beat date does not slip a day west of UTC', () => {
  const frames = gaming.rollCreditsFrames({
    type: 'credits.show',
    games: [{
      title: 'Celeste', system: 'switch', beatenAt: '2026-08-22', induction: 1,
    }],
  });
  assert.match(formatLayout(frames[0].rows).split('\n')[2], /AUG 22/);
});

test('a scheduled tour subset still prints the library total from stats', () => {
  const frames = gaming.rollCreditsFrames({
    type: 'roll-credits.tour',
    count: 29,
    games: [{
      title: 'Celeste', system: 'switch', systemLabel: 'Switch', beatenAt: '2026-03-01', induction: 1,
    }],
    stats: {
      total: 29,
      latest: {
        title: 'Contra: Operation Galuga',
        system: 'pc',
        systemLabel: 'PC',
        beatenAt: '2026-08-22',
        media: { selectedKind: 'cover', hero: { url: 'https://x/cover.jpg' }, screenshots: [] },
      },
      bySystem: [{ id: 'arcade', label: 'Arcade', count: 18 }],
    },
  });

  assertLayout(frames[0].rows, [
    'ww ROLL CREDITS     ww',
    ' 29 GAMES BEATEN',
    ' LAST - AUG 22 ON PC',
    ' CONTRA: OPERATION',
    ' GALUGA',
    'ww 18 ON ARCADE     ww',
  ], 'roll credits scheduled subset');
});

function huupeSession(overrides = {}) {
  return {
    type: 'huupe.session',
    session: {
      status: 'live',
      mode: 'family',
      modeLabel: 'Family Mode',
      stats: {
        made: 9, attempts: 21, fgPct: 43, points: 17.1, streak: 3, bestStreak: 5, threes: 2,
      },
      players: [
        {
          name: 'trashpanda', score: 17.1, made: 6, attempts: 12, fgPct: 50, threes: 2,
        },
        {
          name: 'War D', score: 12.9, made: 4, attempts: 11, fgPct: 36, threes: 1,
        },
      ],
      lastShot: {
        player: 'trashpanda', zone: 'three', made: true, points: 3, worthLabel: '3PT',
      },
      ...overrides,
    },
  };
}

test('a live Family Mode game is a scoreboard, closest race first', () => {
  const frames = gaming.huupeSessionFrames(huupeSession());

  assert.equal(frames[0].priority, 'snapshot');
  assertLayout(frames[0].rows, [
    'oo HUUPE     FAMILY oo',
    ' TRASHPANDA      17.1',
    ' WAR D           12.9',
    ' LAST SHOT 3PT MADE',
    '',
    'oo   SHOOTING NOW   oo',
  ], 'huupe live family');
});

test('the mode never eats into the HUUPE badge', () => {
  // "Family Mode" is 11 characters and used to clip the header down to "HUUP".
  const rows = gaming.huupeSessionFrames(huupeSession())[0].rows;
  assert.match(formatLayout(rows).split('\n')[0], /^oo HUUPE/);
});

test('an unknown mode name is shortened rather than allowed to clip the badge', () => {
  const rows = gaming.huupeSessionFrames(
    huupeSession({ mode: 'somethingnew', modeLabel: 'Tournament Bracket' }),
  )[0].rows;
  assert.match(formatLayout(rows).split('\n')[0], /^oo HUUPE {2,}TOURNAMEN oo$/);
});

test('free play has no names, so the board shows the session score', () => {
  const frames = gaming.huupeSessionFrames(huupeSession({
    mode: 'justhuupe',
    modeLabel: 'Free Play',
    players: [],
    stats: {
      made: 9, attempts: 21, fgPct: 43, points: 17, streak: 4, bestStreak: 5, threes: 2,
    },
  }));

  assertLayout(frames[0].rows, [
    'oo HUUPE  FREE PLAY oo',
    ' 17 POINTS',
    ' FG 9/21 - 43%',
    ' LAST SHOT 3PT MADE',
    ' 4 MAKES IN A ROW',
    'oo   SHOOTING NOW   oo',
  ], 'huupe live free play');
});

test('the last shot is named on the board, made or missed', () => {
  // Totals say how the session is going; they never say what just happened,
  // and the shooter walking back to the line is asking about that shot.
  const missed = gaming.huupeSessionFrames(huupeSession({
    mode: 'justhuupe',
    modeLabel: 'Free Play',
    players: [],
    stats: {
      made: 9, attempts: 22, fgPct: 41, points: 17, streak: 0,
    },
    lastShot: { zone: 'three', made: false, points: 0, worthLabel: '3PT' },
  }));

  // A miss breaks the run, so the streak row goes with it.
  assertLayout(missed[0].rows, [
    'oo HUUPE  FREE PLAY oo',
    ' 17 POINTS',
    ' FG 9/22 - 41%',
    ' LAST SHOT 3PT MISS',
    '',
    'oo   SHOOTING NOW   oo',
  ], 'huupe live free play miss');
});

test('the longest last-shot row is the full width of a body row', () => {
  // "LAST SHOT LAYUP MADE" is twenty characters — exactly the room a body row
  // has — so it must land whole rather than lose its last letter.
  const rows = gaming.huupeSessionFrames(huupeSession({
    lastShot: { player: 'War D', zone: 'layup', made: true, points: 0.1, worthLabel: 'LAYUP' },
  }))[0].rows;

  assertLayout(rows, [
    'oo HUUPE     FAMILY oo',
    ' TRASHPANDA      17.1',
    ' WAR D           12.9',
    ' LAST SHOT LAYUP MADE',
    '',
    'oo   SHOOTING NOW   oo',
  ], 'huupe live layup');
});

test('a full scoreboard still leaves the last shot its row', () => {
  const rows = gaming.huupeSessionFrames(huupeSession({
    players: [
      { name: 'trashpanda', score: 17.1 },
      { name: 'War D', score: 12.9 },
      { name: 'Bean', score: 9 },
      { name: 'Nobody', score: 2 },
    ],
  }))[0].rows;

  assertLayout(rows, [
    'oo HUUPE     FAMILY oo',
    ' TRASHPANDA      17.1',
    ' WAR D           12.9',
    ' BEAN               9',
    ' LAST SHOT 3PT MADE',
    'oo   SHOOTING NOW   oo',
  ], 'huupe live full scoreboard');
});

test('a session with no shot on record simply omits the row', () => {
  // An archived game replayed onto the board carries no last shot.
  const rows = gaming.huupeSessionFrames(huupeSession({ lastShot: null }))[0].rows;

  assertLayout(rows, [
    'oo HUUPE     FAMILY oo',
    ' TRASHPANDA      17.1',
    ' WAR D           12.9',
    '',
    '',
    'oo   SHOOTING NOW   oo',
  ], 'huupe live no last shot');
});

test('a finished game flanks the winner and names who they beat', () => {
  const frames = gaming.huupeSessionFrames(huupeSession({
    status: 'finished',
    durationLabel: '12:22',
    players: [
      {
        name: 'trashpanda', score: 17.1, made: 6, attempts: 12, fgPct: 50, threes: 2, isWinner: true,
      },
      {
        name: 'War D', score: 12.9, made: 4, attempts: 11, fgPct: 36, threes: 1,
      },
    ],
  }));

  assertLayout(frames[0].rows, [
    'oo HUUPE     FAMILY oo',
    ' y TRASHPANDA WINS y',
    ' OVER WAR D 17.1-12.9',
    ' FG 6/12 - 50%',
    ' 2 FROM DEEP',
    'oo GAME OVER  12:22 oo',
  ], 'huupe final');
});

test('a layup keeps its tenth on the board', () => {
  // Family Mode pays 0.1 for a layup, so 17.1 must not flip up as 17.
  const rows = gaming.huupeSessionFrames(huupeSession())[0].rows;
  assert.match(formatLayout(rows), /17\.1/);
});

test('a whole score drops the decimal point rather than flipping a pointless 0', () => {
  const rows = gaming.huupeSessionFrames(huupeSession({
    players: [{ name: 'trashpanda', score: 12, made: 6, attempts: 12, fgPct: 50 }],
  }))[0].rows;
  assert.match(formatLayout(rows).split('\n')[1], / 12$/);
});

test('two stray shots are not worth flipping the board for', () => {
  // A board flip is six seconds of flapping; a ball knocked off the rim by
  // someone walking past should not buy that.
  assert.deepEqual(
    gaming.huupeSessionFrames(huupeSession({ stats: { made: 1, attempts: 1 }, players: [] })),
    [],
  );
});

test('the huupe dashboard fits a four-digit shot count', () => {
  // "SESSIONS" plus 3371 ran off the end of the board and printed "SHO".
  const frames = gaming.huupeDashboardFrames({
    type: 'huupe.dashboard',
    totals: {
      sessions: 48, shots: 3371, fgPct: 44, lastPlayedAt: '2026-08-25',
    },
    leaderboard: [{ name: 'trashpanda', wins: 11 }],
    records: { bestStreak: { value: 11 }, bestSessionScore: { value: 34.2 } },
  }, { timeZone: 'America/Denver' });

  assert.equal(frames[0].priority, 'snapshot');
  assertLayout(frames[0].rows, [
    'oo HUUPE            oo',
    ' 48 PLAYS  3371 SHOTS',
    ' TRASHPANDA   11 WINS',
    ' FG 44%  RUN 11',
    ' BEST GAME 34.2',
    'oo LAST GAME AUG 25 oo',
  ], 'huupe dashboard');
});

test('a hoop nobody has played is not worth a board flip', () => {
  assert.deepEqual(
    gaming.huupeDashboardFrames({ type: 'huupe.dashboard', totals: { sessions: 0 } }),
    [],
  );
});

test('player names truncate at 13 with no ellipsis', () => {
  const frames = gaming.autodartsMatchFrames({
    type: 'autodarts.match',
    match: {
      status: 'live',
      settingsLine: '501 · First to 3 legs',
      players: [{ name: 'AlexanderTheGreat' }, { name: 'Sam' }],
    },
  });
  assert.match(formatLayout(frames[0].rows).split('\n')[2], /^ ALEXANDERTHEG VS SAM$/);
});
