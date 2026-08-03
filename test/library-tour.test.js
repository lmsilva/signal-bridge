const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const {
  createLibraryTourSettings,
  clampSecondsPerGame,
  normalizeSort,
} = require('../src/library-tour-settings');
const { buildGameLibraryTourPayload } = require('../src/udp-payload');
const { fetchOwnedGames } = require('../src/steam-api');
const { createSteamLibraryTour } = require('../src/steam-library-tour');
const { createSteamLibraryCache } = require('../src/steam-library-cache');
const { createLibraryTourSessions } = require('../src/library-tour-sessions');
const { COMMANDS } = require('../src/command-registry');

describe('library tour settings', () => {
  it('clamps seconds per game between 5 and 300', () => {
    assert.equal(clampSecondsPerGame(4), 5);
    assert.equal(clampSecondsPerGame(60), 60);
    assert.equal(clampSecondsPerGame(999), 300);
    assert.equal(clampSecondsPerGame('nope'), 60);
  });

  it('persists per-platform sort and secondsPerGame', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'library-tour-'));
    const settings = createLibraryTourSettings({
      ROOT: root,
      libraryTourSettingsPath: path.join(root, 'data/library-tour-settings.json'),
    });
    const steam = settings.update({ platform: 'steam', secondsPerGame: 45, sort: 'oldest' });
    assert.equal(steam.ok, true);
    assert.equal(settings.getFor('steam').secondsPerGame, 45);
    assert.equal(settings.getFor('steam').sort, 'oldest');
    // PSN stays at defaults until touched.
    assert.equal(settings.getFor('psn').secondsPerGame, 60);
    assert.equal(settings.getFor('psn').sort, 'recent');

    const psn = settings.update({ platform: 'psn', sort: 'random' });
    assert.equal(psn.ok, true);
    assert.equal(settings.getFor('psn').sort, 'random');
    assert.equal(settings.getFor('steam').sort, 'oldest');

    assert.equal(settings.update({ sort: 'recent' }).ok, false);
    assert.equal(normalizeSort('random'), 'random');
    assert.equal(normalizeSort('recent'), 'recent');
    // Legacy name/playtime map onto Newest first.
    assert.equal(normalizeSort('name'), 'recent');
    assert.equal(normalizeSort('playtime'), 'recent');
  });

  it('migrates legacy shared settings onto both platforms', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'library-tour-legacy-'));
    const file = path.join(root, 'data/library-tour-settings.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ secondsPerGame: 90, sort: 'random' }), 'utf8');
    const settings = createLibraryTourSettings({
      ROOT: root,
      libraryTourSettingsPath: file,
    });
    assert.equal(settings.getFor('steam').secondsPerGame, 90);
    assert.equal(settings.getFor('steam').sort, 'random');
    assert.equal(settings.getFor('psn').secondsPerGame, 90);
    assert.equal(settings.getFor('psn').sort, 'random');
  });
});

describe('library tour sortGames', () => {
  const { sortGames, resolveCardBaseUrl } = require('../src/steam-library-tour');

  it('orders by newest / oldest lastPlayedAt', () => {
    const games = [
      { id: '1', name: 'Old', lastPlayedAt: 1000 },
      { id: '2', name: 'New', lastPlayedAt: 3000 },
      { id: '3', name: 'Mid', lastPlayedAt: 2000 },
      { id: '4', name: 'Never', lastPlayedAt: null },
    ];
    assert.deepEqual(
      sortGames(games, 'recent').map((game) => game.id),
      ['2', '3', '1', '4'],
    );
    assert.deepEqual(
      sortGames(games, 'oldest').map((game) => game.id),
      ['1', '3', '2', '4'],
    );
  });

  it('prefers GUEST_PHOTOBOOTH_URL origin for cardBaseUrl', () => {
    const previous = process.env.GUEST_PHOTOBOOTH_URL;
    process.env.GUEST_PHOTOBOOTH_URL = 'https://signal.example.com/guest/';
    try {
      assert.equal(
        resolveCardBaseUrl({ proxyOwnIp: '10.0.0.5', webServer: { port: 47810 } }),
        'https://signal.example.com',
      );
    } finally {
      if (previous == null) {
        delete process.env.GUEST_PHOTOBOOTH_URL;
      } else {
        process.env.GUEST_PHOTOBOOTH_URL = previous;
      }
    }
  });
});

describe('buildGameLibraryTourPayload', () => {
  it('builds a tiny session start payload with seed only', () => {
    const payload = buildGameLibraryTourPayload({
      platform: 'steam',
      secondsPerGame: 90,
      tourId: 'abc123',
      count: 704,
      seedGames: [{
        id: '570',
        name: 'Dota 2',
        playtimeLabel: '12 hrs',
        posterCandidates: ['https://example.com/a.jpg', 'https://example.com/b.jpg'],
      }],
      cardBaseUrl: 'https://bridge.local:47810/',
    });
    assert.equal(payload.type, 'game.library-tour');
    assert.equal(payload.displaySeconds, 0);
    assert.equal(payload.persistent, true);
    assert.equal(payload.gameTour.platform, 'steam');
    assert.equal(payload.gameTour.secondsPerGame, 90);
    assert.equal(payload.gameTour.loop, true);
    assert.equal(payload.gameTour.tourId, 'abc123');
    assert.equal(payload.gameTour.count, 704);
    assert.equal(payload.gameTour.playlistPath, '/api/library-tour/playlist/abc123');
    assert.equal(payload.gameTour.cardBaseUrl, 'https://bridge.local:47810');
    assert.equal(payload.gameTour.games.length, 1);
    assert.equal(payload.gameTour.games[0].name, 'Dota 2');
    assert.equal(payload.gameTour.games[0].imageUrl, 'https://example.com/a.jpg');
    assert.equal(payload.gameTour.games[0].posterCandidates, undefined);
    // Packet must stay small enough for UDP even at library scale.
    assert.ok(JSON.stringify(payload).length < 2500);
  });

  it('builds a one-pass scheduled tour with finite displaySeconds', () => {
    const payload = buildGameLibraryTourPayload({
      platform: 'steam',
      secondsPerGame: 30,
      loop: false,
      tourId: 'sched1',
      count: 2,
      seedGames: [{ id: '1', name: 'A' }],
    });
    assert.equal(payload.gameTour.loop, false);
    assert.equal(payload.persistent, false);
    assert.equal(payload.displaySeconds, 60);
  });

  it('still supports tiny inline lists for smoke tests', () => {
    const payload = buildGameLibraryTourPayload({
      platform: 'psn',
      secondsPerGame: 2,
      games: [{ id: 'CUSA12345_00', name: 'Game' }],
    });
    assert.equal(payload.gameTour.secondsPerGame, 5);
    assert.equal(payload.gameTour.games.length, 1);
    assert.equal(payload.gameTour.tourId, null);
  });
});

describe('library tour sessions', () => {
  it('stores and returns a playlist by tourId', () => {
    const sessions = createLibraryTourSessions();
    const session = sessions.create({
      platform: 'steam',
      secondsPerGame: 60,
      loop: true,
      games: [
        { id: '1', name: 'A' },
        { id: '2', name: 'B' },
      ],
    });
    assert.ok(session.tourId);
    assert.equal(sessions.get(session.tourId).games.length, 2);
  });
});

describe('steam library cache', () => {
  it('round-trips owned games to disk', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'steam-lib-cache-'));
    const cache = createSteamLibraryCache({
      ROOT: root,
      steamLibraryCachePath: path.join(root, 'data/steam-library-cache.json'),
    });
    cache.set('76561198000000000', [
      { appId: 570, name: 'Dota 2', playtimeForeverMin: 10, lastPlayedAt: null },
    ]);
    const hit = cache.get('76561198000000000');
    assert.equal(hit.games.length, 1);
    assert.equal(hit.games[0].name, 'Dota 2');
    assert.equal(cache.isFresh(hit), true);
  });
});

describe('fetchOwnedGames', () => {
  it('maps all owned games without rtime filter', async () => {
    const calls = [];
    const api = {
      async fetchOwnedGames(apiKey, steamId) {
        calls.push({ apiKey, steamId });
        return [
          {
            appId: 570,
            name: 'Dota 2',
            playtimeForeverMin: 100,
            lastPlayedAt: null,
          },
          {
            appId: 730,
            name: 'CS2',
            playtimeForeverMin: 0,
            lastPlayedAt: 1_700_000_000_000,
          },
        ];
      },
    };
    const tour = createSteamLibraryTour({
      config: { steam: { apiKey: 'k', steamId: '1' } },
      log: null,
      sendUdpPayload: () => {},
      steamApi: api,
    });
    const loaded = await tour.loadGames({ preferCache: false });
    assert.equal(loaded.ok, true);
    assert.equal(loaded.games.length, 2);
    assert.ok(loaded.games.some((game) => game.appId === 570 && game.lastPlayedAt == null));
    assert.equal(calls.length, 1);
    assert.equal(typeof fetchOwnedGames, 'function');
  });
});

describe('steam library tour push', () => {
  it('returns 400-equivalent result when library is empty', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'steam-lib-empty-'));
    const tour = createSteamLibraryTour({
      config: {
        steam: { apiKey: 'k', steamId: '1' },
        steamLibraryCachePath: path.join(root, 'cache.json'),
      },
      log: null,
      sendUdpPayload: () => {},
      steamApi: {
        async fetchOwnedGames() {
          return [];
        },
      },
    });
    const result = await tour.pushTour({});
    assert.equal(result.ok, false);
    assert.match(result.error || '', /empty/i);
  });

  it('pushes a session start (not 700 games on UDP) and serves playlist', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'steam-lib-push-'));
    const sessions = createLibraryTourSessions();
    const owned = Array.from({ length: 120 }, (_, index) => ({
      appId: 1000 + index,
      name: `Game ${index}`,
      playtimeForeverMin: index,
      lastPlayedAt: null,
    }));
    const sent = [];
    let fetchCalls = 0;
    const tour = createSteamLibraryTour({
      config: {
        steam: { apiKey: 'k', steamId: '1' },
        proxyOwnIp: '10.0.0.5',
        webServer: { port: 47810, https: false },
        steamLibraryCachePath: path.join(root, 'cache.json'),
      },
      log: null,
      sendUdpPayload: (payload, options) => sent.push({ payload, options }),
      sessions,
      steamApi: {
        async fetchOwnedGames() {
          fetchCalls += 1;
          return owned;
        },
      },
    });
    const result = await tour.pushTour({
      secondsPerGame: 45,
      loop: false,
      send: (payload, options) => sent.push({ payload, options }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.count, 120);
    assert.equal(result.loop, false);
    assert.ok(result.tourId);
    assert.equal(sent.length, 1);
    const wire = sent[0].payload.gameTour;
    assert.equal(wire.tourId, result.tourId);
    assert.equal(wire.count, 120);
    assert.equal(wire.games.length, 1, 'UDP carries seed only');
    assert.ok(JSON.stringify(sent[0].payload).length < 2500);
    assert.equal(sent[0].options.holdSeconds, 120 * 45);

    const playlist = tour.getPlaylist(result.tourId);
    assert.equal(playlist.games.length, 120);
    assert.equal(playlist.games[0].name, 'Game 0');

    // Second push should hit the warm cache (no second GetOwnedGames).
    await tour.pushTour({
      secondsPerGame: 30,
      send: (payload, options) => sent.push({ payload, options }),
    });
    assert.equal(fetchCalls, 1);
    assert.equal(sent[1].payload.gameTour.games.length, 1);
  });

  it('enrichCard returns a library-tour steam object', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'steam-lib-enrich-'));
    const tour = createSteamLibraryTour({
      config: {
        steam: { apiKey: 'k', steamId: '1' },
        steamLibraryCachePath: path.join(root, 'cache.json'),
      },
      log: null,
      sendUdpPayload: () => {},
      steamApi: {
        async fetchOwnedGames() { return []; },
        async fetchAppDetails(appId) {
          return {
            appId: Number(appId),
            name: 'Dota 2',
            shortDescription: 'A MOBA',
            developers: ['Valve'],
            publishers: ['Valve'],
            releaseYear: 2013,
            tags: ['MOBA', 'Strategy'],
            posterCandidates: ['https://example.com/p.jpg'],
            headerImage: 'https://example.com/h.jpg',
            screenshots: ['https://example.com/s.jpg'],
          };
        },
        async fetchOwnedGamePlaytime() {
          return { playtimeForeverMin: 120, lastPlayedAt: 1_700_000_000_000 };
        },
        async fetchAchievementProgress() {
          return { earned: 1, total: 10, available: true };
        },
        async fetchCurrentPlayers() { return 100; },
        formatPlaytimeHours: (m) => `${m}m`,
      },
    });
    const result = await tour.enrichCard('570');
    assert.equal(result.ok, true);
    assert.equal(result.platform, 'steam');
    assert.equal(result.steam.mode, 'library-tour');
    assert.equal(result.steam.name, 'Dota 2');
    assert.equal(result.steam.shortDescription, 'A MOBA');
    assert.deepEqual(result.steam.tags.slice(0, 2), ['MOBA', 'Strategy']);
  });

  it('keeps a 700+ game start packet well under the UDP MTU budget', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'steam-lib-big-'));
    const owned = Array.from({ length: 704 }, (_, index) => ({
      appId: 2000 + index,
      name: `Library Title ${index}`,
      playtimeForeverMin: index,
      lastPlayedAt: null,
    }));
    const sent = [];
    const tour = createSteamLibraryTour({
      config: {
        steam: { apiKey: 'k', steamId: '1' },
        proxyOwnIp: '10.0.0.5',
        webServer: { port: 47810, https: false },
        steamLibraryCachePath: path.join(root, 'cache.json'),
      },
      log: null,
      sendUdpPayload: (payload) => sent.push(payload),
      steamApi: {
        async fetchOwnedGames() { return owned; },
      },
    });
    const result = await tour.pushTour({ secondsPerGame: 60, loop: true });
    assert.equal(result.ok, true);
    assert.equal(result.count, 704);
    assert.equal(sent[0].gameTour.games.length, 1);
    assert.ok(JSON.stringify(sent[0]).length < 2500);
    assert.equal(tour.getPlaylist(result.tourId).games.length, 704);
    // Registry still lists the tour as a scheduled command.
    assert.equal(COMMANDS.some((command) => (
      command.id === 'steam.library-tour' && command.schedulable
    )), true);
  });
});

describe('psn library tour', () => {
  const { createPsnLibraryTour, fetchPurchasedTitles } = require('../src/psn-library-tour');
  const { createPsnLibraryCache } = require('../src/psn-library-cache');

  it('maps getPurchasedGames GraphQL shape', async () => {
    const titles = await fetchPurchasedTitles({ accessToken: 't' }, 'me', {
      api: {
        async getPurchasedGames(auth, options) {
          assert.equal(auth.accessToken, 't');
          assert.equal(options.size, 50);
          assert.equal(options.start, 0);
          return {
            data: {
              purchasedTitlesRetrieve: {
                games: [
                  {
                    titleId: 'PPSA1_00',
                    name: 'Astro',
                    image: { url: 'https://image.api.playstation.com/a.png' },
                  },
                ],
              },
            },
          };
        },
      },
    });
    assert.equal(titles.length, 1);
    assert.equal(titles[0].titleId, 'PPSA1_00');
    assert.equal(titles[0].imageUrl, 'https://image.api.playstation.com/a.png');
  });

  it('does not let example.com cache art overwrite PlayStation CDN URLs', () => {
    const cache = createPsnLibraryCache({ ROOT: fs.mkdtempSync(path.join(os.tmpdir(), 'psn-merge-')) });
    const merged = cache.mergeLists(
      [{ titleId: 'PPSA1_00', name: 'Astro', imageUrl: 'https://example.com/fake.png' }],
      [{
        titleId: 'PPSA1_00',
        name: 'Astro',
        imageUrl: 'https://image.api.playstation.com/real.png',
        lastPlayedAt: 1_700_000_000_000,
      }],
    );
    assert.equal(merged[0].imageUrl, 'https://image.api.playstation.com/real.png');
  });

  it('pushes a PSN session tour from disk cache without network', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'psn-lib-tour-'));
    const sessionPath = path.join(root, 'psn-session.json');
    fs.writeFileSync(sessionPath, JSON.stringify({
      accessToken: 'access',
      refreshToken: 'refresh',
      accountId: 'me',
      onlineId: 'tester',
    }));
    const cache = createPsnLibraryCache({
      ROOT: root,
      psnLibraryCachePath: path.join(root, 'psn-library-cache.json'),
    });
    cache.setLibrary([
      {
        titleId: 'PPSA1_00',
        name: 'Astro',
        imageUrl: 'https://image.api.playstation.com/a.png',
        lastPlayedAt: 1_700_000_000_000,
      },
      {
        titleId: 'PPSA2_00',
        name: 'Precinct',
        imageUrl: 'https://image.api.playstation.com/b.png',
        lastPlayedAt: 1_600_000_000_000,
      },
    ]);
    const sent = [];
    const tour = createPsnLibraryTour({
      config: {
        psn: { sessionPath },
        proxyOwnIp: '10.0.0.5',
        webServer: { port: 47810, https: false },
        psnLibraryCachePath: path.join(root, 'psn-library-cache.json'),
      },
      log: null,
      cache,
      sendUdpPayload: (payload) => sent.push(payload),
      apiHelpers: {
        // Background refresh may fire after disk warm — must not break the push.
        ensurePsnAuth: async () => {
          throw new Error('background refresh auth failure is fine');
        },
        fetchPlayedTitles: async () => [],
        fetchPurchasedTitles: async () => [],
        enrichPsnTitle: async () => null,
      },
    });
    const result = await tour.pushTour({
      secondsPerGame: 30,
      send: (payload) => sent.push(payload),
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.count, 2);
    assert.equal(result.fromCache, true);
    assert.equal(sent[0].gameTour.platform, 'psn');
    assert.equal(sent[0].gameTour.games.length, 1);
    assert.ok(sent[0].gameTour.games[0].imageUrl.includes('playstation.com'));
    // Newest first — Astro has the newer lastPlayedAt.
    assert.equal(sent[0].gameTour.games[0].name, 'Astro');
  });
});
