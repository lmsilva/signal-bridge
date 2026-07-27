/**
 * Steam Now Playing poller: presence allowlist + session suppress rules.
 *
 * Auto detection is authoritative only:
 *   1) GetPlayerSummaries.gameid  — Steam says this account is in-game
 *   2) Fresh local presence       — theater PC announce / reporter appId
 *
 * OwnedGames rtime_last_played is NOT used for auto Now Playing — Steam stamps
 * it on quit, which caused false "still playing" overlays after close.
 * Manual Auth preview may still fall back to last-played OwnedGames.
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
const {
  buildSteamNowPlayingPayload,
  buildSteamNowPlayingClosePayload,
} = require('./udp-payload');

/**
 * Prefer Steam profile gameid; fall back to a fresh local presence hint when
 * gameid is empty (common launch lag). Never invent a title from OwnedGames.
 */
function resolveEffectiveSteamAppId(accountAppId, presenceEntry) {
  const fromAccount = Number(accountAppId);
  if (Number.isFinite(fromAccount) && fromAccount > 0) {
    return fromAccount;
  }
  const fromPresence = Number(presenceEntry?.appId);
  if (Number.isFinite(fromPresence) && fromPresence > 0) {
    return fromPresence;
  }
  return null;
}

function createSteamNowPlaying({
  config,
  log,
  sendUdpPayload,
  now = () => Date.now(),
} = {}) {
  const steamConfig = config.steam;
  const presence = createSteamPresenceStore(steamConfig, { now });

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
   * }} */
  let session = null;
  let lastAccountAppId = null;
  let lastError = null;
  let lastStatus = 'idle';
  let restoreTimer = null;

  function getCredentials() {
    return resolveSteamCredentials(steamConfig);
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
        }
        : null,
      presence: presence.snapshot(),
      lastAccountAppId,
    };
  }

  async function enrichGame(apiKey, steamId, appId) {
    const [details, playtime, achievements, players] = await Promise.all([
      fetchAppDetails(appId),
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
    return {
      ...details,
      playtimeForeverMin: playtime?.playtimeForeverMin ?? null,
      playtimeLabel: formatPlaytimeHours(playtime?.playtimeForeverMin),
      lastPlayedAt: playtime?.lastPlayedAt ?? null,
      achievements,
      currentPlayers: players,
    };
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

  function beginSession({ appId, host }) {
    clearRestoreTimer();
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
    };
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
    // Presence may name the app while Steam's gameid is still catching up.
    const presenceHint = presence.matchForApp(accountAppId) || presence.matchForApp(null);
    const effectiveAppId = resolveEffectiveSteamAppId(accountAppId, presenceHint);
    const matchedPresence = effectiveAppId
      ? presence.matchForApp(effectiveAppId)
      : null;
    const presenceLed = Boolean(effectiveAppId && !accountAppId && matchedPresence);
    const requirePresence = Boolean(steamConfig.requirePresence);

    // No authoritative in-game signal → close immediately. Never invent a
    // session from OwnedGames last-played (quit stamps that timestamp).
    if (!effectiveAppId) {
      if (session) {
        endSession('game-ended');
      }
      lastAccountAppId = null;
      lastStatus = 'idle';
      lastError = null;
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
      });
    } else if (lastAccountAppId == null && effectiveAppId) {
      beginSession({
        appId: effectiveAppId,
        host: host || (requirePresence ? null : 'any'),
      });
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
    lastStatus = presenceLed ? 'playing_presence' : 'playing';
    lastError = presenceLed
      ? 'Showing from local presence hint (Steam profile gameid still catching up)'
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

    lastPlayedAt = lastPlayedAt || reading.lastPlayedAt || null;
    const startedAt = mode === 'playing' ? now() : (lastPlayedAt || null);
    reading = {
      ...reading,
      host: null,
      startedAt: startedAt || now(),
      lastPlayedAt,
      elapsedSec: 0,
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
    // test helpers
    _getSession: () => session,
    _setSession: (value) => { session = value; },
    _maybeClearSuppressForRestore: () => maybeClearSuppressForRestore(),
  };
}

module.exports = {
  createSteamNowPlaying,
  resolveEffectiveSteamAppId,
};
