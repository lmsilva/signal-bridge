/**
 * Wiki Common Knowledge — settings, cache, and UDP push.
 */

const path = require('path');
const {
  createWikiCommonKnowledgeSettings,
  indexSecondsFor,
  cycleSecondsFor,
} = require('./wiki-common-knowledge-settings');
const { createWikiCommonKnowledgeCache } = require('./wiki-common-knowledge-cache');
const {
  listTopics,
  artworkUrls,
  ensureArtworkPlaceholders,
  getUnmatchedLog,
} = require('./wiki-common-knowledge-categories');
const { createWikiClient } = require('./wiki-common-knowledge-wiki');
const { buildWikiCommonKnowledgeRoundPayload } = require('./udp-payload');

function createWikiCommonKnowledgeService({
  config = {},
  log = console,
  sendUdpPayload = null,
  now = () => Date.now(),
  fetchImpl = fetch,
} = {}) {
  const root = config.ROOT || path.resolve(__dirname, '..');
  ensureArtworkPlaceholders(root, log);
  const settings = createWikiCommonKnowledgeSettings(config, log);
  const cache = createWikiCommonKnowledgeCache({
    config,
    log,
    settings,
    fetchImpl,
    now,
  });

  function artworkBaseUrl() {
    if (config.wikiCommonKnowledge?.artworkBaseUrl) {
      return String(config.wikiCommonKnowledge.artworkBaseUrl).replace(/\/+$/, '');
    }
    const host = config.proxyOwnIp || config.webServer?.publicHost || null;
    if (host) {
      const scheme = config.webServer?.https === false ? 'http' : 'https';
      const port = config.webServer?.port || 47810;
      return `${scheme}://${host}:${port}`;
    }
    const guestUrl = String(
      process.env.GUEST_PHOTOBOOTH_URL
      || config.guestPhotobooth?.url
      || '',
    ).trim();
    if (guestUrl) {
      try {
        const parsed = new URL(guestUrl);
        return `${parsed.protocol}//${parsed.host}`.replace(/\/+$/, '');
      } catch { /* fall through */ }
    }
    return '';
  }

  function presentArticle(article, settingsSnapshot) {
    const catId = article.categoryId || 'misc';
    const art = artworkUrls(artworkBaseUrl(), catId);
    const topic = listTopics().find((t) => t.id === art.topicId) || {};
    return {
      id: article.pageid || article.title,
      rank: article.rank,
      title: article.title,
      description: article.description || '',
      extract: article.extract || '',
      categoryId: art.topicId,
      categoryName: topic.label || art.topicId,
      accent: topic.accent || '#E897FF',
      background: topic.background || '#7A2396',
      thumbnailUrl: article.thumbnailUrl || article.originalImageUrl || '',
      imageUrl: article.originalImageUrl || article.thumbnailUrl || '',
      contentUrl: article.contentUrl || '',
      views: article.views || 0,
      viewsDelta: article.viewsDelta || 0,
      viewsDeltaPct: article.viewsDeltaPct,
      history: Array.isArray(article.history) ? article.history.slice(-30) : [],
      artwork: {
        topic: art.imageUrl,
        fallback: art.fallbackUrl,
      },
      showSparkline: settingsSnapshot.showSparkline !== false,
    };
  }

  function buildRound(overrides = {}, { device = 'Signal', triggeredBy = 'manual' } = {}) {
    const current = { ...settings.get(), ...overrides };
    const selected = cache.selectArticles(overrides);
    if (!selected.length) {
      return {
        ok: false,
        error: 'No Wikipedia articles cached yet — set a contact email, then refresh the cache',
      };
    }

    const items = selected.length;
    const indexSeconds = indexSecondsFor(items, current.indexSeconds);
    const articleSeconds = Math.max(8, Math.min(30, Number(current.articleSeconds) || 15));
    let loops = current.loops || 'once';
    if (triggeredBy === 'scheduler' && loops === 'until-dismissed') {
      loops = 'once';
    }
    const loopCount = loops === 'until-dismissed'
      ? 0
      : (loops === 'once' ? 1 : Math.max(1, Number(loops) || 1));
    const oneCycle = cycleSecondsFor({
      items,
      indexSeconds,
      articleSeconds,
    });
    const SLACK_SECONDS = 4;
    const durationSeconds = (loopCount > 0 ? oneCycle * loopCount : oneCycle)
      + SLACK_SECONDS;

    const payload = buildWikiCommonKnowledgeRoundPayload({
      stories: selected.map((a) => presentArticle(a, current)),
      settings: current,
      indexSeconds,
      articleSeconds,
      loops,
      loopCount,
      artworkBaseUrl: artworkBaseUrl(),
      device,
      timestamp: now(),
      trigger: `wiki-common-knowledge-${triggeredBy}`,
      triggeredBy,
      durationSeconds,
    }, config);

    if (!payload) {
      return { ok: false, error: 'Could not build a Wiki Common Knowledge payload' };
    }
    return {
      ok: true,
      payload,
      durationSeconds,
      storyCount: items,
      cycleSeconds: oneCycle,
    };
  }

  function push(overrides = {}, { device = 'Signal', triggeredBy = 'manual', send } = {}) {
    const round = buildRound(overrides, { device, triggeredBy });
    if (!round.ok) return round;
    const emit = typeof send === 'function' ? send : sendUdpPayload;
    if (typeof emit !== 'function') {
      return { ok: false, error: 'No UDP sender is wired up' };
    }
    emit(round.payload);
    log?.info?.('Wiki Common Knowledge round pushed', {
      stories: round.storyCount,
      seconds: round.durationSeconds,
      triggeredBy,
    });
    return {
      ok: true,
      sessionId: round.payload.wikiCommonKnowledge.sessionId,
      storyCount: round.storyCount,
      durationSeconds: round.durationSeconds,
      cycleSeconds: round.cycleSeconds,
    };
  }

  function statusSnapshot() {
    const current = settings.get();
    const cacheStats = cache.stats();
    return {
      enabled: true,
      settings: {
        ...current,
        apiToken: current.apiToken ? '••••••••' : '',
      },
      cycleSeconds: cycleSecondsFor(current),
      indexSeconds: indexSecondsFor(current.items, current.indexSeconds),
      hasContent: cache.hasContent(),
      available: cache.selectArticles().length,
      cache: cacheStats,
      topics: listTopics(),
      unmatchedCategories: getUnmatchedLog(),
      artworkBaseUrl: artworkBaseUrl(),
      hasContactEmail: Boolean(current.contactEmail && current.contactEmail.includes('@')),
    };
  }

  async function testConnection() {
    const snap = settings.get();
    if (!snap.contactEmail || !snap.contactEmail.includes('@')) {
      return { ok: false, error: 'Contact email is required for the Wikimedia User-Agent' };
    }
    const client = createWikiClient({
      contactEmail: snap.contactEmail,
      apiToken: snap.apiToken,
      lang: snap.lang,
      fetchImpl,
      log,
    });
    return client.testConnection();
  }

  return {
    settings,
    cache,
    start: () => cache.start(),
    stop: () => cache.stop(),
    buildRound,
    push,
    statusSnapshot,
    hasContent: (overrides) => cache.hasContent(overrides),
    estimateDuration: (overrides) => cache.estimateDuration(overrides),
    testConnection,
    artworkBaseUrl,
  };
}

module.exports = {
  createWikiCommonKnowledgeService,
};
