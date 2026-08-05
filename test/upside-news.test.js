const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  decodeHtmlEntities,
  stripHtml,
  titleSimilarity,
  readingMinutes,
  relativeOrAbsoluteTime,
} = require('../src/upside-news-text');
const {
  sanitiseSettings,
  cycleSecondsFor,
  indexSecondsFor,
  createUpsideNewsSettings,
} = require('../src/upside-news-settings');
const { resolveTopicId, listTopics } = require('../src/upside-news-categories');
const {
  createUpsideNewsArchive,
  passesFilters,
  scoreStory,
  pickRandomStories,
} = require('../src/upside-news-archive');
const { buildUpsideNewsRoundPayload } = require('../src/udp-payload');
const { createCommandRegistry } = require('../src/command-registry');
const { parseRssItems } = require('../src/upside-news-rss');
const { normaliseGuardianResult } = require('../src/upside-news-guardian');

test('decodeHtmlEntities cleans Guardian trailText', () => {
  assert.equal(decodeHtmlEntities('Fish &amp; chips'), 'Fish & chips');
  assert.equal(stripHtml('<p>Hello <b>world</b></p>'), 'Hello world');
});

test('topic artwork registry has 13 sections including general', () => {
  const topics = listTopics();
  assert.ok(topics.length >= 13);
  assert.equal(resolveTopicId('environment'), 'environment');
  assert.equal(resolveTopicId('lifeandstyle'), 'society');
  assert.equal(resolveTopicId('unknown-section'), 'general');
});

test('cycle length matches goodnews.md defaults', () => {
  assert.equal(indexSecondsFor(5), 12);
  assert.equal(cycleSecondsFor({ items: 5, storySeconds: 15 }), 87);
  assert.equal(cycleSecondsFor({ items: 8, storySeconds: 15 }), 137);
});

test('settings hard-cap items at 8', () => {
  const settings = sanitiseSettings({ items: 99, storySeconds: 3, period: 'nope' });
  assert.equal(settings.items, 8);
  assert.equal(settings.storySeconds, 8);
  assert.equal(settings.period, 'daily');
});

test('denylist filters negative headlines', () => {
  const settings = sanitiseSettings({});
  assert.equal(passesFilters({
    headline: 'Breakthrough cure discovered',
    standfirst: 'Scientists celebrate',
  }, settings), true);
  assert.equal(passesFilters({
    headline: 'Crisis as war attack kills dozens',
    standfirst: '',
  }, settings), false);
});

test('scoreStory boosts positive signals and corroboration', () => {
  const settings = sanitiseSettings({});
  const now = Date.now();
  const low = scoreStory({
    headline: 'Something happened',
    standfirst: '',
    corroboratingSources: 1,
    publishedAt: new Date(now).toISOString(),
    sectionId: 'world',
  }, settings, now);
  const high = scoreStory({
    headline: 'Record breakthrough recovery saved species',
    standfirst: 'Rewilding wins',
    corroboratingSources: 3,
    publishedAt: new Date(now).toISOString(),
    sectionId: 'environment',
    sourceId: 'guardian',
  }, settings, now);
  assert.ok(high > low);
});

test('titleSimilarity catches near-duplicate headlines', () => {
  assert.ok(titleSimilarity(
    'Mangroves restore coastal towns in Senegal',
    'Mangroves restore coastal towns across Senegal',
  ) >= 0.72);
  assert.ok(titleSimilarity('Cats win award', 'Stock market tumbles') < 0.3);
});

test('readingMinutes and relative time helpers', () => {
  assert.equal(readingMinutes(460), 2);
  assert.match(relativeOrAbsoluteTime(new Date(Date.now() - 2 * 3600 * 1000).toISOString(), {
    period: 'daily',
  }), /h ago/);
  assert.match(relativeOrAbsoluteTime('2026-03-12T12:00:00.000Z', {
    period: 'monthly',
  }), /Mar/);
});

test('RSS parser extracts items from a minimal feed', () => {
  const xml = `<?xml version="1.0"?>
  <rss><channel>
    <item>
      <title>Happy &amp; hopeful news</title>
      <link>https://example.com/a</link>
      <description><![CDATA[A short standfirst.]]></description>
      <pubDate>Tue, 04 Aug 2026 12:00:00 GMT</pubDate>
      <category>Environment</category>
    </item>
  </channel></rss>`;
  const items = parseRssItems(xml);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Happy & hopeful news');
  assert.equal(items[0].link, 'https://example.com/a');
});

test('normaliseGuardianResult drops non-syndicatable articles', () => {
  const kept = normaliseGuardianResult({
    id: 'environment/2026/aug/04/good',
    webTitle: 'Trees planted',
    sectionId: 'environment',
    sectionName: 'Environment',
    webPublicationDate: '2026-08-04T10:00:00Z',
    webUrl: 'https://www.theguardian.com/environment/2026/aug/04/good',
    type: 'article',
    fields: {
      headline: 'Trees planted',
      trailText: 'A hopeful standfirst',
      shortUrl: 'https://gu.com/p/abc',
      wordcount: '700',
      byline: 'Fiona Harvey',
    },
    rights: { syndicatable: 'true' },
    tags: [],
  });
  assert.equal(kept.headline, 'Trees planted');
  assert.equal(kept.url, 'https://gu.com/p/abc');

  const dropped = normaliseGuardianResult({
    id: 'x',
    webTitle: 'Nope',
    fields: { headline: 'Nope' },
    rights: { syndicatable: false },
  });
  assert.equal(dropped, null);
});

test('buildUpsideNewsRoundPayload shapes index + stories', () => {
  const payload = buildUpsideNewsRoundPayload({
    stories: [
      {
        id: '1',
        headline: 'Story one',
        standfirst: 'Standfirst',
        sectionId: 'environment',
        sectionName: 'Environment',
        accent: '#00D16C',
        url: 'https://gu.com/p/1',
        artwork: { portrait: 'a', landscape: 'b' },
      },
      {
        id: '2',
        headline: 'Story two',
        standfirst: '',
        sectionId: 'health',
        url: 'https://gu.com/p/2',
      },
    ],
    settings: { period: 'daily', showQr: true },
    indexSeconds: 12,
    storySeconds: 15,
    artworkBaseUrl: 'https://bridge.local:47810',
  }, {});
  assert.equal(payload.type, 'upside-news.round');
  assert.equal(payload.upsideNews.storyCount, 2);
  assert.equal(payload.upsideNews.indexTitle, "Today's 2");
  assert.equal(payload.displaySeconds, 12 + 2 * 15);
  assert.ok(payload.upsideNews.indexArtwork.portrait.includes('/upside-news-artwork/general-portrait.jpg'));
});

test('index title uses word forms for 3–8 stories', () => {
  const payload = buildUpsideNewsRoundPayload({
    stories: [1, 2, 3, 4, 5].map((n) => ({
      id: String(n),
      headline: `Story ${n}`,
      sectionId: 'general',
      url: `https://example.com/${n}`,
    })),
    settings: { period: 'daily' },
    indexSeconds: 12,
    storySeconds: 15,
  }, {});
  assert.equal(payload.upsideNews.indexTitle, "Today's five");
});

test('archive selectStories returns ranked daily set from injected stories', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upside-news-'));
  const settings = createUpsideNewsSettings({
    upsideNewsSettingsPath: path.join(dir, 'settings.json'),
  });
  const archive = createUpsideNewsArchive({
    config: { upsideNewsArchivePath: path.join(dir, 'archive.json') },
    settings,
    getApiKey: () => '',
    now: () => Date.parse('2026-08-04T18:00:00.000Z'),
  });
  archive._setStories([
    {
      id: 'a',
      sourceId: 'good-news-network',
      headline: 'Breakthrough recovery saved a forest',
      standfirst: 'Rewilding wins',
      sectionId: 'environment',
      publishedAt: '2026-08-04T12:00:00.000Z',
      url: 'https://example.com/a',
      corroboratingSources: 1,
    },
    {
      id: 'b',
      sourceId: 'guardian',
      headline: 'Quiet day at the office',
      standfirst: 'Nothing much',
      sectionId: 'business',
      publishedAt: '2026-08-04T11:00:00.000Z',
      url: 'https://example.com/b',
      corroboratingSources: 1,
    },
    {
      id: 'old',
      sourceId: 'guardian',
      headline: 'Old breakthrough',
      standfirst: '',
      sectionId: 'science',
      publishedAt: '2026-07-01T11:00:00.000Z',
      url: 'https://example.com/old',
      corroboratingSources: 1,
    },
  ]);
  const selected = archive.selectStories({ items: 5, period: 'daily' });
  assert.ok(selected.length >= 1);
  assert.ok(selected.every((story) => story.id !== 'old'));
  assert.equal(archive.hasContent({ items: 3 }), false); // only 2 in window
  assert.equal(archive.hasContent({ items: 5 }), false);
  // With 2 stories, hasContent still true for min 3? Spec: hasContent = archive has ≥ items OR at least something?
  // Our impl: available >= min(3, want). With 2 stories and want 5 → min(3,5)=3 → false. Good.
});

test('pickRandomStories prefers unseen ids then shuffles', () => {
  const scored = [
    { id: 'a', score: 10, publishedAt: '2026-08-04T12:00:00.000Z' },
    { id: 'b', score: 9, publishedAt: '2026-08-04T11:00:00.000Z' },
    { id: 'c', score: 8, publishedAt: '2026-08-04T10:00:00.000Z' },
    { id: 'd', score: 7, publishedAt: '2026-08-04T09:00:00.000Z' },
    { id: 'e', score: 6, publishedAt: '2026-08-04T08:00:00.000Z' },
    { id: 'f', score: 5, publishedAt: '2026-08-04T07:00:00.000Z' },
  ];
  const first = pickRandomStories(scored, 3, {
    recentIds: new Set(['a', 'b', 'c']),
    rng: () => 0, // deterministic: always swaps to index 0 → stable reverse-ish shuffle
  });
  assert.equal(first.length, 3);
  assert.ok(first.every((story) => !['a', 'b', 'c'].includes(story.id)));

  const orderA = pickRandomStories(scored, 3, { recentIds: new Set(), rng: () => 0 })
    .map((story) => story.id)
    .join(',');
  let calls = 0;
  const orderB = pickRandomStories(scored, 3, {
    recentIds: new Set(),
    rng: () => {
      calls += 1;
      return calls % 2 === 0 ? 0.99 : 0.01;
    },
  }).map((story) => story.id).join(',');
  assert.notEqual(orderA, orderB);
});

test('selectStories + rememberShown rotates away from the last push', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upside-news-rot-'));
  const settings = createUpsideNewsSettings({
    upsideNewsSettingsPath: path.join(dir, 'settings.json'),
  });
  let seq = 0;
  const archive = createUpsideNewsArchive({
    config: { upsideNewsArchivePath: path.join(dir, 'archive.json') },
    settings,
    getApiKey: () => '',
    now: () => Date.parse('2026-08-04T18:00:00.000Z'),
    rng: () => {
      // Mild shuffle that still lets preference for unseen dominate.
      seq += 1;
      return (seq % 5) / 5;
    },
  });
  const injected = [];
  for (let i = 0; i < 12; i += 1) {
    injected.push({
      id: `s${i}`,
      sourceId: 'good-news-network',
      headline: `Breakthrough recovery story ${i}`,
      standfirst: 'Hopeful update',
      sectionId: 'environment',
      publishedAt: `2026-08-04T${String(10 + (i % 8)).padStart(2, '0')}:00:00.000Z`,
      url: `https://example.com/s${i}`,
      corroboratingSources: 1,
    });
  }
  archive._setStories(injected);

  const first = archive.selectStories({ items: 5, period: 'daily' });
  assert.equal(first.length, 5);
  archive.rememberShown(first.map((story) => story.id));
  const second = archive.selectStories({ items: 5, period: 'daily' });
  assert.equal(second.length, 5);
  const overlap = second.filter((story) => first.some((prior) => prior.id === story.id));
  assert.ok(
    overlap.length <= 2,
    `expected little overlap after rememberShown, got ${overlap.map((s) => s.id)}`,
  );
});

test('command registry registers goodnews.show as variable duration', () => {
  const registry = createCommandRegistry({
    getUpsideNewsStatus: () => ({
      hasContent: true,
      available: 5,
      settings: { items: 5, storySeconds: 15, indexSeconds: null },
      cycleSeconds: 87,
    }),
  });
  const command = registry.get('goodnews.show');
  assert.equal(command.title, 'The Upside News');
  assert.equal(command.variableDuration, true);
  assert.equal(command.group, 'News');
  assert.equal(registry.hasContent('goodnews.show'), true);
  assert.equal(registry.estimateDuration('goodnews.show'), 87);
});

test('testKey uses active env key when no pasted key is provided', async () => {
  const { createUpsideNewsService } = require('../src/upside-news-service');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upside-news-key-'));
  const previous = process.env.GUARDIAN_API_KEY;
  process.env.GUARDIAN_API_KEY = 'env-test-key-123456';
  let seenKey = null;
  const service = createUpsideNewsService({
    config: {
      ROOT: dir,
      upsideNewsSettingsPath: path.join(dir, 'settings.json'),
      upsideNewsArchivePath: path.join(dir, 'archive.json'),
      guardianCredentialsPath: path.join(dir, 'guardian-credentials.json'),
    },
    fetchImpl: async (url) => {
      seenKey = new URL(url).searchParams.get('api-key');
      return {
        ok: true,
        async json() {
          return { response: { status: 'ok', results: [], pages: 1, currentPage: 1, total: 0 } };
        },
      };
    },
  });
  try {
    const result = await service.testKey('');
    assert.equal(result.ok, true);
    assert.equal(result.testedSource, 'env');
    assert.equal(seenKey, 'env-test-key-123456');

    const pasted = await service.testKey('pasted-key-999');
    assert.equal(pasted.testedSource, 'provided');
    assert.equal(seenKey, 'pasted-key-999');
  } finally {
    if (previous === undefined) delete process.env.GUARDIAN_API_KEY;
    else process.env.GUARDIAN_API_KEY = previous;
  }
});
