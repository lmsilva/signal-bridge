const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createIgdbProvider,
  createSteamProvider,
} = require('../src/roll-credits-providers');

function response(body) {
  return { ok: true, status: 200, json: async () => body };
}

test('IGDB provider maps search candidates and full metadata', async () => {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/oauth2/token')) {
      return response({ access_token: 'token', expires_in: 3600 });
    }
    if (options.body.includes('search ')) {
      return response([{
        id: 42,
        name: 'Example Game',
        first_release_date: 1609459200,
        platforms: [167, 6],
        cover: { url: '//images.igdb.com/igdb/image/upload/t_thumb/co1.jpg' },
      }]);
    }
    return response([{
      id: 42,
      name: 'Example Game',
      summary: 'A summary',
      first_release_date: 1609459200,
      involved_companies: [
        { developer: true, company: { name: 'Dev' } },
        { publisher: true, company: { name: 'Pub' } },
      ],
      genres: [{ name: 'Adventure' }],
      multiplayer_modes: [{ offlinecoopmax: 2, offlinemax: 2 }],
      cover: { url: '//images.igdb.com/igdb/image/upload/t_thumb/co1.jpg' },
      screenshots: [{ url: '//images.igdb.com/igdb/image/upload/t_thumb/sc1.jpg' }],
      videos: [{ video_id: 'abc123' }],
    }]);
  };
  const store = {
    mapIgdbPlatformToSystem: (id) => ({ 167: { id: 'ps5' }, 6: { id: 'pc' } }[id] || null),
  };
  const provider = createIgdbProvider({
    store,
    credentials: { clientId: 'id', clientSecret: 'secret' },
    fetch,
    requestSpacingMs: 0,
  });
  const candidates = await provider.search('Example', { limit: 5 });
  assert.deepEqual(candidates[0].platforms, ['ps5', 'pc']);
  assert.match(candidates[0].thumbUrl, /^https:/);

  const game = await provider.fetchGame(42, { system: 'ps5' });
  assert.equal(game.meta.publisher, 'Pub');
  assert.equal(game.meta.developer, 'Dev');
  assert.equal(game.meta.maxPlayers, 2);
  assert.equal(game.meta.coopSupported, true);
  assert.equal(game.meta.difficulty, undefined);
  assert.equal(game.youtubeUrl, 'https://www.youtube.com/watch?v=abc123');
  assert.equal(calls.filter((call) => call.url.includes('/oauth2/token')).length, 1);
});

test('Steam provider exposes cover, screenshots, and direct movies', async () => {
  const provider = createSteamProvider({
    steamApi: {
      searchStoreApps: async () => [{ appId: 7, name: 'Steam Game' }],
      fetchAppDetails: async () => ({
        appId: 7,
        name: 'Steam Game',
        shortDescription: 'Description',
        developers: ['Dev'],
        publishers: ['Pub'],
        releaseYear: '2024',
        headerImage: 'https://steam/header.jpg',
        screenshots: ['one.jpg', 'two.jpg'],
        movieMp4Urls: ['movie.mp4'],
      }),
    },
  });
  assert.equal((await provider.search('Steam Game'))[0].platforms[0], 'pc');
  const game = await provider.fetchGame(7, { system: 'pc' });
  assert.equal(game.coverUrl, 'https://steam/header.jpg');
  assert.deepEqual(game.screenshotUrls, ['one.jpg', 'two.jpg']);
  assert.deepEqual(game.movieMp4Urls, ['movie.mp4']);
});
