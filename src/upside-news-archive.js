/**
 * Local story archive for The Upside News — mandatory for weekly/monthly/yearly.
 */

const fs = require('fs');
const path = require('path');
const { normaliseUrl, titleSimilarity } = require('./upside-news-text');
const { indexSecondsFor, cycleSecondsFor } = require('./upside-news-settings');
const { fetchGuardianPeriod } = require('./upside-news-guardian');
const { fetchEnabledRss } = require('./upside-news-rss');

const MAX_ARCHIVE = 8000;
/** How many recently-aired story ids to remember (avoid instant repeats). */
const RECENT_SHOWN_CAP = 48;
/** Draw each round from up to this many top-scoring candidates. */
const SELECTION_POOL_MULTIPLIER = 4;

function periodWindowMs(period, nowMs) {
  const day = 24 * 60 * 60 * 1000;
  switch (period) {
    case 'weekly': return 7 * day;
    case 'monthly': return 30 * day;
    case 'yearly': return 365 * day;
    case 'daily':
    default: return day;
  }
}

function isoDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function matchesKeywordList(story, list) {
  const hay = `${story.headline || ''} ${story.standfirst || ''}`.toLowerCase();
  return list.filter((word) => hay.includes(String(word).toLowerCase()));
}

function passesFilters(story, settings) {
  if (!story?.headline) {
    return false;
  }
  if (matchesKeywordList(story, settings.denylist || []).length) {
    return false;
  }
  if (settings.region && settings.region !== 'any') {
    const office = String(story.productionOffice || '').toLowerCase();
    // RSS has no office — keep them. Guardian filters by production office.
    if (story.sourceId === 'guardian' && office && office !== settings.region) {
      return false;
    }
  }
  return true;
}

function scoreStory(story, settings, nowMs) {
  const boostHits = matchesKeywordList(story, settings.boostlist || []).length;
  const corroboration = Number(story.corroboratingSources) || 1;
  const published = Date.parse(story.publishedAt);
  const ageDays = Number.isFinite(published)
    ? Math.max(0, (nowMs - published) / (24 * 60 * 60 * 1000))
    : 30;
  const sectionBonus = (settings.enabledSectionIds || []).includes(story.sectionId) ? 1 : 0;
  const guardianBonus = story.sourceId === 'guardian' ? 0.5 : 0;
  return (boostHits * 2)
    + (corroboration * 3)
    + sectionBonus
    + guardianBonus
    - (ageDays * 0.15);
}

function shuffleInPlace(list, rng = Math.random) {
  const arr = list;
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

/**
 * Pick ``limit`` stories from a scored candidate list.
 * Prefers stories not in ``recentIds``, then shuffles so pushes vary.
 */
function pickRandomStories(scored, limit, {
  recentIds = new Set(),
  rng = Math.random,
} = {}) {
  const want = Math.max(0, Number(limit) || 0);
  if (!want || !Array.isArray(scored) || !scored.length) {
    return [];
  }
  const ranked = [...scored].sort((a, b) => {
    const scoreDiff = (Number(b.score) || 0) - (Number(a.score) || 0);
    if (scoreDiff !== 0) return scoreDiff;
    return Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0);
  });
  const poolSize = Math.min(
    ranked.length,
    Math.max(want, want * SELECTION_POOL_MULTIPLIER),
  );
  let pool = ranked.slice(0, poolSize);
  const fresh = pool.filter((story) => !recentIds.has(story.id));
  if (fresh.length >= want) {
    pool = fresh;
  } else if (fresh.length) {
    const seen = pool.filter((story) => recentIds.has(story.id));
    pool = [...fresh, ...seen];
  }
  shuffleInPlace(pool, rng);
  return pool.slice(0, want);
}

function mergeStories(existing, incoming) {
  const byUrl = new Map();
  const list = [];

  function consider(story) {
    if (!story?.headline) {
      return;
    }
    const urlKey = normaliseUrl(story.url || story.webUrl || '');
    if (urlKey && byUrl.has(urlKey)) {
      const prior = byUrl.get(urlKey);
      prior.corroboratingSources = (prior.corroboratingSources || 1) + 1;
      // Prefer Guardian metadata.
      if (story.sourceId === 'guardian' && prior.sourceId !== 'guardian') {
        Object.assign(prior, story, {
          corroboratingSources: prior.corroboratingSources,
        });
      }
      return;
    }
    for (const other of list) {
      if (titleSimilarity(story.headline, other.headline) >= 0.72) {
        other.corroboratingSources = (other.corroboratingSources || 1) + 1;
        if (story.sourceId === 'guardian' && other.sourceId !== 'guardian') {
          const key = normaliseUrl(other.url || other.webUrl || '');
          Object.assign(other, story, {
            corroboratingSources: other.corroboratingSources,
          });
          if (key) {
            byUrl.set(key, other);
          }
        }
        return;
      }
    }
    const copy = { ...story, corroboratingSources: story.corroboratingSources || 1 };
    list.push(copy);
    if (urlKey) {
      byUrl.set(urlKey, copy);
    }
  }

  for (const story of existing) {
    consider(story);
  }
  for (const story of incoming) {
    consider(story);
  }
  return list;
}

function createUpsideNewsArchive({
  config = {},
  log = console,
  settings,
  getApiKey = () => '',
  fetchImpl = fetch,
  now = () => Date.now(),
  rng = Math.random,
} = {}) {
  const archivePath = config.upsideNewsArchivePath
    || path.resolve(config.ROOT || path.resolve(__dirname, '..'), 'data', 'upside-news-archive.json');

  let stories = [];
  let sourceStatus = [];
  let lastPollAt = null;
  let pollTimer = null;
  let polling = false;
  let quotaToday = { day: '', count: 0 };
  let recentShownIds = [];

  function load() {
    try {
      if (!fs.existsSync(archivePath)) {
        stories = [];
        recentShownIds = [];
        return;
      }
      const raw = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
      stories = Array.isArray(raw?.stories) ? raw.stories : [];
      lastPollAt = raw?.lastPollAt || null;
      sourceStatus = Array.isArray(raw?.sourceStatus) ? raw.sourceStatus : [];
      quotaToday = raw?.quotaToday || quotaToday;
      recentShownIds = Array.isArray(raw?.recentShownIds)
        ? raw.recentShownIds.map(String).filter(Boolean).slice(0, RECENT_SHOWN_CAP)
        : [];
    } catch (error) {
      log?.warn?.('Could not load upside-news archive', error?.message || error);
      stories = [];
      recentShownIds = [];
    }
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(archivePath), { recursive: true });
      // Cap size — keep newest.
      stories.sort((a, b) => Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0));
      if (stories.length > MAX_ARCHIVE) {
        stories = stories.slice(0, MAX_ARCHIVE);
      }
      fs.writeFileSync(archivePath, `${JSON.stringify({
        stories,
        lastPollAt,
        sourceStatus,
        quotaToday,
        recentShownIds,
        savedAt: new Date().toISOString(),
      }, null, 2)}\n`, 'utf8');
    } catch (error) {
      log?.warn?.('Could not save upside-news archive', error?.message || error);
    }
  }

  function bumpQuota(n = 1) {
    const day = isoDate(now());
    if (quotaToday.day !== day) {
      quotaToday = { day, count: 0 };
    }
    quotaToday.count += n;
  }

  async function poll({ force = false } = {}) {
    if (polling) {
      return { ok: false, error: 'Poll already in progress' };
    }
    polling = true;
    const current = settings.get();
    const incoming = [];
    const statuses = [];
    try {
      if (current.guardianEnabled) {
        const apiKey = getApiKey();
        if (apiKey) {
          const end = now();
          const start = end - periodWindowMs('yearly', end);
          const guardianStories = await fetchGuardianPeriod({
            apiKey,
            fromDate: isoDate(start),
            toDate: isoDate(end),
            sections: current.enabledSectionIds,
            maxPagesPerSection: force ? 2 : 1,
            fetchImpl,
            log,
          });
          // Rough call count: sections × pages (capped).
          bumpQuota((current.enabledSectionIds?.length || 1) * (force ? 2 : 1));
          incoming.push(...guardianStories);
          statuses.push({
            id: 'guardian',
            label: 'The Guardian',
            ok: true,
            count: guardianStories.length,
            fetchedAt: new Date().toISOString(),
          });
        } else {
          statuses.push({
            id: 'guardian',
            label: 'The Guardian',
            ok: false,
            error: 'API key not configured',
            count: 0,
            fetchedAt: new Date().toISOString(),
          });
        }
      }

      const rss = await fetchEnabledRss({
        enabledIds: current.enabledRssSourceIds,
        fetchImpl,
        log,
      });
      incoming.push(...rss.results);
      statuses.push(...rss.statuses);

      stories = mergeStories(stories, incoming);
      sourceStatus = statuses;
      lastPollAt = new Date(now()).toISOString();
      save();
      log?.info?.('Upside News archive polled', {
        added: incoming.length,
        total: stories.length,
      });
      return { ok: true, total: stories.length, fetched: incoming.length };
    } catch (error) {
      log?.warn?.('Upside News poll failed', error?.message || error);
      return { ok: false, error: error?.message || String(error) };
    } finally {
      polling = false;
    }
  }

  function selectStories(overrides = {}, options = {}) {
    const current = { ...settings.get(), ...overrides };
    const nowMs = now();
    const windowMs = periodWindowMs(current.period, nowMs);
    const cutoff = nowMs - windowMs;
    const limit = Math.max(3, Math.min(8, Number(current.items) || 5));
    const excludeRecent = options.excludeRecent !== false;
    const randomise = options.randomise !== false;

    let candidates = stories.filter((story) => {
      const published = Date.parse(story.publishedAt);
      if (!Number.isFinite(published) || published < cutoff) {
        return false;
      }
      return passesFilters(story, current);
    });

    // Prefer allowlisted sections, but don't empty the set.
    const sectionFiltered = candidates.filter((story) => (
      (current.enabledSectionIds || []).includes(story.sectionId)
      || story.sourceId !== 'guardian'
    ));
    if (sectionFiltered.length >= Math.min(3, limit)) {
      candidates = sectionFiltered;
    }

    const scored = candidates.map((story) => {
      let score = scoreStory(story, current, nowMs);
      // Period-specific nudges before the random draw.
      if (current.period === 'yearly' && story.sourceId === 'guardian') {
        score += 2;
      } else if (current.period === 'daily' && story.sourceId !== 'guardian') {
        score += 1;
      } else if (current.period === 'daily') {
        // Keep daily fresher without locking to the same newest five.
        const published = Date.parse(story.publishedAt);
        if (Number.isFinite(published)) {
          const ageHours = Math.max(0, (nowMs - published) / (60 * 60 * 1000));
          score += Math.max(0, 6 - ageHours / 4);
        }
      }
      return { ...story, score };
    });

    if (!randomise) {
      scored.sort((a, b) => (b.score - a.score)
        || (Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0)));
      return scored.slice(0, limit);
    }

    return pickRandomStories(scored, limit, {
      recentIds: excludeRecent ? new Set(recentShownIds) : new Set(),
      rng,
    });
  }

  function rememberShown(ids) {
    const incoming = (Array.isArray(ids) ? ids : [])
      .map((id) => String(id || '').trim())
      .filter(Boolean);
    if (!incoming.length) {
      return recentShownIds.slice();
    }
    const seen = new Set();
    const next = [];
    for (const id of [...incoming, ...recentShownIds]) {
      if (seen.has(id)) continue;
      seen.add(id);
      next.push(id);
      if (next.length >= RECENT_SHOWN_CAP) break;
    }
    recentShownIds = next;
    save();
    return recentShownIds.slice();
  }

  function hasContent(overrides = {}) {
    const current = { ...settings.get(), ...overrides };
    const want = Math.max(3, Math.min(8, Number(current.items) || 5));
    return selectStories(overrides).length >= Math.min(3, want);
  }

  function estimateDuration(overrides = {}) {
    const current = { ...settings.get(), ...overrides };
    const selected = selectStories(overrides);
    const items = selected.length || current.items;
    return cycleSecondsFor({
      items,
      indexSeconds: current.indexSeconds,
      storySeconds: current.storySeconds,
    });
  }

  function stats() {
    const published = stories
      .map((story) => Date.parse(story.publishedAt))
      .filter((ms) => Number.isFinite(ms));
    const oldest = published.length ? new Date(Math.min(...published)).toISOString() : null;
    const perSource = {};
    for (const story of stories) {
      perSource[story.sourceId] = (perSource[story.sourceId] || 0) + 1;
    }
    return {
      count: stories.length,
      oldest,
      lastPollAt,
      perSource,
      sourceStatus,
      quotaToday: {
        used: quotaToday.day === isoDate(now()) ? quotaToday.count : 0,
        limit: 5000,
      },
      polling,
    };
  }

  function start() {
    load();
    const tick = () => {
      poll().catch(() => {});
    };
    // Warm shortly after boot, then on the configured interval.
    setTimeout(tick, 8_000);
    const minutes = settings.get().pollIntervalMinutes || 60;
    pollTimer = setInterval(tick, minutes * 60 * 1000);
  }

  function stop() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  load();

  return {
    load,
    save,
    poll,
    selectStories,
    rememberShown,
    hasContent,
    estimateDuration,
    stats,
    start,
    stop,
    indexSecondsFor,
    // test helpers
    _stories: () => stories,
    _setStories: (next) => { stories = next; },
    _recentShownIds: () => recentShownIds.slice(),
    _setRecentShownIds: (next) => {
      recentShownIds = (Array.isArray(next) ? next : []).map(String);
    },
  };
}

module.exports = {
  createUpsideNewsArchive,
  periodWindowMs,
  passesFilters,
  scoreStory,
  mergeStories,
  pickRandomStories,
  shuffleInPlace,
  RECENT_SHOWN_CAP,
  SELECTION_POOL_MULTIPLIER,
};
