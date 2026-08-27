const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  VIDEO_STATS_TTL_MS,
  CHANNEL_TTL_MS,
  CHANNEL_TTL_LARGE_MS,
  NEGATIVE_TTL_MS,
  MAX_IDS_PER_REQUEST,
  pickThumbnail,
  createYoutubeApi,
} = require('../src/youtube-api');

const {
  cleanDescription,
  abbreviateCount,
  parseIso8601Duration,
  formatClock,
} = require('../src/youtube-text');

const DAY = 24 * 60 * 60 * 1000;

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'yt-api-'));
}

function videoItem(id, overrides = {}) {
  return {
    id,
    snippet: {
      title: `Video ${id}`,
      description: 'A description.',
      publishedAt: '2024-03-12T14:00:00Z',
      channelId: overrides.channelId || 'UC-veritasium',
      channelTitle: 'Veritasium',
      liveBroadcastContent: 'none',
      thumbnails: {
        high: { url: `https://i.ytimg.com/vi/${id}/hq.jpg`, width: 480, height: 360 },
        maxres: { url: `https://i.ytimg.com/vi/${id}/maxres.jpg`, width: 1280, height: 720 },
      },
      ...(overrides.snippet || {}),
    },
    statistics: { viewCount: '4218774', likeCount: '312401', ...(overrides.statistics || {}) },
    contentDetails: { duration: 'PT28M31S', ...(overrides.contentDetails || {}) },
  };
}

function channelItem(id, overrides = {}) {
  return {
    id,
    snippet: {
      title: 'Veritasium',
      thumbnails: { high: { url: 'https://yt3.ggpht.com/avatar.jpg' } },
    },
    statistics: { subscriberCount: '16832904', ...(overrides.statistics || {}) },
    ...overrides,
  };
}

/**
 * A fetch double that records every call so the tests can assert on the exact
 * number of network round trips, which is the whole point of §6.
 */
function makeFetch({ videos = {}, channels = {}, dislikes = {} } = {}) {
  const calls = [];
  const impl = async (url) => {
    const target = String(url);
    calls.push(target);
    if (target.includes('/videos?') || target.includes('/videos')) {
      const ids = new URL(target).searchParams.get('id').split(',');
      return {
        ok: true,
        status: 200,
        json: async () => ({ items: ids.map((id) => videos[id]).filter(Boolean) }),
      };
    }
    if (target.includes('/channels')) {
      const ids = new URL(target).searchParams.get('id').split(',');
      return {
        ok: true,
        status: 200,
        json: async () => ({ items: ids.map((id) => channels[id]).filter(Boolean) }),
      };
    }
    if (target.includes('returnyoutubedislike')) {
      const id = new URL(target).searchParams.get('videoId');
      if (!(id in dislikes)) {
        return { ok: false, status: 404, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => ({ dislikes: dislikes[id] }) };
    }
    // A thumbnail or avatar download.
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff]).buffer,
    };
  };
  impl.calls = calls;
  impl.api = () => calls.filter((url) => url.includes('googleapis.com'));
  impl.images = () => calls.filter((url) => url.includes('ytimg') || url.includes('ggpht'));
  return impl;
}

function makeApi(fetchImpl, {
  clock = { t: Date.parse('2026-08-02T18:00:00Z') },
  imageRetryDelays,
} = {}) {
  const dir = tempDir();
  const api = createYoutubeApi({
    config: {
      youtube: {
        apiKey: 'test-key',
        cachePath: path.join(dir, 'cache.json'),
        thumbnailCachePath: path.join(dir, 'thumbs'),
      },
    },
    now: () => clock.t,
    fetchImpl,
    ...(imageRetryDelays ? { imageRetryDelays } : {}),
    // Never wait out a real backoff; the schedule is asserted separately.
    sleepImpl: async () => {},
  });
  return { api, clock, dir };
}

// -------------------------------------------------------------- text utils

test('the description cleaner strips the boilerplate a card cannot show', () => {
  const raw = [
    'A look at the Deep Space Network.',
    '',
    'Subscribe: https://youtube.com/veritasium',
    'Follow me on Twitter: www.twitter.com/veritasium',
    '',
    '0:00 Intro',
    '2:14 The problem',
    '12:40 The fix',
    '',
    'This video is sponsored by Brilliant.',
    'Patreon: https://patreon.com/veritasium',
  ].join('\n');

  const clean = cleanDescription(raw);
  assert.match(clean, /Deep Space Network/);
  assert.doesNotMatch(clean, /https?:\/\//);
  assert.doesNotMatch(clean, /www\./);
  assert.doesNotMatch(clean, /0:00/);
  assert.doesNotMatch(clean, /Patreon/i);
});

test('a description of nothing but links cleans to an empty string', () => {
  assert.equal(cleanDescription('https://a.com\nhttps://b.com\nSubscribe: https://c.com'), '');
  assert.equal(cleanDescription(null), '');
});

test('a leading subscribe banner does not wipe the pitch below it', () => {
  // Why Files (and many others) put SUBSCRIBE above the real copy; breaking
  // on the first boilerplate marker left the card with a blank description.
  const clean = cleanDescription([
    'SUBSCRIBE for weekly mysteries:',
    'https://youtube.com/thewhyfiles',
    '',
    'In 1974, Carl Higdon claimed an alien took him aboard a craft.',
    '',
    'Follow me on Instagram: @thewhyfiles',
  ].join('\n'));
  assert.match(clean, /Carl Higdon/);
  assert.doesNotMatch(clean, /SUBSCRIBE/i);
  assert.doesNotMatch(clean, /Instagram/i);
});

test('counts abbreviate the way a viewer reads them', () => {
  assert.equal(abbreviateCount(947), '947');
  assert.equal(abbreviateCount(9481), '9,481');
  assert.equal(abbreviateCount(312401), '312K');
  assert.equal(abbreviateCount(4218774), '4.2M');
  assert.equal(abbreviateCount(null), null);
});

test('ISO 8601 durations parse into seconds and back into a clock', () => {
  assert.equal(parseIso8601Duration('PT28M31S'), 1711);
  assert.equal(parseIso8601Duration('PT1H2M4S'), 3724);
  assert.equal(parseIso8601Duration('P0D'), 0);
  assert.equal(parseIso8601Duration(null), 0);
  assert.equal(formatClock(1711), '28:31');
  assert.equal(formatClock(3724), '1:02:04');
});

// ------------------------------------------------------------ call counting

test('the first play of a video costs exactly three network calls', async () => {
  const fetchImpl = makeFetch({
    videos: { abc: videoItem('abc') },
    channels: { 'UC-veritasium': channelItem('UC-veritasium') },
    dislikes: { abc: 1204 },
  });
  const { api } = makeApi(fetchImpl);

  const video = await api.resolveVideo('abc');

  // videos.list + channels.list + Return YouTube Dislike. Nothing else.
  assert.equal(fetchImpl.api().length, 2);
  assert.equal(fetchImpl.calls.filter((u) => u.includes('returnyoutubedislike')).length, 1);
  assert.equal(video.title, 'Video abc');
  assert.equal(video.viewCount, 4218774);
  assert.equal(video.dislikeCount, 1204);
  assert.equal(video.subscriberCount, 16832904);
  assert.equal(video.durationSeconds, 1711);
});

test('replaying the same video inside the TTLs costs nothing', async () => {
  const fetchImpl = makeFetch({
    videos: { abc: videoItem('abc') },
    channels: { 'UC-veritasium': channelItem('UC-veritasium') },
    dislikes: { abc: 1204 },
  });
  const { api, clock } = makeApi(fetchImpl);

  await api.resolveVideo('abc');
  const before = fetchImpl.calls.length;

  clock.t += 60 * 60 * 1000;
  const again = await api.resolveVideo('abc');

  assert.equal(fetchImpl.calls.length, before, 'a cached replay must not touch the network');
  assert.equal(again.title, 'Video abc');
  assert.equal(again.dislikeCount, 1204);
});

test('a second video from the same channel skips the channel call', async () => {
  const fetchImpl = makeFetch({
    videos: { abc: videoItem('abc'), def: videoItem('def') },
    channels: { 'UC-veritasium': channelItem('UC-veritasium') },
    dislikes: { abc: 1204, def: 88 },
  });
  const { api } = makeApi(fetchImpl);

  await api.resolveVideo('abc');
  const apiBefore = fetchImpl.api().length;
  await api.resolveVideo('def');

  // Exactly one more Data API call: videos.list. The channel is already known.
  assert.equal(fetchImpl.api().length, apiBefore + 1);
  assert.ok(fetchImpl.api().at(-1).includes('/videos'));
});

test('past the stats TTL only the counters are re-fetched, never the core', async () => {
  const first = videoItem('abc');
  const fetchImpl = makeFetch({
    videos: { abc: first },
    channels: { 'UC-veritasium': channelItem('UC-veritasium') },
    dislikes: { abc: 1204 },
  });
  const { api, clock } = makeApi(fetchImpl);

  await api.resolveVideo('abc');
  first.statistics.viewCount = '9000000';

  clock.t += VIDEO_STATS_TTL_MS + 1000;
  const refreshed = await api.resolveVideo('abc');

  assert.equal(refreshed.viewCount, 9000000, 'the counter must update');
  // One videos.list; the channel and the dislike estimate are still fresh.
  assert.equal(fetchImpl.api().filter((u) => u.includes('/videos')).length, 2);
  assert.equal(fetchImpl.api().filter((u) => u.includes('/channels')).length, 1);
});

test('a big channel is cached far longer than a small one', async () => {
  const big = channelItem('UC-big');
  const small = channelItem('UC-small', { statistics: { subscriberCount: '4200' } });
  const fetchImpl = makeFetch({
    videos: {
      a: videoItem('a', { channelId: 'UC-big' }),
      b: videoItem('b', { channelId: 'UC-small' }),
    },
    channels: { 'UC-big': big, 'UC-small': small },
  });
  const { api, clock } = makeApi(fetchImpl);

  await api.resolveVideo('a', { includeDislikes: false });
  await api.resolveVideo('b', { includeDislikes: false });
  const before = fetchImpl.api().filter((u) => u.includes('/channels')).length;
  assert.equal(before, 2);

  // Eight days: past the 7-day default, well inside the 30-day large-channel TTL.
  clock.t += CHANNEL_TTL_MS + DAY;
  await api.resolveVideo('a', { includeDislikes: false });
  await api.resolveVideo('b', { includeDislikes: false });

  const channelCalls = fetchImpl.api().filter((u) => u.includes('/channels'));
  assert.equal(channelCalls.length, 3, 'only the small channel should be re-fetched');
  assert.ok(channelCalls.at(-1).includes('UC-small'));
  assert.ok(CHANNEL_TTL_LARGE_MS > CHANNEL_TTL_MS);
});

test('ids are batched fifty at a time', async () => {
  const videos = {};
  for (let i = 0; i < 120; i += 1) {
    videos[`v${i}`] = videoItem(`v${i}`);
  }
  const fetchImpl = makeFetch({ videos });
  const { api } = makeApi(fetchImpl);

  const results = await api.fetchVideos(Object.keys(videos));

  assert.equal(results.length, 120);
  const videoCalls = fetchImpl.api().filter((u) => u.includes('/videos'));
  assert.equal(videoCalls.length, 3);
  for (const call of videoCalls) {
    const ids = new URL(call).searchParams.get('id').split(',');
    assert.ok(ids.length <= MAX_IDS_PER_REQUEST);
  }
});

test('duplicate ids in one batch are requested once', async () => {
  const fetchImpl = makeFetch({ videos: { abc: videoItem('abc') } });
  const { api } = makeApi(fetchImpl);

  const results = await api.fetchVideos(['abc', 'abc', 'abc', null, '']);

  assert.equal(results.length, 1);
  assert.equal(fetchImpl.api().length, 1);
});

// ------------------------------------------------------------ negative cache

test('a private video is negatively cached for a day, then retried', async () => {
  const fetchImpl = makeFetch({ videos: {} });
  const { api, clock } = makeApi(fetchImpl);

  const first = await api.resolveVideo('gone', { fallbackTitle: 'From the TV' });
  assert.equal(first.missing, true);
  assert.equal(first.title, 'From the TV', 'the lounge title still fills the card');
  const after = fetchImpl.api().length;

  await api.resolveVideo('gone');
  assert.equal(fetchImpl.api().length, after, 'a known-missing video must not be re-requested');

  clock.t += NEGATIVE_TTL_MS + 1000;
  await api.resolveVideo('gone');
  assert.equal(fetchImpl.api().length, after + 1, 'the negative entry expires after a day');
});

test('a network failure degrades the card instead of throwing', async () => {
  const fetchImpl = async () => {
    throw new Error('ECONNREFUSED');
  };
  const { api } = makeApi(fetchImpl);

  const video = await api.resolveVideo('abc', { fallbackTitle: 'Something' });

  assert.equal(video.degraded, true);
  assert.equal(video.missing, true);
  assert.equal(video.title, 'Something');
  assert.equal(video.viewCount, null);
});

test('a rejected key surfaces as degraded, not as a crash', async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, json: async () => ({}) });
  const { api } = makeApi(fetchImpl);

  const video = await api.resolveVideo('abc');
  assert.equal(video.degraded, true);
  assert.equal(api.stats().quotaUsedToday, 1, 'a rejected call still costs quota');
});

test('with no API key at all the resolver still returns a renderable card', async () => {
  const dir = tempDir();
  const api = createYoutubeApi({
    config: {
      youtube: {
        apiKey: '',
        cachePath: path.join(dir, 'cache.json'),
        thumbnailCachePath: path.join(dir, 'thumbs'),
      },
    },
    fetchImpl: async () => {
      throw new Error('should never be called');
    },
  });

  const video = await api.resolveVideo('abc', { fallbackTitle: 'Untitled' });
  assert.equal(video.title, 'Untitled');
  assert.equal(api.stats().hasApiKey, false);
});

// ------------------------------------------------------------------- dislikes

test('a missing dislike estimate is null, not zero', async () => {
  const fetchImpl = makeFetch({
    videos: { abc: videoItem('abc') },
    channels: { 'UC-veritasium': channelItem('UC-veritasium') },
    dislikes: {},
  });
  const { api } = makeApi(fetchImpl);

  const video = await api.resolveVideo('abc');
  assert.equal(video.dislikeCount, null);
});

test('dislikes can be turned off without touching the other two calls', async () => {
  const fetchImpl = makeFetch({
    videos: { abc: videoItem('abc') },
    channels: { 'UC-veritasium': channelItem('UC-veritasium') },
    dislikes: { abc: 1204 },
  });
  const { api } = makeApi(fetchImpl);

  const video = await api.resolveVideo('abc', { includeDislikes: false });

  assert.equal(video.dislikeCount, null);
  assert.equal(fetchImpl.calls.filter((u) => u.includes('returnyoutubedislike')).length, 0);
  assert.equal(fetchImpl.api().length, 2);
});

// ----------------------------------------------------------------- channels

test('a hidden subscriber count reads as absent rather than zero', async () => {
  const fetchImpl = makeFetch({
    videos: { abc: videoItem('abc') },
    channels: {
      'UC-veritasium': channelItem('UC-veritasium', {
        statistics: { subscriberCount: '0', hiddenSubscriberCount: true },
      }),
    },
  });
  const { api } = makeApi(fetchImpl);

  const video = await api.resolveVideo('abc', { includeDislikes: false });
  assert.equal(video.subscriberCount, null);
  assert.equal(video.hiddenSubscriberCount, true);
});

// --------------------------------------------------------------- thumbnails

test('the thumbnail ladder prefers maxres and falls back when it is absent', () => {
  assert.equal(pickThumbnail({
    default: { url: 'd' }, high: { url: 'h' }, maxres: { url: 'm' },
  }).url, 'm');
  assert.equal(pickThumbnail({ default: { url: 'd' }, high: { url: 'h' } }).url, 'h');
  assert.equal(pickThumbnail({}), null);
});

test('images are downloaded once and served from a local filename', async () => {
  const fetchImpl = makeFetch({
    videos: { abc: videoItem('abc') },
    channels: { 'UC-veritasium': channelItem('UC-veritasium') },
  });
  const { api, dir } = makeApi(fetchImpl);

  const video = await api.resolveVideo('abc', { includeDislikes: false });

  assert.match(video.thumbnailFile, /^[a-f0-9]{40}\.jpg$/);
  assert.match(video.avatarFile, /^[a-f0-9]{40}\.jpg$/);
  assert.ok(fs.existsSync(path.join(dir, 'thumbs', video.thumbnailFile)));
  const downloads = fetchImpl.images().length;

  await api.resolveVideo('abc', { includeDislikes: false });
  assert.equal(fetchImpl.images().length, downloads, 'a cached image must not re-download');
});

// A thumbnail that failed to download used to stay missing for the whole
// video: the payload can only carry a URL once the file exists locally, so the
// display had nothing to retry and the hero stayed empty until the next play.

test('a thumbnail download that fails once is retried rather than abandoned', async () => {
  const fetchImpl = makeFetch({
    videos: { abc: videoItem('abc') },
    channels: { 'UC-veritasium': channelItem('UC-veritasium') },
  });
  const base = fetchImpl;
  let failures = 1;
  const flaky = async (url, options) => {
    if (String(url).includes('maxres.jpg') && failures > 0) {
      failures -= 1;
      base.calls.push(String(url));
      throw new Error('ETIMEDOUT');
    }
    return base(url, options);
  };
  Object.assign(flaky, { calls: base.calls, api: base.api, images: base.images });
  const { api, dir } = makeApi(flaky);

  const video = await api.resolveVideo('abc', { includeDislikes: false });

  assert.ok(video.thumbnailFile, 'the retry must recover the artwork');
  assert.ok(fs.existsSync(path.join(dir, 'thumbs', video.thumbnailFile)));
});

test('a size that 404s falls back down the ladder instead of losing the art', async () => {
  const fetchImpl = makeFetch({
    videos: { abc: videoItem('abc') },
    channels: { 'UC-veritasium': channelItem('UC-veritasium') },
  });
  const base = fetchImpl;
  const withDeadMaxres = async (url, options) => {
    if (String(url).includes('maxres.jpg')) {
      base.calls.push(String(url));
      return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    }
    return base(url, options);
  };
  Object.assign(withDeadMaxres, { calls: base.calls, api: base.api, images: base.images });
  const { api } = makeApi(withDeadMaxres);

  const video = await api.resolveVideo('abc', { includeDislikes: false });

  assert.ok(video.thumbnailFile, 'the next size down must be used');
  // The reported dimensions have to describe the image we actually got.
  assert.equal(video.thumbnailWidth, 480);
  assert.equal(video.thumbnailHeight, 360);
  // A 404 is settled fact, so it must cost exactly one call, not three.
  assert.equal(base.calls.filter((url) => url.includes('maxres.jpg')).length, 1);
});

test('a truncated download is never left behind as a cached image', async () => {
  const fetchImpl = makeFetch({
    videos: { abc: videoItem('abc') },
    channels: { 'UC-veritasium': channelItem('UC-veritasium') },
  });
  const base = fetchImpl;
  const empty = async (url, options) => {
    if (String(url).includes('ytimg')) {
      base.calls.push(String(url));
      return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) };
    }
    return base(url, options);
  };
  Object.assign(empty, { calls: base.calls, api: base.api, images: base.images });
  const { api, dir } = makeApi(empty, { imageRetryDelays: [] });

  const video = await api.resolveVideo('abc', { includeDislikes: false });

  assert.equal(video.thumbnailFile, null);
  // Only the avatar. An empty file here would satisfy the cache check forever.
  assert.deepEqual(fs.readdirSync(path.join(dir, 'thumbs')), [video.avatarFile]);
});

test('a card built without artwork still knows where to find it later', async () => {
  const fetchImpl = makeFetch({
    videos: { abc: videoItem('abc') },
    channels: { 'UC-veritasium': channelItem('UC-veritasium') },
  });
  const base = fetchImpl;
  let offline = true;
  const flaky = async (url, options) => {
    if (String(url).includes('ytimg') && offline) {
      base.calls.push(String(url));
      throw new Error('ENETUNREACH');
    }
    return base(url, options);
  };
  Object.assign(flaky, { calls: base.calls, api: base.api, images: base.images });
  const { api } = makeApi(flaky, { imageRetryDelays: [] });

  const video = await api.resolveVideo('abc', { includeDislikes: false });
  assert.equal(video.thumbnailFile, null);
  assert.deepEqual(video.thumbnailCandidateUrls, [
    'https://i.ytimg.com/vi/abc/maxres.jpg',
    'https://i.ytimg.com/vi/abc/hq.jpg',
  ]);

  // The network comes back; the same URLs fill the card in without new quota.
  offline = false;
  const apiCallsBefore = base.api().length;
  const { file } = await api.cacheFirstImage(
    video.thumbnailCandidateUrls.map((url) => ({ url })),
  );

  assert.ok(file);
  assert.equal(base.api().length, apiCallsBefore, 'a backfill must not cost a Data API call');
});

test('the prune drops stale thumbnails but keeps channel avatars', async () => {
  const fetchImpl = makeFetch({
    videos: { abc: videoItem('abc') },
    channels: { 'UC-veritasium': channelItem('UC-veritasium') },
  });
  const { api, clock, dir } = makeApi(fetchImpl);

  const video = await api.resolveVideo('abc', { includeDislikes: false });
  const thumbs = path.join(dir, 'thumbs');
  assert.equal(fs.readdirSync(thumbs).length, 2);

  clock.t += 100 * DAY;
  const stale = new Date(clock.t - 100 * DAY);
  for (const name of fs.readdirSync(thumbs)) {
    fs.utimesSync(path.join(thumbs, name), stale, stale);
  }

  const removed = api.pruneThumbnails(90);
  assert.equal(removed, 1);
  assert.deepEqual(fs.readdirSync(thumbs), [video.avatarFile]);
});

// -------------------------------------------------------------- persistence

test('the cache survives a restart, so a reboot costs no quota', async () => {
  const fetchImpl = makeFetch({
    videos: { abc: videoItem('abc') },
    channels: { 'UC-veritasium': channelItem('UC-veritasium') },
    dislikes: { abc: 1204 },
  });
  const dir = tempDir();
  const clock = { t: Date.parse('2026-08-02T18:00:00Z') };
  const config = {
    youtube: {
      apiKey: 'test-key',
      cachePath: path.join(dir, 'cache.json'),
      thumbnailCachePath: path.join(dir, 'thumbs'),
    },
  };

  const first = createYoutubeApi({ config, now: () => clock.t, fetchImpl });
  await first.resolveVideo('abc');
  first.flush();
  const before = fetchImpl.calls.length;

  const second = createYoutubeApi({ config, now: () => clock.t, fetchImpl });
  const video = await second.resolveVideo('abc');

  assert.equal(fetchImpl.calls.length, before, 'a restart must reuse the persisted cache');
  assert.equal(video.title, 'Video abc');
  assert.equal(second.stats().videos, 1);
});

// -------------------------------------------------------------- prefetch

test('prefetch warms an unseen video and skips a known one', async () => {
  const fetchImpl = makeFetch({
    videos: { abc: videoItem('abc'), next: videoItem('next') },
    channels: { 'UC-veritasium': channelItem('UC-veritasium') },
  });
  const { api } = makeApi(fetchImpl);

  await api.resolveVideo('abc', { includeDislikes: false });
  const before = fetchImpl.api().length;

  assert.equal(await api.prefetchVideo('next'), true);
  assert.equal(fetchImpl.api().length, before + 1);

  const warmed = fetchImpl.api().length;
  assert.equal(await api.prefetchVideo('next'), false, 'a warm video is not re-fetched');
  assert.equal(fetchImpl.api().length, warmed);
});

// ------------------------------------------------------------------- stats

test('the readout reports quota, cache size and hit rate', async () => {
  const fetchImpl = makeFetch({
    videos: { abc: videoItem('abc') },
    channels: { 'UC-veritasium': channelItem('UC-veritasium') },
    dislikes: { abc: 1204 },
  });
  const { api, clock } = makeApi(fetchImpl);

  await api.resolveVideo('abc');
  await api.resolveVideo('abc');

  const stats = api.stats();
  assert.equal(stats.videos, 1);
  assert.equal(stats.channels, 1);
  assert.equal(stats.quotaUsedToday, 2);
  assert.equal(stats.quotaLimit, 10000);
  assert.ok(stats.hitRate > 0 && stats.hitRate < 1);

  // Quota is a daily allowance, so it resets with the date.
  clock.t += DAY;
  assert.equal(api.stats().quotaUsedToday, 0);
});

test('clearing the cache empties it and reports the new state', async () => {
  const fetchImpl = makeFetch({
    videos: { abc: videoItem('abc') },
    channels: { 'UC-veritasium': channelItem('UC-veritasium') },
  });
  const { api } = makeApi(fetchImpl);

  await api.resolveVideo('abc', { includeDislikes: false });
  const cleared = api.clear('all');

  assert.equal(cleared.videos, 0);
  assert.equal(cleared.channels, 0);

  await api.resolveVideo('abc', { includeDislikes: false });
  assert.equal(fetchImpl.api().length, 4, 'a cleared cache refetches both records');
});

test('clearing only the stats keeps the immutable core', async () => {
  const fetchImpl = makeFetch({
    videos: { abc: videoItem('abc') },
    channels: { 'UC-veritasium': channelItem('UC-veritasium') },
  });
  const { api } = makeApi(fetchImpl);

  await api.resolveVideo('abc', { includeDislikes: false });
  const cleared = api.clear('stats');

  assert.equal(cleared.videos, 1, 'core survives a stats-only clear');
  assert.equal(cleared.channels, 1);
});
