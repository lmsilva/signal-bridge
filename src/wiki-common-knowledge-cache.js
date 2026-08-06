/**
 * Day-list + article core cache for Wiki Common Knowledge.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  createWikiClient,
  articlesFromFeatured,
} = require('./wiki-common-knowledge-wiki');
const { filterArticles } = require('./wiki-common-knowledge-filters');
const { categoriseDescription } = require('./wiki-common-knowledge-categories');
const {
  indexSecondsFor,
  cycleSecondsFor,
} = require('./wiki-common-knowledge-settings');

const ARTICLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const POLL_INTERVAL_MS = 24 * 60 * 60 * 1000;

function dayKey(date = new Date(), period = 'daily') {
  const d = new Date(date);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  if (period === 'weekly') {
    const tmp = new Date(Date.UTC(y, d.getUTCMonth(), d.getUTCDate()));
    const dayNum = tmp.getUTCDay() || 7;
    tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
    const week = Math.ceil((((tmp - yearStart) / 86400000) + 1) / 7);
    return `${tmp.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
  }
  if (period === 'monthly') return `${y}-${m}`;
  if (period === 'yearly') return `${y}`;
  return `${y}-${m}-${day}`;
}

function createWikiCommonKnowledgeCache({
  config = {},
  log = console,
  settings,
  fetchImpl = fetch,
  now = () => Date.now(),
} = {}) {
  const root = config.ROOT || path.resolve(__dirname, '..');
  const cacheDir = config.wikiCommonKnowledgeCacheDir
    || path.resolve(root, 'data', 'wiki-common-knowledge-cache');
  const dayDir = path.join(cacheDir, 'days');
  const articleDir = path.join(cacheDir, 'articles');
  const imageDir = path.join(cacheDir, 'images');

  let pollTimer = null;
  let lastPollAt = null;
  let lastPollError = null;
  let lastPollCount = 0;
  let networkCalls = 0;

  function ensureDirs() {
    for (const dir of [dayDir, articleDir, imageDir]) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  function clientFromSettings(snap) {
    return createWikiClient({
      contactEmail: snap.contactEmail,
      apiToken: snap.apiToken,
      lang: snap.lang || 'en',
      fetchImpl,
      log,
    });
  }

  function articlePath(title) {
    const hash = crypto.createHash('sha1').update(String(title).toLowerCase()).digest('hex');
    return path.join(articleDir, `${hash}.json`);
  }

  function readArticle(title) {
    try {
      const file = articlePath(title);
      if (!fs.existsSync(file)) return null;
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data.cachedAt && (now() - data.cachedAt) > ARTICLE_TTL_MS) return null;
      return data.article || null;
    } catch {
      return null;
    }
  }

  function writeArticle(article) {
    ensureDirs();
    const file = articlePath(article.title);
    fs.writeFileSync(file, `${JSON.stringify({
      cachedAt: now(),
      article,
    }, null, 2)}\n`, 'utf8');
  }

  function dayPath(period, key) {
    return path.join(dayDir, `${period}-${key}.json`);
  }

  function readDayList(period, key) {
    try {
      const file = dayPath(period, key);
      if (!fs.existsSync(file)) return null;
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }

  function writeDayList(period, key, articles) {
    ensureDirs();
    fs.writeFileSync(dayPath(period, key), `${JSON.stringify({
      period,
      key,
      fetchedAt: now(),
      articles,
    }, null, 2)}\n`, 'utf8');
  }

  function articlesFromDayList(cached) {
    return Array.isArray(cached?.articles) ? cached.articles : [];
  }

  /** Prefer a non-empty day list, walking back up to ``maxLag`` days. */
  function latestNonEmptyDayArticles(period, fromDate = new Date(now()), maxLag = 7) {
    if (period === 'daily') {
      for (let lag = 0; lag <= maxLag; lag += 1) {
        const d = new Date(fromDate);
        d.setUTCDate(d.getUTCDate() - lag);
        const articles = articlesFromDayList(readDayList('daily', dayKey(d, 'daily')));
        if (articles.length) return articles;
      }
      return [];
    }
    const primary = articlesFromDayList(readDayList(period, dayKey(fromDate, period)));
    if (primary.length) return primary;
    for (let lag = 0; lag <= maxLag; lag += 1) {
      const d = new Date(fromDate);
      d.setUTCDate(d.getUTCDate() - lag);
      const articles = articlesFromDayList(readDayList('daily', dayKey(d, 'daily')));
      if (articles.length) return articles;
    }
    return [];
  }

  /**
   * Today's featured feed often omits ``mostread`` until later UTC, and
   * pageviews/top for "today" is usually 404. Walk back a few days.
   */
  async function fetchMostReadCandidates(client, date = new Date(now())) {
    const base = new Date(date);
    for (let lag = 0; lag <= 3; lag += 1) {
      const d = new Date(base);
      d.setUTCDate(d.getUTCDate() - lag);
      try {
        networkCalls += 1;
        const featured = await client.fetchFeatured(d);
        const articles = articlesFromFeatured(featured);
        if (articles.length) {
          return { articles, source: 'featured', date: d };
        }
      } catch (error) {
        log?.warn?.('Wiki featured fetch failed', dayKey(d, 'daily'), error?.message || error);
      }
    }
    for (let lag = 1; lag <= 3; lag += 1) {
      const d = new Date(base);
      d.setUTCDate(d.getUTCDate() - lag);
      try {
        networkCalls += 1;
        const top = await client.fetchPageviewsTop(d);
        const items = top?.items?.[0]?.articles || [];
        if (!items.length) continue;
        const articles = items.slice(0, 50).map((item, i) => ({
          title: String(item.article || '').replace(/_/g, ' '),
          views: Number(item.views) || 0,
          viewsDelta: 0,
          viewsDeltaPct: null,
          rank: i + 1,
          description: '',
          extract: '',
          thumbnailUrl: '',
          originalImageUrl: '',
          contentUrl: '',
          history: [],
        }));
        return { articles, source: 'pageviews', date: d };
      } catch (error) {
        log?.warn?.('Wiki pageviews fetch failed', dayKey(d, 'daily'), error?.message || error);
      }
    }
    return { articles: [], source: null, date: base };
  }

  async function enrichArticle(client, raw) {
    const cached = readArticle(raw.title);
    let article;
    if (cached) {
      // Never let an empty featured-feed field wipe a previously enriched image.
      article = {
        ...cached,
        ...raw,
        thumbnailUrl: raw.thumbnailUrl || cached.thumbnailUrl || '',
        originalImageUrl: raw.originalImageUrl || cached.originalImageUrl || '',
        extract: String(raw.extract || cached.extract || '').trim(),
        description: String(raw.description || cached.description || '').trim(),
        contentUrl: raw.contentUrl || cached.contentUrl || '',
        history: (Array.isArray(raw.history) && raw.history.length)
          ? raw.history
          : (cached.history || []),
        fromCache: true,
      };
      if ((cached.extract || '').length > (article.extract || '').length) {
        article.extract = cached.extract;
      }
    } else {
      article = { ...raw, fromCache: false };
    }

    try {
      const needsExtract = !article.extract || article.extract.length < 40;
      const needsImage = !article.thumbnailUrl && !article.originalImageUrl;
      if (needsExtract || needsImage) {
        networkCalls += 1;
        const summary = await client.fetchSummary(raw.title);
        if (needsExtract || !article.extract) {
          article.extract = String(summary.extract || article.extract || '').trim();
        }
        article.description = article.description
          || String(summary.description || '').trim();
        article.thumbnailUrl = article.thumbnailUrl
          || summary.thumbnail?.source
          || '';
        article.originalImageUrl = article.originalImageUrl
          || summary.originalimage?.source
          || article.thumbnailUrl;
        article.contentUrl = article.contentUrl
          || summary.content_urls?.desktop?.page
          || '';
      }
      if (!article.history?.length) {
        networkCalls += 1;
        article.history = await client.fetchPageviewHistory(raw.title, 30);
      }
    } catch (error) {
      log?.warn?.('Wiki article enrich failed', raw.title, error?.message || error);
    }
    article.categoryId = categoriseDescription(article.description || article.extract || '');
    writeArticle(article);
    return article;
  }

  async function fetchDay(period = 'daily', { force = false } = {}) {
    const snap = settings.get();
    if (!snap.contactEmail || !String(snap.contactEmail).includes('@')) {
      lastPollError = 'Contact email required for Wikimedia User-Agent';
      return { ok: false, error: lastPollError, articles: [] };
    }
    const key = dayKey(new Date(now()), period);
    if (!force) {
      const cached = readDayList(period, key);
      // Empty stubs are a miss — today's feed often ships without mostread.
      if (articlesFromDayList(cached).length) {
        return { ok: true, articles: cached.articles, fromCache: true, key };
      }
    }

    const client = clientFromSettings(snap);
    try {
      const resolved = await fetchMostReadCandidates(client, new Date(now()));
      let articles = resolved.articles || [];
      articles = filterArticles(articles, {
        denylist: snap.denylist,
        filterDistressing: snap.filterDistressing,
      });

      const enriched = [];
      for (const raw of articles.slice(0, 40)) {
        // eslint-disable-next-line no-await-in-loop
        const art = await enrichArticle(client, raw);
        if (snap.skipNoImage && !art.thumbnailUrl && !art.originalImageUrl) continue;
        enriched.push(art);
      }

      if (!enriched.length) {
        lastPollError = 'No most-read articles available yet — will retry later';
        const fallback = latestNonEmptyDayArticles(period, new Date(now()));
        if (fallback.length) {
          lastPollCount = fallback.length;
          return {
            ok: true,
            articles: fallback,
            fromCache: true,
            key,
            stale: true,
            error: lastPollError,
          };
        }
        return { ok: false, error: lastPollError, articles: [] };
      }

      // Never persist an empty day list — that poisoned Push after UTC midnight.
      writeDayList(period, key, enriched);
      lastPollAt = now();
      lastPollError = null;
      lastPollCount = enriched.length;
      return {
        ok: true,
        articles: enriched,
        fromCache: false,
        key,
        source: resolved.source || null,
      };
    } catch (error) {
      lastPollError = error?.message || String(error);
      log?.warn?.('Wiki day fetch failed', lastPollError);
      const fallback = latestNonEmptyDayArticles(period, new Date(now()));
      if (fallback.length) {
        return { ok: true, articles: fallback, fromCache: true, key, stale: true };
      }
      return { ok: false, error: lastPollError, articles: [] };
    }
  }

  function selectArticles(overrides = {}) {
    const snap = { ...settings.get(), ...overrides };
    let articles = latestNonEmptyDayArticles(snap.period, new Date(now()));
    articles = filterArticles(articles, {
      denylist: snap.denylist,
      filterDistressing: snap.filterDistressing,
    });
    if (snap.skipNoImage) {
      articles = articles.filter((a) => a.thumbnailUrl || a.originalImageUrl);
    }
    const limit = Math.max(3, Math.min(8, Number(snap.items) || 5));
    return articles.slice(0, limit).map((a, i) => ({ ...a, rank: i + 1 }));
  }

  function hasContent(overrides = {}) {
    return selectArticles(overrides).length >= 3;
  }

  function estimateDuration(overrides = {}) {
    const snap = { ...settings.get(), ...overrides };
    const selected = selectArticles(overrides);
    const items = selected.length || snap.items;
    const one = cycleSecondsFor({
      items,
      indexSeconds: snap.indexSeconds,
      articleSeconds: snap.articleSeconds,
    });
    let loops = snap.loops || 'once';
    if (loops === 'until-dismissed') loops = 'once';
    const loopCount = loops === 'once' ? 1 : Math.max(1, Number(loops) || 1);
    return one * loopCount + 4;
  }

  async function poll({ force = false } = {}) {
    const snap = settings.get();
    return fetchDay(snap.period || 'daily', { force });
  }

  async function backfill(days = 7) {
    const results = [];
    for (let i = 0; i < days; i += 1) {
      const d = new Date(now());
      d.setUTCDate(d.getUTCDate() - i);
      // Temporarily use featured for each past day via client
      const snap = settings.get();
      if (!snap.contactEmail) break;
      const client = clientFromSettings(snap);
      try {
        networkCalls += 1;
        // eslint-disable-next-line no-await-in-loop
        const featured = await client.fetchFeatured(d);
        let articles = articlesFromFeatured(featured);
        articles = filterArticles(articles, {
          denylist: snap.denylist,
          filterDistressing: snap.filterDistressing,
        });
        const key = dayKey(d, 'daily');
        writeDayList('daily', key, articles.slice(0, 40));
        results.push({ key, count: articles.length });
      } catch (error) {
        results.push({ error: error.message });
      }
    }
    return results;
  }

  function stats() {
    ensureDirs();
    let dayFiles = 0;
    let articleFiles = 0;
    try {
      dayFiles = fs.readdirSync(dayDir).filter((f) => f.endsWith('.json')).length;
      articleFiles = fs.readdirSync(articleDir).filter((f) => f.endsWith('.json')).length;
    } catch { /* empty */ }
    return {
      dayLists: dayFiles,
      articles: articleFiles,
      lastPollAt,
      lastPollError,
      lastPollCount,
      networkCalls,
      cacheDir,
      indexSeconds: indexSecondsFor(settings.get().items, settings.get().indexSeconds),
    };
  }

  function start() {
    if (pollTimer) return;
    ensureDirs();
    // Kick off soon after boot (don't block)
    setTimeout(() => {
      poll().catch((error) => log?.warn?.('Wiki initial poll failed', error?.message || error));
    }, 3000);
    pollTimer = setInterval(() => {
      poll().catch((error) => log?.warn?.('Wiki poll failed', error?.message || error));
    }, POLL_INTERVAL_MS);
    if (typeof pollTimer.unref === 'function') pollTimer.unref();
  }

  function stop() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  return {
    fetchDay,
    selectArticles,
    hasContent,
    estimateDuration,
    poll,
    backfill,
    stats,
    start,
    stop,
    /** test helper */
    _networkCalls: () => networkCalls,
    _resetNetworkCalls: () => { networkCalls = 0; },
    dayKey,
  };
}

module.exports = {
  dayKey,
  createWikiCommonKnowledgeCache,
};
