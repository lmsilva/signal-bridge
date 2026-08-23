const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createAutodartsHistory,
  archiveFromCloudStats,
  archiveFromHistoryItem,
  parseDuration,
} = require('../src/autodarts-history');
const { createAutodartsArchive } = require('../src/autodarts-archive');
const { createAutodartsAggregates } = require('../src/autodarts-aggregates');
const { createAutodartsSettings } = require('../src/autodarts-settings');

test('parseDuration understands Autodarts duration strings', () => {
  assert.equal(parseDuration('10m38s'), 638);
  assert.equal(parseDuration('1h2m3s'), 3723);
  assert.equal(parseDuration(90), 90);
});

test('archiveFromCloudStats maps matchStats onto players', () => {
  const row = archiveFromCloudStats({
    id: 'm1',
    variant: 'X01',
    type: 'Local',
    createdAt: '2026-08-01T00:00:00Z',
    finishedAt: '2026-08-01T00:10:00Z',
    duration: '10m0s',
    winner: 0,
    settings: { baseScore: 501 },
    scores: [{ legs: 2, sets: 0 }, { legs: 1, sets: 0 }],
    players: [
      { id: 'p1', name: 'trashpanda', userId: 'u1' },
      { id: 'p2', name: 'war d', userId: null },
    ],
    matchStats: [
      {
        playerId: 'p1',
        legsWon: 2,
        average: 40.5,
        first9Average: 50,
        dartsThrown: 30,
        checkoutsHit: 2,
        checkouts: 10,
        checkoutPercent: 0.2,
        checkoutPoints: 40,
        total180: 1,
        plus100: 2,
      },
      {
        playerId: 'p2',
        legsWon: 1,
        average: 30,
        dartsThrown: 33,
        checkoutsHit: 1,
        checkouts: 8,
        checkoutPercent: 0.125,
        total180: 0,
      },
    ],
  });
  assert.equal(row.matchId, 'm1');
  assert.equal(row.source, 'backfill');
  assert.equal(row.winner, 'trashpanda');
  assert.equal(row.durationSec, 600);
  assert.equal(row.players[0].average, 40.5);
  assert.equal(row.players[0].checkoutPct, 20);
  assert.equal(row.players[0].counts['180'], 1);
  assert.equal(row.players[1].name, 'war d');
  assert.equal(row.local, true);
});

test('history sync imports new matches and skips known ids', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-hist-'));
  const archive = createAutodartsArchive({ ROOT: root, autodartsArchivePath: path.join(root, 'm') });
  const aggregates = createAutodartsAggregates({ ROOT: root, autodartsPlayersPath: path.join(root, 'p.json') });
  const settings = createAutodartsSettings({ autodartsSettingsPath: path.join(root, 's.json') });
  archive.append({
    matchId: 'known',
    variant: 'X01',
    finishedAt: '2026-07-01T00:00:00Z',
    players: [{ name: 'A', legsWon: 1 }, { name: 'B', legsWon: 0 }],
    winner: 'A',
    source: 'live',
  });

  const calls = [];
  const history = createAutodartsHistory({
    archive,
    aggregates,
    settings,
    sleep: async () => {},
    api: {
      listMatchHistory: async ({ page }) => {
        calls.push(['list', page]);
        if (page > 0) {
          return { ok: true, status: 200, json: { items: [], last: true, total_pages: 1 } };
        }
        return {
          ok: true,
          status: 200,
          json: {
            items: [
              {
                id: 'known',
                variant: 'X01',
                finishedAt: '2026-07-01T00:00:00Z',
                players: [{ name: 'A' }, { name: 'B' }],
                scores: [{ legs: 1 }, { legs: 0 }],
                winner: 0,
                type: 'Local',
              },
              {
                id: 'new-1',
                variant: 'X01',
                createdAt: '2026-08-01T00:00:00Z',
                finishedAt: '2026-08-01T00:12:00Z',
                players: [{ id: 'p1', name: 'trashpanda', userId: 'u1' }, { id: 'p2', name: 'war d' }],
                scores: [{ legs: 2 }, { legs: 0 }],
                winner: 0,
                type: 'Local',
              },
            ],
            last: true,
            total_pages: 1,
          },
        };
      },
      getMatchStats: async (id) => {
        calls.push(['stats', id]);
        assert.equal(id, 'new-1');
        return {
          ok: true,
          status: 200,
          json: {
            id: 'new-1',
            variant: 'X01',
            type: 'Local',
            createdAt: '2026-08-01T00:00:00Z',
            finishedAt: '2026-08-01T00:12:00Z',
            duration: '12m0s',
            winner: 0,
            players: [
              { id: 'p1', name: 'trashpanda', userId: 'u1' },
              { id: 'p2', name: 'war d' },
            ],
            scores: [{ legs: 2 }, { legs: 0 }],
            matchStats: [
              { playerId: 'p1', average: 42, dartsThrown: 24, legsWon: 2, total180: 0 },
              { playerId: 'p2', average: 28, dartsThrown: 27, legsWon: 0, total180: 0 },
            ],
            settings: { baseScore: 501 },
          },
        };
      },
    },
  });

  const result = await history.sync();
  assert.equal(result.ok, true);
  assert.equal(result.imported, 1);
  assert.equal(result.skipped, 1);
  assert.equal(archive.has('new-1'), true);
  assert.equal(archive.count(), 2);
  assert.ok(aggregates.get().players.some((row) => row.name === 'trashpanda'));
  assert.ok(calls.some((row) => row[0] === 'stats' && row[1] === 'new-1'));
});

test('history sync soft-fails when cloud list is down', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-hist-fail-'));
  const archive = createAutodartsArchive({ ROOT: root, autodartsArchivePath: path.join(root, 'm') });
  const aggregates = createAutodartsAggregates({ ROOT: root, autodartsPlayersPath: path.join(root, 'p.json') });
  const settings = createAutodartsSettings({ autodartsSettingsPath: path.join(root, 's.json') });
  const history = createAutodartsHistory({
    archive,
    aggregates,
    settings,
    sleep: async () => {},
    api: {
      listMatchHistory: async () => ({ ok: false, status: 503, json: null }),
      getMatchStats: async () => ({ ok: false, status: 503 }),
    },
  });
  const result = await history.sync();
  assert.equal(result.ok, false);
  assert.match(result.error, /503/);
  assert.equal(archive.count(), 0);
});

test('list-only fallback still archives when stats 404', () => {
  const row = archiveFromHistoryItem({
    id: 'thin',
    variant: 'Cricket',
    type: 'Local',
    finishedAt: '2026-08-01T00:00:00Z',
    players: [{ name: 'A' }, { name: 'B' }],
    scores: [{ legs: 1 }, { legs: 0 }],
    winner: 0,
  });
  assert.equal(row.matchId, 'thin');
  assert.equal(row.source, 'backfill-list');
  assert.equal(row.winner, 'A');
});
