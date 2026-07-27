/**
 * Steam Now Playing poller: presence allowlist + session suppress rules.
 */

const {
  fetchPlayerSummary,
  fetchRecentlyPlayedGames,
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
 * Steam Web API gameid often lags a local launch by tens of seconds.
 * When the theater-PC reporter has a fresh appId, trust that until Steam catches up.
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
   *   pushed: boolean,
   *   lastPushAt: number,
   *   details: object | null,
   * }} */
  let session = null;
  let lastAccountAppId = null;
  let lastError = null;
  let lastStatus = 'idle';

  function getCredentials() {
    return resolveSteamCredentials(steamConfig);
  }

  function statusSnapshot() {
    const creds = getCredentials();
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
      status: lastStatus,
      message: lastError,
      session: session
        ? {
          appId: session.appId,
          host: session.host,
          startedAt: new Date(session.startedAt).toISOString(),
          suppressed: session.suppressed,
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
    session = {
      appId: Number(appId),
      host: String(host),
      startedAt: now(),
      suppressed: false,
      pushed: false,
      lastPushAt: 0,
      details: null,
    };
  }

  function endSession(reason) {
    const wasPushed = Boolean(session?.pushed && !session?.suppressed);
    session = null;
    if (wasPushed) {
      pushClose(reason);
    }
  }

  /** Called when any other display overlay is sent. */
  function suppressActiveSession(reason = 'interrupted') {
    if (!session || session.suppressed) {
      return false;
    }
    session.suppressed = true;
    lastStatus = 'suppressed';
    log?.info?.('Steam Now Playing suppressed', {
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
    const presenceHint = presence.matchForApp(accountAppId) || presence.matchForApp(null);
    // Optional presence can still unstick Steam's laggy gameid, but is not required.
    const effectiveAppId = resolveEffectiveSteamAppId(accountAppId, presenceHint);
    const matchedPresence = effectiveAppId
      ? presence.matchForApp(effectiveAppId)
      : null;
    const presenceLed = Boolean(effectiveAppId && !accountAppId && matchedPresence);
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
      beginSession({ appId: effectiveAppId, host: host || (requirePresence ? null : 'any') });
    } else if (lastAccountAppId == null && effectiveAppId) {
      // Restart after idle gap while session object somehow lingered — treat as new.
      beginSession({ appId: effectiveAppId, host: host || (requirePresence ? null : 'any') });
    }

    lastAccountAppId = effectiveAppId;

    if (session.suppressed) {
      lastStatus = 'suppressed';
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
      let recent;
      try {
        recent = await fetchRecentlyPlayedGames(creds.apiKey, creds.steamId, { count: 1 });
      } catch (error) {
        return { ok: false, error: error?.message || String(error) };
      }
      const top = recent[0];
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
  };
}

module.exports = {
  createSteamNowPlaying,
  resolveEffectiveSteamAppId,
};
