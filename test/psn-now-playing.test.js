const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolvePsnConfig } = require('../src/psn-config');
const {
  parseIsoDurationToMinutes,
  formatPlaytimeHours,
  pickPresenceGame,
  findPlayedTitle,
  normalizeTokens,
  collectConceptImageUrls,
  buildPsnStatusLine,
  formatTrophyProgress,
} = require('../src/psn-api');
const {
  savePsnSession,
  resolvePsnCredentials,
  clearPsnSession,
} = require('../src/psn-session');
const {
  buildPsnNowPlayingPayload,
  buildPsnNowPlayingClosePayload,
} = require('../src/udp-payload');
const { createPsnNowPlaying } = require('../src/psn-now-playing');
const { shouldSuppressSteamForPayload } = require('../src/listener');

test('resolvePsnConfig defaults', () => {
  const prev = process.env.PSN_ENABLED;
  delete process.env.PSN_ENABLED;
  try {
    const psn = resolvePsnConfig({ ROOT: os.tmpdir() }, {});
    assert.equal(psn.enabled, true);
    assert.equal(psn.accountId, 'me');
    assert.ok(psn.pollIntervalSeconds >= 10);
    assert.ok(psn.sessionPath.includes('psn-session.json'));
  } finally {
    if (prev == null) {
      delete process.env.PSN_ENABLED;
    } else {
      process.env.PSN_ENABLED = prev;
    }
  }
});

test('parseIsoDurationToMinutes handles PT hours/minutes', () => {
  assert.equal(parseIsoDurationToMinutes('PT228H56M33S'), Math.round(228 * 60 + 56 + 33 / 60));
  assert.equal(parseIsoDurationToMinutes('PT1H30M'), 90);
  assert.equal(parseIsoDurationToMinutes(''), null);
  assert.equal(formatPlaytimeHours(90), '1.5 h');
  assert.equal(formatPlaytimeHours(600), '10 h');
});

test('pickPresenceGame reads gameTitleInfoList', () => {
  const picked = pickPresenceGame({
    basicPresence: {
      availability: 'availableToPlay',
      primaryPlatformInfo: { onlineStatus: 'online', platform: 'PS5' },
      gameTitleInfoList: [{
        npTitleId: 'PPSA01325_00',
        titleName: "Astro's Playroom",
        launchPlatform: 'PS5',
        conceptIconUrl: 'https://example.com/icon.png',
      }],
    },
  });
  assert.equal(picked.game.titleId, 'PPSA01325_00');
  assert.equal(picked.game.name, "Astro's Playroom");
  assert.equal(picked.game.platform, 'PS5');
  assert.equal(pickPresenceGame({ basicPresence: {} }).game, null);
});

test('findPlayedTitle matches titleId or name', () => {
  const titles = [
    { titleId: 'CUSA00001_00', name: 'Other' },
    { titleId: 'PPSA01325_00', name: 'Astro' },
    { titleId: 'PPSA12345_00', name: 'Split Fiction' },
  ];
  assert.equal(findPlayedTitle(titles, 'PPSA01325_00').name, 'Astro');
  assert.equal(findPlayedTitle(titles, 'missing', 'Split Fiction').name, 'Split Fiction');
  assert.equal(findPlayedTitle(titles, 'missing'), null);
});

test('collectConceptImageUrls keeps screenshots only (not key-art)', () => {
  const urls = collectConceptImageUrls({
    concept: {
      media: {
        images: [
          { url: 'https://example.com/logo.png', type: 'LOGO' },
          { url: 'https://example.com/banner.jpg', type: 'FOUR_BY_THREE_BANNER' },
          { url: 'https://example.com/still.jpg', type: 'SCREENSHOT' },
        ],
      },
    },
  });
  assert.deepEqual(urls, ['https://example.com/still.jpg']);
});

test('buildPsnStatusLine and trophy progress labels', () => {
  assert.equal(
    buildPsnStatusLine({
      platform: 'PS5',
      onlineId: 'Tester',
      playCount: 3,
      mode: 'playing',
      starRating: 4.04,
    }),
    'Playing now · on PS5 · as Tester · 3 sessions · ★ 4.0',
  );
  assert.equal(formatTrophyProgress({ progress: 61 }), '61%');
  assert.equal(formatTrophyProgress({ earned: 5, total: 20 }), '25%');
});

test('normalizeTokens sets expiry skew', () => {
  const now = 1_000_000_000;
  const tokens = normalizeTokens({
    accessToken: 'a',
    refreshToken: 'r',
    expiresIn: 3600,
    refreshTokenExpiresIn: 7200,
  }, { now });
  assert.equal(tokens.accessToken, 'a');
  assert.equal(tokens.expiresAt, now + 3600 * 1000 - 60_000);
  assert.equal(tokens.refreshExpiresAt, now + 7200 * 1000);
});

test('psn session save/load credentials', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psn-sess-'));
  const sessionPath = path.join(dir, 'psn-session.json');
  const cfg = { sessionPath, accountId: 'me' };
  savePsnSession(sessionPath, {
    accessToken: 'atok',
    refreshToken: 'rtok',
    expiresAt: Date.now() + 60_000,
    onlineId: 'PlayerOne',
    linkedAt: new Date().toISOString(),
  });
  const creds = resolvePsnCredentials(cfg);
  assert.equal(creds.configured, true);
  assert.equal(creds.onlineId, 'PlayerOne');
  clearPsnSession(sessionPath);
  assert.equal(resolvePsnCredentials(cfg).configured, false);
});

test('buildPsnNowPlayingPayload persistent vs last-played', () => {
  const config = { udpBroadcast: { defaultDisplaySeconds: 45 } };
  const playing = buildPsnNowPlayingPayload({
    titleId: 'PPSA1',
    name: 'Game',
    platform: 'PS5',
    startedAt: Date.now(),
  }, config);
  assert.equal(playing.type, 'psn.now-playing');
  assert.equal(playing.persistent, true);
  assert.equal(playing.displaySeconds, 0);
  assert.equal(playing.psn.platform, 'PS5');
  assert.equal(
    buildPsnNowPlayingPayload({
      name: 'Game',
      statusLine: 'Playing now · on PS5',
      progressLabel: '40%',
      playCount: 2,
    }, config).psn.statusLine,
    'Playing now · on PS5',
  );

  const last = buildPsnNowPlayingPayload({
    titleId: 'PPSA1',
    name: 'Game',
    lastPlayedAt: Date.now() - 86_400_000,
  }, config, { mode: 'last-played', dismissible: true });
  assert.equal(last.persistent, false);
  assert.equal(last.displaySeconds, 45);
  assert.equal(last.psn.mode, 'last-played');

  assert.equal(buildPsnNowPlayingClosePayload().type, 'psn.now-playing.close');
});

test('shouldSuppressSteamForPayload ignores PSN now-playing traffic', () => {
  assert.equal(shouldSuppressSteamForPayload({ type: 'psn.now-playing' }), false);
  assert.equal(shouldSuppressSteamForPayload({ type: 'psn.now-playing.close' }), false);
  assert.equal(shouldSuppressSteamForPayload({ type: 'broadcast' }), true);
});

test('createPsnNowPlaying opens and closes on presence changes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psn-np-'));
  const sessionPath = path.join(dir, 'psn-session.json');
  savePsnSession(sessionPath, {
    accessToken: 'atok',
    refreshToken: 'rtok',
    expiresAt: Date.now() + 3_600_000,
    onlineId: 'Tester',
    accountId: 'me',
    linkedAt: new Date().toISOString(),
  });

  const sent = [];
  let presenceGame = {
    titleId: 'PPSA01325_00',
    name: "Astro's Playroom",
    platform: 'PS5',
    conceptIconUrl: 'https://example.com/a.png',
    npTitleIconUrl: null,
  };

  const poller = createPsnNowPlaying({
    config: {
      udpBroadcast: { defaultDisplaySeconds: 30 },
      psn: resolvePsnConfig({ ROOT: dir }, {
        psn: { sessionFile: 'psn-session.json', pollIntervalSeconds: 20 },
      }),
    },
    sendUdpPayload: (payload) => sent.push(payload),
    apiHelpers: {
      ensurePsnAuth: async () => ({
        accessToken: 'atok',
        accountId: 'me',
        onlineId: 'Tester',
        authorization: { accessToken: 'atok' },
        session: {},
      }),
      fetchBasicPresence: async () => ({ game: presenceGame }),
      fetchPlayedTitles: async () => [{
        titleId: 'PPSA01325_00',
        name: "Astro's Playroom",
        playtimeForeverMin: 120,
        playtimeLabel: '2.0 h',
        lastPlayedAt: Date.now() - 1000,
        imageUrl: 'https://example.com/a.png',
      }],
      enrichPsnTitle: async (_auth, _id, game, opts = {}) => ({
        titleId: game.titleId,
        name: game.name,
        platform: game.platform,
        tags: [game.platform],
        statusLine: `Playing now · on ${game.platform}`,
        posterCandidates: [game.conceptIconUrl].filter(Boolean),
        headerImage: game.conceptIconUrl,
        screenshots: ['https://example.com/banner.jpg'],
        playtimeLabel: '2.0 h',
        progressLabel: '10%',
        onlineId: opts.onlineId || null,
        achievements: { earned: 1, total: 10, available: true },
        trophies: { earned: 1, total: 10, available: true, progress: 10 },
      }),
    },
  });

  await poller.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'psn.now-playing');
  assert.equal(sent[0].psn.name, "Astro's Playroom");
  assert.equal(poller.statusSnapshot().status, 'playing');

  // Same game — no re-push.
  await poller.tick();
  assert.equal(sent.length, 1);

  presenceGame = null;
  await poller.tick();
  assert.equal(sent.at(-1).type, 'psn.now-playing.close');
  assert.equal(poller.statusSnapshot().status, 'idle');
});

test('pushManualPreview falls back to last played', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psn-manual-'));
  const sessionPath = path.join(dir, 'psn-session.json');
  savePsnSession(sessionPath, {
    accessToken: 'atok',
    refreshToken: 'rtok',
    expiresAt: Date.now() + 3_600_000,
    linkedAt: new Date().toISOString(),
  });
  const sent = [];
  const poller = createPsnNowPlaying({
    config: {
      udpBroadcast: { defaultDisplaySeconds: 30 },
      psn: resolvePsnConfig({ ROOT: dir }, {
        psn: { sessionFile: 'psn-session.json' },
      }),
    },
    sendUdpPayload: (payload) => sent.push(payload),
    apiHelpers: {
      ensurePsnAuth: async () => ({
        accessToken: 'atok',
        accountId: 'me',
        onlineId: 'Tester',
        authorization: { accessToken: 'atok' },
        session: {},
      }),
      fetchBasicPresence: async () => ({ game: null }),
      fetchPlayedTitles: async () => [{
        titleId: 'CUSA12345_00',
        name: 'Old Game',
        category: 'ps4_game',
        imageUrl: 'https://example.com/old.png',
        lastPlayedAt: Date.now() - 86400000,
        playtimeForeverMin: 30,
        playtimeLabel: '0.5 h',
      }],
      enrichPsnTitle: async (_a, _i, game) => ({
        titleId: game.titleId,
        name: game.name,
        platform: game.platform,
        tags: game.platform ? [game.platform] : [],
        posterCandidates: [game.npTitleIconUrl || game.conceptIconUrl].filter(Boolean),
        achievements: { earned: null, total: null, available: false },
        trophies: { earned: null, total: null, available: false },
        lastPlayedAt: Date.now() - 86400000,
      }),
    },
  });

  const result = await poller.pushManualPreview();
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'last-played');
  assert.equal(sent[0].psn.mode, 'last-played');
  assert.equal(sent[0].persistent, false);
});
