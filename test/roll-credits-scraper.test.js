const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRollCreditsStore } = require('../src/roll-credits-store');
const { createRollCreditsScraper } = require('../src/roll-credits-scraper');

function setup() {
  const store = createRollCreditsStore({
    rollCreditsPath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'roll-credits-scraper-')), 'store.json'),
  });
  let fetched = {
    name: 'Scraped Game',
    meta: { description: 'New description', publisher: 'New publisher', difficulty: 'Brutal' },
    coverUrl: 'cover.jpg',
    screenshotUrls: ['shot.jpg'],
    youtubeUrl: 'https://youtube.test/watch?v=1',
    provider: { igdbId: 3 },
  };
  let searchRows = [];
  const fetchCalls = [];
  const providers = {
    search: async () => searchRows,
    fetchGame: async (candidate, options) => {
      fetchCalls.push({ candidate, options });
      return fetched;
    },
  };
  const settings = {
    get: () => ({
      scrape: { maxScreenshots: 6, downloadVideo: true },
      youtube: { defaultResolution: 720 },
    }),
  };
  const queued = [];
  const jobs = { enqueueDownload: (job) => queued.push(job) };
  return {
    store,
    queued,
    fetchCalls,
    setFetched: (value) => { fetched = value; },
    setSearchRows: (rows) => { searchRows = rows; },
    scraper: createRollCreditsScraper({ store, providers, settings, jobs }),
  };
}

test('candidate creation stores text synchronously and queues pending media', async () => {
  const { store, queued, scraper } = setup();
  const game = await scraper.createFromCandidate({
    candidate: { provider: 'igdb', providerId: 3, name: 'Scraped Game' },
    system: 'ps5',
    beatenAt: '2026-08-23',
  });
  assert.equal(game.meta.description, 'New description');
  assert.equal(game.meta.difficulty, undefined);
  assert.equal(game.media.length, 3);
  assert.equal(queued.length, 3);
  assert.equal(store.getGame(game.id).provider.igdbId, 3);
});

test('re-scrape scopes preserve edits and user media', async () => {
  const { store, scraper, setFetched } = setup();
  const created = store.createGame({
    title: 'Game',
    system: 'pc',
    meta: { description: 'Hand edited', publisher: 'Old', difficulty: 'Hard' },
    metaEdited: ['description'],
    provider: { igdbId: 3 },
    media: [
      { id: 'upload', kind: 'cover', source: 'upload', status: 'ready', path: 'x.jpg' },
      { id: 'old', kind: 'screenshot', source: 'scraped:igdb', status: 'ready', path: 'old.jpg' },
      { id: 'youtube', kind: 'video', source: 'youtube', status: 'ready', path: 'video.mp4' },
    ],
  });
  setFetched({
    meta: { description: 'Scraped', publisher: 'New' },
    screenshotUrls: ['new.jpg'],
    coverUrl: 'new-cover.jpg',
  });
  const result = await scraper.rescrape(created.id, {
    scopes: { metadata: true, cover: false, screenshots: true, video: false },
    mode: 'replace-scraped',
  });
  assert.equal(result.meta.description, 'Hand edited');
  assert.equal(result.meta.publisher, 'New');
  assert.equal(result.meta.difficulty, 'Hard');
  assert.ok(result.media.some((row) => row.id === 'upload'));
  assert.ok(result.media.some((row) => row.id === 'youtube'));
  assert.ok(!result.media.some((row) => row.id === 'old'));
});

test('re-scrape rematches by title and system, keeps system, accepts scope arrays', async () => {
  const { store, scraper, setFetched, setSearchRows, fetchCalls } = setup();
  const created = store.createGame({
    title: 'Rambo',
    system: 'arcade',
    meta: { description: '' },
    provider: { igdbId: 999 }, // stale NES id
  });
  setSearchRows([
    { provider: 'igdb', providerId: 111, name: 'Rambo', platforms: ['nes'] },
    { provider: 'igdb', providerId: 222, name: 'Rambo', platforms: ['arcade'] },
  ]);
  setFetched({
    name: 'Rambo',
    meta: { description: 'Arcade light gun shooter' },
    provider: { igdbId: 222 },
    coverUrl: 'arcade-cover.jpg',
  });
  const result = await scraper.rescrape(created.id, {
    scopes: ['metadata', 'cover'],
    mode: 'fill-gaps',
  });
  assert.equal(result.system, 'arcade');
  assert.equal(result.title, 'Rambo');
  assert.equal(result.provider.igdbId, 222);
  assert.equal(result.meta.description, 'Arcade light gun shooter');
  assert.equal(fetchCalls[0].candidate.providerId, 222);
  assert.equal(fetchCalls[0].options.system, 'arcade');
  assert.ok(result.media.some((row) => row.kind === 'cover'));
});

test('re-scrape uses title/system overrides from the edit form', async () => {
  const { store, scraper, setFetched, setSearchRows, fetchCalls } = setup();
  const created = store.createGame({
    title: 'Rambo',
    system: 'nes',
    provider: { igdbId: 111 },
  });
  setSearchRows([
    { provider: 'igdb', providerId: 222, name: 'Rambo', platforms: ['arcade'] },
  ]);
  setFetched({
    meta: { description: 'Arcade entry' },
    provider: { igdbId: 222 },
  });
  const result = await scraper.rescrape(created.id, {
    scopes: { metadata: true },
    mode: 'fill-gaps',
    title: 'Rambo',
    system: 'arcade',
  });
  assert.equal(result.system, 'arcade');
  assert.equal(result.provider.igdbId, 222);
  assert.equal(fetchCalls[0].options.system, 'arcade');
  assert.equal(fetchCalls[0].options.title, 'Rambo');
});
