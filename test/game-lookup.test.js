const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normaliseName,
  pickBestApp,
  lookupGameByName,
  clearGameLookupCache,
  MISS_TTL_MS,
} = require('../src/game-lookup');

test('editions and platform suffixes normalise to the same game', () => {
  assert.equal(normaliseName('The Precinct'), 'the precinct');
  assert.equal(normaliseName('Split Fiction™ PS5'), normaliseName('Split Fiction'));
  assert.equal(normaliseName('Cyberpunk 2077: Ultimate Edition'), 'cyberpunk 2077');
  assert.equal(normaliseName('  '), '');
});

test('a soundtrack or demo is never mistaken for the game', () => {
  const results = [
    { appId: 3240070, name: 'The Precinct Soundtrack' },
    { appId: 2893830, name: 'The Precinct Demo' },
    { appId: 490110, name: 'The Precinct' },
  ];
  assert.equal(pickBestApp(results, 'The Precinct').appId, 490110);
});

test('a partial match has to be a real prefix, not a coincidence', () => {
  assert.equal(pickBestApp([{ appId: 1, name: 'Split Second' }], 'Split Fiction'), null);
  // A store listing carrying an edition suffix still resolves.
  assert.equal(
    pickBestApp([{ appId: 2, name: 'Split Fiction Deluxe Edition' }], 'Split Fiction').appId,
    2,
  );
  assert.equal(pickBestApp([{ appId: 3, name: 'Ico' }], 'Icons of the Storm'), null);
});

test('a lookup returns the blurb, stills and credits', async () => {
  clearGameLookupCache();
  const steamApi = {
    searchStoreApps: async () => [
      { appId: 3240070, name: 'The Precinct Soundtrack' },
      { appId: 490110, name: 'The Precinct' },
    ],
    fetchAppDetails: async (appId) => {
      assert.equal(appId, 490110);
      return {
        name: 'The Precinct',
        shortDescription: 'Averno City, 1983.',
        screenshots: ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg'],
        developers: ['Fallen Tree Games Ltd'],
        publishers: ['Kwalee'],
        releaseYear: '2025',
      };
    },
  };

  const value = await lookupGameByName('The Precinct', { steamApi });
  assert.equal(value.shortDescription, 'Averno City, 1983.');
  assert.deepEqual(value.screenshots, ['a.jpg', 'b.jpg', 'c.jpg']);
  assert.deepEqual(value.developers, ['Fallen Tree Games Ltd']);
  assert.equal(value.releaseYear, '2025');
  assert.equal(value.source, 'steam');
});

test('a search that ranks the wrong game is rejected on its canonical name', async () => {
  clearGameLookupCache();
  const steamApi = {
    searchStoreApps: async () => [{ appId: 99, name: 'Split Fiction' }],
    fetchAppDetails: async () => ({ name: 'Totally Different Game', screenshots: [] }),
  };
  assert.equal(await lookupGameByName('Split Fiction', { steamApi }), null);
});

test('a network failure is a miss, not a throw', async () => {
  clearGameLookupCache();
  const steamApi = {
    searchStoreApps: async () => { throw new Error('offline'); },
    fetchAppDetails: async () => null,
  };
  assert.equal(await lookupGameByName('Anything', { steamApi }), null);
});

test('hits are cached, and misses are retried sooner than hits', async () => {
  clearGameLookupCache();
  let searches = 0;
  const steamApi = {
    searchStoreApps: async () => { searches += 1; return []; },
    fetchAppDetails: async () => null,
  };

  await lookupGameByName('Nowhere Game', { steamApi, now: () => 0 });
  assert.equal(searches, 1);
  await lookupGameByName('Nowhere Game', { steamApi, now: () => MISS_TTL_MS - 1 });
  assert.equal(searches, 1, 'inside the miss window it stays quiet');
  await lookupGameByName('Nowhere Game', { steamApi, now: () => MISS_TTL_MS + 1 });
  assert.equal(searches, 2);
});
