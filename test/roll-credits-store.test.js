const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createRollCreditsStore,
  generateId,
  normalizeTitle,
} = require('../src/roll-credits-store');

function tempStorePath() {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'roll-credits-store-unit-')),
    'roll-credits.json',
  );
}

function makeStore() {
  return createRollCreditsStore({ rollCreditsPath: tempStorePath() });
}

test('Roll Credits store performs CRUD and persists atomic JSON', () => {
  const storePath = tempStorePath();
  const store = createRollCreditsStore({ rollCreditsPath: storePath });
  const created = store.createGame({
    title: 'It Takes Two',
    system: 'ps5',
    beatenAt: '2026-08-14',
    notes: 'Great co-op',
  });

  assert.match(created.id, /^rc_[0-9a-f]+$/);
  assert.match(generateId(), /^rc_[0-9a-f]+$/);
  assert.equal(created.induction, 1);
  assert.equal(store.getGame(created.id).title, 'It Takes Two');

  const updated = store.updateGame(created.id, { notes: 'Excellent co-op' });
  assert.equal(updated.notes, 'Excellent co-op');
  assert.equal(updated.induction, 1);
  assert.notEqual(updated.updatedAt, undefined);

  const disk = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  assert.equal(disk.version, 1);
  assert.equal(disk.games.length, 1);
  assert.equal(
    fs.readdirSync(path.dirname(storePath)).some((name) => name.endsWith('.tmp')),
    false,
  );

  // A temp file left by an interrupted older write never replaces the canonical file.
  fs.writeFileSync(`${storePath}.crashed.tmp`, '{"version":1,"games":[', 'utf8');
  const reloaded = createRollCreditsStore({ rollCreditsPath: storePath });
  assert.equal(reloaded.getGame(created.id).notes, 'Excellent co-op');
  assert.equal(reloaded.deleteGame(created.id), true);
  assert.equal(reloaded.deleteGame(created.id), false);
});

test('create numbers games by beat date and reports duplicates without blocking', () => {
  const store = makeStore();
  const first = store.createGame({ title: 'Pokémon: Red!', system: 'gb', beatenAt: '2020-01-01' });
  const second = store.createGame({ title: 'Pokemon Red', system: 'GB', beatenAt: '2021-01-01' });
  store.deleteGame(first.id);
  const third = store.createGame({ title: 'Metroid', system: 'nes', beatenAt: '2022-01-01' });

  assert.equal(normalizeTitle('Pokémon: Red!'), 'pokemon red');
  assert.equal(first.duplicateWarning, false);
  assert.equal(second.duplicateWarning, true);
  assert.match(second.warning, /same title and system/i);
  // Deleting the 2020 clear closes the gap: 2021 is now #1, 2022 lands on #2.
  assert.equal(store.getGame(second.id).induction, 1);
  assert.equal(third.induction, 2);
});

test('induction order follows beat dates however games are entered', () => {
  const store = makeStore();
  const august1 = store.createGame({ title: 'First', system: 'pc', beatenAt: '2026-08-01' });
  const august3 = store.createGame({ title: 'Third', system: 'pc', beatenAt: '2026-08-03' });
  const august2 = store.createGame({ title: 'Second', system: 'pc', beatenAt: '2026-08-02' });

  assert.deepEqual(
    store.listGames({ sort: 'induction', dir: 'asc' }).games.map((game) => game.title),
    ['First', 'Second', 'Third'],
  );
  assert.equal(store.getGame(august1.id).induction, 1);
  assert.equal(store.getGame(august2.id).induction, 2);
  assert.equal(store.getGame(august3.id).induction, 3);

  // Undated games are captured but parked below every dated clear.
  const unknown = store.createGame({ title: 'Someday', system: 'pc', beatenDateUnknown: true });
  assert.equal(store.getGame(unknown.id).induction, 1);
  assert.equal(store.getGame(august3.id).induction, 4);
  assert.deepEqual(
    store.listGames({ sort: 'induction', dir: 'desc' }).games.map((game) => game.title),
    ['Third', 'Second', 'First', 'Someday'],
  );

  // Correcting a date reshuffles the numbering rather than freezing it.
  store.updateGame(august2.id, { beatenAt: '2026-08-09' });
  assert.deepEqual(
    store.listGames({ sort: 'induction', dir: 'desc' }).games.map((game) => game.title),
    ['Second', 'Third', 'First', 'Someday'],
  );
});

test('manual reorder overrides the beat-date order and survives a reload', () => {
  const storePath = tempStorePath();
  const store = createRollCreditsStore({ rollCreditsPath: storePath });
  const older = store.createGame({ title: 'Older', system: 'pc', beatenAt: '2026-01-01' });
  const middle = store.createGame({ title: 'Middle', system: 'pc', beatenAt: '2026-02-01' });
  const newer = store.createGame({ title: 'Newer', system: 'pc', beatenAt: '2026-03-01' });

  assert.equal(store.isOrderManual(), false);
  const result = store.reorderGames([older.id, newer.id, middle.id]);
  assert.equal(result.manual, true);
  assert.deepEqual(
    store.listGames({ sort: 'induction', dir: 'desc' }).games.map((game) => game.title),
    ['Older', 'Newer', 'Middle'],
  );
  assert.equal(store.listGames({}).orderManual, true);

  const reloaded = createRollCreditsStore({ rollCreditsPath: storePath });
  assert.equal(reloaded.isOrderManual(), true);
  assert.deepEqual(
    reloaded.listGames({ sort: 'induction', dir: 'desc' }).games.map((game) => game.title),
    ['Older', 'Newer', 'Middle'],
  );

  // A back-dated addition still slots in chronologically around the hand-sort.
  reloaded.createGame({ title: 'Backfill', system: 'pc', beatenAt: '2026-01-15' });
  assert.deepEqual(
    reloaded.listGames({ sort: 'induction', dir: 'desc' }).games.map((game) => game.title),
    ['Older', 'Newer', 'Middle', 'Backfill'],
  );

  reloaded.resetInductionOrder();
  assert.equal(reloaded.isOrderManual(), false);
  assert.deepEqual(
    reloaded.listGames({ sort: 'induction', dir: 'desc' }).games.map((game) => game.title),
    ['Newer', 'Middle', 'Backfill', 'Older'],
  );
});

test('reorder only shuffles the slots the listed games already hold', () => {
  const store = makeStore();
  const ids = ['A', 'B', 'C', 'D', 'E'].map((title, index) => store.createGame({
    title,
    system: 'pc',
    beatenAt: `2026-01-0${index + 1}`,
  }).id);
  // Display order runs newest first: E D C B A. Handing back the two ends of a
  // filtered view swaps them without disturbing C in between.
  const [a, b, , d] = ids;

  store.reorderGames([b, d]);
  assert.deepEqual(
    store.listGames({ sort: 'induction', dir: 'desc' }).games.map((game) => game.title),
    ['E', 'B', 'C', 'D', 'A'],
  );

  assert.throws(() => store.reorderGames([a, a]), /repeats a game/i);
  assert.throws(() => store.reorderGames(['nope']), /Unknown game/i);
});

test('list sorts by difficulty, release and players with unknowns pinned last', () => {
  const store = makeStore();
  store.createGame({
    title: 'Brutal One',
    system: 'pc',
    beatenAt: '2026-01-01',
    meta: { difficulty: 'Brutal', releaseDate: '1998-05-01', maxPlayers: 1 },
  });
  store.createGame({
    title: 'Easy One',
    system: 'pc',
    beatenAt: '2026-01-02',
    meta: { difficulty: 'Easy', releaseDate: '2024', maxPlayers: 4 },
  });
  store.createGame({ title: 'Unrated', system: 'pc', beatenAt: '2026-01-03', meta: {} });

  const titles = (options) => store.listGames(options).games.map((game) => game.title);
  assert.deepEqual(titles({ sort: 'difficulty', dir: 'desc' }), ['Brutal One', 'Easy One', 'Unrated']);
  assert.deepEqual(titles({ sort: 'difficulty', dir: 'asc' }), ['Easy One', 'Brutal One', 'Unrated']);
  assert.deepEqual(titles({ sort: 'releaseDate', dir: 'desc' }), ['Easy One', 'Brutal One', 'Unrated']);
  assert.deepEqual(titles({ sort: 'maxPlayers', dir: 'desc' }), ['Easy One', 'Brutal One', 'Unrated']);
  assert.deepEqual(titles({ sort: 'beatenAt', dir: 'asc' }), ['Brutal One', 'Easy One', 'Unrated']);
  // An unknown sort column falls back to induction rather than throwing.
  assert.deepEqual(titles({ sort: 'nonsense', dir: 'desc' }), ['Unrated', 'Easy One', 'Brutal One']);
});

test('bulk delete returns deleted and failed id lists', () => {
  const store = makeStore();
  const first = store.createGame({ title: 'One', system: 'pc' });
  const second = store.createGame({ title: 'Two', system: 'pc' });
  assert.deepEqual(store.bulkDelete([first.id, 'missing']), {
    deleted: [first.id],
    failed: ['missing'],
  });
  assert.deepEqual(store.getAllGames().map((game) => game.id), [second.id]);
});

test('list supports sorting, filtering, no-date records and pagination', () => {
  const store = makeStore();
  store.createGame({ title: 'Zelda', system: 'switch', beatenAt: '2024-12-01' });
  store.createGame({ title: 'Astro Bot', system: 'ps5', beatenAt: '2025-01-15' });
  store.createGame({
    title: 'Mystery Game',
    system: 'pc',
    beatenAt: null,
    beatenDateUnknown: true,
    notes: 'A forgotten date',
  });

  assert.deepEqual(
    store.listGames({ sort: 'title', dir: 'asc' }).games.map((game) => game.title),
    ['Astro Bot', 'Mystery Game', 'Zelda'],
  );
  assert.deepEqual(
    store.listGames({ sort: 'induction', dir: 'desc' }).games.map((game) => game.induction),
    [3, 2, 1],
  );
  assert.equal(store.listGames({ system: 'PS5' }).total, 1);
  assert.equal(store.listGames({ yearBeaten: 2024 }).games[0].title, 'Zelda');
  assert.equal(store.listGames({ q: 'forgotten' }).games[0].title, 'Mystery Game');
  assert.deepEqual(
    store.listGames({ noDate: true }).games.map((game) => game.title),
    ['Mystery Game'],
  );

  const page = store.listGames({ sort: 'title', dir: 'asc', page: 2, pageSize: 2 });
  assert.equal(page.total, 3);
  assert.equal(page.pages, 2);
  assert.equal(page.games[0].title, 'Zelda');
});

test('create defaults to today while NA dates remain null', () => {
  const store = makeStore();
  const today = new Date();
  const expected = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, '0'),
    String(today.getDate()).padStart(2, '0'),
  ].join('-');
  const dated = store.createGame({ title: 'Today', system: 'pc' });
  const unknown = store.createGame({
    title: 'Unknown',
    system: 'other',
    beatenDateUnknown: true,
  });

  assert.equal(dated.beatenAt, expected);
  assert.equal(dated.beatenDateUnknown, false);
  assert.equal(unknown.beatenAt, null);
  assert.equal(unknown.beatenDateUnknown, true);
});

test('stats build month buckets across years and exclude undated games', () => {
  const store = makeStore();
  const now = new Date();
  const monthDate = (offset) => {
    const date = new Date(now.getFullYear(), now.getMonth() + offset, 10);
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      '10',
    ].join('-');
  };
  store.createGame({
    title: 'Older',
    system: 'snes',
    beatenAt: monthDate(-2),
    meta: { releaseDate: '1994-01-01' },
  });
  store.createGame({
    title: 'Recent A',
    system: 'ps5',
    beatenAt: monthDate(-1),
    meta: { releaseDate: '2024' },
  });
  const latest = store.createGame({
    title: 'Recent B',
    system: 'ps5',
    beatenAt: monthDate(-1),
    beatenWith: 'Luis',
  });
  store.createGame({
    title: 'No Date',
    system: 'other',
    beatenDateUnknown: true,
    beatenWith: 'Luis',
  });
  store.createGame({
    title: 'Solo Clear',
    system: 'switch',
    beatenAt: monthDate(-2),
    beatenWith: 'Alex',
  });

  const stats = store.getStats();
  assert.equal(stats.total, 5);
  assert.equal(stats.systemsCount, 4);
  // Latest inducted is the most recent clear, not the most recently typed in.
  assert.equal(stats.latest.id, latest.id);
  assert.equal(stats.undatedCount, 1);
  assert.equal(stats.months.length, 12);
  assert.equal(stats.months.at(-2).count, 2);
  assert.equal(stats.bestMonth.count, 2);
  assert.equal(stats.streakMonths, 2);
  assert.equal(stats.topBeatenWith.name, 'Luis');
  assert.equal(stats.topBeatenWith.count, 2);
  assert.equal(stats.beatenWith[0].name, 'Luis');
  assert.equal(stats.beatenWith[1].name, 'Alex');
  assert.deepEqual(stats.decades, [
    { key: '1990s', label: '1990s', count: 1 },
    { key: '2020s', label: '2020s', count: 1 },
  ]);
  // Undated first, then the two -2 month clears, then the two -1 month ones.
  assert.equal(store.getGame(latest.id).induction, 5);
});

test('stats roll per-system counts into top eight plus Others and detect milestones', () => {
  const store = makeStore();
  const games = [];
  for (let index = 0; index < 25; index += 1) {
    games.push({
      id: `g${index}`,
      title: `Game ${index}`,
      system: `system-${index % 9}`,
      beatenAt: '2026-01-01',
      induction: index + 1,
      createdAt: `2026-01-${String((index % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
    });
  }
  const stats = store.computeStats(games);
  assert.equal(stats.bySystem.length, 9);
  assert.equal(stats.bySystem.at(-1).label, 'Others');
  assert.equal(stats.bySystem.reduce((sum, row) => sum + row.count, 0), 25);
  assert.deepEqual(stats.milestones, [25]);
  assert.equal(stats.latest.induction, 25);
});

test('system helpers load canonical systems and map IGDB platform ids', () => {
  const store = makeStore();
  assert.equal(store.loadSystems().length, 31);
  assert.equal(store.getSystemById('PS5').label, 'PS5');
  assert.equal(store.mapIgdbPlatformToSystem(19).id, 'snes');
  assert.equal(store.mapIgdbPlatformToSystem(52).id, 'arcade');
  assert.equal(store.getSystemById('arcade').label, 'Arcade');
  assert.equal(store.mapIgdbPlatformToSystem(999999), null);
});

test('getSystemUsage only returns systems that have recorded games', () => {
  const store = makeStore();
  store.createGame({ title: 'Chrono Trigger', system: 'snes', beatenAt: '2026-01-01' });
  store.createGame({ title: 'Celeste', system: 'pc', beatenAt: '2026-02-01' });
  store.createGame({ title: 'Super Metroid', system: 'snes', beatenAt: '2026-03-01' });
  const used = store.getSystemUsage();
  assert.deepEqual(used.map((row) => row.id).sort(), ['pc', 'snes']);
  assert.equal(used.find((row) => row.id === 'snes').count, 2);
  assert.equal(used.find((row) => row.id === 'pc').count, 1);
});
