const test = require('node:test');
const assert = require('node:assert/strict');
const {
  recomputeFromMatches,
  isX01Family,
  playerKey,
  completedLegs,
  wasPlayed,
} = require('../src/autodarts-aggregates');

test('weighted X01 average prefers pointsScored path', () => {
  const data = recomputeFromMatches([
    {
      matchId: '1',
      variant: 'X01',
      finishedAt: '2026-01-01T00:00:00.000Z',
      winner: 'A',
      players: [
        { name: 'A', legsWon: 2, pointsScored: 501, dartsThrown: 60, average: 99 },
        { name: 'B', legsWon: 0, pointsScored: 200, dartsThrown: 60, average: 10 },
      ],
    },
    {
      matchId: '2',
      variant: 'X01',
      finishedAt: '2026-01-02T00:00:00.000Z',
      winner: 'A',
      players: [
        { name: 'A', legsWon: 2, pointsScored: 501, dartsThrown: 30, average: 50 },
        { name: 'B', legsWon: 1, pointsScored: 300, dartsThrown: 30, average: 30 },
      ],
    },
  ]);
  const a = data.players.find((row) => row.name === 'A');
  // (501+501)/(60+30)*3 = 33.4
  assert.equal(a.x01Average, 33.4);
  assert.equal(a.wins, 2);
});

test('wins across variants; skill columns X01-only; crown tie-breaks', () => {
  const data = recomputeFromMatches([
    {
      matchId: 'c1',
      variant: 'Cricket',
      finishedAt: '2026-02-01T00:00:00.000Z',
      winner: 'Guest',
      players: [
        { name: 'guest', userId: null, legsWon: 1 },
        { name: 'Host', userId: 'h1', legsWon: 0 },
      ],
    },
    {
      matchId: 'x1',
      variant: 'X01',
      finishedAt: '2026-02-02T00:00:00.000Z',
      winner: 'Host',
      players: [
        { name: 'HOST', userId: 'h1', legsWon: 2, average: 40, dartsThrown: 30, bestCheckout: 40, counts: { 180: 1 } },
        { name: 'guest', legsWon: 0, average: 20, dartsThrown: 30 },
      ],
    },
    {
      matchId: 'x2',
      variant: 'X01',
      finishedAt: '2026-02-03T00:00:00.000Z',
      winner: 'Host',
      players: [
        { name: 'Host', userId: 'h1', legsWon: 2, average: 42, dartsThrown: 30, bestCheckout: 48, counts: { 180: 0 } },
        { name: 'GUEST', legsWon: 1, average: 18, dartsThrown: 30 },
      ],
    },
  ]);
  assert.equal(playerKey('HOST'), 'host');
  assert.equal(isX01Family('X01+'), true);
  assert.equal(data.players[0].name, 'Host');
  assert.equal(data.players[0].wins, 2);
  assert.ok(data.players[0].x01Average > 0);
  assert.equal(data.records.total180s, 1);
  assert.equal(data.records.highestCheckout.value, 48);
  const guest = data.players.find((row) => row.name.toLowerCase() === 'guest');
  assert.equal(guest.isGuest, true);
  assert.equal(guest.wins, 1);
});

test('a match is played once a leg is decided, whoever ended the race', () => {
  assert.equal(wasPlayed({ players: [{ legsWon: 0 }] }), true);
  assert.equal(wasPlayed({ aborted: true, players: [{ legsWon: 1 }] }), true);
  assert.equal(wasPlayed({ aborted: true, players: [{ legsWon: 0 }] }), false);
  assert.equal(wasPlayed({ aborted: true, players: [] }), false);
  assert.equal(completedLegs({ players: [{ legsWon: 2 }, { legsWon: 1 }] }), 3);
});

test('the headline total agrees with the legs, months and last-played date', () => {
  const data = recomputeFromMatches([
    {
      matchId: 'played',
      variant: 'X01',
      finishedAt: '2026-08-02T05:34:19.000Z',
      winner: 'A',
      players: [{ name: 'A', legsWon: 2 }, { name: 'B', legsWon: 1 }],
    },
    {
      // Opened and deleted without a leg — setup, not a game.
      matchId: 'deleted',
      aborted: true,
      abortReason: 'delete',
      variant: 'X01',
      finishedAt: '2026-08-23T23:36:49.000Z',
      winner: null,
      players: [{ name: 'A', legsWon: 0 }],
    },
  ]);
  // The board reads "N MATCHES" straight off this, so it has to agree with every
  // other figure rather than counting the raw archive.
  assert.equal(data.totals.matches, 1);
  assert.equal(data.totals.legs, 3);
  assert.equal(data.totals.lastPlayedAt, '2026-08-02T05:34:19.000Z');
  assert.equal(data.months.find((row) => row.key === '2026-08')?.count, 1);
});

test('rivalry pairing and month buckets across year boundary', () => {
  const data = recomputeFromMatches([
    {
      matchId: '1',
      variant: 'X01',
      finishedAt: '2025-12-15T00:00:00.000Z',
      winner: 'A',
      players: [{ name: 'A', legsWon: 2 }, { name: 'B', legsWon: 1 }],
    },
    {
      matchId: '2',
      variant: 'X01',
      finishedAt: '2026-01-15T00:00:00.000Z',
      winner: 'B',
      players: [{ name: 'A', legsWon: 0 }, { name: 'B', legsWon: 2 }],
    },
    {
      matchId: '3',
      variant: 'Killer',
      finishedAt: '2026-01-20T00:00:00.000Z',
      winner: 'A',
      players: [{ name: 'A', legsWon: 1 }, { name: 'C', legsWon: 0 }],
    },
  ]);
  assert.equal(data.months.length, 12);
  assert.ok(data.rivalry);
  assert.equal(data.rivalry.matches, 2);
  assert.ok(data.byVariant.some((row) => row.label === 'Killer'));
});
