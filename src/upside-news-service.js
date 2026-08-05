/**
 * The Upside News — wires settings, archive, and UDP payload for push / scheduler.
 */

const path = require('path');
const { createUpsideNewsSettings, indexSecondsFor, cycleSecondsFor } = require('./upside-news-settings');
const { createUpsideNewsArchive } = require('./upside-news-archive');
const {
  resolveGuardianApiKey,
  defaultCredentialsPath,
  saveGuardianApiKey,
} = require('./upside-news-credentials');
const { testGuardianKey } = require('./upside-news-guardian');
const { buildUpsideNewsRoundPayload } = require('./udp-payload');
const { listTopics, artworkUrls } = require('./upside-news-categories');
const { readingMinutes, relativeOrAbsoluteTime } = require('./upside-news-text');
const { RSS_SOURCES } = require('./upside-news-settings');

function createUpsideNewsService({
  config = {},
  log = console,
  sendUdpPayload = null,
  now = () => Date.now(),
  fetchImpl = fetch,
} = {}) {
  const root = config.ROOT || path.resolve(__dirname, '..');
  const credentialsPath = config.guardianCredentialsPath || defaultCredentialsPath(root);
  const settings = createUpsideNewsSettings(config, log);

  function getApiKey() {
    const resolved = resolveGuardianApiKey({
      env: process.env,
      configKey: config.upsideNews?.guardianApiKey || config.guardian?.apiKey || '',
      credentialsPath,
    });
    return resolved.apiKey;
  }

  function apiKeyInfo() {
    return resolveGuardianApiKey({
      env: process.env,
      configKey: config.upsideNews?.guardianApiKey || config.guardian?.apiKey || '',
      credentialsPath,
    });
  }

  const archive = createUpsideNewsArchive({
    config,
    log,
    settings,
    getApiKey,
    fetchImpl,
    now,
  });

  function artworkBaseUrl() {
    if (config.upsideNews?.artworkBaseUrl) {
      return String(config.upsideNews.artworkBaseUrl).replace(/\/+$/, '');
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
      } catch {
        // fall through
      }
    }
    return '';
  }

  function presentStory(story, settingsSnapshot) {
    const art = artworkUrls(artworkBaseUrl(), story.sectionId);
    const topic = listTopics().find((t) => t.id === art.topicId) || {};
    return {
      id: story.id,
      headline: story.headline,
      standfirst: story.standfirst || '',
      sectionId: art.topicId,
      sectionName: story.sectionName || topic.label || art.topicId,
      accent: topic.accent || '#E897FF',
      background: topic.background || '#7A2396',
      publishedAt: story.publishedAt,
      publishedLabel: relativeOrAbsoluteTime(story.publishedAt, {
        period: settingsSnapshot.period,
        now: now(),
      }),
      readingMinutes: readingMinutes(story.wordcount),
      byline: story.byline || '',
      sourceLabel: story.sourceLabel || story.sourceId,
      url: story.url || story.webUrl || null,
      keywords: settingsSnapshot.showTopicTags ? (story.keywords || []).slice(0, 3) : [],
      artwork: {
        portrait: art.portrait,
        landscape: art.landscape,
      },
      score: story.score,
    };
  }

  function buildRound(overrides = {}, { device = 'Signal', triggeredBy = 'manual' } = {}) {
    const current = { ...settings.get(), ...overrides };
    const selected = archive.selectStories(overrides);
    if (!selected.length) {
      return {
        ok: false,
        error: 'No positive stories in the archive for this period yet — wait for a poll, or check your Guardian API key',
      };
    }
    // Remember this draw so the next push prefers different stories.
    archive.rememberShown?.(selected.map((story) => story.id));

    const items = selected.length;
    const indexSeconds = indexSecondsFor(items, current.indexSeconds);
    const storySeconds = Math.max(8, Math.min(30, Number(current.storySeconds) || 15));
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
      storySeconds,
    });
    // Until-dismissed: air one cycle for busy tracking; client loops locally.
    // A few seconds of slack covers Tk after()-drift so the last story page
    // is not trimmed off the overlay clock.
    const SLACK_SECONDS = 4;
    const durationSeconds = (loopCount > 0 ? oneCycle * loopCount : oneCycle)
      + SLACK_SECONDS;

    const payload = buildUpsideNewsRoundPayload({
      stories: selected.map((story) => presentStory(story, current)),
      settings: current,
      indexSeconds,
      storySeconds,
      loops,
      loopCount,
      artworkBaseUrl: artworkBaseUrl(),
      device,
      timestamp: now(),
      trigger: `upside-news-${triggeredBy}`,
      triggeredBy,
      durationSeconds,
    }, config);

    if (!payload) {
      return { ok: false, error: 'Could not build an Upside News payload' };
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
    if (!round.ok) {
      return round;
    }
    const emit = typeof send === 'function' ? send : sendUdpPayload;
    if (typeof emit !== 'function') {
      return { ok: false, error: 'No UDP sender is wired up' };
    }
    emit(round.payload);
    log?.info?.('Upside News round pushed', {
      stories: round.storyCount,
      seconds: round.durationSeconds,
      triggeredBy,
    });
    return {
      ok: true,
      sessionId: round.payload.upsideNews.sessionId,
      storyCount: round.storyCount,
      durationSeconds: round.durationSeconds,
      cycleSeconds: round.cycleSeconds,
    };
  }

  function statusSnapshot() {
    const current = settings.get();
    const key = apiKeyInfo();
    const archiveStats = archive.stats();
    return {
      enabled: true,
      settings: current,
      cycleSeconds: cycleSecondsFor(current),
      indexSeconds: indexSecondsFor(current.items, current.indexSeconds),
      hasContent: archive.hasContent(),
      available: archive.selectStories().length,
      archive: archiveStats,
      apiKeySource: key.apiKeySource,
      hasApiKey: Boolean(key.apiKey),
      topics: listTopics().map((topic) => ({
        id: topic.id,
        label: topic.label,
        accent: topic.accent,
        background: topic.background,
      })),
      rssSources: Object.values(RSS_SOURCES).map((source) => ({
        id: source.id,
        label: source.label,
        enabled: current.enabledRssSourceIds.includes(source.id),
      })),
      artworkBaseUrl: artworkBaseUrl(),
    };
  }

  async function saveApiKey(apiKey) {
    if (String(process.env.GUARDIAN_API_KEY || '').trim()) {
      return {
        ok: false,
        error: 'GUARDIAN_API_KEY is set in .env and takes precedence. '
          + 'Update or remove it in .env — admin save does not rewrite .env.',
        source: 'env',
      };
    }
    saveGuardianApiKey(credentialsPath, apiKey);
    return { ok: true, source: 'session' };
  }

  async function testKey(apiKey) {
    const provided = String(apiKey || '').trim();
    if (provided) {
      const result = await testGuardianKey(provided, { fetchImpl });
      return { ...result, testedSource: 'provided' };
    }
    const info = apiKeyInfo();
    if (!info.apiKey) {
      return {
        ok: false,
        error: 'No API key to test — paste one here, or set GUARDIAN_API_KEY in .env',
      };
    }
    const result = await testGuardianKey(info.apiKey, { fetchImpl });
    return { ...result, testedSource: info.apiKeySource || 'session' };
  }

  return {
    settings,
    archive,
    start: () => archive.start(),
    stop: () => archive.stop(),
    buildRound,
    push,
    statusSnapshot,
    hasContent: (overrides) => archive.hasContent(overrides),
    estimateDuration: (overrides) => archive.estimateDuration(overrides),
    saveApiKey,
    testKey,
    getApiKey,
    apiKeyInfo,
    artworkBaseUrl,
  };
}

module.exports = {
  createUpsideNewsService,
};
