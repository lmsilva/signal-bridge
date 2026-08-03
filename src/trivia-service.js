/**
 * Wires the trivia pieces into one thing the listener and web server can hold.
 *
 * `trivia-settings` (what the user wants) + `trivia-providers` (where questions
 * come from) + `trivia-pool` (the local table that makes the display instant) +
 * `udp-payload` (how a round reaches the screen).
 */

const fs = require('fs');
const path = require('path');
const { createTriviaSettings, roundDurationSeconds } = require('./trivia-settings');
const { createOpentdbProvider, createTriviaApiProvider } = require('./trivia-providers');
const { createTriviaPool } = require('./trivia-pool');
const { buildTriviaRoundPayload } = require('./udp-payload');
const { listCategories } = require('./trivia-categories');

/** Persisted OpenTDB session token — they die after 6h idle (trivia.md §2.2). */
function createTokenStore(config, log) {
  const tokenPath = config.triviaTokensPath
    || path.resolve(config.ROOT || path.resolve(__dirname, '..'), 'data/trivia-tokens.json');
  return {
    read() {
      try {
        if (!fs.existsSync(tokenPath)) {
          return null;
        }
        return JSON.parse(fs.readFileSync(tokenPath, 'utf8'))?.opentdb || null;
      } catch (error) {
        log?.warn?.('Could not read trivia tokens', error?.message || error);
        return null;
      }
    },
    write(token) {
      try {
        fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
        fs.writeFileSync(
          tokenPath,
          `${JSON.stringify({ opentdb: token, savedAt: new Date().toISOString() }, null, 2)}\n`,
          'utf8',
        );
      } catch (error) {
        log?.warn?.('Could not persist trivia tokens', error?.message || error);
      }
    },
    tokenPath,
  };
}

function createTriviaService({
  config = {},
  log = console,
  sendUdpPayload = null,
  now = () => Date.now(),
  providers: injectedProviders = null,
  refillIntervalMs,
} = {}) {
  const settings = createTriviaSettings(config, log);
  const tokenStore = createTokenStore(config, log);

  const providers = injectedProviders || [
    createOpentdbProvider({ log, tokenStore, now }),
    createTriviaApiProvider({
      log,
      now,
      // Optional on the free tier — nothing may be gated behind it (§11.8).
      getApiKey: () => config.trivia?.triviaApiKey || process.env.TRIVIA_API_KEY || null,
    }),
  ];

  const pool = createTriviaPool({
    config, log, providers, settings, now, refillIntervalMs,
  });

  /**
   * Origin the display should fetch category artwork from.
   *
   * Prefer a public HTTPS origin (GUEST_PHOTOBOOTH_URL / Signal domain) when
   * set — the display can verify a real cert. Fall back to the LAN
   * PROXY_OWN_IP:47810 origin (self-signed; the client tolerates that).
   */
  function artworkBaseUrl() {
    if (config.trivia?.artworkBaseUrl) {
      return String(config.trivia.artworkBaseUrl).replace(/\/+$/, '');
    }
    const guestUrl = String(
      process.env.GUEST_PHOTOBOOTH_URL
      || config.guestPhotobooth?.url
      || config.guestPhotobooth?.publicOrigin
      || '',
    ).trim();
    if (guestUrl) {
      try {
        const parsed = new URL(guestUrl);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          return `${parsed.protocol}//${parsed.host}`.replace(/\/+$/, '');
        }
      } catch {
        // Fall through to LAN origin.
      }
    }
    const host = config.proxyOwnIp || config.webServer?.publicHost || null;
    if (!host) {
      return '';
    }
    const scheme = config.webServer?.https === false ? 'http' : 'https';
    const port = config.webServer?.port || 47810;
    return `${scheme}://${host}:${port}`;
  }

  /**
   * Draw a round and build its payload. Returns `{ ok: false }` rather than a
   * short round — a half-populated trivia card is worse than none (§5.1).
   */
  function buildRound(overrides = {}, { device = 'Signal', triggeredBy = 'manual' } = {}) {
    const drawn = pool.drawSession(overrides);
    if (!drawn.ok) {
      return drawn;
    }
    const current = settings.get();
    const payload = buildTriviaRoundPayload({
      questions: drawn.questions,
      settings: current,
      overrides,
      artworkBaseUrl: artworkBaseUrl(),
      device,
      timestamp: now(),
      trigger: `trivia-${triggeredBy}`,
      triggeredBy,
      durationSeconds: drawn.durationSeconds,
      attribution: [...new Set(drawn.questions.map((question) => {
        const provider = providers.find((p) => p.id === question.provider);
        return provider?.attribution?.label || question.provider;
      }))],
    }, config);
    if (!payload) {
      return { ok: false, error: 'Could not build a trivia payload' };
    }
    return {
      ok: true,
      payload,
      relaxation: drawn.relaxation,
      durationSeconds: drawn.durationSeconds,
      questionCount: drawn.questions.length,
    };
  }

  /**
   * @param {Function} [options.send] Targeted delivery from the web server;
   *   falls back to the listener's broadcast.
   */
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
    log?.info?.('Trivia round pushed', {
      questions: round.questionCount,
      seconds: round.durationSeconds,
      relaxation: round.relaxation,
      triggeredBy,
    });
    return {
      ok: true,
      sessionId: round.payload.trivia.sessionId,
      questionCount: round.questionCount,
      durationSeconds: round.durationSeconds,
      relaxation: round.relaxation,
    };
  }

  /** Shape the command registry and the settings page read. */
  function statusSnapshot() {
    const poolStatus = pool.status();
    return {
      ...poolStatus,
      enabled: config.trivia?.enabled !== false,
      providers: providers.map((provider) => ({
        id: provider.id,
        attribution: provider.attribution,
        supportsImages: provider.supportsImages,
        requiresAuth: provider.requiresAuth,
        enabled: poolStatus.settings.enabledProviders.includes(provider.id),
      })),
      roundDurationSeconds: roundDurationSeconds(poolStatus.settings),
      artworkBaseUrl: artworkBaseUrl(),
    };
  }

  function categoriesWithCounts() {
    const poolStatus = pool.status();
    const current = poolStatus.settings;
    return listCategories().map((category) => ({
      ...category,
      count: poolStatus.perCategory[category.id] || 0,
      enabled: current.enabledCategoryIds.includes(category.id),
      // Grey out with a real number rather than failing silently at air time.
      starved: (poolStatus.perCategory[category.id] || 0) < current.questionsPerSession,
    }));
  }

  return {
    settings,
    pool,
    providers,
    start: () => pool.start(),
    stop: () => pool.stop(),
    buildRound,
    push,
    statusSnapshot,
    categoriesWithCounts,
    artworkBaseUrl,
    hasContent: (overrides) => pool.hasContent(overrides),
    estimateDuration: (overrides) => roundDurationSeconds(settings.get(), overrides),
  };
}

module.exports = { createTriviaService, createTokenStore };
