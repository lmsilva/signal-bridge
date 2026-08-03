const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { cleanDescription, parseIso8601Duration } = require('./youtube-text');

/**
 * YouTube Data API v3 + Return YouTube Dislike client.
 *
 * The whole design is the mutability split from youtube.md §6.1. A video's
 * title, description, upload date, channel, duration and thumbnail URLs are
 * fixed at publish time, so `VideoCore` is cached forever and only the two
 * counters ever get re-fetched. That is the difference between a heavy
 * household using 3% of the daily quota and using all of it.
 */

const API_BASE = 'https://www.googleapis.com/youtube/v3';
const RYD_BASE = 'https://returnyoutubedislikeapi.com';

const VIDEO_STATS_TTL_MS = 6 * 60 * 60 * 1000;
const CHANNEL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// §6.3: above 1M subscribers the rounded figure cannot move for a long time.
const CHANNEL_TTL_LARGE_MS = 30 * 24 * 60 * 60 * 1000;
const CHANNEL_LARGE_THRESHOLD = 1000000;
const RYD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_IDS_PER_REQUEST = 50;
const THUMBNAIL_PRUNE_DAYS = 90;

/** `maxres` genuinely does not exist for many videos, so the ladder is required. */
const THUMBNAIL_LADDER = ['maxres', 'standard', 'high', 'medium', 'default'];

function emptyCache() {
  return {
    videos: {},
    stats: {},
    channels: {},
    dislikes: {},
    missing: {},
    quota: { date: null, units: 0 },
    counters: { hits: 0, misses: 0 },
  };
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

function pickThumbnail(thumbnails = {}) {
  for (const key of THUMBNAIL_LADDER) {
    const entry = thumbnails[key];
    if (entry?.url) {
      return { key, ...entry };
    }
  }
  return null;
}

function createYoutubeApi({
  config,
  log = null,
  now = () => Date.now(),
  fetchImpl = null,
} = {}) {
  const youtubeConfig = config?.youtube || {};
  const cachePath = youtubeConfig.cachePath;
  const thumbnailDir = youtubeConfig.thumbnailCachePath;
  const doFetch = fetchImpl || ((...args) => globalThis.fetch(...args));

  let cache = readCache();
  let writeTimer = null;

  function readCache() {
    try {
      const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      return { ...emptyCache(), ...parsed };
    } catch {
      return emptyCache();
    }
  }

  function persist() {
    // The cache is written on every resolve; batching keeps a playlist binge
    // from turning into one fsync per video.
    if (writeTimer) {
      return;
    }
    writeTimer = setTimeout(() => {
      writeTimer = null;
      try {
        fs.mkdirSync(path.dirname(cachePath), { recursive: true });
        fs.writeFileSync(cachePath, JSON.stringify(cache), 'utf8');
      } catch (error) {
        log?.warn?.('Could not persist the YouTube cache', error?.message || error);
      }
    }, 400);
    writeTimer?.unref?.();
  }

  function flush() {
    if (writeTimer) {
      clearTimeout(writeTimer);
      writeTimer = null;
    }
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, JSON.stringify(cache), 'utf8');
    } catch (error) {
      log?.warn?.('Could not persist the YouTube cache', error?.message || error);
    }
  }

  function apiKey() {
    return String(config?.youtube?.apiKey || '').trim();
  }

  function localDateKey(ms) {
    return new Date(ms).toISOString().slice(0, 10);
  }

  function spendQuota(units) {
    const today = localDateKey(now());
    if (cache.quota.date !== today) {
      cache.quota = { date: today, units: 0 };
    }
    cache.quota.units += units;
  }

  // ------------------------------------------------------------- requests

  async function apiGet(resource, params) {
    const key = apiKey();
    if (!key) {
      throw new Error('No YouTube Data API key configured');
    }
    const url = new URL(`${API_BASE}/${resource}`);
    for (const [name, value] of Object.entries(params)) {
      url.searchParams.set(name, value);
    }
    url.searchParams.set('key', key);

    const response = await doFetch(url.toString(), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    // A list call costs one unit whether or not it returns items, so bill it
    // before checking the status.
    spendQuota(1);
    if (!response.ok) {
      const detail = response.status === 403 ? 'quota exceeded or key rejected' : `HTTP ${response.status}`;
      throw new Error(`YouTube Data API: ${detail}`);
    }
    return response.json();
  }

  // ---------------------------------------------------------- video core

  function coreFrom(item) {
    const snippet = item.snippet || {};
    const raw = snippet.description || '';
    return {
      videoId: item.id,
      title: snippet.title || '',
      description: raw,
      // Computed once at fetch time: the cleaner is deterministic and the
      // result is cached forever alongside the rest of the immutable record.
      descriptionClean: cleanDescription(raw),
      publishedAt: snippet.publishedAt || null,
      channelId: snippet.channelId || null,
      channelTitle: snippet.channelTitle || '',
      durationSeconds: parseIso8601Duration(item.contentDetails?.duration),
      thumbnails: snippet.thumbnails || {},
      liveBroadcastContent: snippet.liveBroadcastContent || 'none',
      fetchedAt: new Date(now()).toISOString(),
    };
  }

  function statsFrom(item) {
    const statistics = item.statistics || {};
    return {
      videoId: item.id,
      viewCount: Number(statistics.viewCount || 0),
      likeCount: Number(statistics.likeCount || 0),
      concurrentViewers: statistics.concurrentViewers != null
        ? Number(statistics.concurrentViewers)
        : null,
      fetchedAt: new Date(now()).toISOString(),
    };
  }

  function statsAreFresh(videoId) {
    const entry = cache.stats[videoId];
    return Boolean(entry) && now() - Date.parse(entry.fetchedAt) < VIDEO_STATS_TTL_MS;
  }

  function negativelyCached(videoId) {
    const at = cache.missing[videoId];
    return Boolean(at) && now() - at < NEGATIVE_TTL_MS;
  }

  /**
   * Resolve `VideoCore` + `VideoStats` for one or more ids, batching up to 50
   * per request (§6.6) and skipping anything already fresh in cache.
   */
  async function fetchVideos(videoIds) {
    const wanted = [...new Set(videoIds.filter(Boolean))];
    const needed = wanted.filter((id) => {
      if (negativelyCached(id)) {
        return false;
      }
      // Core is permanent, so a video only needs re-fetching for its counters.
      const need = !cache.videos[id] || !statsAreFresh(id);
      if (need) {
        cache.counters.misses += 1;
      } else {
        cache.counters.hits += 1;
      }
      return need;
    });

    for (const batch of chunk(needed, MAX_IDS_PER_REQUEST)) {
      // One request, all three parts — parts are free, requests are not (§6.2).
      const data = await apiGet('videos', {
        part: 'snippet,statistics,contentDetails',
        id: batch.join(','),
      });
      const returned = new Set();
      for (const item of data.items || []) {
        returned.add(item.id);
        cache.videos[item.id] = coreFrom(item);
        cache.stats[item.id] = statsFrom(item);
        delete cache.missing[item.id];
      }
      // Private, deleted or age-restricted: remember so a replay does not
      // re-request it forever (§6.9).
      for (const id of batch) {
        if (!returned.has(id)) {
          cache.missing[id] = now();
        }
      }
    }
    if (needed.length) {
      persist();
    }
    return wanted.map((id) => ({
      core: cache.videos[id] || null,
      stats: cache.stats[id] || null,
      missing: negativelyCached(id),
    }));
  }

  // ------------------------------------------------------------- channel

  function channelTtlFor(record) {
    return record?.subscriberCount >= CHANNEL_LARGE_THRESHOLD ? CHANNEL_TTL_LARGE_MS : CHANNEL_TTL_MS;
  }

  function channelIsFresh(channelId) {
    const record = cache.channels[channelId];
    return Boolean(record) && now() - Date.parse(record.fetchedAt) < channelTtlFor(record);
  }

  /** Keyed by `channelId`, never by video: twenty videos, one fetch (§6.3). */
  async function fetchChannels(channelIds) {
    const wanted = [...new Set(channelIds.filter(Boolean))];
    const needed = wanted.filter((id) => {
      const fresh = channelIsFresh(id);
      if (fresh) {
        cache.counters.hits += 1;
      } else {
        cache.counters.misses += 1;
      }
      return !fresh;
    });

    for (const batch of chunk(needed, MAX_IDS_PER_REQUEST)) {
      const data = await apiGet('channels', {
        part: 'snippet,statistics',
        id: batch.join(','),
      });
      for (const item of data.items || []) {
        const statistics = item.statistics || {};
        cache.channels[item.id] = {
          channelId: item.id,
          title: item.snippet?.title || '',
          avatarUrl: pickThumbnail(item.snippet?.thumbnails)?.url || null,
          subscriberCount: Number(statistics.subscriberCount || 0),
          hiddenSubscriberCount: statistics.hiddenSubscriberCount === true,
          fetchedAt: new Date(now()).toISOString(),
        };
      }
    }
    if (needed.length) {
      persist();
    }
    return wanted.map((id) => cache.channels[id] || null);
  }

  // ----------------------------------------------------------------- RYD

  /**
   * Only `dislikes` is taken from RYD — its likes and views are its own
   * estimates and disagree with the authoritative Data API figures (§2.2).
   */
  async function fetchDislikes(videoId) {
    const cached = cache.dislikes[videoId];
    if (cached && now() - Date.parse(cached.fetchedAt) < RYD_TTL_MS) {
      return cached.dislikes;
    }
    try {
      const response = await doFetch(`${RYD_BASE}/votes?videoId=${encodeURIComponent(videoId)}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        // 404 (unknown id) and 400 (malformed) are both "no estimate", which
        // the card renders as a two-stat row rather than an error.
        cache.dislikes[videoId] = { dislikes: null, fetchedAt: new Date(now()).toISOString() };
        persist();
        return null;
      }
      const data = await response.json();
      const dislikes = Number.isFinite(Number(data?.dislikes)) ? Number(data.dislikes) : null;
      cache.dislikes[videoId] = { dislikes, fetchedAt: new Date(now()).toISOString() };
      persist();
      return dislikes;
    } catch {
      return cached?.dislikes ?? null;
    }
  }

  // ---------------------------------------------------------- thumbnails

  function thumbnailFileFor(url) {
    const digest = crypto.createHash('sha256').update(String(url)).digest('hex').slice(0, 40);
    const ext = path.extname(new URL(url, 'https://i.ytimg.com').pathname).toLowerCase();
    return path.join(thumbnailDir, `${digest}${['.jpg', '.png', '.webp'].includes(ext) ? ext : '.jpg'}`);
  }

  /**
   * Download once and serve locally. Hotlinking `i.ytimg.com` from the render
   * path breaks offline, adds latency to every paint, and hammers Google (§6.5).
   */
  async function cacheImage(url) {
    if (!url) {
      return null;
    }
    const file = thumbnailFileFor(url);
    if (fs.existsSync(file)) {
      // Touch so the 90-day prune measures last use, not download date.
      try {
        fs.utimesSync(file, new Date(now()), new Date(now()));
      } catch {
        // Non-fatal: the file is still usable.
      }
      return path.basename(file);
    }
    try {
      const response = await doFetch(url, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) {
        return null;
      }
      const body = Buffer.from(await response.arrayBuffer());
      fs.mkdirSync(thumbnailDir, { recursive: true });
      fs.writeFileSync(file, body);
      return path.basename(file);
    } catch (error) {
      log?.warn?.('Could not cache a YouTube image', error?.message || error);
      return null;
    }
  }

  /** Nightly: drop thumbnails untouched for 90 days. Avatars are kept. */
  function pruneThumbnails(days = THUMBNAIL_PRUNE_DAYS) {
    const cutoff = now() - days * 24 * 60 * 60 * 1000;
    const avatars = new Set(
      Object.values(cache.channels)
        .map((record) => (record.avatarUrl ? path.basename(thumbnailFileFor(record.avatarUrl)) : null))
        .filter(Boolean),
    );
    let removed = 0;
    try {
      for (const name of fs.readdirSync(thumbnailDir)) {
        if (avatars.has(name)) {
          continue;
        }
        const file = path.join(thumbnailDir, name);
        if (fs.statSync(file).mtimeMs < cutoff) {
          fs.unlinkSync(file);
          removed += 1;
        }
      }
    } catch {
      // Directory may not exist yet.
    }
    return removed;
  }

  // ------------------------------------------------------------- resolve

  /**
   * Everything the card needs for one video, cache-first.
   *
   * Never throws on a network problem: youtube.md §6.9 is explicit that the
   * card must render from whatever is known rather than block on the API.
   */
  async function resolveVideo(videoId, { includeDislikes = true, fallbackTitle = null } = {}) {
    let core = cache.videos[videoId] || null;
    let stats = cache.stats[videoId] || null;
    let degraded = false;

    if (!negativelyCached(videoId) && (!core || !statsAreFresh(videoId))) {
      try {
        const [resolved] = await fetchVideos([videoId]);
        core = resolved.core || core;
        stats = resolved.stats || stats;
      } catch (error) {
        degraded = true;
        log?.warn?.(`YouTube metadata unavailable for ${videoId}`, error?.message || error);
      }
    } else if (core) {
      // The short-circuit is the case the hit rate exists to measure, so it
      // has to be counted here rather than inside the fetch that never runs.
      cache.counters.hits += 1;
    }

    let channel = null;
    if (core?.channelId) {
      channel = cache.channels[core.channelId] || null;
      if (!channelIsFresh(core.channelId)) {
        try {
          [channel] = await fetchChannels([core.channelId]);
        } catch {
          degraded = true;
        }
      } else {
        cache.counters.hits += 1;
      }
    }

    let dislikeCount = null;
    if (includeDislikes && core) {
      dislikeCount = await fetchDislikes(videoId);
    }

    const thumbnail = core ? pickThumbnail(core.thumbnails) : null;
    const [thumbnailFile, avatarFile] = await Promise.all([
      thumbnail ? cacheImage(thumbnail.url) : null,
      channel?.avatarUrl ? cacheImage(channel.avatarUrl) : null,
    ]);

    return {
      videoId,
      // A private or deleted video still gets a card, using the title the
      // Lounge API already handed us (§4.5).
      missing: !core,
      degraded,
      title: core?.title || fallbackTitle || 'YouTube',
      // Re-clean on every resolve so a cleaner fix applies to cores that were
      // cached forever under an older (emptier) result.
      descriptionClean: core ? cleanDescription(core.description || '') : '',
      publishedAt: core?.publishedAt || null,
      durationSeconds: core?.durationSeconds || 0,
      liveBroadcastContent: core?.liveBroadcastContent || 'none',
      channelId: core?.channelId || null,
      channelTitle: channel?.title || core?.channelTitle || '',
      subscriberCount: channel?.hiddenSubscriberCount ? null : (channel?.subscriberCount ?? null),
      hiddenSubscriberCount: Boolean(channel?.hiddenSubscriberCount),
      viewCount: stats?.viewCount ?? null,
      likeCount: stats?.likeCount ?? null,
      dislikeCount,
      concurrentViewers: stats?.concurrentViewers ?? null,
      thumbnailFile,
      thumbnailWidth: thumbnail?.width || null,
      thumbnailHeight: thumbnail?.height || null,
      avatarFile,
    };
  }

  /**
   * Warm the cache for the autoplay-queued video while the current one plays
   * (§6.4). Fire-and-forget: nothing is waiting on the result.
   */
  function prefetchVideo(videoId) {
    if (!videoId || cache.videos[videoId] || negativelyCached(videoId)) {
      return Promise.resolve(false);
    }
    return resolveVideo(videoId, { includeDislikes: false })
      .then(() => true)
      .catch(() => false);
  }

  function stats0() {
    const today = localDateKey(now());
    const total = cache.counters.hits + cache.counters.misses;
    return {
      videos: Object.keys(cache.videos).length,
      channels: Object.keys(cache.channels).length,
      negative: Object.keys(cache.missing).length,
      hitRate: total ? cache.counters.hits / total : null,
      quotaUsedToday: cache.quota.date === today ? cache.quota.units : 0,
      quotaLimit: 10000,
      hasApiKey: Boolean(apiKey()),
    };
  }

  function clear(scope = 'all') {
    if (scope === 'stats') {
      cache.stats = {};
      cache.dislikes = {};
    } else {
      cache = emptyCache();
    }
    flush();
    return stats0();
  }

  return {
    resolveVideo,
    prefetchVideo,
    fetchVideos,
    fetchChannels,
    fetchDislikes,
    cacheImage,
    pruneThumbnails,
    stats: stats0,
    clear,
    flush,
    thumbnailFileFor,
    _cache: () => cache,
  };
}

module.exports = {
  VIDEO_STATS_TTL_MS,
  CHANNEL_TTL_MS,
  CHANNEL_TTL_LARGE_MS,
  RYD_TTL_MS,
  NEGATIVE_TTL_MS,
  MAX_IDS_PER_REQUEST,
  THUMBNAIL_LADDER,
  pickThumbnail,
  createYoutubeApi,
};
