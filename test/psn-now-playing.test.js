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
  collectConceptGenres,
  psnReadingIsThin,
  enrichPsnTitle,
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
  // A game launched a minute ago is not "0.0 h".
  assert.equal(formatPlaytimeHours(0), '0 min');
  assert.equal(formatPlaytimeHours(14), '14 min');
});

test('a reading is thin until PSN has published the details', () => {
  const full = {
    shortDescription: 'A blurb.',
    screenshots: ['a.jpg'],
    playtimeLabel: '2.0 h',
    trophies: { available: true },
  };
  assert.equal(psnReadingIsThin(full), false);
  assert.equal(psnReadingIsThin(null), true);
  assert.equal(psnReadingIsThin({ ...full, screenshots: [] }), true);
  assert.equal(psnReadingIsThin({ ...full, shortDescription: '  ' }), true);
  assert.equal(psnReadingIsThin({ ...full, playtimeLabel: null }), true);
  assert.equal(psnReadingIsThin({ ...full, trophies: { available: false } }), true);
});

test('concept genres come through as strings or as tagged rows', () => {
  assert.deepEqual(collectConceptGenres({ concept: { genres: ['Action', 'Racing'] } }), ['Action', 'Racing']);
  assert.deepEqual(
    collectConceptGenres({ concept: { genres: [{ value: 'Shooter' }, { value: 'shooter' }] } }),
    ['Shooter'],
  );
  assert.deepEqual(collectConceptGenres({}), []);
});

test('a game the PlayStation Store will not describe borrows its blurb', async () => {
  const reading = await enrichPsnTitle(
    { accessToken: 'x' },
    'me',
    { titleId: 'PPSA17732_00', name: 'The Precinct', platform: 'PS5' },
    {
      api: {
        getUserPlayedGames: async () => ({
          titles: [{
            titleId: 'PPSA17732_00',
            name: 'The Precinct',
            category: 'ps5_native_game',
            playDuration: 'PT0S',
            playCount: 1,
            concept: { genres: ['Action'], media: { images: [] } },
          }],
        }),
        getUserTitles: async () => ({ trophyTitles: [] }),
      },
      // Chihiro answered, but with nothing worth showing.
      storeEnrichment: { productId: 'EP6959-X', shortDescription: '', screenshots: [] },
      gameLookup: {
        shortDescription: 'Averno City, 1983.',
        screenshots: ['https://steam.example/1.jpg', 'https://steam.example/2.jpg'],
        developers: ['Fallen Tree Games Ltd'],
        publishers: ['Kwalee'],
        releaseYear: '2025',
        source: 'steam',
      },
    },
  );

  assert.equal(reading.shortDescription, 'Averno City, 1983.');
  assert.equal(reading.screenshots.length, 2);
  assert.deepEqual(reading.developers, ['Fallen Tree Games Ltd']);
  assert.deepEqual(reading.publishers, ['Kwalee']);
  assert.equal(reading.releaseYear, '2025');
  assert.ok(reading.tags.includes('Action'), 'concept genre becomes a tag');
});

test('PlayStation stills are kept in preference to the borrowed ones', async () => {
  const reading = await enrichPsnTitle(
    { accessToken: 'x' },
    'me',
    { titleId: 'PPSA17732_00', name: 'The Precinct', platform: 'PS5' },
    {
      api: {
        getUserPlayedGames: async () => ({
          titles: [{
            titleId: 'PPSA17732_00',
            name: 'The Precinct',
            playDuration: 'PT30M',
            concept: {
              media: { images: [{ url: 'https://psn.example/shot.jpg', type: 'SCREENSHOT' }] },
            },
          }],
        }),
        getUserTitles: async () => ({ trophyTitles: [] }),
      },
      storeEnrichment: { productId: 'EP6959-X', shortDescription: '', screenshots: [] },
      gameLookup: {
        shortDescription: 'Averno City, 1983.',
        screenshots: ['https://steam.example/1.jpg'],
      },
    },
  );

  assert.deepEqual(reading.screenshots, ['https://psn.example/shot.jpg']);
  assert.equal(reading.shortDescription, 'Averno City, 1983.', 'the blurb is still borrowed');
  assert.equal(reading.playtimeLabel, '30 min');
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

test('a card that opened bare is filled in once PSN catches up', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psn-thin-'));
  savePsnSession(path.join(dir, 'psn-session.json'), {
    accessToken: 'atok',
    refreshToken: 'rtok',
    expiresAt: Date.now() + 3_600_000,
    onlineId: 'Tester',
    accountId: 'me',
    linkedAt: new Date().toISOString(),
  });

  const sent = [];
  const clock = { t: 1_000_000 };
  let enrichCalls = 0;
  const game = { titleId: 'PPSA17732_00', name: 'The Precinct', platform: 'PS5' };

  const poller = createPsnNowPlaying({
    config: {
      udpBroadcast: { defaultDisplaySeconds: 30 },
      psn: resolvePsnConfig({ ROOT: dir }, { psn: { sessionFile: 'psn-session.json' } }),
    },
    now: () => clock.t,
    sendUdpPayload: (payload) => sent.push(payload),
    apiHelpers: {
      ensurePsnAuth: async () => ({
        accountId: 'me', onlineId: 'Tester', authorization: { accessToken: 'atok' }, session: {},
      }),
      fetchBasicPresence: async () => ({ game }),
      fetchPlayedTitles: async () => [],
      // The library and trophy set only exist from the third look onward.
      enrichPsnTitle: async (_a, _i, g) => {
        enrichCalls += 1;
        const ready = enrichCalls >= 3;
        return {
          titleId: g.titleId,
          name: g.name,
          platform: g.platform,
          tags: [g.platform],
          posterCandidates: ['https://example.com/a.png'],
          headerImage: 'https://example.com/a.png',
          shortDescription: ready ? 'Averno City, 1983.' : '',
          screenshots: ready ? ['https://psn.example/1.jpg'] : [],
          playtimeLabel: ready ? '12 min' : null,
          progressLabel: ready ? '0%' : null,
          achievements: { earned: null, total: null, available: false },
          trophies: ready
            ? { earned: 0, total: 40, available: true, progress: 0 }
            : { earned: null, total: null, available: false },
        };
      },
    },
  });

  await poller.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].psn.screenshots?.length || 0, 0, 'opens bare, as PSN reported it');

  // Nothing is re-asked while the backoff is still running.
  clock.t += 10_000;
  await poller.tick();
  assert.equal(enrichCalls, 1);
  assert.equal(sent.length, 1);

  // First retry — PSN still has nothing, so the card is left alone.
  clock.t += 60_000;
  await poller.tick();
  assert.equal(enrichCalls, 2);
  assert.equal(sent.length, 1, 'no redraw without new information');

  // Second retry lands the details, and the card is redrawn.
  clock.t += 120_000;
  await poller.tick();
  assert.equal(enrichCalls, 3);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].psn.shortDescription, 'Averno City, 1983.');
  assert.equal(sent[1].psn.screenshots.length, 1);
  assert.equal(sent[1].psn.trophies.total, 40);

  // Complete now, so the poller stops asking.
  clock.t += 600_000;
  await poller.tick();
  assert.equal(enrichCalls, 3);
  assert.equal(sent.length, 2);
});

test('re-enrichment gives up rather than polling PSN all session', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psn-giveup-'));
  savePsnSession(path.join(dir, 'psn-session.json'), {
    accessToken: 'atok',
    expiresAt: Date.now() + 3_600_000,
    accountId: 'me',
    linkedAt: new Date().toISOString(),
  });

  const sent = [];
  const clock = { t: 0 };
  let enrichCalls = 0;
  const poller = createPsnNowPlaying({
    config: {
      udpBroadcast: { defaultDisplaySeconds: 30 },
      psn: resolvePsnConfig({ ROOT: dir }, { psn: { sessionFile: 'psn-session.json' } }),
    },
    now: () => clock.t,
    sendUdpPayload: (payload) => sent.push(payload),
    apiHelpers: {
      ensurePsnAuth: async () => ({
        accountId: 'me', authorization: { accessToken: 'atok' }, session: {},
      }),
      fetchBasicPresence: async () => ({ game: { titleId: 'X_00', name: 'Obscure', platform: 'PS5' } }),
      fetchPlayedTitles: async () => [],
      enrichPsnTitle: async (_a, _i, g) => {
        enrichCalls += 1;
        return {
          titleId: g.titleId,
          name: g.name,
          platform: g.platform,
          tags: [],
          posterCandidates: ['https://example.com/a.png'],
          screenshots: [],
          trophies: { earned: null, total: null, available: false },
          achievements: { earned: null, total: null, available: false },
        };
      },
    },
  });

  await poller.tick();
  for (let i = 0; i < 20; i += 1) {
    clock.t += 600_000;
    await poller.tick();
  }
  assert.equal(enrichCalls, 6, 'the opening look plus five retries');
  assert.equal(sent.length, 1);
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
