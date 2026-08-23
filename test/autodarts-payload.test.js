const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAutodartsArchive } = require('../src/autodarts-archive');
const { createAutodartsAggregates } = require('../src/autodarts-aggregates');
const { createAutodartsSettings } = require('../src/autodarts-settings');
const {
  createAutodartsPayload,
  buildMatchPayload,
} = require('../src/autodarts-payload');
const { createAutodartsHistory } = require('../src/autodarts-history');
const { normalizeDart } = require('../src/autodarts-live');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autodarts-payload-'));
}

test('dashboard payload byte bound at leaderboardSize 16', () => {
  const root = tempRoot();
  const archive = createAutodartsArchive({
    ROOT: root,
    autodartsArchivePath: path.join(root, 'matches'),
  });
  const aggregates = createAutodartsAggregates({
    ROOT: root,
    autodartsPlayersPath: path.join(root, 'players.json'),
  });
  const settings = createAutodartsSettings({
    autodartsSettingsPath: path.join(root, 'settings.json'),
  });
  settings.update({ dashboard: { leaderboardSize: 16 } });
  for (let i = 0; i < 20; i += 1) {
    archive.append({
      matchId: `m${i}`,
      variant: 'X01',
      finishedAt: `2026-03-${String((i % 28) + 1).padStart(2, '0')}T12:00:00.000Z`,
      winner: `P${i % 16}`,
      players: [
        { name: `P${i % 16}`, legsWon: 2, average: 20 + i, dartsThrown: 40, pointsScored: 400, counts: { 180: i % 2 } },
        { name: `Q${i}`, legsWon: 0, average: 15, dartsThrown: 40, pointsScored: 200 },
      ],
    });
  }
  aggregates.recompute(archive.listAll());
  const payload = createAutodartsPayload({ archive, aggregates, settings }).buildDashboard();
  assert.equal(payload.type, 'autodarts.dashboard');
  assert.equal(payload.leaderboard.length, 16);
  assert.ok(payload.moreCount >= 0);
  const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  assert.ok(bytes < 12_000, `dashboard payload too large: ${bytes}`);
});

test('match payload carries dart objects, prevTurn, and null coords passthrough', () => {
  const payload = buildMatchPayload({
    matchId: 'm1',
    revision: 3,
    status: 'live',
    variant: 'X01',
    settingsLine: '501 · SI-DO',
    currentPlayerIndex: 0,
    turn: {
      points: 65,
      busted: false,
      darts: [
        { seg: 'T20', x: 0.12, y: -0.34, type: 'normal' },
        { seg: 'M', x: 1.2, y: 0.1, type: 'normal' },
        { seg: '20', x: null, y: null, type: 'bouncer' },
      ],
    },
    prevTurn: {
      playerIndex: 1,
      points: 41,
      darts: [{ seg: '20', x: 0.1, y: -0.7, type: 'normal' }],
    },
    players: [{ name: 'A', score: 261, legs: 1 }],
  });
  assert.equal(payload.type, 'autodarts.match');
  assert.equal(payload.persistent, true);
  assert.equal(payload.match.turn.darts[0].seg, 'T20');
  assert.equal(payload.match.turn.darts[2].type, 'bouncer');
  assert.equal(payload.match.turn.darts[2].x, null);
  assert.ok(payload.match.prevTurn);
  const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  assert.ok(bytes < 8_000, `match payload too large: ${bytes}`);
});

test('normalizeDart never invents coordinates', () => {
  assert.deepEqual(normalizeDart({ name: 'T20' }), { seg: 'T20', x: null, y: null, type: 'normal' });
  assert.equal(normalizeDart(null), null);
});

test('history sync disabled until endpoint confirmed', async () => {
  const root = tempRoot();
  const archive = createAutodartsArchive({ ROOT: root, autodartsArchivePath: path.join(root, 'm') });
  const aggregates = createAutodartsAggregates({ ROOT: root, autodartsPlayersPath: path.join(root, 'p.json') });
  const settings = createAutodartsSettings({ autodartsSettingsPath: path.join(root, 's.json') });
  settings.update({ sync: { historyEndpointConfirmed: false } });
  const history = createAutodartsHistory({ archive, aggregates, api: {}, settings });
  const status = history.status();
  assert.equal(status.enabled, false);
  assert.match(status.note, /live matches/i);
  const result = await history.sync();
  assert.equal(result.skipped, true);
});

test('history sync enabled when endpoint confirmed', async () => {
  const root = tempRoot();
  const archive = createAutodartsArchive({ ROOT: root, autodartsArchivePath: path.join(root, 'm') });
  const aggregates = createAutodartsAggregates({ ROOT: root, autodartsPlayersPath: path.join(root, 'p.json') });
  const settings = createAutodartsSettings({ autodartsSettingsPath: path.join(root, 's.json') });
  const history = createAutodartsHistory({ archive, aggregates, api: {}, settings });
  assert.equal(history.status().enabled, true);
});

test('archive matchId dedupe', () => {
  const root = tempRoot();
  const archive = createAutodartsArchive({ ROOT: root, autodartsArchivePath: path.join(root, 'm') });
  assert.equal(archive.append({ matchId: 'x', finishedAt: '2026-01-01T00:00:00.000Z', players: [] }).deduped, false);
  assert.equal(archive.append({ matchId: 'x', finishedAt: '2026-01-01T00:00:00.000Z', players: [] }).deduped, true);
  assert.equal(archive.count(), 1);
});
