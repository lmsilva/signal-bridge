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

  it('persists sort and secondsPerGame', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'library-tour-'));
    const settings = createLibraryTourSettings({
      ROOT: root,
      libraryTourSettingsPath: path.join(root, 'data/library-tour-settings.json'),
    });
    const result = settings.update({ secondsPerGame: 45, sort: 'playtime' });
    assert.equal(result.ok, true);
    assert.equal(settings.get().secondsPerGame, 45);
    assert.equal(settings.get().sort, 'playtime');
    assert.equal(normalizeSort('random'), 'random');
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
