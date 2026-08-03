/**
 * PSN Now Playing poller (unofficial psn-api).
 *
 * Detects in-game via getBasicPresence → gameTitleInfoList.
 * Enriches with getUserPlayedGames (playtime / last played) + best-effort trophies.
 * Manual Auth preview pushes now-playing or last-played (dismissible).
 */

const {
  ensurePsnAuth,
  fetchBasicPresence,
  fetchPlayedTitles,
  enrichPsnTitle,
  findPlayedTitle,
  psnReadingIsThin,
} = require('./psn-api');

/**
 * PSN publishes a title's library entry, playtime and trophy set some way into
 * the session, not at launch — so the first enrichment almost always comes back
 * bare. Re-check on this schedule (ms after the previous look) until the card
 * is complete or we run out of patience.
 */
const REENRICH_DELAYS_MS = [45_000, 90_000, 180_000, 300_000, 600_000];
const { resolvePsnCredentials, markPsnAuthStatus } = require('./psn-session');
const {
  buildPsnNowPlayingPayload,
  buildPsnNowPlayingClosePayload,
} = require('./udp-payload');
const { createPsnLibraryCache } = require('./psn-library-cache');

function createPsnNowPlaying({
  config,
  log,
  sendUdpPayload,
  now = () => Date.now(),
  apiHelpers = null,
} = {}) {
  const psnConfig = config.psn;
  const helpers = apiHelpers || {
    ensurePsnAuth,
    fetchBasicPresence,
    fetchPlayedTitles,
    enrichPsnTitle,
  };
  const libraryCache = createPsnLibraryCache(config, log);

  let timer = null;
  let running = false;
  /** @type {null | {
   *   titleId: string,
   *   startedAt: number,
   *   suppressed: boolean,
   *   suppressedAt: number | null,
   *   suppressReason: string | null,
   *   pushed: boolean,
   *   lastPushAt: number,
   *   details: object | null,
   *   enrichAttempts: number,
   *   nextEnrichAt: number,
   * }} */
  let session = null;
  let lastError = null;
  let lastStatus = 'idle';
  let restoreTimer = null;
  let lastOnlineId = null;

  function getCredentials() {
    return resolvePsnCredentials(psnConfig);
  }

  function restoreAfterInterruptMs() {
    return Math.max(15, Number(psnConfig.restoreAfterInterruptSeconds) || 75) * 1000;
  }

  function statusSnapshot() {
    const creds = getCredentials();
    const restoreMs = restoreAfterInterruptMs();
    const suppressedAgeMs = session?.suppressed && session.suppressedAt
      ? Math.max(0, now() - session.suppressedAt)
      : null;
    return {
      enabled: psnConfig.enabled !== false,
      configured: Boolean(creds.configured),
      onlineId: lastOnlineId || creds.onlineId || null,
      accountId: creds.accountId || null,
      restoreAfterInterruptSeconds: Math.round(restoreMs / 1000),
      status: lastStatus,
      message: lastError,
      session: session
        ? {
          titleId: session.titleId,
          startedAt: new Date(session.startedAt).toISOString(),
          suppressed: session.suppressed,
          suppressReason: session.suppressReason || null,
          suppressedAt: session.suppressedAt
            ? new Date(session.suppressedAt).toISOString()
            : null,
          restoreInSec: session.suppressed && suppressedAgeMs != null
            ? Math.max(0, Math.ceil((restoreMs - suppressedAgeMs) / 1000))
            : null,
          pushed: session.pushed,
          elapsedSec: Math.max(0, Math.round((now() - session.startedAt) / 1000)),
        }
        : null,
    };
  }

  function cacheReading(reading) {
    try {
      libraryCache.rememberTitleFromReading(reading);
    } catch {
      // Cache is best-effort.
    }
  }

  function pushOpen(reading) {
    const payload = buildPsnNowPlayingPayload(reading, config);
    if (!payload) {
      return;
    }
    cacheReading(reading);
    sendUdpPayload(payload);
    if (session) {
      session.pushed = true;
      session.lastPushAt = now();
      session.details = reading;
    }
    log?.info?.('PSN Now Playing pushed', {
      titleId: reading.titleId,
      name: reading.name,
      platform: reading.platform,
    });
  }

  function pushClose(reason = 'game-ended') {
    sendUdpPayload(buildPsnNowPlayingClosePayload({ trigger: reason }, config));
    log?.info?.('PSN Now Playing closed', { reason });
  }

  function beginSession({ titleId }) {
    clearRestoreTimer();
    session = {
      titleId: String(titleId),
      startedAt: now(),
      suppressed: false,
      suppressedAt: null,
      suppressReason: null,
      pushed: false,
      lastPushAt: 0,
      details: null,
      enrichAttempts: 0,
      nextEnrichAt: 0,
    };
  }

  /** How many of the four optional bands this reading can actually fill. */
  function readingFillCount(reading) {
    return [
      String(reading?.shortDescription || '').trim(),
      (reading?.screenshots || []).length,
      reading?.playtimeLabel,
      reading?.trophies?.available,
    ].filter(Boolean).length;
  }

  async function refreshThinReading(auth, game) {
    if (!session?.details || !psnReadingIsThin(session.details)) {
      return;
    }
    if (session.enrichAttempts >= REENRICH_DELAYS_MS.length || now() < session.nextEnrichAt) {
      return;
    }
    const attempt = session.enrichAttempts;
    session.enrichAttempts += 1;
    session.nextEnrichAt = now()
      + REENRICH_DELAYS_MS[Math.min(attempt + 1, REENRICH_DELAYS_MS.length - 1)];

    let reading;
    try {
      reading = await helpers.enrichPsnTitle(auth.authorization, auth.accountId, game, {
        onlineId: auth.onlineId || lastOnlineId,
        mode: 'playing',
      });
    } catch (error) {
      lastError = error?.message || String(error);
      return;
    }
    // Only redraw when the wait actually bought something — a re-push that
    // changes nothing just restarts the card's animation on screen.
    if (!reading?.name || readingFillCount(reading) <= readingFillCount(session.details)) {
      return;
    }
    log?.info?.('PSN Now Playing enriched', {
      titleId: reading.titleId,
      attempt: attempt + 1,
    });
    cacheReading(reading);
    pushOpen({
      ...reading,
      startedAt: session.startedAt,
      elapsedSec: Math.max(0, Math.round((now() - session.startedAt) / 1000)),
      onlineId: auth.onlineId || lastOnlineId || reading.onlineId,
      mode: 'playing',
    });
  }

  function endSession(reason) {
    clearRestoreTimer();
    const wasPushed = Boolean(session?.pushed && !session?.suppressed);
    session = null;
    if (wasPushed) {
      pushClose(reason);
    }
  }

  function clearRestoreTimer() {
    if (restoreTimer) {
      clearTimeout(restoreTimer);
      restoreTimer = null;
    }
  }

  function scheduleRestoreTick(delayMs) {
    clearRestoreTimer();
    restoreTimer = setTimeout(() => {
      restoreTimer = null;
      tick().catch((error) => {
        lastError = error?.message || String(error);
        log?.warn?.('PSN Now Playing restore tick failed', lastError);
      });
    }, Math.max(0, delayMs));
    if (typeof restoreTimer.unref === 'function') {
      restoreTimer.unref();
    }
  }

  function suppressActiveSession(reason = 'interrupted') {
    if (!session || session.suppressed) {
      return false;
    }
    session.suppressed = true;
    session.suppressedAt = now();
    session.suppressReason = String(reason || 'interrupted');
    lastStatus = 'suppressed';
    const restoreMs = restoreAfterInterruptMs();
    scheduleRestoreTick(restoreMs);
    log?.info?.('PSN Now Playing suppressed', {
      titleId: session.titleId,
      reason: session.suppressReason,
      restoreAfterSec: Math.round(restoreMs / 1000),
    });
    return true;
  }

  function maybeClearSuppressForRestore() {
    if (!session?.suppressed) {
      return false;
    }
    const suppressedAt = Number(session.suppressedAt || 0);
    if (!suppressedAt) {
      session.suppressed = false;
      session.suppressReason = null;
      session.pushed = false;
      return true;
    }
    if (now() - suppressedAt < restoreAfterInterruptMs()) {
      return false;
    }
    session.suppressed = false;
    session.suppressedAt = null;
    const reason = session.suppressReason;
    session.suppressReason = null;
    session.pushed = false;
    clearRestoreTimer();
    log?.info?.('PSN Now Playing restoring after interrupt', {
      titleId: session.titleId,
      reason,
    });
    return true;
  }

  async function tick() {
    if (psnConfig.enabled === false) {
      lastStatus = 'disabled';
      return;
    }
    const creds = getCredentials();
    if (!creds.configured) {
      lastStatus = 'not_linked';
      lastError = null;
      return;
    }

    let auth;
    try {
      auth = await helpers.ensurePsnAuth(psnConfig);
      lastOnlineId = auth.onlineId || lastOnlineId;
      lastError = null;
    } catch (error) {
      lastStatus = 'auth_error';
      lastError = error?.message || String(error);
      markPsnAuthStatus(psnConfig, {
        status: 'auth_error',
        message: lastError,
      });
      return;
    }

    let presence;
    try {
      presence = await helpers.fetchBasicPresence(auth.authorization, auth.accountId);
    } catch (error) {
      lastStatus = 'api_error';
      lastError = error?.message || String(error);
      markPsnAuthStatus(psnConfig, {
        status: 'api_error',
        message: lastError,
      });
      return;
    }

    const game = presence?.game || null;
    const titleId = game?.titleId || null;

    if (!titleId) {
      if (session) {
        endSession('game-ended');
      }
      lastStatus = 'idle';
      return;
    }

    if (session && session.titleId !== titleId) {
      endSession('title-changed');
    }

    if (!session) {
      beginSession({ titleId });
    }

    maybeClearSuppressForRestore();

    if (session.suppressed) {
      lastStatus = 'suppressed';
      return;
    }

    if (session.pushed && session.details?.titleId === titleId) {
      // Refresh elapsed only — avoid spamming UDP every poll — but do go back
      // for the details PSN had not published yet when the session opened.
      await refreshThinReading(auth, game);
      lastStatus = 'playing';
      return;
    }

    let reading;
    try {
      reading = await helpers.enrichPsnTitle(
        auth.authorization,
        auth.accountId,
        game,
        {
          onlineId: auth.onlineId || lastOnlineId,
          mode: 'playing',
        },
      );
    } catch (error) {
      lastError = error?.message || String(error);
      reading = {
        titleId,
        name: game.name || 'PlayStation Game',
        platform: game.platform,
        tags: game.platform ? [game.platform] : [],
        statusLine: game.platform ? `Playing now · on ${game.platform}` : 'Playing now',
        posterCandidates: [game.npTitleIconUrl, game.conceptIconUrl].filter(Boolean),
        headerImage: game.npTitleIconUrl || game.conceptIconUrl || null,
        screenshots: [],
        achievements: { earned: null, total: null, available: false },
        trophies: { earned: null, total: null, available: false },
      };
    }

    if (!reading?.name) {
      lastStatus = 'api_error';
      lastError = 'Could not enrich PSN title';
      return;
    }

    reading = {
      ...reading,
      startedAt: session.startedAt,
      elapsedSec: Math.max(0, Math.round((now() - session.startedAt) / 1000)),
      onlineId: auth.onlineId || lastOnlineId || reading.onlineId,
      mode: 'playing',
    };

    pushOpen(reading);
    session.nextEnrichAt = now() + REENRICH_DELAYS_MS[0];
    lastStatus = 'playing';
    markPsnAuthStatus(psnConfig, { status: 'ok', message: null });
  }

  /**
   * @param {Object} [options]
   * @param {'auto'|'now-playing'|'last-played'} [options.requestedMode] `auto`
   *   (the admin test button) falls back to the last played title when nothing
   *   is running. The scheduler asks for one specific mode so a `psn.now-playing`
   *   rule can never quietly air a last-played card instead.
   */
  async function pushManualPreview({ device = 'Signal', send, requestedMode = 'auto' } = {}) {
    const creds = getCredentials();
    if (!creds.configured) {
      return { ok: false, error: 'PSN is not linked — paste an NPSSO cookie first' };
    }

    let auth;
    try {
      auth = await helpers.ensurePsnAuth(psnConfig);
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }

    let mode = 'playing';
    let game = null;
    if (requestedMode !== 'last-played') {
      try {
        const presence = await helpers.fetchBasicPresence(auth.authorization, auth.accountId);
        game = presence?.game || null;
      } catch (error) {
        return { ok: false, error: error?.message || String(error) };
      }
      if (!game?.titleId && requestedMode === 'now-playing') {
        return { ok: false, error: 'Nothing is playing on PSN right now' };
      }
    }

    let playedTitles = [];
    try {
      playedTitles = await helpers.fetchPlayedTitles(auth.authorization, auth.accountId);
    } catch {
      playedTitles = [];
    }

    if (!game?.titleId) {
      const top = playedTitles[0] || null;
      if (!top?.titleId && !top?.name) {
        return { ok: false, error: 'Nothing playing right now, and no recently played games found' };
      }
      mode = 'last-played';
      game = {
        titleId: top.titleId,
        name: top.name,
        platform: top.category
          ? String(top.category).replace(/_game$/i, '').toUpperCase()
          : null,
        conceptIconUrl: top.imageUrl,
        npTitleIconUrl: top.imageUrl,
      };
    }

    let reading;
    try {
      reading = await helpers.enrichPsnTitle(
        auth.authorization,
        auth.accountId,
        game,
        {
          playedTitles,
          onlineId: auth.onlineId,
          mode,
        },
      );
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
    if (!reading) {
      return { ok: false, error: 'Could not load PSN title details' };
    }

    cacheReading(reading);

    const played = findPlayedTitle(playedTitles, game.titleId, game.name);
    reading = {
      ...reading,
      startedAt: mode === 'playing' ? now() : (reading.lastPlayedAt || played?.lastPlayedAt || now()),
      lastPlayedAt: reading.lastPlayedAt || played?.lastPlayedAt || null,
      elapsedSec: 0,
      onlineId: auth.onlineId || reading.onlineId,
      mode,
    };

    const payload = buildPsnNowPlayingPayload(reading, config, {
      device,
      trigger: 'psn-manual-preview',
      mode,
      dismissible: true,
    });
    if (!payload) {
      return { ok: false, error: 'Failed to build PSN display payload' };
    }
    const emit = typeof send === 'function' ? send : sendUdpPayload;
    emit(payload);
    log?.info?.('PSN Now Playing manual preview pushed', {
      mode,
      titleId: reading.titleId,
      name: reading.name,
    });
    return {
      ok: true,
      mode,
      titleId: reading.titleId,
      name: reading.name,
      displaySeconds: payload.displaySeconds,
    };
  }

  function start() {
    if (running || psnConfig.enabled === false) {
      return;
    }
    running = true;
    const intervalMs = (psnConfig.pollIntervalSeconds || 20) * 1000;
    const run = () => {
      tick().catch((error) => {
        lastError = error?.message || String(error);
        log?.warn?.('PSN Now Playing tick failed', lastError);
      });
    };
    run();
    timer = setInterval(run, intervalMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    log?.info?.('PSN Now Playing poller started', {
      pollIntervalSeconds: psnConfig.pollIntervalSeconds,
      restoreAfterInterruptSeconds: psnConfig.restoreAfterInterruptSeconds,
    });
  }

  function stop() {
    running = false;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    clearRestoreTimer();
  }

  return {
    start,
    stop,
    tick,
    suppressActiveSession,
    statusSnapshot,
    pushManualPreview,
    _getSession: () => session,
    _setSession: (value) => { session = value; },
    _maybeClearSuppressForRestore: () => maybeClearSuppressForRestore(),
  };
}

module.exports = {
  createPsnNowPlaying,
};
