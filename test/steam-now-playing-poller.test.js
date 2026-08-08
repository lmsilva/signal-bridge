const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const steamApi = require('../src/steam-api');
const { resolveSteamConfig } = require('../src/steam-config');

const ORIGINALS = {
  fetchPlayerSummary: steamApi.fetchPlayerSummary,
  fetchMostRecentlyPlayedOwnedGames: steamApi.fetchMostRecentlyPlayedOwnedGames,
  fetchMostRecentlyPlayedOwnedGame: steamApi.fetchMostRecentlyPlayedOwnedGame,
  fetchRecentlyPlayedGames: steamApi.fetchRecentlyPlayedGames,
  fetchAppDetails: steamApi.fetchAppDetails,
  fetchOwnedGamePlaytime: steamApi.fetchOwnedGamePlaytime,
  fetchAchievementProgress: steamApi.fetchAchievementProgress,
  fetchCurrentPlayers: steamApi.fetchCurrentPlayers,
};

const STEAM_NP_PATH = require.resolve('../src/steam-now-playing');

function restoreSteamApi() {
  Object.assign(steamApi, ORIGINALS);
  delete require.cache[STEAM_NP_PATH];
  require('../src/steam-now-playing');
}

function withSteamApiMocks(mocks, run) {
  Object.assign(steamApi, mocks);
  delete require.cache[STEAM_NP_PATH];
  const { createSteamNowPlaying } = require('../src/steam-now-playing');
  return Promise.resolve()
    .then(() => run(createSteamNowPlaying))
    .finally(restoreSteamApi);
}

function makeConfig(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'steam-poller-'));
  const { steam: steamOverrides, ...restOverrides } = overrides;
  const steam = resolveSteamConfig({ ROOT: root }, {
    steam: {
      apiKey: 'test-key-xxxxxxxxxxxx',
      steamId: '76561198000000000',
      enabled: true,
      requirePresence: false,
      allowedHosts: ['MOVIETHEATERPC'],
      restoreAfterInterruptSeconds: 30,
      inferFromRecentSeconds: 180,
      recentPlayStagnantSeconds: 150,
      ...steamOverrides,
    },
  });
  return {
    ROOT: root,
    steam,
    udpBroadcast: { defaultDisplaySeconds: 120 },
    ...restOverrides,
  };
}

function enrichStubs(appId = 570) {
  return {
    fetchAppDetails: async () => ({
      appId,
      name: `App ${appId}`,
      shortDescription: 'A game',
      tags: ['Multi-player'],
      posterCandidates: ['https://example.com/p.jpg'],
      screenshots: ['https://example.com/s.jpg'],
    }),
    fetchOwnedGamePlaytime: async () => ({
      playtimeForeverMin: 100,
      playtime2WeeksMin: 10,
      lastPlayedAt: Date.now() - 60_000,
    }),
    fetchAchievementProgress: async () => ({ earned: 1, total: 10, available: true }),
    fetchCurrentPlayers: async () => 1234,
  };
}

test('tick opens session from Steam gameid and pushes overlay', async () => {
  const sent = [];
  let now = 1_700_000_000_000;
  await withSteamApiMocks({
    fetchPlayerSummary: async () => ({
      gameId: 570,
      personaState: 1,
      personaName: 'Tester',
    }),
    fetchMostRecentlyPlayedOwnedGames: async () => [],
    ...enrichStubs(570),
  }, async (createSteamNowPlaying) => {
    const controller = createSteamNowPlaying({
      config: makeConfig(),
      log: { info() {}, warn() {} },
      sendUdpPayload: (payload) => sent.push(payload),
      now: () => now,
    });
    controller._setBaselineReady(true);
    await controller.tick();
    assert.equal(controller.statusSnapshot().status, 'playing');
    assert.equal(controller._getSession()?.appId, 570);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'steam.now-playing');
    assert.equal(sent[0].steam.appId, 570);
    controller.stop();
  });
});

test('tick keeps session through brief gameid dropout via OwnedGames activity', async () => {
  const sent = [];
  let now = 1_700_000_000_000;
  const game = {
    appId: 965680,
    lastPlayedAt: now - 30_000,
    playtimeForeverMin: 100,
  };
  await withSteamApiMocks({
    fetchPlayerSummary: async () => ({
      gameId: null,
      personaState: 1,
      personaName: 'Tester',
    }),
    fetchMostRecentlyPlayedOwnedGames: async () => [game],
    ...enrichStubs(965680),
  }, async (createSteamNowPlaying) => {
    const controller = createSteamNowPlaying({
      config: makeConfig(),
      log: { info() {}, warn() {} },
      sendUdpPayload: (payload) => sent.push(payload),
      now: () => now,
    });
    controller._setBaselineReady(true);
    controller._setSession({
      appId: 965680,
      host: 'any',
      startedAt: now - 60_000,
      suppressed: false,
      suppressedAt: null,
      suppressReason: null,
      pushed: true,
      lastPushAt: now - 10_000,
      details: { appId: 965680, name: 'App 965680' },
      lastPlaytime: 100,
      lastRtime: now - 30_000,
      lastActivityAt: now - 20_000,
      recentLed: true,
    });
    await controller.tick();
    assert.ok(controller._getSession());
    assert.equal(controller._getSession().appId, 965680);
    assert.equal(sent.some((p) => p.type === 'steam.now-playing.close'), false);
    controller.stop();
  });
});

test('tick opens OwnedGames launch even when stale presence claims another app', async () => {
  const sent = [];
  let now = 1_700_000_000_000;
  await withSteamApiMocks({
    fetchPlayerSummary: async () => ({
      gameId: null,
      personaState: 1,
      personaName: 'Tester',
    }),
    fetchMostRecentlyPlayedOwnedGames: async () => [{
      appId: 2524850,
      lastPlayedAt: now - 20_000,
      playtimeForeverMin: 12,
    }],
    ...enrichStubs(2524850),
  }, async (createSteamNowPlaying) => {
    const controller = createSteamNowPlaying({
      config: makeConfig(),
      log: { info() {}, warn() {} },
      sendUdpPayload: (payload) => sent.push(payload),
      now: () => now,
    });
    controller._getBaseline().set(2524850, {
      lastPlayedAt: now - 600_000,
      playtimeForeverMin: 11,
    });
    // Leftover presence for a different title (stuck RunningAppID).
    controller.recordPresence({ hostname: 'MOVIETHEATERPC', appId: 965680 });
    controller._setBaselineReady(true);
    await controller.tick();
    assert.equal(controller._getSession()?.appId, 2524850);
    assert.equal(controller._getSession()?.recentLed, true);
    assert.equal(sent[0]?.type, 'steam.now-playing');
    assert.equal(sent[0]?.steam?.appId, 2524850);
    controller.stop();
  });
});

test('tick hands off from stagnant session to a different OwnedGames launch', async () => {
  const sent = [];
  let now = 1_700_000_000_000;
  const quitStamp = now - 10_000;
  await withSteamApiMocks({
    fetchPlayerSummary: async () => ({
      gameId: null,
      personaState: 1,
      personaName: 'Tester',
    }),
    fetchMostRecentlyPlayedOwnedGames: async () => [
      {
        appId: 2524850,
        lastPlayedAt: now - 15_000,
        playtimeForeverMin: 5,
      },
      {
        appId: 965680,
        lastPlayedAt: quitStamp,
        playtimeForeverMin: 100,
      },
    ],
    ...enrichStubs(2524850),
  }, async (createSteamNowPlaying) => {
    const controller = createSteamNowPlaying({
      config: makeConfig(),
      log: { info() {}, warn() {} },
      sendUdpPayload: (payload) => sent.push(payload),
      now: () => now,
    });
    controller._getBaseline().set(965680, {
      lastPlayedAt: quitStamp,
      playtimeForeverMin: 100,
    });
    controller._getBaseline().set(2524850, {
      lastPlayedAt: now - 600_000,
      playtimeForeverMin: 4,
    });
    controller._setBaselineReady(true);
    controller._setSession({
      appId: 965680,
      host: 'any',
      startedAt: now - 300_000,
      suppressed: false,
      suppressedAt: null,
      suppressReason: null,
      pushed: true,
      lastPushAt: now - 200_000,
      details: { appId: 965680, name: 'App 965680' },
      lastPlaytime: 100,
      lastRtime: quitStamp,
      lastActivityAt: now - 200_000,
      recentLed: true,
    });
    await controller.tick();
    assert.equal(controller._getSession()?.appId, 2524850);
    assert.equal(sent.some((p) => p.type === 'steam.now-playing.close'), true);
    assert.equal(sent.some((p) => p.type === 'steam.now-playing' && p.steam?.appId === 2524850), true);
    controller.stop();
  });
});

test('tick ends stagnant session even when local presence still claims the app', async () => {
  // Regression: stuck RunningAppID / presence used to skip OwnedGames quit
  // detection and refresh lastActivityAt every poll, so STEAM_RECENT_PLAY_STAGNANT_SEC
  // never fired.
  const sent = [];
  let now = 1_700_000_000_000;
  const quitStamp = now - 10_000;
  const game = {
    appId: 965680,
    lastPlayedAt: quitStamp,
    playtimeForeverMin: 100,
  };
  await withSteamApiMocks({
    fetchPlayerSummary: async () => ({
      gameId: null,
      personaState: 1,
      personaName: 'Tester',
    }),
    fetchMostRecentlyPlayedOwnedGames: async () => [game],
    ...enrichStubs(965680),
  }, async (createSteamNowPlaying) => {
    const controller = createSteamNowPlaying({
      config: makeConfig(),
      log: { info() {}, warn() {} },
      sendUdpPayload: (payload) => sent.push(payload),
      now: () => now,
    });
    controller._setBaselineReady(true);
    controller.recordPresence({ hostname: 'MOVIETHEATERPC', appId: 965680 });
    controller._setSession({
      appId: 965680,
      host: 'MOVIETHEATERPC',
      startedAt: now - 300_000,
      suppressed: false,
      suppressedAt: null,
      suppressReason: null,
      pushed: true,
      lastPushAt: now - 200_000,
      details: { appId: 965680, name: 'App 965680' },
      lastPlaytime: 100,
      lastRtime: quitStamp,
      lastActivityAt: now - 200_000, // beyond stagnantSeconds (150s)
      recentLed: false,
    });
    await controller.tick();
    assert.equal(controller._getSession(), null);
    assert.equal(sent.some((p) => p.type === 'steam.now-playing.close'), true);
    assert.equal(controller.presence.listFresh().length, 0);
    controller.stop();
  });
});

test('tick ends stagnant recent-led session and absorbs quit stamp into baseline', async () => {
  const sent = [];
  let now = 1_700_000_000_000;
  const quitStamp = now - 10_000;
  const game = {
    appId: 965680,
    lastPlayedAt: quitStamp,
    playtimeForeverMin: 100,
  };
  await withSteamApiMocks({
    fetchPlayerSummary: async () => ({
      gameId: null,
      personaState: 1,
      personaName: 'Tester',
    }),
    fetchMostRecentlyPlayedOwnedGames: async () => [game],
    ...enrichStubs(965680),
  }, async (createSteamNowPlaying) => {
    const controller = createSteamNowPlaying({
      config: makeConfig(),
      log: { info() {}, warn() {} },
      sendUdpPayload: (payload) => sent.push(payload),
      now: () => now,
    });
    controller._setBaselineReady(true);
    controller._setSession({
      appId: 965680,
      host: 'any',
      startedAt: now - 300_000,
      suppressed: false,
      suppressedAt: null,
      suppressReason: null,
      pushed: true,
      lastPushAt: now - 200_000,
      details: { appId: 965680, name: 'App 965680' },
      lastPlaytime: 100,
      lastRtime: quitStamp,
      lastActivityAt: now - 200_000, // beyond stagnantSeconds (150s)
      recentLed: true,
    });
    await controller.tick();
    assert.equal(controller._getSession(), null);
    assert.equal(sent.some((p) => p.type === 'steam.now-playing.close'), true);
    assert.equal(controller.statusSnapshot().status, 'idle');

    // Same quit stamp must not reopen as a launch on the next poll.
    await controller.tick();
    assert.equal(controller._getSession(), null);
    assert.equal(controller.statusSnapshot().status, 'idle');
    controller.stop();
  });
});

test('tick infers launch from OwnedGames when gameid empty and baseline advanced', async () => {
  const sent = [];
  let now = 1_700_000_000_000;
  await withSteamApiMocks({
    fetchPlayerSummary: async () => ({
      gameId: null,
      personaState: 1,
      personaName: 'Tester',
    }),
    fetchMostRecentlyPlayedOwnedGames: async () => [{
      appId: 440,
      lastPlayedAt: now - 20_000,
      playtimeForeverMin: 50,
    }],
    ...enrichStubs(440),
  }, async (createSteamNowPlaying) => {
    const controller = createSteamNowPlaying({
      config: makeConfig(),
      log: { info() {}, warn() {} },
      sendUdpPayload: (payload) => sent.push(payload),
      now: () => now,
    });
    // Baseline has older stamp — new rtime is a launch.
    controller._getBaseline().set(440, {
      lastPlayedAt: now - 600_000,
      playtimeForeverMin: 49,
    });
    controller._setBaselineReady(true);
    await controller.tick();
    assert.equal(controller._getSession()?.appId, 440);
    assert.equal(controller._getSession()?.recentLed, true);
    assert.equal(sent[0]?.type, 'steam.now-playing');
    assert.equal(controller.statusSnapshot().status, 'playing_recent');
    controller.stop();
  });
});

test('tick with STEAM_REQUIRE_PRESENCE=1 refuses non-allowlisted host', async () => {
  const sent = [];
  let now = 1_700_000_000_000;
  await withSteamApiMocks({
    fetchPlayerSummary: async () => ({
      gameId: 570,
      personaState: 1,
      personaName: 'Tester',
    }),
    fetchMostRecentlyPlayedOwnedGames: async () => [],
    ...enrichStubs(570),
  }, async (createSteamNowPlaying) => {
    const controller = createSteamNowPlaying({
      config: makeConfig({ steam: { requirePresence: true } }),
      log: { info() {}, warn() {} },
      sendUdpPayload: (payload) => sent.push(payload),
      now: () => now,
    });
    controller._setBaselineReady(true);
    await controller.tick();
    assert.equal(controller.statusSnapshot().status, 'playing_elsewhere');
    assert.equal(controller._getSession(), null);
    assert.equal(sent.length, 0);
    controller.stop();
  });
});

test('interrupt restore clears suppress and re-pushes while still in-game', async () => {
  const sent = [];
  let now = 1_700_000_000_000;
  await withSteamApiMocks({
    fetchPlayerSummary: async () => ({
      gameId: 570,
      personaState: 1,
      personaName: 'Tester',
    }),
    fetchMostRecentlyPlayedOwnedGames: async () => [],
    ...enrichStubs(570),
  }, async (createSteamNowPlaying) => {
    const controller = createSteamNowPlaying({
      config: makeConfig({ steam: { restoreAfterInterruptSeconds: 30 } }),
      log: { info() {}, warn() {} },
      sendUdpPayload: (payload) => sent.push(payload),
      now: () => now,
    });
    controller._setBaselineReady(true);
    controller._setSession({
      appId: 570,
      host: 'any',
      startedAt: now - 60_000,
      suppressed: true,
      suppressedAt: now - 5_000,
      suppressReason: 'weather.query',
      pushed: true,
      lastPushAt: now - 50_000,
      details: { appId: 570, name: 'Dota 2', posterCandidates: ['https://example.com/p.jpg'] },
      lastPlaytime: 100,
      lastRtime: now - 30_000,
      lastActivityAt: now,
      recentLed: false,
    });

    await controller.tick();
    assert.equal(controller.statusSnapshot().status, 'suppressed');
    assert.equal(sent.length, 0);

    now += 40_000;
    await controller.tick();
    assert.equal(controller._getSession()?.suppressed, false);
    assert.ok(sent.some((p) => p.type === 'steam.now-playing'));
    controller.stop();
  });
});

test('recordPresence schedules immediate tick via presence allowlist', async () => {
  const sent = [];
  let now = 1_700_000_000_000;
  let tickCalls = 0;
  await withSteamApiMocks({
    fetchPlayerSummary: async () => {
      tickCalls += 1;
      return { gameId: 570, personaState: 1, personaName: 'Tester' };
    },
    fetchMostRecentlyPlayedOwnedGames: async () => [],
    ...enrichStubs(570),
  }, async (createSteamNowPlaying) => {
    const controller = createSteamNowPlaying({
      config: makeConfig({ steam: { requirePresence: true } }),
      log: { info() {}, warn() {} },
      sendUdpPayload: (payload) => sent.push(payload),
      now: () => now,
    });
    controller._setBaselineReady(true);
    const result = controller.recordPresence({ hostname: 'MOVIETHEATERPC', appId: 570 });
    assert.equal(result.ok, true);
    // Immediate tick is scheduled at +200ms.
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.ok(tickCalls >= 1, 'presence should schedule an immediate tick');
    controller.stop();
  });
});

test('pushManualPreview uses OwnedGames lastPlayedAt (not push time) when idle', async () => {
  const sent = [];
  const lastPlayedAt = Date.UTC(2026, 6, 20, 18, 30, 0);
  await withSteamApiMocks({
    fetchPlayerSummary: async () => ({
      gameId: null,
      personaState: 1,
      personaName: 'Tester',
    }),
    fetchMostRecentlyPlayedOwnedGame: async () => ({
      appId: 570,
      name: 'Dota 2',
      lastPlayedAt,
      playtimeForeverMin: 2400,
    }),
    fetchRecentlyPlayedGames: async () => [],
    ...enrichStubs(570),
    fetchOwnedGamePlaytime: async () => ({
      playtimeForeverMin: 2400,
      lastPlayedAt,
    }),
  }, async (createSteamNowPlaying) => {
    const controller = createSteamNowPlaying({
      config: makeConfig(),
      log: { info() {}, warn() {} },
      sendUdpPayload: (payload) => sent.push(payload),
    });
    const result = await controller.pushManualPreview({ device: 'Signal' });
    assert.equal(result.ok, true);
    assert.equal(result.mode, 'last-played');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].persistent, false);
    assert.equal(sent[0].steam.mode, 'last-played');
    assert.equal(sent[0].steam.lastPlayedAt, new Date(lastPlayedAt).toISOString());
    controller.stop();
  });
});
