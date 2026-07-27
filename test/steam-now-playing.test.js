const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { resolveSteamConfig, isAllowedHost, normalizeHostname } = require('../src/steam-config');
const { createSteamPresenceStore } = require('../src/steam-presence');
const { extractSteamIdFromClaimedId } = require('../src/steam-auth');
const { stripHtml, libraryCapsuleUrls, formatPlaytimeHours } = require('../src/steam-api');
const { buildSteamNowPlayingPayload, buildSteamNowPlayingClosePayload } = require('../src/udp-payload');
const {
  createSteamNowPlaying,
  resolveEffectiveSteamAppId,
  pickRecentPlayAppId,
  isRecentBlockedByQuitSuppress,
  applyCachedArtworkUrls,
  isUsableArtworkOrigin,
} = require('../src/steam-now-playing');

test('resolveEffectiveSteamAppId prefers Steam gameid, else presence, else recent', () => {
  assert.equal(resolveEffectiveSteamAppId(570, { appId: 440 }, 2524850), 570);
  assert.equal(resolveEffectiveSteamAppId(null, { appId: 440 }, 2524850), 440);
  assert.equal(resolveEffectiveSteamAppId(0, { appId: 440 }, 2524850), 440);
  assert.equal(resolveEffectiveSteamAppId(null, null, 2524850), 2524850);
  assert.equal(resolveEffectiveSteamAppId(null, null, null), null);
});

test('isRecentBlockedByQuitSuppress blocks just-quit titles until relaunch', () => {
  const quitSuppress = { appId: 111, playtime: 10, rtime: 1_000 };
  assert.equal(isRecentBlockedByQuitSuppress({
    appId: 111,
    playtimeForeverMin: 10,
    lastPlayedAt: 1_000,
  }, quitSuppress), true);
  assert.equal(isRecentBlockedByQuitSuppress({
    appId: 222,
    playtimeForeverMin: 1,
    lastPlayedAt: 2_000,
  }, quitSuppress), false);
  assert.equal(isRecentBlockedByQuitSuppress({
    appId: 111,
    playtimeForeverMin: 11,
    lastPlayedAt: 1_000,
  }, quitSuppress), false);
});

test('applyCachedArtworkUrls keeps CDN fallbacks and ignores loopback origins', () => {
  const reading = {
    appId: 570,
    posterCandidates: ['https://cdn.example/poster.jpg'],
    screenshots: ['https://cdn.example/s1.jpg'],
    headerImage: 'https://cdn.example/header.jpg',
  };
  assert.equal(isUsableArtworkOrigin('https://127.0.0.1:47810'), false);
  assert.equal(isUsableArtworkOrigin('https://192.168.1.10:47810'), true);
  assert.deepEqual(
    applyCachedArtworkUrls(reading, null, 'https://192.168.1.10:47810'),
    reading,
  );
});

test('pickRecentPlayAppId infers fresh launches and ends after stagnant grace', () => {
  const nowMs = 1_000_000_000;
  const fresh = {
    appId: 2524850,
    lastPlayedAt: nowMs - 45_000,
    playtimeForeverMin: 2,
  };
  assert.equal(pickRecentPlayAppId({
    recentGame: fresh,
    nowMs,
    inferSeconds: 300,
    stagnantSeconds: 120,
    personaOnline: true,
  }), 2524850);
  assert.equal(pickRecentPlayAppId({
    recentGame: fresh,
    nowMs,
    personaOnline: false,
  }), null);

  // Active session: no playtime/rtime growth and past stagnant grace → quit.
  assert.equal(pickRecentPlayAppId({
    recentGame: {
      appId: 2524850,
      lastPlayedAt: nowMs - 60_000,
      playtimeForeverMin: 2,
    },
    sessionAppId: 2524850,
    sessionLastPlaytime: 2,
    sessionLastRtime: nowMs - 60_000,
    sessionLastActivityAt: nowMs - 180_000,
    nowMs,
    inferSeconds: 300,
    stagnantSeconds: 120,
    personaOnline: true,
  }), null);

  // Still within stagnant grace after last activity → keep showing.
  assert.equal(pickRecentPlayAppId({
    recentGame: {
      appId: 2524850,
      lastPlayedAt: nowMs - 60_000,
      playtimeForeverMin: 2,
    },
    sessionAppId: 2524850,
    sessionLastPlaytime: 2,
    sessionLastRtime: nowMs - 60_000,
    sessionLastActivityAt: nowMs - 30_000,
    nowMs,
    inferSeconds: 300,
    stagnantSeconds: 120,
    personaOnline: true,
  }), 2524850);

  // Playtime bump keeps the session even when lastPlayedAt is older than infer.
  assert.equal(pickRecentPlayAppId({
    recentGame: {
      appId: 2524850,
      lastPlayedAt: nowMs - 600_000,
      playtimeForeverMin: 5,
    },
    sessionAppId: 2524850,
    sessionLastPlaytime: 4,
    sessionLastRtime: nowMs - 600_000,
    sessionLastActivityAt: nowMs - 600_000,
    nowMs,
    inferSeconds: 300,
    stagnantSeconds: 120,
    personaOnline: true,
  }), 2524850);
});

test('resolveSteamConfig defaults to any-PC (no presence required)', () => {
  const prevHosts = process.env.STEAM_ALLOWED_HOSTS;
  const prevReq = process.env.STEAM_REQUIRE_PRESENCE;
  delete process.env.STEAM_ALLOWED_HOSTS;
  delete process.env.STEAM_REQUIRE_PRESENCE;
  try {
    const steam = resolveSteamConfig({ ROOT: os.tmpdir() }, {});
    assert.equal(steam.requirePresence, false);
    assert.deepEqual(steam.allowedHosts, ['MOVIETHEATERPC']);
    assert.equal(isAllowedHost(steam, 'movietheaterpc'), true);
    assert.equal(normalizeHostname('MovieTheaterPC'), 'MOVIETHEATERPC');
    assert.equal(steam.pollIntervalSeconds, 15);
    assert.equal(steam.restoreAfterInterruptSeconds, 75);
    assert.equal(steam.inferFromRecentSeconds, 300);
    assert.equal(steam.recentPlayStagnantSeconds, 120);
  } finally {
    if (prevHosts === undefined) delete process.env.STEAM_ALLOWED_HOSTS;
    else process.env.STEAM_ALLOWED_HOSTS = prevHosts;
    if (prevReq === undefined) delete process.env.STEAM_REQUIRE_PRESENCE;
    else process.env.STEAM_REQUIRE_PRESENCE = prevReq;
  }
});

test('STEAM_REQUIRE_PRESENCE=1 enables host gate', () => {
  const prev = process.env.STEAM_REQUIRE_PRESENCE;
  process.env.STEAM_REQUIRE_PRESENCE = '1';
  try {
    const steam = resolveSteamConfig({ ROOT: os.tmpdir() }, {});
    assert.equal(steam.requirePresence, true);
  } finally {
    if (prev === undefined) delete process.env.STEAM_REQUIRE_PRESENCE;
    else process.env.STEAM_REQUIRE_PRESENCE = prev;
  }
});

test('extractSteamIdFromClaimedId parses OpenID claimed id', () => {
  assert.equal(
    extractSteamIdFromClaimedId('https://steamcommunity.com/openid/id/76561198000000000'),
    '76561198000000000',
  );
  assert.equal(extractSteamIdFromClaimedId('nope'), null);
});

test('stripHtml and libraryCapsuleUrls helpers', () => {
  assert.equal(stripHtml('Hello<br>world &amp; friends'), 'Hello world & friends');
  const urls = libraryCapsuleUrls(570);
  assert.ok(urls.some((url) => url.includes('/570/library_600x900.jpg')));
  assert.equal(formatPlaytimeHours(90), '1.5 hrs');
});

test('presence store allowlists hosts and prunes stale entries', () => {
  let now = 1_000_000;
  const steam = resolveSteamConfig({ ROOT: os.tmpdir() }, {
    steam: { allowedHosts: ['MOVIETHEATERPC'], presenceStaleSeconds: 60 },
  });
  const store = createSteamPresenceStore(steam, { now: () => now });
  assert.equal(store.upsert({ hostname: 'evil', appId: 1 }).ok, false);
  assert.equal(store.snapshot().lastAttempt?.hostname, 'EVIL');
  assert.equal(store.snapshot().lastAttempt?.allowed, false);
  assert.equal(store.upsert({ hostname: 'MOVIETHEATERPC', appId: 570 }).ok, true);
  assert.equal(store.matchForApp(570)?.hostname, 'MOVIETHEATERPC');
  assert.equal(store.snapshot().lastAttempt?.allowed, true);
  now += 120_000;
  assert.equal(store.matchForApp(570), null);
});

test('buildSteamNowPlayingPayload is persistent', () => {
  const payload = buildSteamNowPlayingPayload({
    appId: 570,
    name: 'Dota 2',
    shortDescription: 'A game',
    tags: ['Multi-player'],
    posterCandidates: ['https://example.com/p.jpg'],
    screenshots: ['https://example.com/s.jpg'],
    host: 'MOVIETHEATERPC',
    startedAt: Date.now(),
    elapsedSec: 12,
    achievements: { earned: 1, total: 10, available: true },
    currentPlayers: 1000,
    playtimeLabel: '12 hrs',
  }, { udpBroadcast: { defaultDisplaySeconds: 120 } });
  assert.equal(payload.type, 'steam.now-playing');
  assert.equal(payload.persistent, true);
  assert.equal(payload.displaySeconds, 0);
  assert.equal(payload.steam.mode, 'playing');
  assert.equal(payload.steam.name, 'Dota 2');
  assert.equal(buildSteamNowPlayingClosePayload({}).type, 'steam.now-playing.close');
});

test('buildSteamNowPlayingPayload last-played is dismissible', () => {
  const lastPlayedAt = Date.UTC(2026, 6, 20, 18, 30, 0);
  const payload = buildSteamNowPlayingPayload({
    appId: 570,
    name: 'Dota 2',
    lastPlayedAt,
    playtimeLabel: '40 hrs',
  }, { udpBroadcast: { defaultDisplaySeconds: 90 } }, {
    mode: 'last-played',
    dismissible: true,
    trigger: 'steam-manual-preview',
  });
  assert.equal(payload.persistent, false);
  assert.equal(payload.displaySeconds, 90);
  assert.equal(payload.steam.mode, 'last-played');
  assert.equal(payload.steam.lastPlayedAt, new Date(lastPlayedAt).toISOString());
  assert.equal(payload.trigger, 'steam-manual-preview');
});

test('buildSteamNowPlayingPayload last-played omits fabricated lastPlayedAt', () => {
  const payload = buildSteamNowPlayingPayload({
    appId: 570,
    name: 'Dota 2',
    startedAt: Date.now(),
  }, { udpBroadcast: { defaultDisplaySeconds: 90 } }, {
    mode: 'last-played',
    dismissible: true,
  });
  assert.equal(payload.steam.mode, 'last-played');
  assert.equal(payload.steam.lastPlayedAt, null);
});

test('resolveSteamCredentials prefers STEAM_API_KEY from env over session', () => {
  const { resolveSteamCredentials, saveSteamSession } = require('../src/steam-session');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'steam-creds-'));
  const sessionPath = path.join(root, 'steam-session.json');
  saveSteamSession(sessionPath, { apiKey: 'session-key-xxxxxxxx', steamId: '76561198000000000' });
  const prev = process.env.STEAM_API_KEY;
  process.env.STEAM_API_KEY = 'env-key-xxxxxxxxxxxx';
  try {
    const creds = resolveSteamCredentials({
      sessionPath,
      apiKey: 'config-key-xxxxxxxx',
      steamId: '',
    });
    assert.equal(creds.apiKey, 'env-key-xxxxxxxxxxxx');
    assert.equal(creds.apiKeySource, 'env');
    assert.equal(creds.steamId, '76561198000000000');
  } finally {
    if (prev == null) {
      delete process.env.STEAM_API_KEY;
    } else {
      process.env.STEAM_API_KEY = prev;
    }
  }
});

test('session suppress blocks re-push until restore window elapses', async () => {
  const sent = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'steam-np-'));
  const steam = resolveSteamConfig({ ROOT: root }, {
    steam: {
      apiKey: 'test-key',
      steamId: '76561198000000000',
      allowedHosts: ['MOVIETHEATERPC'],
      enabled: true,
      restoreAfterInterruptSeconds: 30,
    },
  });
  const config = { ROOT: root, steam, udpBroadcast: { defaultDisplaySeconds: 120 } };
  let now = Date.now();
  const controller = createSteamNowPlaying({
    config,
    log: { info() {}, warn() {} },
    sendUdpPayload: (payload) => sent.push(payload),
    now: () => now,
  });

  // Manually drive session state (avoid live Steam HTTP).
  controller.recordPresence({ hostname: 'MOVIETHEATERPC', appId: 570 });
  controller._setSession({
    appId: 570,
    host: 'MOVIETHEATERPC',
    startedAt: now,
    suppressed: false,
    suppressedAt: null,
    suppressReason: null,
    pushed: true,
    lastPushAt: now,
    details: { appId: 570, name: 'Dota 2', host: 'MOVIETHEATERPC' },
  });
  assert.equal(controller.suppressActiveSession('weather.query'), true);
  assert.equal(controller._getSession().suppressed, true);
  assert.equal(controller._getSession().suppressReason, 'weather.query');
  assert.equal(sent.length, 0);

  // Still inside the restore window.
  now += 10_000;
  assert.equal(controller.statusSnapshot().session.restoreInSec > 0, true);

  // After the restore window, suppress clears and a re-push is forced.
  now += 25_000;
  assert.equal(controller._maybeClearSuppressForRestore(), true);
  assert.equal(controller._getSession().suppressed, false);
  assert.equal(controller._getSession().pushed, false);
});
