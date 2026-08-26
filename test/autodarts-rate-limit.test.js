const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createAutodartsRateLimit,
  messageLooksRateLimited,
} = require('../src/autodarts-rate-limit');
const { createAutodartsApi } = require('../src/autodarts-api');
const { createAutodartsHistory } = require('../src/autodarts-history');
const { createAutodartsArchive } = require('../src/autodarts-archive');
const { createAutodartsAggregates } = require('../src/autodarts-aggregates');
const { createAutodartsSettings } = require('../src/autodarts-settings');
const { createAutodartsAuth } = require('../src/autodarts-auth');
const { createAutodartsCredentials } = require('../src/autodarts-credentials');

test('messageLooksRateLimited detects common Autodarts throttling text', () => {
  assert.equal(messageLooksRateLimited('too many requests, try again later'), true);
  assert.equal(messageLooksRateLimited('Rate limit exceeded'), true);
  assert.equal(messageLooksRateLimited('Board offline'), false);
});

test('rate limit pauses requests and honours Retry-After', async () => {
  let clock = 1_000_000;
  const sleeps = [];
  const rateLimit = createAutodartsRateLimit({
    now: () => clock,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    defaultCooldownMs: 60_000,
  });
  rateLimit.noteResponse({
    status: 429,
    json: { message: 'too many requests, try again later' },
    headers: { get: (name) => (name.toLowerCase() === 'retry-after' ? '120' : null) },
  });
  assert.equal(rateLimit.isPaused(), true);
  assert.equal(rateLimit.snapshot().reason.includes('too many requests'), true);
  await rateLimit.waitForSlot();
  const sleptMs = sleeps.reduce((sum, ms) => sum + ms, 0);
  assert.ok(sleptMs >= 120_000);
});

test('autodarts-api marks 429 responses and spaces calls', async () => {
  let clock = 0;
  let calls = 0;
  const rateLimit = createAutodartsRateLimit({
    now: () => clock,
    minIntervalMs: 100,
    sleep: async (ms) => { clock += ms; },
  });
  const api = createAutodartsApi({
    rateLimit,
    accessTokenProvider: async () => 'token',
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: false,
          status: 429,
          text: async () => '{"message":"too many requests, try again later"}',
          headers: { get: () => null },
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => '[]',
        headers: { get: () => null },
      };
    },
  });
  const first = await api.getBoards();
  assert.equal(first.rateLimited, true);
  assert.equal(rateLimit.isPaused(), true);
});

test('history sync aborts immediately when cloud is rate limited', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-rate-'));
  const archive = createAutodartsArchive({ ROOT: root, autodartsArchivePath: path.join(root, 'm') });
  const aggregates = createAutodartsAggregates({ ROOT: root, autodartsPlayersPath: path.join(root, 'p.json') });
  const settings = createAutodartsSettings({ autodartsSettingsPath: path.join(root, 's.json') });
  const rateLimit = createAutodartsRateLimit({ defaultCooldownMs: 60_000 });
  const history = createAutodartsHistory({
    archive,
    aggregates,
    settings,
    rateLimit,
    sleep: async () => {},
    api: {
      listMatchHistory: async () => ({
        ok: false,
        status: 429,
        json: { message: 'too many requests, try again later' },
        rateLimited: true,
      }),
      getMatchStats: async () => ({ ok: false, status: 429 }),
    },
  });
  const result = await history.sync();
  assert.equal(result.ok, false);
  assert.match(result.error, /too many requests/i);
});

test('history sync stops after consecutive fully-skipped pages', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-skip-'));
  const archive = createAutodartsArchive({ ROOT: root, autodartsArchivePath: path.join(root, 'm') });
  const aggregates = createAutodartsAggregates({ ROOT: root, autodartsPlayersPath: path.join(root, 'p.json') });
  const settings = createAutodartsSettings({ autodartsSettingsPath: path.join(root, 's.json') });
  archive.append({
    matchId: 'known',
    variant: 'X01',
    finishedAt: '2026-08-01T00:00:00Z',
    players: [{ name: 'A', legsWon: 1 }, { name: 'B', legsWon: 0 }],
    winner: 'A',
    source: 'live',
  });
  let listCalls = 0;
  const skippedItem = {
    id: 'known',
    variant: 'X01',
    finishedAt: '2026-08-01T00:00:00Z',
    players: [{ name: 'A' }, { name: 'B' }],
    scores: [{ legs: 1 }, { legs: 0 }],
    winner: 0,
    type: 'Local',
  };
  const history = createAutodartsHistory({
    archive,
    aggregates,
    settings,
    sleep: async () => {},
    api: {
      listMatchHistory: async ({ page, size }) => {
        listCalls += 1;
        const pageSize = Number(size) || 25;
        return {
          ok: true,
          status: 200,
          json: {
            items: Array.from({ length: pageSize }, () => ({ ...skippedItem })),
            last: page >= 1,
            total_pages: 5,
          },
        };
      },
      getMatchStats: async () => ({ ok: false, status: 404 }),
    },
  });
  const result = await history.sync();
  assert.equal(result.ok, true);
  assert.equal(result.imported, 0);
  assert.equal(listCalls, 2);
});

test('token refresh on 429 does not mark needs relink', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-auth-429-'));
  const credentials = createAutodartsCredentials({
    ROOT: root,
    autodartsCredentialsPath: path.join(root, 'creds.json'),
  });
  credentials.save({
    refreshToken: 'refresh-token',
    userId: 'u1',
    userName: 'player',
  });
  const rateLimit = createAutodartsRateLimit();
  const api = {
    refreshWithAutodarts: async () => ({
      ok: false,
      status: 429,
      json: { message: 'too many requests, try again later' },
      text: '',
      rateLimited: true,
    }),
  };
  const auth = createAutodartsAuth({ credentials, api, rateLimit });
  await assert.rejects(() => auth.refreshAccessToken(), /too many requests/i);
  const stored = credentials.load();
  assert.equal(stored.needsRelink, false);
});
