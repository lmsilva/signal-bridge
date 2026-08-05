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
