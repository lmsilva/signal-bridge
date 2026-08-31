const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const { createYoutubeNowPlaying, SHORT_MAX_SECONDS } = require('../src/youtube-now-playing');
const { createYoutubeStore, sanitiseSettings } = require('../src/youtube-settings');
const { createSecretBox } = require('../src/secret-box');
const {
  buildYoutubeNowPlayingPayload,
  buildYoutubeNowPlayingClosePayload,
} = require('../src/udp-payload');
const { createCommandRegistry } = require('../src/command-registry');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'yt-svc-'));
}

function makeConfig(dir) {
  return {
    udpBroadcast: { defaultDisplaySeconds: 45, maxDisplaySeconds: 300 },
    proxyOwnIp: '192.168.1.50',
    webServer: { port: 47810, https: true },
    youtube: {
      enabled: true,
      loungeEnabled: true,
      apiKey: 'test-key',
      // Unit tests use a fake lounge — no need to wait for NDJSON events.
      pollSettleMs: 0,
      devicesPath: path.join(dir, 'devices.json'),
      settingsPath: path.join(dir, 'settings.json'),
      cachePath: path.join(dir, 'cache.json'),
      historyPath: path.join(dir, 'history.json'),
      thumbnailCachePath: path.join(dir, 'thumbs'),
    },
  };
}

const VIDEO = {
  videoId: 'abc',
  missing: false,
  degraded: false,
  title: 'How the Voyager Probes Still Phone Home',
  descriptionClean: 'A look at the Deep Space Network.',
  publishedAt: '2024-03-12T14:00:00Z',
  durationSeconds: 1711,
  liveBroadcastContent: 'none',
  channelId: 'UC-veritasium',
  channelTitle: 'Veritasium',
  subscriberCount: 16832904,
  hiddenSubscriberCount: false,
  viewCount: 4218774,
  likeCount: 312401,
  dislikeCount: 1204,
  concurrentViewers: null,
  thumbnailFile: 'a'.repeat(40) + '.jpg',
  thumbnailWidth: 1280,
  thumbnailHeight: 720,
  avatarFile: 'b'.repeat(40) + '.jpg',
};

/** A lounge double: the same event surface, no process and no protocol. */
function fakeLounge() {
  const emitter = new EventEmitter();
  const sessions = [];
  const current = [];
  return {
    on: (event, handler) => emitter.on(event, handler),
    off: (event, handler) => emitter.off(event, handler),
    start: () => {},
    stop: () => {},
    emit: (event, payload) => emitter.emit(event, payload),
    connectDevice: async () => ({ ok: true, screenName: 'Theater' }),
    disconnectDevice: async () => ({ ok: true }),
    pairWithCode: async (id) => ({ ok: true, screenId: `screen-${id}`, authState: { t: 1 } }),
    pairWithScreenId: async (id) => ({ ok: true, screenId: `screen-${id}`, authState: { t: 2 } }),
    discover: async () => ({ ok: true, devices: [{ address: '192.168.1.42', screenId: 'screen-x', server: 'AppleTV/1' }] }),
    refreshDevice: async () => ({ ok: true }),
    pollNowPlaying: async () => ({ ok: true }),
    activeSessions: () => sessions,
    currentPlayback: () => (current.length ? current : sessions),
    snapshot: () => ({ running: true, ready: true, loungeAvailable: true, devices: [] }),
    _sessions: sessions,
    _current: current,
  };
}

function fakeApi(overrides = {}) {
  const resolved = [];
  return {
    resolved,
    resolveVideo: async (videoId, options) => {
      resolved.push({ videoId, options });
      if (overrides.resolveVideo) {
        return overrides.resolveVideo(videoId, options);
      }
      return { ...VIDEO, videoId };
    },
    prefetchVideo: async (videoId) => {
      resolved.push({ videoId, prefetch: true });
      return true;
    },
    stats: () => ({ videos: 1, channels: 1, quotaUsedToday: 3, quotaLimit: 10000, hasApiKey: true }),
    cachedVideo: (videoId) => ({ ...VIDEO, videoId }),
    recentVideos: (opts) => (overrides.recentVideos
      ? overrides.recentVideos(opts)
      : []),
    clear: () => ({ videos: 0, channels: 0 }),
    pruneThumbnails: () => 0,
    flush: () => {},
  };
}

function makeService(extra = {}) {
  const dir = tempDir();
  const config = makeConfig(dir);
  const sent = [];
  const lounge = extra.lounge || fakeLounge();
  const api = extra.api || fakeApi();
  const store = createYoutubeStore({
    config,
    secretBox: createSecretBox({ keyPath: path.join(dir, 'secret.key') }),
  });
  const service = createYoutubeNowPlaying({
    config,
    sendUdpPayload: (payload) => sent.push(payload),
    lounge,
    api,
    store,
    ...extra.options,
  });
  return { service, sent, lounge, api, store, config, dir };
}

// ------------------------------------------------------------- the payload

test('a playing card is persistent and carries everything the panel needs', () => {
  const payload = buildYoutubeNowPlayingPayload(VIDEO, makeConfig(tempDir()), {
    mode: 'playing',
    deviceLabel: 'Movie Theater',
    imageBaseUrl: 'https://192.168.1.50:47810',
    settings: sanitiseSettings({}),
    session: { startedAt: '2026-08-02T20:00:00Z', positionSeconds: 724 },
  });

  assert.equal(payload.type, 'youtube.now-playing');
  assert.equal(payload.version, 2);
  assert.equal(payload.persistent, true);
  assert.equal(payload.displaySeconds, 0, 'a live session holds until playback stops');
  assert.equal(payload.youtube.mode, 'playing');
  assert.equal(payload.youtube.positionSeconds, 724);
  assert.equal(payload.youtube.watchedSeconds, null);
  assert.equal(payload.youtube.deviceLabel, 'Movie Theater');
  assert.equal(payload.youtube.durationSeconds, 1711);
  assert.equal(
    payload.youtube.thumbnailUrl,
    `https://192.168.1.50:47810/youtube-images/${VIDEO.thumbnailFile}`,
  );
  assert.match(payload.youtube.avatarUrl, /\/youtube-images\//);
});

test('a last-played card is dismissible and reports watched time instead of position', () => {
  const payload = buildYoutubeNowPlayingPayload(VIDEO, makeConfig(tempDir()), {
    mode: 'last-played',
    settings: sanitiseSettings({ dismissSeconds: 90 }),
    session: {
      watchedSeconds: 1450,
      positionSeconds: 1450,
      completed: false,
      endedAt: '2026-08-02T20:30:00Z',
    },
  });

  assert.equal(payload.persistent, false);
  assert.equal(payload.displaySeconds, 90);
  assert.equal(payload.youtube.mode, 'last-played');
  assert.equal(payload.youtube.watchedSeconds, 1450);
  assert.equal(payload.youtube.positionSeconds, 1450);
  assert.equal(payload.youtube.completed, false);
  assert.equal(payload.youtube.endedAt, '2026-08-02T20:30:00Z');
});

test('a last-played card prefers scrubber position for the Watched X of Y line', () => {
  const payload = buildYoutubeNowPlayingPayload(VIDEO, makeConfig(tempDir()), {
    mode: 'last-played',
    settings: sanitiseSettings({ dismissSeconds: 90 }),
    session: { watchedSeconds: 9, positionSeconds: 724, completed: false },
  });
  assert.equal(payload.youtube.watchedSeconds, 724);
  assert.equal(payload.youtube.positionSeconds, 724);
});

test('the dislike figure is always flagged as an estimate', () => {
  const payload = buildYoutubeNowPlayingPayload(VIDEO, makeConfig(tempDir()), {
    settings: sanitiseSettings({}),
  });
  assert.equal(payload.youtube.dislikeCount, 1204);
  assert.equal(payload.youtube.dislikeEstimated, true);

  const without = buildYoutubeNowPlayingPayload({ ...VIDEO, dislikeCount: null }, makeConfig(tempDir()), {
    settings: sanitiseSettings({}),
  });
  assert.equal(without.youtube.dislikeCount, null);
  assert.equal(without.youtube.dislikeEstimated, false);
});

test('the display toggles actually suppress their fields', () => {
  const payload = buildYoutubeNowPlayingPayload(VIDEO, makeConfig(tempDir()), {
    settings: sanitiseSettings({
      showDescription: false, showSubscribers: false, showDislikes: false,
    }),
  });
  assert.equal(payload.youtube.description, '');
  assert.equal(payload.youtube.subscriberCount, null);
  assert.equal(payload.youtube.dislikeCount, null);
});

test('a hidden subscriber count is omitted even with the toggle on', () => {
  const payload = buildYoutubeNowPlayingPayload(
    { ...VIDEO, hiddenSubscriberCount: true, subscriberCount: 0 },
    makeConfig(tempDir()),
    { settings: sanitiseSettings({}) },
  );
  assert.equal(payload.youtube.subscriberCount, null);
});

test('a live stream carries its viewer count and no duration bar', () => {
  const payload = buildYoutubeNowPlayingPayload(
    {
      ...VIDEO, liveBroadcastContent: 'live', durationSeconds: 0, concurrentViewers: 18402,
    },
    makeConfig(tempDir()),
    { settings: sanitiseSettings({}) },
  );
  assert.equal(payload.youtube.live, true);
  assert.equal(payload.youtube.concurrentViewers, 18402);
  assert.equal(payload.youtube.durationSeconds, 0);
});

test('a video with no metadata still produces a card', () => {
  const payload = buildYoutubeNowPlayingPayload(
    { videoId: 'gone', missing: true, title: 'Untitled' },
    makeConfig(tempDir()),
    { settings: sanitiseSettings({}) },
  );
  assert.equal(payload.youtube.metadataMissing, true);
  assert.equal(payload.youtube.title, 'Untitled');
  assert.equal(payload.youtube.thumbnailUrl, null);
});

test('a payload without a video id is refused rather than half-built', () => {
  assert.equal(buildYoutubeNowPlayingPayload(null, makeConfig(tempDir())), null);
  assert.equal(buildYoutubeNowPlayingPayload({}, makeConfig(tempDir())), null);
});

test('the close payload is a bare command', () => {
  const payload = buildYoutubeNowPlayingClosePayload({ trigger: 'test' }, makeConfig(tempDir()));
  assert.equal(payload.type, 'youtube.now-playing.close');
  assert.equal(payload.displaySeconds, 0);
  assert.equal(payload.trigger, 'test');
});

// ---------------------------------------------------------- session → card

test('a confirmed session sends a card, and stopping closes it', async () => {
  const { service, sent, lounge, store } = makeService();
  service.start();

  lounge.emit('started', {
    deviceId: 'tv-1', videoId: 'abc', startedAt: '2026-08-02T20:00:00Z', durationSeconds: 1711,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'youtube.now-playing');
  assert.equal(sent[0].youtube.videoId, 'abc');
  assert.equal(store.history()[0].videoId, 'abc', 'history is seeded on confirm, before stop');
  assert.equal(store.history().length, 1);

  lounge.emit('stopped', {
    deviceId: 'tv-1', videoId: 'abc', watchedSeconds: 900,
    startedAt: '2026-08-02T20:00:00Z', endedAt: '2026-08-02T20:15:00Z', completed: false,
  });

  assert.equal(sent.at(-1).type, 'youtube.now-playing.close');
  assert.equal(store.history().length, 1, 'stop upserts the same session rather than duplicating');
  assert.equal(store.history()[0].watchedSeconds, 900);
});

// A card whose thumbnail failed to download carries no image URL at all, so
// the display cannot retry for itself. The bridge keeps chasing the file and
// pushes the card again once it lands — otherwise the hero stays empty for the
// length of the video even though the artwork was there all along.

const IMAGELESS = { ...VIDEO, thumbnailFile: null, thumbnailCandidateUrls: ['https://i.ytimg.com/vi/abc/maxres.jpg'] };

function backfillService({ landsOnAttempt = 1, delays = [1, 1, 1] } = {}) {
  let attempts = 0;
  const api = fakeApi({ resolveVideo: async () => ({ ...IMAGELESS }) });
  api.cacheFirstImage = async () => {
    attempts += 1;
    return { file: attempts >= landsOnAttempt ? 'c'.repeat(40) + '.jpg' : null, entry: null };
  };
  const built = makeService({ api, options: { imageBackfillDelays: delays } });
  return { ...built, attempts: () => attempts };
}

const settle = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));

test('a thumbnail that arrives late refreshes the card that went out without it', async () => {
  const { service, sent, lounge } = backfillService({ landsOnAttempt: 2 });
  service.start();

  lounge.emit('started', { deviceId: 'tv-1', videoId: 'abc', startedAt: '2026-08-02T20:00:00Z' });
  await settle();

  assert.equal(sent[0].youtube.thumbnailUrl, null, 'the first card genuinely has no art');
  await settle();

  assert.equal(sent.length, 2, 'the card is pushed again once the image lands');
  assert.equal(sent[1].trigger, 'youtube-thumbnail-backfill');
  assert.match(sent[1].youtube.thumbnailUrl, /\/youtube-images\/c{40}\.jpg$/);
  assert.equal(sent[1].youtube.videoId, 'abc');
  assert.equal(
    sent[1].youtube.startedAt,
    sent[0].youtube.startedAt,
    'the refreshed card must not restart the elapsed clock',
  );
  service.stop();
});

test('the card is left alone when the retry keeps failing', async () => {
  const { service, sent, lounge, attempts } = backfillService({ landsOnAttempt: 99 });
  service.start();

  lounge.emit('started', { deviceId: 'tv-1', videoId: 'abc', startedAt: '2026-08-02T20:00:00Z' });
  await settle(60);

  assert.equal(sent.length, 1, 'a no-op re-push would restart the card animation for nothing');
  assert.equal(attempts(), 3, 'it gives up after the schedule is exhausted');
  service.stop();
});

test('a card that already has its artwork never schedules a retry', async () => {
  const api = fakeApi();
  let called = false;
  api.cacheFirstImage = async () => {
    called = true;
    return { file: null, entry: null };
  };
  const { service, sent, lounge } = makeService({ api, options: { imageBackfillDelays: [1] } });
  service.start();

  lounge.emit('started', { deviceId: 'tv-1', videoId: 'abc', startedAt: '2026-08-02T20:00:00Z' });
  await settle();

  assert.equal(called, false);
  assert.equal(sent.length, 1);
  service.stop();
});

test('stopping the video calls off the hunt for its thumbnail', async () => {
  const { service, sent, lounge } = backfillService({ landsOnAttempt: 1, delays: [15] });
  service.start();

  lounge.emit('started', { deviceId: 'tv-1', videoId: 'abc', startedAt: '2026-08-02T20:00:00Z' });
  await settle(1);
  lounge.emit('stopped', {
    deviceId: 'tv-1', videoId: 'abc', watchedSeconds: 4,
    startedAt: '2026-08-02T20:00:00Z', endedAt: '2026-08-02T20:00:04Z',
  });
  const afterClose = sent.length;
  await settle(60);

  assert.equal(sent.length, afterClose, 'nothing may re-open a card the viewer already closed');
  assert.equal(sent.at(-1).type, 'youtube.now-playing.close');
  service.stop();
});

test('an empty history is rebuilt from the metadata cache on start', () => {
  const { service, store } = makeService({
    api: fakeApi({
      recentVideos: () => ([
        { videoId: 'newer', fetchedAt: '2026-08-03T05:00:00Z', durationSeconds: 100 },
        { videoId: 'older', fetchedAt: '2026-08-03T04:00:00Z', durationSeconds: 200 },
      ]),
    }),
  });
  assert.equal(store.history().length, 0);
  service.start();
  assert.equal(store.history().length, 2);
  assert.equal(store.lastPlayed().videoId, 'newer');
});

test('a non-empty history is left alone when recovering from the cache', () => {
  const { service, store } = makeService({
    api: fakeApi({
      recentVideos: () => ([
        { videoId: 'cached', fetchedAt: '2026-08-03T05:00:00Z', durationSeconds: 100 },
      ]),
    }),
  });
  store.recordSession({
    videoId: 'real-watch', deviceId: 'tv-1',
    startedAt: '2026-08-03T03:00:00Z', endedAt: '2026-08-03T03:10:00Z',
    watchedSeconds: 600,
  });
  service.start();
  assert.equal(store.history().length, 1);
  assert.equal(store.lastPlayed().videoId, 'real-watch');
});

test('a Short is suppressed unless the setting asks for it', async () => {
  const short = { ...VIDEO, durationSeconds: 42, liveBroadcastContent: 'none' };
  const { service, sent, lounge, store } = makeService({
    api: fakeApi({ resolveVideo: async () => short }),
  });
  service.start();

  lounge.emit('started', { deviceId: 'tv-1', videoId: 'abc', startedAt: '2026-08-02T20:00:00Z' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 0);
  assert.ok(short.durationSeconds < SHORT_MAX_SECONDS);

  store.updateSettings({ showShorts: true });
  lounge.emit('started', { deviceId: 'tv-1', videoId: 'def', startedAt: '2026-08-02T20:01:00Z' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 1);
});

test('a live stream is never mistaken for a Short', async () => {
  const live = { ...VIDEO, durationSeconds: 0, liveBroadcastContent: 'live' };
  const { service, sent, lounge } = makeService({
    api: fakeApi({ resolveVideo: async () => live }),
  });
  service.start();

  lounge.emit('started', { deviceId: 'tv-1', videoId: 'abc', startedAt: '2026-08-02T20:00:00Z' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].youtube.live, true);
});

test('a push still airs when Lounge cleared active during metadata resolve', async () => {
  const devices = new Map();
  devices.set('tv-1', { active: null, provisional: null });
  const lounge = fakeLounge();
  lounge._devices = () => devices;
  const { service, sent } = makeService({ lounge });
  service.start();

  lounge.emit('started', { deviceId: 'tv-1', videoId: 'abc', startedAt: '2026-08-02T20:00:00Z' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].youtube.videoId, 'abc');
});

test('a push is skipped only when Lounge moved on to a different video', async () => {
  const devices = new Map();
  devices.set('tv-1', { active: { videoId: 'other' }, provisional: null });
  const lounge = fakeLounge();
  lounge._devices = () => devices;
  const { service, sent } = makeService({ lounge });
  service.start();

  lounge.emit('started', { deviceId: 'tv-1', videoId: 'abc', startedAt: '2026-08-02T20:00:00Z' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sent.length, 0);
});

test('a metadata failure is recorded and does not send a broken card', async () => {
  const { service, sent, lounge } = makeService({
    api: fakeApi({
      resolveVideo: async () => {
        throw new Error('quota exceeded');
      },
    }),
  });
  service.start();

  lounge.emit('started', { deviceId: 'tv-1', videoId: 'abc', startedAt: '2026-08-02T20:00:00Z' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sent.length, 0);
  assert.match(service.statusSnapshot().message, /quota exceeded/);
});

test('a stop for a video that is not on screen closes nothing', async () => {
  const { service, sent, lounge } = makeService();
  service.start();

  lounge.emit('stopped', {
    deviceId: 'tv-1', videoId: 'never-aired', watchedSeconds: 5,
    startedAt: '2026-08-02T20:00:00Z', endedAt: '2026-08-02T20:00:05Z',
  });

  assert.deepEqual(sent, []);
});

test('the autoplay prefetch reaches the API client', async () => {
  const { service, lounge, api } = makeService();
  service.start();

  lounge.emit('prefetch', { deviceId: 'tv-1', videoId: 'next-one' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(api.resolved.some((entry) => entry.videoId === 'next-one' && entry.prefetch));
});

// ------------------------------------------------------------- multi-device

test('the most-recent TV wins by default', async () => {
  const { service, lounge } = makeService();
  lounge._sessions.push(
    { deviceId: 'living-room', videoId: 'older', startedAt: '2026-08-02T20:00:00Z' },
    { deviceId: 'theater', videoId: 'newer', startedAt: '2026-08-02T20:10:00Z' },
  );

  const result = await service.pushManualPreview({ send: () => {} });
  assert.equal(result.videoId, 'newer');
});

test('a preferred TV wins even when another started later', async () => {
  const { service, lounge, store } = makeService();
  store.saveDevice({ id: 'living-room', label: 'Living Room' });
  store.updateSettings({ multiDevice: 'preferred', preferredDeviceId: 'living-room' });
  lounge._sessions.push(
    { deviceId: 'living-room', videoId: 'older', startedAt: '2026-08-02T20:00:00Z' },
    { deviceId: 'theater', videoId: 'newer', startedAt: '2026-08-02T20:10:00Z' },
  );

  const result = await service.pushManualPreview({ send: () => {} });
  assert.equal(result.videoId, 'older');
});

// ------------------------------------------------------------ manual push

test('a manual push falls back to last played when nothing is on', async () => {
  const { service, store } = makeService();
  store.recordSession({
    deviceId: 'tv-1', videoId: 'yesterday', watchedSeconds: 600,
    startedAt: '2026-08-01T20:00:00Z', endedAt: '2026-08-01T20:10:00Z', completed: false,
  });

  const sent = [];
  const result = await service.pushManualPreview({ send: (payload) => sent.push(payload) });

  assert.equal(result.ok, true);
  assert.equal(result.mode, 'last-played');
  assert.equal(sent[0].youtube.mode, 'last-played');
  assert.equal(sent[0].persistent, false, 'a preview must dismiss itself');
});

test('a manual push prefers a provisional Lounge video over stale history', async () => {
  const { service, store, lounge } = makeService();
  store.recordSession({
    deviceId: 'tv-1', videoId: 'yesterday', watchedSeconds: 600,
    startedAt: '2026-08-01T20:00:00Z', endedAt: '2026-08-01T20:10:00Z', completed: false,
  });
  lounge._current.push({
    deviceId: 'tv-1',
    videoId: 'abc',
    startedAt: '2026-08-02T20:00:00Z',
    provisional: true,
    state: 'Playing',
  });

  const sent = [];
  const result = await service.pushManualPreview({ send: (payload) => sent.push(payload) });

  assert.equal(result.ok, true);
  assert.equal(result.mode, 'playing');
  assert.equal(result.videoId, 'abc');
  assert.equal(sent[0].youtube.mode, 'playing');
});

test('a video still listed on a stopped TV is pushed as last played, not now playing', async () => {
  // The reported bug: the Settings button aired a NOW PLAYING card with a
  // running elapsed clock for a video that had finished hours earlier but was
  // still sitting on the Apple TV screen.
  const { service, lounge } = makeService();
  lounge._current.push({
    deviceId: 'tv-1',
    videoId: 'finished',
    startedAt: '2026-08-02T17:00:00.000Z',
    provisional: true,
    state: 'Stopped',
    positionSeconds: 9304,
    durationSeconds: 9304,
    watchedSeconds: 9304,
  });

  const sent = [];
  const result = await service.pushManualPreview({ send: (payload) => sent.push(payload) });

  assert.equal(result.ok, true);
  assert.equal(result.mode, 'last-played');
  assert.equal(result.videoId, 'finished');
  assert.equal(sent[0].youtube.mode, 'last-played');
});

test('a paused video is last played rather than a card with a ticking clock', async () => {
  const { service, lounge } = makeService();
  lounge._current.push({
    deviceId: 'tv-1',
    videoId: 'paused',
    startedAt: '2026-08-02T19:00:00.000Z',
    provisional: false,
    state: 'Paused',
    positionSeconds: 300,
    durationSeconds: 600,
    watchedSeconds: 300,
  });

  const sent = [];
  const result = await service.pushManualPreview({ send: (payload) => sent.push(payload) });

  assert.equal(result.ok, true);
  assert.equal(result.mode, 'last-played');
  assert.equal(sent[0].youtube.mode, 'last-played');
});

test('asking for now-playing while the TV sits on a stopped video is an error', async () => {
  const { service, lounge } = makeService();
  lounge._current.push({
    deviceId: 'tv-1',
    videoId: 'finished',
    startedAt: '2026-08-02T17:00:00.000Z',
    provisional: true,
    state: 'Stopped',
    positionSeconds: 9304,
    durationSeconds: 9304,
  });

  const result = await service.pushManualPreview({
    requestedMode: 'now-playing',
    send: () => {},
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /Nothing is playing/);
});

test('last-played prefers the TV current video over a days-old history row', async () => {
  const { service, store, lounge } = makeService();
  store.recordSession({
    deviceId: 'tv-1', videoId: 'four-days-ago', watchedSeconds: 300,
    startedAt: '2026-08-15T04:47:10.599Z', endedAt: '2026-08-15T04:55:31.477Z',
  });
  lounge._current.push({
    deviceId: 'tv-1',
    videoId: 'watched-today',
    startedAt: '2026-08-20T01:00:00.000Z',
    provisional: true,
    state: 'Stopped',
    positionSeconds: 120,
    durationSeconds: 600,
  });

  const sent = [];
  const result = await service.pushManualPreview({
    requestedMode: 'last-played',
    send: (payload) => sent.push(payload),
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, 'last-played');
  assert.equal(result.videoId, 'watched-today');
  assert.equal(store.lastPlayed().videoId, 'watched-today');
});

test('last-played still uses history when the TV is idle', async () => {
  const { service, store } = makeService();
  store.recordSession({
    deviceId: 'tv-1', videoId: 'yesterday', watchedSeconds: 600,
    startedAt: '2026-08-01T20:00:00Z', endedAt: '2026-08-01T20:10:00Z',
  });

  const result = await service.pushManualPreview({
    requestedMode: 'last-played',
    send: () => {},
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, 'last-played');
  assert.equal(result.videoId, 'yesterday');
});

test('an observed Stopped watch is recorded without airing a card', () => {
  const { service, store, lounge, sent } = makeService();
  service.start();

  lounge.emit('observed', {
    deviceId: 'tv-1',
    videoId: 'watched-today',
    startedAt: '2026-08-20T01:00:00.000Z',
    endedAt: '2026-08-20T01:10:00.000Z',
    watchedSeconds: 90,
    positionSeconds: 120,
    durationSeconds: 600,
  });

  assert.deepEqual(sent, []);
  assert.equal(store.lastPlayed().videoId, 'watched-today');
});

test('asking for now-playing when nothing is on is an error, not a stale card', async () => {
  const { service } = makeService();
  const result = await service.pushManualPreview({ requestedMode: 'now-playing', send: () => {} });

  assert.equal(result.ok, false);
  assert.match(result.error, /Nothing is playing/);
});

test('with no history at all the push explains itself', async () => {
  const { service } = makeService();
  const result = await service.pushManualPreview({ send: () => {} });

  assert.equal(result.ok, false);
  assert.match(result.error, /no watch history/);
});

test('a manual push is always dismissible even while a video is playing', async () => {
  const { service, lounge } = makeService();
  lounge._sessions.push({ deviceId: 'tv-1', videoId: 'abc', startedAt: '2026-08-02T20:00:00Z' });

  const sent = [];
  await service.pushManualPreview({ send: (payload) => sent.push(payload) });

  assert.equal(sent[0].persistent, false);
  assert.ok(sent[0].displaySeconds > 0);
});

// -------------------------------------------------- reconnect / keep-alive

test('a hard device disconnect schedules a reconnect', async () => {
  const lounge = fakeLounge();
  let connects = 0;
  lounge.connectDevice = async () => {
    connects += 1;
    return { ok: true, screenName: 'Theater' };
  };
  const { service, store } = makeService({ lounge });
  store.saveDevice({
    id: 'tv-1',
    label: 'Movie Theater',
    screenId: 'screen-1',
    enabled: true,
    status: 'linked',
  });
  service.start();
  lounge.emit('ready');
  await new Promise((resolve) => setTimeout(resolve, 20));
  const afterReady = connects;

  lounge.emit('device-disconnected', { deviceId: 'tv-1', reason: 'unreachable' });
  assert.equal(service._reconnectState.has('tv-1'), true);

  await new Promise((resolve) => setTimeout(resolve, 2100));
  assert.ok(connects > afterReady, 'reconnect should call connectDevice again');
  service.stop();
});

test('needs-relink does not keep retrying reconnect', async () => {
  const lounge = fakeLounge();
  const { service, store } = makeService({ lounge });
  store.saveDevice({
    id: 'tv-1',
    label: 'Movie Theater',
    screenId: 'screen-1',
    enabled: true,
    status: 'linked',
  });
  service.start();
  lounge.emit('device-disconnected', { deviceId: 'tv-1', reason: 'needs-relink' });

  assert.equal(store.getDevice('tv-1').status, 'needs-relink');
  assert.equal(service._reconnectState.has('tv-1'), false);
  service.stop();
});

test('keep-alive not-connected schedules a reconnect', async () => {
  const lounge = fakeLounge();
  lounge.pollNowPlaying = async () => ({
    ok: true,
    devices: [{ deviceId: 'tv-1', ok: false, error: 'not-connected' }],
  });
  const { service, store } = makeService({ lounge });
  store.saveDevice({
    id: 'tv-1',
    label: 'Movie Theater',
    screenId: 'screen-1',
    enabled: true,
    status: 'linked',
  });
  service.start();
  await service._keepAlivePoll();

  assert.equal(service._reconnectState.has('tv-1'), true);
  service.stop();
});

test('keep-alive re-binds a device the agent no longer has a session for', async () => {
  // The sidecar pops a dead session, so the TV vanishes from poll-all rather
  // than reporting not-connected. An empty list must not read as healthy.
  const lounge = fakeLounge();
  lounge.pollNowPlaying = async () => ({ ok: true, devices: [] });
  const { service, store } = makeService({ lounge });
  store.saveDevice({
    id: 'tv-1',
    label: 'Movie Theater',
    screenId: 'screen-1',
    enabled: true,
    status: 'linked',
  });
  service.start();
  await service._keepAlivePoll();

  assert.equal(service._reconnectState.has('tv-1'), true);
  service.stop();
});

test('keep-alive leaves a device the agent reports as healthy alone', async () => {
  const lounge = fakeLounge();
  lounge.pollNowPlaying = async () => ({
    ok: true,
    devices: [{ deviceId: 'tv-1', ok: true }],
  });
  const { service, store } = makeService({ lounge });
  store.saveDevice({
    id: 'tv-1',
    label: 'Movie Theater',
    screenId: 'screen-1',
    enabled: true,
    status: 'linked',
  });
  service.start();
  await service._keepAlivePoll();

  assert.equal(service._reconnectState.has('tv-1'), false);
  service.stop();
});

test('keep-alive ignores a disabled device that the agent dropped', async () => {
  const lounge = fakeLounge();
  lounge.pollNowPlaying = async () => ({ ok: true, devices: [] });
  const { service, store } = makeService({ lounge });
  store.saveDevice({
    id: 'tv-1',
    label: 'Spare TV',
    screenId: 'screen-1',
    enabled: false,
    status: 'linked',
  });
  service.start();
  await service._keepAlivePoll();

  assert.equal(service._reconnectState.has('tv-1'), false);
  service.stop();
});

test('keep-alive re-binds a listed device whose bind has died', async () => {
  // Worst case: the sidecar task is alive, so the device is reported and looks
  // healthy, but its bind is dead and get_now_playing() raises. Matching only
  // `not-connected` left this device silent until a container restart.
  const lounge = fakeLounge();
  lounge.pollNowPlaying = async () => ({
    ok: true,
    devices: [{ deviceId: 'tv-1', ok: false, error: 'Session closed' }],
  });
  const { service, store } = makeService({ lounge });
  store.saveDevice({
    id: 'tv-1',
    label: 'Movie Theater',
    screenId: 'screen-1',
    enabled: true,
    status: 'linked',
  });
  service.start();
  await service._keepAlivePoll();

  assert.equal(service._reconnectState.has('tv-1'), true);
  service.stop();
});

test('keep-alive hangs up a lounge session the store no longer knows about', async () => {
  // A deleted or re-registered TV used to leave its sidecar task running, still
  // re-binding the same screen, so the live device never received an event.
  const hungUp = [];
  const lounge = fakeLounge();
  lounge.disconnectDevice = async (deviceId) => {
    hungUp.push(deviceId);
    return { ok: true };
  };
  lounge.pollNowPlaying = async () => ({
    ok: true,
    devices: [{ deviceId: 'tv-new', ok: true }, { deviceId: 'tv-old', ok: true }],
  });
  const { service, store } = makeService({ lounge });
  store.saveDevice({
    id: 'tv-new',
    label: 'Movie Theater',
    screenId: 'screen-1',
    enabled: true,
    status: 'linked',
  });
  service.start();
  await service._keepAlivePoll();

  assert.deepEqual(hungUp, ['tv-old']);
  assert.equal(service._reconnectState.has('tv-new'), false);
  service.stop();
});

// ---------------------------------------------------------- device linking

test('forgetting a device disconnects its agent session before dropping the row', async () => {
  const hungUp = [];
  const lounge = fakeLounge();
  lounge.disconnectDevice = async (deviceId) => {
    hungUp.push(deviceId);
    return { ok: true };
  };
  const { service, store } = makeService({ lounge });
  store.saveDevice({ id: 'tv-1', label: 'Movie Theater', screenId: 'screen-1', status: 'linked' });

  assert.equal(await service.forgetDevice('tv-1'), true);
  assert.deepEqual(hungUp, ['tv-1']);
  assert.ok(!store.getDevice('tv-1'));
});

test('pausing a device releases the screen instead of only flipping the flag', async () => {
  const hungUp = [];
  const lounge = fakeLounge();
  lounge.disconnectDevice = async (deviceId) => {
    hungUp.push(deviceId);
    return { ok: true };
  };
  const { service, store } = makeService({ lounge });
  store.saveDevice({
    id: 'tv-1',
    label: 'Movie Theater',
    screenId: 'screen-1',
    enabled: true,
    status: 'linked',
  });

  await service.setDeviceEnabled('tv-1', false);
  assert.deepEqual(hungUp, ['tv-1']);
  assert.equal(store.getDevice('tv-1').enabled, false);
});

test('re-linking a TV that is already linked replaces the earlier row', async () => {
  // Two rows for one screen would fight over a single Lounge bind.
  const hungUp = [];
  const lounge = fakeLounge();
  lounge.disconnectDevice = async (deviceId) => {
    hungUp.push(deviceId);
    return { ok: true };
  };
  lounge.pairWithScreenId = async (id, screenId) => ({ ok: true, screenId, authState: { t: 3 } });
  const { service, store } = makeService({ lounge });
  store.saveDevice({
    id: 'tv-old',
    label: 'Movie Theater',
    screenId: 'screen-1',
    enabled: true,
    status: 'linked',
  });

  const result = await service.linkDevice({ label: 'Movie Theater', screenId: 'screen-1' });
  assert.equal(result.ok, true);
  assert.ok(!store.getDevice('tv-old'));
  assert.deepEqual(hungUp, ['tv-old']);
  assert.equal(store.listDevices().filter((d) => d.screenId === 'screen-1').length, 1);
});

test('linking stores the device with its token encrypted at rest', async () => {
  const { service, store, config } = makeService();

  const result = await service.linkDevice({ label: 'Movie Theater', pairingCode: '123456789012' });
  assert.equal(result.ok, true);

  const [device] = store.publicDevices();
  assert.equal(device.label, 'Movie Theater');
  assert.equal(device.hasToken, true);
  assert.equal(device.authState, undefined, 'the token must never leave the bridge');

  const raw = fs.readFileSync(config.youtube.devicesPath, 'utf8');
  assert.doesNotMatch(raw, /"t":\s*1/, 'the token must not be readable on disk');
});

test('a failed link leaves no half-created device behind', async () => {
  const lounge = fakeLounge();
  lounge.pairWithCode = async () => ({ ok: false, error: 'code-expired' });
  const { service, store } = makeService({ lounge });

  const result = await service.linkDevice({ label: 'Bad', pairingCode: '000' });

  assert.equal(result.ok, false);
  assert.match(result.error, /expired/);
  assert.deepEqual(store.publicDevices(), []);
});

test('a link that fails because the agent is broken says what is broken', async () => {
  const lounge = fakeLounge();
  lounge.pairWithCode = async () => ({ ok: false, error: 'pyytlounge-missing' });
  lounge.unavailableReason = () => 'The bridge could not load the pyytlounge library. (ImportError: …)';
  const { service } = makeService({ lounge });

  const result = await service.linkDevice({ label: 'Theater', pairingCode: '123456789012' });

  assert.equal(result.ok, false);
  assert.match(result.error, /ImportError/);
});

test('a revoked link surfaces as needs-relink rather than silence', async () => {
  const lounge = fakeLounge();
  lounge.connectDevice = async () => ({ ok: false, error: 'needs-relink' });
  const { service, store } = makeService({ lounge });

  await service.linkDevice({ label: 'Theater', pairingCode: '123456789012' });

  const [device] = store.publicDevices();
  assert.equal(device.status, 'needs-relink');
  assert.deepEqual(service.statusSnapshot().needsRelink, ['Theater']);
});

test('re-linking clears the old failure reason instead of pinning it forever', async () => {
  const lounge = fakeLounge();
  lounge.connectDevice = async () => ({ ok: false, error: 'needs-relink' });
  const { service, store } = makeService({ lounge });

  await service.linkDevice({ label: 'Theater', pairingCode: '123456789012' });
  const [failed] = store.publicDevices();
  assert.equal(failed.status, 'needs-relink');
  assert.equal(failed.statusDetail, 'needs-relink');

  lounge.connectDevice = async () => ({ ok: true });
  store.markDeviceStatus(failed.id, 'linked', null);

  const [healed] = store.publicDevices();
  assert.equal(healed.status, 'linked');
  assert.equal(healed.statusDetail, null, 'a healthy device must not report a stale failure');
});

test('a refreshed token records when it expires so it is not refreshed every pass', async () => {
  const { service, lounge, store } = makeService();
  await service.linkDevice({ label: 'Theater', pairingCode: '123456789012' });
  service.start();
  const [device] = store.publicDevices();

  lounge.emit('auth', {
    deviceId: device.id,
    authState: { version: 0, screenId: 'screen-x', loungeIdToken: 'fresh' },
    expiry: 1785000000,
  });

  assert.equal(store.publicDevices()[0].tokenExpiry, 1785000000);
});

test('discovery marks TVs that are already linked', async () => {
  const { service, store } = makeService();
  store.saveDevice({ id: 'existing', label: 'Theater', screenId: 'screen-x' });

  const result = await service.discover();

  assert.equal(result.ok, true);
  assert.equal(result.devices[0].alreadyLinked, true);
  assert.equal(result.devices[0].name, 'AppleTV/1');
});

test('removing a device forgets it entirely', async () => {
  const { service, store } = makeService();
  await service.linkDevice({ label: 'Theater', pairingCode: '123456789012' });
  const [device] = store.publicDevices();

  assert.equal(store.removeDevice(device.id), true);
  assert.deepEqual(store.publicDevices(), []);
  assert.equal(store.removeDevice(device.id), false);
});

// ---------------------------------------------------------------- history

test('history is capped so the file cannot grow without bound', () => {
  const { store } = makeService();
  store.updateSettings({ historyLimit: 10 });

  for (let i = 0; i < 40; i += 1) {
    store.recordSession({
      deviceId: 'tv-1', videoId: `v${i}`, watchedSeconds: 60,
      startedAt: new Date(Date.parse('2026-08-02T00:00:00Z') + i * 60000).toISOString(),
      endedAt: new Date(Date.parse('2026-08-02T00:01:00Z') + i * 60000).toISOString(),
    });
  }

  const history = store.history({ limit: 100 });
  assert.ok(history.length <= 10, `history grew to ${history.length}`);
  assert.equal(history[0].videoId, 'v39', 'newest first');
});

test('last played can be scoped to one TV', () => {
  const { store } = makeService();
  store.recordSession({
    deviceId: 'theater', videoId: 'theater-one', watchedSeconds: 60,
    startedAt: '2026-08-02T20:00:00Z', endedAt: '2026-08-02T20:05:00Z',
  });
  store.recordSession({
    deviceId: 'living-room', videoId: 'living-one', watchedSeconds: 60,
    startedAt: '2026-08-02T21:00:00Z', endedAt: '2026-08-02T21:05:00Z',
  });

  assert.equal(store.lastPlayed().videoId, 'living-one');
  assert.equal(store.lastPlayed('theater').videoId, 'theater-one');
});

// ---------------------------------------------------------------- settings

test('settings are clamped to sane values rather than trusted', () => {
  const settings = sanitiseSettings({
    descriptionLines: 99,
    confirmSeconds: -4,
    dismissSeconds: 100000,
    historyLimit: 1,
    multiDevice: 'whatever',
  });

  assert.equal(settings.descriptionLines, 6);
  assert.equal(settings.confirmSeconds, 0);
  assert.equal(settings.dismissSeconds, 600);
  assert.equal(settings.historyLimit, 10);
  assert.equal(settings.multiDevice, 'most-recent');
});

test('settings survive a reload from disk', () => {
  const { store, config } = makeService();
  store.updateSettings({ showDislikes: false, dismissSeconds: 120 });

  const reopened = createYoutubeStore({ config });
  assert.equal(reopened.getSettings().showDislikes, false);
  assert.equal(reopened.getSettings().dismissSeconds, 120);
});

// ------------------------------------------------------------ registration

test('both YouTube commands are registered and content-checked correctly', () => {
  const registry = createCommandRegistry({
    getYoutubeStatus: () => ({ playing: true, videoId: 'abc' }),
  });
  const commands = registry.list();

  const nowPlaying = commands.find((command) => command.id === 'youtube.now-playing');
  const lastPlayed = commands.find((command) => command.id === 'youtube.last-played');

  assert.ok(nowPlaying, 'youtube.now-playing must be registered');
  assert.ok(lastPlayed, 'youtube.last-played must be registered');
  assert.equal(nowPlaying.schedulable, true);
  assert.equal(nowPlaying.supportsContentCheck, true);
  assert.equal(nowPlaying.variableDuration, false);
  assert.equal(nowPlaying.route, '/api/push/youtube-now-playing');
  // Push tile posts no mode (auto); the scheduler forces one by command id.
  assert.equal(nowPlaying.body?.mode, undefined);
  assert.equal(nowPlaying.pushable, true);
  assert.equal(lastPlayed.body.mode, 'last-played');
  assert.equal(lastPlayed.pushable, false);
  assert.equal(lastPlayed.supportsContentCheck, true);
});

test('the content check follows whether a video is actually playing', () => {
  const playing = createCommandRegistry({ getYoutubeStatus: () => ({ playing: true }) });
  const idle = createCommandRegistry({ getYoutubeStatus: () => ({ playing: false }) });

  assert.equal(playing.hasContent('youtube.now-playing'), true);
  assert.equal(idle.hasContent('youtube.now-playing'), false);
});

test('the status snapshot reports enough to render the settings card', async () => {
  const { service, store } = makeService();
  await service.linkDevice({ label: 'Theater', pairingCode: '123456789012' });

  const status = service.statusSnapshot();
  assert.equal(status.enabled, true);
  assert.equal(status.configured, true);
  assert.equal(status.hasApiKey, true);
  assert.equal(status.playing, false);
  assert.equal(status.devices.length, 1);
  assert.ok(status.cache);
  assert.ok(status.settings);
  assert.deepEqual(status.needsRelink, []);
  assert.equal(store.publicDevices()[0].label, 'Theater');
});
