/**
 * Steam Now Playing poller: presence allowlist + session suppress rules.
 */

const {
  fetchPlayerSummary,
  fetchRecentlyPlayedGames,
  fetchMostRecentlyPlayedOwnedGame,
  fetchAppDetails,
  fetchOwnedGamePlaytime,
  fetchAchievementProgress,
  fetchCurrentPlayers,
  formatPlaytimeHours,
} = require('./steam-api');
const { createSteamPresenceStore } = require('./steam-presence');
const { resolveSteamCredentials, markSteamAuthStatus } = require('./steam-session');
const { createSteamArtworkCache } = require('./steam-artwork-cache');
const { resolvePublicOrigin } = require('./steam-auth');
const {
  buildSteamNowPlayingPayload,
  buildSteamNowPlayingClosePayload,
} = require('./udp-payload');

/**
 * Steam Web API gameid often lags a local launch by tens of seconds — or never
 * appears. Prefer account gameid, then local presence, then a fresh OwnedGames
 * last-played timestamp (see pickRecentPlayAppId).
 */
function resolveEffectiveSteamAppId(accountAppId, presenceEntry, recentAppId = null) {
  const fromAccount = Number(accountAppId);
  if (Number.isFinite(fromAccount) && fromAccount > 0) {
    return fromAccount;
  }
  const fromPresence = Number(presenceEntry?.appId);
  if (Number.isFinite(fromPresence) && fromPresence > 0) {
    return fromPresence;
  }
  const fromRecent = Number(recentAppId);
  if (Number.isFinite(fromRecent) && fromRecent > 0) {
    return fromRecent;
  }
  return null;
}

/** Online / away / busy / etc. — not Offline (0) or unknown. */
function isSteamPersonaOnline(personaState) {
  const state = Number(personaState);
  return Number.isFinite(state) && state >= 1;
}

/**
 * When Steam omits gameid, infer the in-game app from OwnedGames rtime.
 * - Fresh lastPlayedAt (infer window) can start a session.
 * - An active session stays alive only while playtime/rtime keeps moving, or
 *   for a short stagnant grace after the last bump (quit detection).
 */
function pickRecentPlayAppId({
  recentGame,
  sessionAppId = null,
  sessionLastPlaytime = null,
  sessionLastRtime = null,
  sessionLastActivityAt = null,
  nowMs,
  inferSeconds = 300,
  stagnantSeconds = 120,
  personaOnline = false,
} = {}) {
  if (!personaOnline || !recentGame) {
    return null;
  }
  const appId = Number(recentGame.appId);
  const lastPlayedAt = Number(recentGame.lastPlayedAt);
  const playtime = Number.isFinite(Number(recentGame.playtimeForeverMin))
    ? Number(recentGame.playtimeForeverMin)
    : null;
  if (!Number.isFinite(appId) || appId <= 0 || !Number.isFinite(lastPlayedAt) || lastPlayedAt <= 0) {
    return null;
  }
  const ageSec = Math.max(0, (Number(nowMs) - lastPlayedAt) / 1000);
  const active = Number(sessionAppId);
  const sameSession = Number.isFinite(active) && active === appId;

  if (!sameSession) {
    return ageSec <= inferSeconds ? appId : null;
  }

  const playtimeGrew = playtime != null
    && Number.isFinite(Number(sessionLastPlaytime))
    && playtime > Number(sessionLastPlaytime);
  const rtimeGrew = Number.isFinite(Number(sessionLastRtime))
    && lastPlayedAt > Number(sessionLastRtime);
  if (playtimeGrew || rtimeGrew) {
    return appId;
  }

  const lastActivity = Number(sessionLastActivityAt) || lastPlayedAt;
  const stagnantFor = Math.max(0, (Number(nowMs) - lastActivity) / 1000);
  if (stagnantFor <= stagnantSeconds) {
    return appId;
  }
  return null;
}

function applyCachedArtworkUrls(reading, artworkCache, publicOrigin) {
  if (!reading?.appId || !artworkCache) {
    return reading;
  }
  const local = artworkCache.getServedImageUrls(reading.appId, publicOrigin);
  if (!local) {
    return reading;
  }
  return {
    ...reading,
    posterCandidates: local.posterCandidates.length
      ? local.posterCandidates
      : reading.posterCandidates,
    screenshots: local.screenshots.length ? local.screenshots : reading.screenshots,
    headerImage: local.headerImage || reading.headerImage,
  };
}

function createSteamNowPlaying({
  config,
  log,
  sendUdpPayload,
  now = () => Date.now(),
  artworkCache: artworkCacheArg = null,
} = {}) {
  const steamConfig = config.steam;
  const presence = createSteamPresenceStore(steamConfig, { now });
  const artworkCache = artworkCacheArg || createSteamArtworkCache(config, log);

  let timer = null;
  let tickSoonTimer = null;
  let running = false;
  /** @type {null | {
   *   appId: number,
   *   host: string,
   *   startedAt: number,
   *   suppressed: boolean,
   *   suppressedAt: number | null,
   *   suppressReason: string | null,
   *   pushed: boolean,
   *   lastPushAt: number,
   *   details: object | null,
   *   lastPlaytime: number | null,
   *   lastRtime: number | null,
   *   lastActivityAt: number | null,
   *   recentLed: boolean,
   * }} */
  let session = null;
  let lastAccountAppId = null;
  /** Last non-null GetPlayerSummaries gameid — used to detect authoritative quits. */
  let lastSummaryGameId = null;
  /** After Steam clears gameid, ignore OwnedGames for that app until playtime/rtime grows. */
  let quitSuppress = null; // { appId, playtime, rtime }
  let lastError = null;
  let lastStatus = 'idle';
  let restoreTimer = null;
  /** @type {Set<number>} */
  const detailsRefreshInFlight = new Set();

  function getCredentials() {
    return resolveSteamCredentials(steamConfig);
  }

  function publicOrigin() {
    return resolvePublicOrigin(config, steamConfig);
  }

  function restoreAfterInterruptMs() {
    return Math.max(15, Number(steamConfig.restoreAfterInterruptSeconds) || 75) * 1000;
  }

  function statusSnapshot() {
    const creds = getCredentials();
    const restoreMs = restoreAfterInterruptMs();
    const suppressedAgeMs = session?.suppressed && session.suppressedAt
      ? Math.max(0, now() - session.suppressedAt)
      : null;
    const art = artworkCache.stats();
    return {
      enabled: steamConfig.enabled !== false,
      configured: Boolean(creds.apiKey && creds.steamId),
      hasApiKey: Boolean(creds.apiKey),
      hasSteamId: Boolean(creds.steamId),
      apiKeySource: creds.apiKeySource || null,
      personaName: creds.personaName,
      steamId: creds.steamId || null,
      requirePresence: Boolean(steamConfig.requirePresence),
      allowedHosts: steamConfig.allowedHosts || [],
      restoreAfterInterruptSeconds: Math.round(restoreMs / 1000),
      inferFromRecentSeconds: steamConfig.inferFromRecentSeconds,
      recentPlayStagnantSeconds: steamConfig.recentPlayStagnantSeconds,
      artworkCache: {
        apps: art.apps,
        bytes: art.bytes,
      },
      status: lastStatus,
      message: lastError,
      session: session
        ? {
          appId: session.appId,
          host: session.host,
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
          recentLed: Boolean(session.recentLed),
        }
        : null,
      presence: presence.snapshot(),
      lastAccountAppId,
    };
  }

  function scheduleArtworkWarm(appId, details) {
    if (!details || !appId) {
      return;
    }
    Promise.resolve()
      .then(() => artworkCache.warmImages(appId, details))
      .then((result) => {
        if (!result?.warmed || !session || session.appId !== Number(appId)
          || !session.pushed || session.suppressed) {
          return;
        }
        // One re-push after a fresh warm so the display switches to LAN URLs.
        const withLocal = applyCachedArtworkUrls(
          session.details || details,
          artworkCache,
          publicOrigin(),
        );
        pushOpen({
          ...withLocal,
          host: session.host,
          startedAt: session.startedAt,
          elapsedSec: Math.max(0, Math.round((now() - session.startedAt) / 1000)),
        });
      })
      .catch((error) => {
        log?.warn?.('Steam artwork warm failed', error?.message || String(error));
      });
  }

  function scheduleDetailsRefresh(appId) {
    const id = Number(appId);
    if (!Number.isFinite(id) || detailsRefreshInFlight.has(id)) {
      return;
    }
    detailsRefreshInFlight.add(id);
    Promise.resolve()
      .then(() => fetchAppDetails(id))
      .then((details) => {
        if (!details) {
          return;
        }
        artworkCache.saveDetails(id, details);
        scheduleArtworkWarm(id, details);
      })
      .catch((error) => {
        log?.warn?.('Steam details refresh failed', error?.message || String(error));
      })
      .finally(() => {
        detailsRefreshInFlight.delete(id);
      });
  }

  async function enrichGame(apiKey, steamId, appId) {
    const cachedDetails = artworkCache.getDetails(appId);
    const detailsPromise = cachedDetails
      ? Promise.resolve(cachedDetails)
      : fetchAppDetails(appId).then((details) => {
        if (details) {
          artworkCache.saveDetails(appId, details);
        }
        return details;
      });

    const [details, playtime, achievements, players] = await Promise.all([
      detailsPromise,
      fetchOwnedGamePlaytime(apiKey, steamId, appId).catch(() => null),
      fetchAchievementProgress(apiKey, steamId, appId).catch(() => ({
        earned: null,
        total: null,
        available: false,
      })),
      fetchCurrentPlayers(appId),
    ]);
    if (!details) {
      return null;
    }
    if (cachedDetails) {
      // Prefer snappy push from cache; refresh store metadata in the background.
      scheduleDetailsRefresh(appId);
    }
    let reading = {
      ...details,
      playtimeForeverMin: playtime?.playtimeForeverMin ?? null,
      playtimeLabel: formatPlaytimeHours(playtime?.playtimeForeverMin),
      lastPlayedAt: playtime?.lastPlayedAt ?? null,
      achievements,
      currentPlayers: players,
    };
    reading = applyCachedArtworkUrls(reading, artworkCache, publicOrigin());
    scheduleArtworkWarm(appId, details);
    return reading;
  }

  function pushOpen(reading) {
    const payload = buildSteamNowPlayingPayload(reading, config);
    if (!payload) {
      return;
    }
    sendUdpPayload(payload);
    if (session) {
      session.pushed = true;
      session.lastPushAt = now();
      session.details = reading;
    }
    log?.info?.('Steam Now Playing pushed', {
      appId: reading.appId,
      host: reading.host,
      name: reading.name,
    });
  }

  function pushClose(reason = 'game-ended') {
    sendUdpPayload(buildSteamNowPlayingClosePayload({ trigger: reason }, config));
    log?.info?.('Steam Now Playing closed', { reason });
  }

  function beginSession({ appId, host, recentLed = false, recentGame = null }) {
    clearRestoreTimer();
    const playtime = recentGame && Number.isFinite(Number(recentGame.playtimeForeverMin))
      ? Number(recentGame.playtimeForeverMin)
      : null;
    const rtime = recentGame && Number.isFinite(Number(recentGame.lastPlayedAt))
      ? Number(recentGame.lastPlayedAt)
      : null;
    session = {
      appId: Number(appId),
      host: String(host),
      startedAt: now(),
      suppressed: false,
      suppressedAt: null,
      suppressReason: null,
      pushed: false,
      lastPushAt: 0,
      details: null,
      lastPlaytime: playtime,
      lastRtime: rtime,
      lastActivityAt: now(),
      recentLed: Boolean(recentLed),
    };
  }

  function noteRecentActivity(recentGame) {
    if (!session || !recentGame) {
      return;
    }
    const playtime = Number.isFinite(Number(recentGame.playtimeForeverMin))
      ? Number(recentGame.playtimeForeverMin)
      : null;
    const rtime = Number.isFinite(Number(recentGame.lastPlayedAt))
      ? Number(recentGame.lastPlayedAt)
      : null;
    const playtimeGrew = playtime != null
      && session.lastPlaytime != null
      && playtime > session.lastPlaytime;
    const rtimeGrew = rtime != null
      && session.lastRtime != null
      && rtime > session.lastRtime;
    if (playtimeGrew || rtimeGrew || session.lastPlaytime == null || session.lastRtime == null) {
      if (playtime != null) {
        session.lastPlaytime = playtime;
      }
      if (rtime != null) {
        session.lastRtime = rtime;
      }
      if (playtimeGrew || rtimeGrew) {
        session.lastActivityAt = now();
      }
    }
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
        log?.warn?.('Steam Now Playing restore tick failed', lastError);
      });
    }, Math.max(0, delayMs));
    if (typeof restoreTimer.unref === 'function') {
      restoreTimer.unref();
    }
  }

  /**
   * Called when any other display overlay is sent. Steam yields the screen,
   * then automatically restores after restoreAfterInterruptSeconds while the
   * same game is still running (previously stayed suppressed until quit).
   */
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
    log?.info?.('Steam Now Playing suppressed', {
      appId: session.appId,
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
      // Legacy / test sessions without a timestamp — restore on next tick.
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
    log?.info?.('Steam Now Playing restoring after interrupt', {
      appId: session.appId,
      reason,
    });
    return true;
  }

  function scheduleImmediateTick(reason = 'presence') {
    if (tickSoonTimer) {
      clearTimeout(tickSoonTimer);
    }
    tickSoonTimer = setTimeout(() => {
      tickSoonTimer = null;
      tick().catch((error) => {
        lastError = error?.message || String(error);
        log?.warn?.('Steam Now Playing immediate tick failed', {
          reason,
          error: lastError,
        });
      });
    }, 200);
    if (typeof tickSoonTimer.unref === 'function') {
      tickSoonTimer.unref();
    }
  }

  function recordPresence(body) {
    const result = presence.upsert(body || {});
    // Closest thing to a "push": theater-PC heartbeat → poll Steam + open overlay
    // without waiting for the next interval.
    if (result?.ok) {
      scheduleImmediateTick('presence');
    }
    return result;
  }

  async function tick() {
    if (!steamConfig.enabled) {
      lastStatus = 'disabled';
      return;
    }
    const creds = getCredentials();
    if (!creds.apiKey || !creds.steamId) {
      lastStatus = !creds.apiKey ? 'missing_api_key' : 'not_linked';
      lastError = !creds.apiKey
        ? 'Set STEAM_API_KEY in .env (or save via admin)'
        : 'Link your Steam account from Settings → Authentication';
      return;
    }

    let summary;
    try {
      summary = await fetchPlayerSummary(creds.apiKey, creds.steamId);
      lastError = null;
    } catch (error) {
      lastError = error?.message || String(error);
      lastStatus = 'api_error';
      markSteamAuthStatus(steamConfig, {
        status: 'error',
        message: lastError,
        reason: 'api_error',
      });
      return;
    }

    if (!summary) {
      lastStatus = 'profile_unavailable';
      lastError = 'Steam profile not returned — check SteamID and API key';
      return;
    }

    const accountAppId = summary.gameId;
    // Profile gameid clearing is authoritative quit — OwnedGames rtime often
    // stamps the quit time and would otherwise keep the overlay up.
    if (lastSummaryGameId && !accountAppId) {
      quitSuppress = {
        appId: Number(lastSummaryGameId),
        playtime: session?.lastPlaytime ?? null,
        rtime: session?.lastRtime ?? null,
      };
      if (session && session.appId === quitSuppress.appId && !session.recentLed) {
        endSession('game-ended');
      }
    }
    if (accountAppId) {
      lastSummaryGameId = accountAppId;
      if (quitSuppress && Number(quitSuppress.appId) === Number(accountAppId)) {
        quitSuppress = null;
      }
    } else if (!accountAppId && !session) {
      lastSummaryGameId = null;
    }

    const presenceHint = presence.matchForApp(accountAppId) || presence.matchForApp(null);
    let recentAppId = null;
    let recentGame = null;
    // Steam often leaves gameid empty for brand-new / laggy launches while
    // OwnedGames rtime_last_played updates within seconds — use that.
    if (!accountAppId && !presenceHint && isSteamPersonaOnline(summary.personaState)) {
      try {
        recentGame = await fetchMostRecentlyPlayedOwnedGame(creds.apiKey, creds.steamId);
        recentAppId = pickRecentPlayAppId({
          recentGame,
          sessionAppId: session?.appId,
          sessionLastPlaytime: session?.lastPlaytime,
          sessionLastRtime: session?.lastRtime,
          sessionLastActivityAt: session?.lastActivityAt,
          nowMs: now(),
          inferSeconds: steamConfig.inferFromRecentSeconds,
          stagnantSeconds: steamConfig.recentPlayStagnantSeconds,
          personaOnline: true,
        });
        if (recentAppId && recentGame && quitSuppress
          && Number(quitSuppress.appId) === Number(recentAppId)) {
          const playtime = Number(recentGame.playtimeForeverMin);
          const rtime = Number(recentGame.lastPlayedAt);
          const playtimeGrew = Number.isFinite(playtime)
            && Number.isFinite(Number(quitSuppress.playtime))
            && playtime > Number(quitSuppress.playtime);
          const rtimeGrew = Number.isFinite(rtime)
            && Number.isFinite(Number(quitSuppress.rtime))
            && rtime > Number(quitSuppress.rtime);
          // Fresh quit stamps rtime once — require a later bump (relaunch) to resume.
          if (!playtimeGrew && !rtimeGrew) {
            recentAppId = null;
          } else {
            quitSuppress = null;
          }
        }
        if (recentAppId && recentGame) {
          noteRecentActivity(recentGame);
        }
      } catch (error) {
        log?.warn?.('Steam recent-play inference failed', error?.message || String(error));
      }
    }
    // Optional presence can still unstick Steam's laggy gameid, but is not required.
    const effectiveAppId = resolveEffectiveSteamAppId(accountAppId, presenceHint, recentAppId);
    const matchedPresence = effectiveAppId
      ? presence.matchForApp(effectiveAppId)
      : null;
    const presenceLed = Boolean(effectiveAppId && !accountAppId && matchedPresence && !recentAppId);
    const recentLed = Boolean(effectiveAppId && !accountAppId && !presenceLed && recentAppId);
    const requirePresence = Boolean(steamConfig.requirePresence);

    // Detect session end / restart boundaries.
    if (!effectiveAppId) {
      if (session) {
        endSession('game-ended');
      }
      lastAccountAppId = null;
      lastStatus = 'idle';
      return;
    }

    const host = matchedPresence?.hostname || null;
    const onAllowedHost = Boolean(matchedPresence && matchedPresence.appId === effectiveAppId);

    // Default: any PC on this Steam account. Opt-in host gate via requirePresence.
    if (requirePresence && !onAllowedHost) {
      if (session && session.appId === effectiveAppId) {
        endSession('host-stale');
      } else if (session && session.appId !== effectiveAppId) {
        endSession('game-changed');
      }
      lastAccountAppId = effectiveAppId;
      lastStatus = 'playing_elsewhere';
      lastError = `Playing app ${effectiveAppId} but not on an allowed host (${steamConfig.allowedHosts.join(', ')})`
        + ' — set STEAM_REQUIRE_PRESENCE=0 to show for any PC, or announce from an allowlisted display';
      return;
    }

    // New game or restart after gap.
    if (!session || session.appId !== effectiveAppId) {
      if (session) {
        endSession('game-changed');
      }
      beginSession({
        appId: effectiveAppId,
        host: host || (requirePresence ? null : 'any'),
        recentLed,
        recentGame: recentLed ? recentGame : null,
      });
    } else if (lastAccountAppId == null && effectiveAppId) {
      // Restart after idle gap while session object somehow lingered — treat as new.
      beginSession({
        appId: effectiveAppId,
        host: host || (requirePresence ? null : 'any'),
        recentLed,
        recentGame: recentLed ? recentGame : null,
      });
    } else {
      session.recentLed = recentLed;
      if (recentLed && recentGame) {
        noteRecentActivity(recentGame);
      }
    }

    lastAccountAppId = effectiveAppId;

    if (session.suppressed && !maybeClearSuppressForRestore()) {
      const remainingMs = restoreAfterInterruptMs() - (now() - (session.suppressedAt || now()));
      lastStatus = 'suppressed';
      lastError = `Interrupted by ${session.suppressReason || 'another overlay'}; `
        + `restores in ~${Math.max(1, Math.ceil(remainingMs / 1000))}s if still in-game`;
      return;
    }

    // Refresh details periodically (every ~2 min) or on first push.
    const needsDetails = !session.details || (now() - session.lastPushAt > 120_000);
    let reading = session.details;
    if (needsDetails) {
      try {
        reading = await enrichGame(creds.apiKey, creds.steamId, effectiveAppId);
      } catch (error) {
        lastError = error?.message || String(error);
        log?.warn?.('Steam game enrich failed', lastError);
      }
    } else if (reading) {
      reading = applyCachedArtworkUrls(reading, artworkCache, publicOrigin());
    }
    if (!reading) {
      lastStatus = 'enrich_failed';
      return;
    }

    reading = {
      ...reading,
      host,
      startedAt: session.startedAt,
      elapsedSec: Math.max(0, Math.round((now() - session.startedAt) / 1000)),
      personaName: summary.personaName,
      currentPlayers: reading.currentPlayers,
    };

    // Push on first show, or refresh payload every 2 minutes while active.
    if (!session.pushed || needsDetails) {
      pushOpen(reading);
    } else {
      session.details = reading;
    }
    lastStatus = presenceLed ? 'playing_presence' : (recentLed ? 'playing_recent' : 'playing');
    lastError = presenceLed
      ? 'Showing from local presence hint (Steam profile gameid still catching up)'
      : recentLed
        ? 'Showing from recent OwnedGames playtime (Steam profile gameid empty)'
        : (requirePresence ? null : 'Showing for any PC (Steam account in-game)');
  }

  /**
   * Manual preview from admin Auth card. Skips presence allowlist so linking
   * can be verified without the theater PC reporter. Dismissible on the client.
   * If nothing is in-game, falls back to the most recently played title.
   */
  async function pushManualPreview({ device = 'Signal' } = {}) {
    const creds = getCredentials();
    if (!creds.apiKey || !creds.steamId) {
      return {
        ok: false,
        error: !creds.apiKey
          ? 'Set STEAM_API_KEY in .env (or save a key below), then try again'
          : 'Link your Steam account first',
      };
    }

    let summary;
    try {
      summary = await fetchPlayerSummary(creds.apiKey, creds.steamId);
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
    if (!summary) {
      return { ok: false, error: 'Steam profile not returned — check SteamID and API key' };
    }

    let mode = 'playing';
    let appId = summary.gameId;
    let lastPlayedAt = null;

    if (!appId) {
      let top;
      try {
        // OwnedGames rtime — GetRecentlyPlayedGames sorts by 2-week playtime
        // and often omits the title you just launched.
        top = await fetchMostRecentlyPlayedOwnedGame(creds.apiKey, creds.steamId);
      } catch (error) {
        return { ok: false, error: error?.message || String(error) };
      }
      if (!top?.appId) {
        try {
          const recent = await fetchRecentlyPlayedGames(creds.apiKey, creds.steamId, { count: 1 });
          top = recent[0] || null;
        } catch {
          top = null;
        }
      }
      if (!top?.appId) {
        return { ok: false, error: 'Nothing playing right now, and no recently played games found' };
      }
      mode = 'last-played';
      appId = top.appId;
      lastPlayedAt = top.lastPlayedAt || null;
    }

    let reading;
    try {
      reading = await enrichGame(creds.apiKey, creds.steamId, appId);
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
    if (!reading) {
      return { ok: false, error: `Could not load Steam store details for app ${appId}` };
    }

    // GetRecentlyPlayedGames often omits rtime_last_played; OwnedGames (via
    // enrichGame) usually has it for the API-key owner's own account.
    lastPlayedAt = lastPlayedAt || reading.lastPlayedAt || null;
    const startedAt = mode === 'playing' ? now() : (lastPlayedAt || null);
    reading = {
      ...reading,
      host: null,
      startedAt: startedAt || now(),
      lastPlayedAt,
      elapsedSec: mode === 'playing' ? 0 : 0,
      personaName: summary.personaName,
    };

    const payload = buildSteamNowPlayingPayload(reading, config, {
      device,
      trigger: 'steam-manual-preview',
      mode,
      dismissible: true,
    });
    if (!payload) {
      return { ok: false, error: 'Failed to build Steam display payload' };
    }
    sendUdpPayload(payload);
    log?.info?.('Steam Now Playing manual preview pushed', {
      mode,
      appId: reading.appId,
      name: reading.name,
    });
    return {
      ok: true,
      mode,
      appId: reading.appId,
      name: reading.name,
      displaySeconds: payload.displaySeconds,
    };
  }

  function start() {
    if (running || steamConfig.enabled === false) {
      return;
    }
    running = true;
    const intervalMs = (steamConfig.pollIntervalSeconds || 30) * 1000;
    const run = () => {
      tick().catch((error) => {
        lastError = error?.message || String(error);
        log?.warn?.('Steam Now Playing tick failed', lastError);
      });
    };
    run();
    timer = setInterval(run, intervalMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    log?.info?.('Steam Now Playing poller started', {
      pollIntervalSeconds: steamConfig.pollIntervalSeconds,
      requirePresence: Boolean(steamConfig.requirePresence),
      restoreAfterInterruptSeconds: steamConfig.restoreAfterInterruptSeconds,
      inferFromRecentSeconds: steamConfig.inferFromRecentSeconds,
      recentPlayStagnantSeconds: steamConfig.recentPlayStagnantSeconds,
      allowedHosts: steamConfig.allowedHosts,
    });
  }

  function stop() {
    running = false;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (tickSoonTimer) {
      clearTimeout(tickSoonTimer);
      tickSoonTimer = null;
    }
    clearRestoreTimer();
  }

  return {
    start,
    stop,
    tick,
    recordPresence,
    suppressActiveSession,
    statusSnapshot,
    pushManualPreview,
    presence,
    artworkCache,
    clearArtworkCache: () => artworkCache.clear(),
    // test helpers
    _getSession: () => session,
    _setSession: (value) => { session = value; },
    _maybeClearSuppressForRestore: () => maybeClearSuppressForRestore(),
  };
}

module.exports = {
  createSteamNowPlaying,
  resolveEffectiveSteamAppId,
  pickRecentPlayAppId,
  isSteamPersonaOnline,
  applyCachedArtworkUrls,
};
