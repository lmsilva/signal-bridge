const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  sanitiseSettings,
  cycleSecondsFor,
  indexSecondsFor,
  createWikiCommonKnowledgeSettings,
} = require('../src/wiki-common-knowledge-settings');
const {
  categoriseDescription,
  listTopics,
} = require('../src/wiki-common-knowledge-categories');
const {
  filterArticles,
  matchesDenylist,
} = require('../src/wiki-common-knowledge-filters');
const {
  normaliseFeaturedArticle,
  articlesFromFeatured,
  buildUserAgent,
  wikimediaDisplayUrl,
  displayImageCandidates,
} = require('../src/wiki-common-knowledge-wiki');
const { createWikiCommonKnowledgeCache } = require('../src/wiki-common-knowledge-cache');
const { createWikiCommonKnowledgeService } = require('../src/wiki-common-knowledge-service');
const { buildWikiCommonKnowledgeRoundPayload } = require('../src/udp-payload');
const { createCommandRegistry } = require('../src/command-registry');

test('User-Agent requires contact email', () => {
  assert.throws(() => buildUserAgent({ contactEmail: '' }), /contact email/i);
  const ua = buildUserAgent({ contactEmail: 'ops@example.com' });
  assert.match(ua, /SignalBridge/);
  assert.match(ua, /ops@example\.com/);
});

test('topic registry has 20 categories', () => {
  assert.ok(listTopics().length >= 20);
});

test('category map prefers specific keywords', () => {
  assert.equal(categoriseDescription('NASA astronaut on the ISS'), 'space');
  assert.equal(categoriseDescription('British film director and screenwriter'), 'film');
  assert.equal(categoriseDescription('completely unrelated fluff'), 'misc');
});

test('cycle length matches Upside-style formula', () => {
  assert.equal(indexSecondsFor(5), 12);
  assert.equal(cycleSecondsFor({ items: 5, articleSeconds: 15 }), 87);
});

test('settings hard-cap items at 8', () => {
  const settings = sanitiseSettings({ items: 99, articleSeconds: 3, period: 'nope' });
  assert.equal(settings.items, 8);
  assert.equal(settings.articleSeconds, 8);
  assert.equal(settings.period, 'daily');
});

test('denylist filters distressing titles', () => {
  assert.equal(matchesDenylist('Murder of Jane Doe', ['murder of']), true);
  const kept = filterArticles([
    { title: 'Solar eclipse', description: 'astronomy' },
    { title: 'Murder of Jane Doe', description: '' },
  ], { denylist: ['murder of'], filterDistressing: true });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].title, 'Solar eclipse');
});

test('featured article normalisation', () => {
  const art = normaliseFeaturedArticle({
    normalizedtitle: 'Ada_Lovelace',
    title: 'Ada_Lovelace',
    description: 'English mathematician',
    extract: 'Ada Lovelace was…',
    views: 120000,
    views_delta: 20000,
    rank: 2,
    thumbnail: { source: 'https://example.com/t.jpg' },
    content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Ada_Lovelace' } },
    view_history: [{ date: '2026-08-01', views: 100000 }, { date: '2026-08-02', views: 120000 }],
  });
  assert.equal(art.title, 'Ada Lovelace');
  assert.equal(art.rank, 2);
  assert.equal(art.viewsDeltaPct, 20);
  assert.equal(art.thumbnailUrl, 'https://example.com/t.jpg');
  assert.equal(articlesFromFeatured({ mostread: { articles: [{ title: 'A', views: 1 }] } }).length, 1);
});

test('wikimedia display urls prefer bounded thumbs over originals', () => {
  const thumb = wikimediaDisplayUrl(
    'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Glen.jpg/220px-Glen.jpg',
    { minWidth: 960 },
  );
  assert.match(thumb, /\/960px-Glen\.jpg$/);

  const fromOriginal = wikimediaDisplayUrl(
    'https://upload.wikimedia.org/wikipedia/commons/a/ab/Glen.jpg',
    { minWidth: 960 },
  );
  assert.equal(
    fromOriginal,
    'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Glen.jpg/960px-Glen.jpg',
  );

  const candidates = displayImageCandidates({
    thumbnailUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Glen.jpg/220px-Glen.jpg',
    originalImageUrl: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Glen_Huge.tif',
  });
  assert.equal(candidates[0], thumb);
  assert.match(candidates.join('\n'), /lossy-page1-960px-Glen_Huge\.tif\.jpg/);
});

test('day-list cache hit makes zero network calls', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-ck-'));
  const settings = createWikiCommonKnowledgeSettings({
    wikiCommonKnowledgeSettingsPath: path.join(tmp, 'settings.json'),
    ROOT: tmp,
  });
  settings.update({ contactEmail: 'ops@example.com', items: 3 });
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new Error('network should not be called');
  };
  const cache = createWikiCommonKnowledgeCache({
    config: { ROOT: tmp, wikiCommonKnowledgeCacheDir: path.join(tmp, 'cache') },
    settings,
    fetchImpl,
  });
  const day = cache.dayKey(new Date(), 'daily');
  const dayFile = path.join(tmp, 'cache', 'days', `daily-${day}.json`);
  fs.mkdirSync(path.dirname(dayFile), { recursive: true });
  fs.writeFileSync(dayFile, JSON.stringify({
    period: 'daily',
    key: day,
    fetchedAt: Date.now(),
    articles: [
      { title: 'One', description: 'astronaut', extract: 'x', views: 10, rank: 1, history: [] },
      { title: 'Two', description: 'film director', extract: 'y', views: 9, rank: 2, history: [] },
      { title: 'Three', description: 'city', extract: 'z', views: 8, rank: 3, history: [] },
    ],
  }));
  const result = await cache.fetchDay('daily', { force: false });
  assert.equal(result.fromCache, true);
  assert.equal(result.articles.length, 3);
  assert.equal(calls, 0);
  assert.equal(cache.selectArticles().length, 3);
  assert.equal(cache.hasContent(), true);
});

test('empty today stub falls back to yesterday cache and walk-back featured', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-ck-empty-'));
  const settings = createWikiCommonKnowledgeSettings({
    wikiCommonKnowledgeSettingsPath: path.join(tmp, 'settings.json'),
    ROOT: tmp,
  });
  settings.update({ contactEmail: 'ops@example.com', items: 3 });
  const fixedNow = Date.UTC(2026, 7, 6, 18, 0, 0); // 2026-08-06
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    if (String(url).includes('/featured/2026/08/06')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ tfa: { title: 'Duck' } }), // no mostread
        text: async () => '',
      };
    }
    if (String(url).includes('/featured/2026/08/05')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({
          mostread: {
            articles: [
              {
                normalizedtitle: 'Ada_Lovelace',
                title: 'Ada_Lovelace',
                description: 'mathematician',
                extract: 'Ada Lovelace was a pioneer of computing and mathematics.',
                views: 100,
                views_delta: 10,
                rank: 1,
                thumbnail: { source: 'https://example.com/a.jpg' },
                content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Ada_Lovelace' } },
              },
              {
                normalizedtitle: 'Mars',
                title: 'Mars',
                description: 'planet',
                extract: 'Mars is the fourth planet from the Sun in our solar system.',
                views: 90,
                rank: 2,
                thumbnail: { source: 'https://example.com/b.jpg' },
              },
              {
                normalizedtitle: 'Tokyo',
                title: 'Tokyo',
                description: 'city',
                extract: 'Tokyo is the capital of Japan and a major world city.',
                views: 80,
                rank: 3,
                thumbnail: { source: 'https://example.com/c.jpg' },
              },
            ],
          },
        }),
        text: async () => '',
      };
    }
    // Summary / pageviews history — return minimal ok bodies
    if (String(url).includes('/page/summary/') || String(url).includes('/per-article/')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ extract: 'ok', thumbnail: { source: 'https://example.com/t.jpg' }, items: [] }),
        text: async () => '',
      };
    }
    return {
      ok: false,
      status: 404,
      headers: { get: () => null },
      json: async () => ({}),
      text: async () => 'missing',
    };
  };
  const cache = createWikiCommonKnowledgeCache({
    config: { ROOT: tmp, wikiCommonKnowledgeCacheDir: path.join(tmp, 'cache') },
    settings,
    fetchImpl,
    now: () => fixedNow,
  });
  // Poisoned empty stub for "today"
  const todayKey = '2026-08-06';
  const daysDir = path.join(tmp, 'cache', 'days');
  fs.mkdirSync(daysDir, { recursive: true });
  fs.writeFileSync(path.join(daysDir, `daily-${todayKey}.json`), JSON.stringify({
    period: 'daily', key: todayKey, fetchedAt: fixedNow, articles: [],
  }));
  // Push should still see yesterday if we had it — and force poll should walk back.
  assert.equal(cache.hasContent(), false);
  const result = await cache.fetchDay('daily', { force: true });
  assert.equal(result.ok, true);
  assert.ok(result.articles.length >= 3);
  assert.ok(urls.some((u) => u.includes('/featured/2026/08/06')));
  assert.ok(urls.some((u) => u.includes('/featured/2026/08/05')));
  assert.equal(cache.hasContent(), true);
  const written = JSON.parse(fs.readFileSync(path.join(daysDir, `daily-${todayKey}.json`), 'utf8'));
  assert.ok(written.articles.length >= 3);
});

test('UDP payload shape', () => {
  const payload = buildWikiCommonKnowledgeRoundPayload({
    stories: [
      {
        id: 1, rank: 1, title: 'Ada Lovelace', description: 'mathematician',
        extract: 'Pioneer of computing.', categoryId: 'science', categoryName: 'Science',
        views: 100, viewsDelta: 10, viewsDeltaPct: 11, history: [{ views: 90 }, { views: 100 }],
        contentUrl: 'https://en.wikipedia.org/wiki/Ada_Lovelace',
      },
      {
        id: 2, rank: 2, title: 'Mars', description: 'planet', extract: 'Fourth planet.',
        categoryId: 'space', categoryName: 'Space', views: 90, history: [],
      },
      {
        id: 3, rank: 3, title: 'Tokyo', description: 'city', extract: 'Capital of Japan.',
        categoryId: 'geography', categoryName: 'Geography', views: 80, history: [],
      },
    ],
    settings: { period: 'daily', showQr: true, showSparkline: true },
    indexSeconds: 12,
    articleSeconds: 15,
    durationSeconds: 61,
    artworkBaseUrl: 'https://bridge.local:47810',
  });
  assert.equal(payload.type, 'wiki-common-knowledge.round');
  assert.equal(payload.wikiCommonKnowledge.storyCount, 3);
  assert.equal(payload.wikiCommonKnowledge.title, 'Wikipedia Common Knowledge');
  assert.equal(payload.wikiCommonKnowledge.indexTitle.includes('world'), true);
  assert.equal(payload.displaySeconds, 61);
});

test('command registry content check and duration', () => {
  const registry = createCommandRegistry({
    getWikiCommonKnowledgeStatus: () => ({
      hasContent: true,
      available: 5,
      settings: { items: 5, articleSeconds: 15, indexSeconds: 12 },
      cycleSeconds: 87,
    }),
  });
  assert.equal(registry.hasContent('wiki.show'), true);
  assert.equal(registry.estimateDuration('wiki.show'), 87);
  const cmd = registry.list().find((c) => c.id === 'wiki.show');
  assert.equal(cmd.title, 'Wikipedia Common Knowledge');
  assert.equal(cmd.group, 'Knowledge');
  assert.equal(cmd.variableDuration, true);
});

test('service push builds payload from cache', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-svc-'));
  const sent = [];
  const service = createWikiCommonKnowledgeService({
    config: {
      ROOT: tmp,
      wikiCommonKnowledgeSettingsPath: path.join(tmp, 'settings.json'),
      wikiCommonKnowledgeCacheDir: path.join(tmp, 'cache'),
      wikiCommonKnowledge: { artworkBaseUrl: 'https://bridge.test' },
    },
    sendUdpPayload: (p) => sent.push(p),
    fetchImpl: async () => { throw new Error('no net'); },
  });
  service.settings.update({ contactEmail: 'ops@example.com', items: 3 });
  const day = service.cache.dayKey(new Date(), 'daily');
  const dayFile = path.join(tmp, 'cache', 'days', `daily-${day}.json`);
  fs.mkdirSync(path.dirname(dayFile), { recursive: true });
  fs.writeFileSync(dayFile, JSON.stringify({
    articles: [
      { title: 'A', description: 'scientist', extract: 'aa', views: 3, rank: 1, history: [], categoryId: 'science' },
      { title: 'B', description: 'musician', extract: 'bb', views: 2, rank: 2, history: [], categoryId: 'music' },
      { title: 'C', description: 'city', extract: 'cc', views: 1, rank: 3, history: [], categoryId: 'geography' },
    ],
  }));
  const result = service.push({});
  assert.equal(result.ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'wiki-common-knowledge.round');
  assert.ok(sent[0].displaySeconds >= 58);
});
