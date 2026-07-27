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
} = require('../src/steam-now-playing');

test('resolveEffectiveSteamAppId prefers Steam gameid, else presence — never OwnedGames', () => {
  assert.equal(resolveEffectiveSteamAppId(570, { appId: 440 }), 570);
  assert.equal(resolveEffectiveSteamAppId(null, { appId: 440 }), 440);
  assert.equal(resolveEffectiveSteamAppId(0, { appId: 440 }), 440);
  assert.equal(resolveEffectiveSteamAppId(null, null), null);
  // Third arg must not invent a session (API is gameid + presence only).
  assert.equal(resolveEffectiveSteamAppId(null, null, 2524850), null);
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
    assert.equal(steam.inferFromRecentSeconds, undefined);
    assert.equal(steam.quitCooldownSeconds, undefined);
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

  now += 10_000;
  assert.equal(controller.statusSnapshot().session.restoreInSec > 0, true);

  now += 25_000;
  assert.equal(controller._maybeClearSuppressForRestore(), true);
  assert.equal(controller._getSession().suppressed, false);
  assert.equal(controller._getSession().pushed, false);
});
