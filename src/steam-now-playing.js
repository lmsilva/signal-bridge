/**
 * Steam Now Playing poller: presence allowlist + session suppress rules.
 *
 * Auto detection (in order):
 *   1) GetPlayerSummaries.gameid — Steam says this account is in-game
 *   2) Fresh local presence — theater PC announce / reporter appId
 *   3) OwnedGames advancement beyond an idle baseline — catches titles that
 *      never publish gameid, WITHOUT reopening after quit (quit stamps rtime,
 *      which we absorb into the baseline when a session ends)
 *
 * Manual Auth preview may still show last-played OwnedGames when idle.
 */

const {
  fetchPlayerSummary,
  fetchRecentlyPlayedGames,
  fetchMostRecentlyPlayedOwnedGames,
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
 * Prefer Steam profile gameid, then a baseline-advanced OwnedGames title when it
 * disagrees with local presence (stuck RunningAppID), then presence, then recent.
 */
function resolveEffectiveSteamAppId(accountAppId, presenceEntry, recentAppId = null) {
  const fromAccount = Number(accountAppId);
  if (Number.isFinite(fromAccount) && fromAccount > 0) {
    return fromAccount;
  }
  const fromPresence = Number(presenceEntry?.appId);
  const fromRecent = Number(recentAppId);
  const presenceOk = Number.isFinite(fromPresence) && fromPresence > 0;
  const recentOk = Number.isFinite(fromRecent) && fromRecent > 0;
  // OwnedGames launch wins over a mismatched presence hint — otherwise a stuck
  // RunningAppID keeps reopening the old title and the real launch is missed.
  if (recentOk && presenceOk && fromRecent !== fromPresence) {
    return fromRecent;
  }
  if (presenceOk) {
    return fromPresence;
  }
  if (recentOk) {
    return fromRecent;
  }
  return null;
}

function isSteamPersonaOnline(personaState) {
  const state = Number(personaState);
  return Number.isFinite(state) && state >= 1;
}

function absorbGamesIntoBaseline(baseline, games) {
  for (const game of games || []) {
    const appId = Number(game.appId);
    if (!Number.isFinite(appId) || appId <= 0) {
      continue;
    }
    const lastPlayedAt = Number(game.lastPlayedAt) || 0;
    const playtime = Number.isFinite(Number(game.playtimeForeverMin))
      ? Number(game.playtimeForeverMin)
      : null;
    const prev = baseline.get(appId);
    baseline.set(appId, {
      lastPlayedAt: Math.max(lastPlayedAt, Number(prev?.lastPlayedAt) || 0),
      playtimeForeverMin: playtime == null
        ? (prev?.playtimeForeverMin ?? null)
        : Math.max(playtime, Number(prev?.playtimeForeverMin) || 0),
    });
  }
}

/** True when OwnedGames shows activity newer than the idle baseline for this app. */
function gameAdvancedBeyondBaseline(game, baselineEntry) {
  if (!game) {
    return false;
  }
  const lastPlayedAt = Number(game.lastPlayedAt) || 0;
  const playtime = Number.isFinite(Number(game.playtimeForeverMin))
    ? Number(game.playtimeForeverMin)
    : null;
  if (!baselineEntry) {
    // Brand-new app id (not in baseline) — treat as advanced; caller still
    // requires a fresh lastPlayedAt window.
    return lastPlayedAt > 0;
  }
  const rtimeUp = lastPlayedAt > Number(baselineEntry.lastPlayedAt || 0);
  const playUp = playtime != null
    && Number.isFinite(Number(baselineEntry.playtimeForeverMin))
    && playtime > Number(baselineEntry.playtimeForeverMin);
  return rtimeUp || playUp;
}

/**
 * Pick a launch candidate: fresh OwnedGames row that advanced past idle baseline.
 */
function pickRecentPlayLaunch({
  games,
  baseline,
  nowMs,
  inferSeconds = 180,
  personaOnline = false,
} = {}) {
  if (!personaOnline || !Array.isArray(games) || !games.length) {
    return null;
  }
  for (const game of games) {
    const appId = Number(game.appId);
    const lastPlayedAt = Number(game.lastPlayedAt);
    if (!Number.isFinite(appId) || appId <= 0 || !Number.isFinite(lastPlayedAt) || lastPlayedAt <= 0) {
      continue;
    }
    const ageSec = Math.max(0, (Number(nowMs) - lastPlayedAt) / 1000);
    if (ageSec > inferSeconds) {
      continue;
    }
    if (!gameAdvancedBeyondBaseline(game, baseline?.get(appId))) {
      continue;
    }
    return game;
  }
  return null;
}

/**
 * Keep a recent-led session only while playtime/rtime keep moving, or briefly
 * after the last bump (Steam playtime often ticks once per minute).
 */
function isRecentSessionStillActive({
  game,
  sessionAppId,
  sessionLastPlaytime,
  sessionLastRtime,
  sessionLastActivityAt,
  nowMs,
  stagnantSeconds = 150,
} = {}) {
  if (!game || Number(game.appId) !== Number(sessionAppId)) {
    return false;
  }
  const playtime = Number.isFinite(Number(game.playtimeForeverMin))
    ? Number(game.playtimeForeverMin)
    : null;
  const lastPlayedAt = Number(game.lastPlayedAt);
  const playtimeGrew = playtime != null
    && Number.isFinite(Number(sessionLastPlaytime))
    && playtime > Number(sessionLastPlaytime);
  const rtimeGrew = Number.isFinite(lastPlayedAt)
    && Number.isFinite(Number(sessionLastRtime))
    && lastPlayedAt > Number(sessionLastRtime);
  if (playtimeGrew || rtimeGrew) {
    return true;
  }
  const lastActivity = Number(sessionLastActivityAt) || lastPlayedAt || 0;
  const stagnantFor = Math.max(0, (Number(nowMs) - lastActivity) / 1000);
  return stagnantFor <= stagnantSeconds;
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
   *   lastPlaytime: number | null,
   *   lastRtime: number | null,
   *   lastActivityAt: number | null,
   *   recentLed: boolean,
   * }} */
  let session = null;
  let lastAccountAppId = null;
  let lastError = null;
  let lastStatus = 'idle';
  let restoreTimer = null;
  /** @type {Map<number, { lastPlayedAt: number, playtimeForeverMin: number|null }>} */
  const idleBaseline = new Map();
  let baselineReady = false;

  function getCredentials() {
    return resolveSteamCredentials(steamConfig);
  }

  function restoreAfterInterruptMs() {
    return Math.max(15, Number(steamConfig.restoreAfterInterruptSeconds) || 75) * 1000;
  }

  function inferFromRecentSeconds() {
    return Math.max(60, Number(steamConfig.inferFromRecentSeconds) || 180);
  }

  function recentPlayStagnantSeconds() {
    return Math.max(60, Number(steamConfig.recentPlayStagnantSeconds) || 150);
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
      inferFromRecentSeconds: inferFromRecentSeconds(),
      recentPlayStagnantSeconds: recentPlayStagnantSeconds(),
      baselineReady,
      baselineApps: idleBaseline.size,
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
      return false;
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
    if (playtime != null) {
      session.lastPlaytime = playtime;
    }
    if (rtime != null) {
      session.lastRtime = rtime;
    }
    if (playtimeGrew || rtimeGrew) {
      session.lastActivityAt = now();
      return true;
    }
    return false;
  }

  function endSession(reason, ownedGames = null) {
    clearRestoreTimer();
    const wasPushed = Boolean(session?.pushed && !session?.suppressed);
    session = null;
    // Absorb current OwnedGames stamps (including quit-time rtime) so the same
    // quit cannot look like a new launch on the next poll.
    if (ownedGames) {
      absorbGamesIntoBaseline(idleBaseline, ownedGames);
    }
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
    if (result?.ok) {
      scheduleImmediateTick('presence');
    }
    return result;
  }

  /** Announce without steamAppId — drop that host so a stuck registry value cannot linger. */
  function clearPresence(hostname) {
    if (!hostname) {
      return;
    }
    presence.clearHost(hostname);
  }

  function clearPresenceMatchingApp(appId) {
    const id = Number(appId);
    if (!Number.isFinite(id) || id <= 0) {
      return;
    }
    for (const entry of presence.listFresh()) {
      if (Number(entry.appId) === id) {
        presence.clearHost(entry.hostname);
      }
    }
  }

  async function loadOwnedGames(apiKey, steamId) {
    try {
      return await fetchMostRecentlyPlayedOwnedGames(apiKey, steamId, { limit: 12 });
    } catch (error) {
      log?.warn?.('Steam OwnedGames fetch failed', error?.message || String(error));
      return [];
    }
  }

  async function ensureIdleBaseline(apiKey, steamId) {
    if (baselineReady) {
      return;
    }
    const games = await loadOwnedGames(apiKey, steamId);
    absorbGamesIntoBaseline(idleBaseline, games);
    baselineReady = true;
    log?.info?.('Steam Now Playing idle baseline ready', { apps: idleBaseline.size });
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

    // Seed baseline once so boot does not treat "last quit" as a launch.
    await ensureIdleBaseline(creds.apiKey, creds.steamId);

    const accountAppId = summary.gameId;
    const presenceHint = presence.matchForApp(accountAppId) || presence.matchForApp(null);
    const personaOnline = isSteamPersonaOnline(summary.personaState);

    let ownedGames = null;
    let recentGame = null;
    let recentAppId = null;

    // Quit detection when Steam omits gameid: OwnedGames stagnant window
    // (STEAM_RECENT_PLAY_STAGNANT_SEC). Presence must NOT skip this — local
    // RunningAppID can stick after exit and would otherwise refresh forever,
    // never closing the overlay.
    if (!accountAppId && personaOnline && session) {
      ownedGames = await loadOwnedGames(creds.apiKey, creds.steamId);
      const active = ownedGames.find((game) => Number(game.appId) === Number(session.appId));
      if (active && isRecentSessionStillActive({
        game: active,
        sessionAppId: session.appId,
        sessionLastPlaytime: session.lastPlaytime,
        sessionLastRtime: session.lastRtime,
        sessionLastActivityAt: session.lastActivityAt,
        nowMs: now(),
        stagnantSeconds: recentPlayStagnantSeconds(),
      })) {
        if (session.lastPlaytime == null
          && Number.isFinite(Number(active.playtimeForeverMin))) {
          session.lastPlaytime = Number(active.playtimeForeverMin);
        }
        if (session.lastRtime == null
          && Number.isFinite(Number(active.lastPlayedAt))) {
          session.lastRtime = Number(active.lastPlayedAt);
        }
        recentGame = active;
        recentAppId = active.appId;
        noteRecentActivity(active);
      } else {
        // Stagnant / missing OwnedGames activity — close even if presence still
        // claims this app (stuck RunningAppID after quit). Capture a *different*
        // baseline-advanced launch BEFORE absorb, or endSession would stamp the
        // new title into the idle baseline and it would never open.
        const stagnantFor = Math.max(
          0,
          (now() - (Number(session.lastActivityAt) || Number(session.startedAt) || now())) / 1000,
        );
        const presenceOnlyGrace = Boolean(presenceHint)
          && Number(presenceHint.appId) === Number(session.appId)
          && !active
          && stagnantFor <= recentPlayStagnantSeconds();
        if (!presenceOnlyGrace) {
          const endedAppId = session.appId;
          const handoff = pickRecentPlayLaunch({
            games: (ownedGames || []).filter(
              (game) => Number(game.appId) !== Number(endedAppId),
            ),
            baseline: idleBaseline,
            nowMs: now(),
            inferSeconds: inferFromRecentSeconds(),
            personaOnline: true,
          });
          clearPresenceMatchingApp(endedAppId);
          endSession('game-ended', ownedGames);
          if (handoff) {
            recentGame = handoff;
            recentAppId = handoff.appId;
            // Fall through — beginSession below opens the new title this tick.
          } else {
            lastAccountAppId = null;
            lastStatus = 'idle';
            lastError = null;
            return;
          }
        }
        // Presence-only + no OwnedGames row yet — keep within stagnant grace
        // without refreshing lastActivityAt from presence.
      }
    } else if (!accountAppId && personaOnline && !session) {
      // Idle: always scan OwnedGames for a launch — even when presence is set.
      // Stuck RunningAppID used to skip this path so new games were never seen.
      ownedGames = await loadOwnedGames(creds.apiKey, creds.steamId);
      recentGame = pickRecentPlayLaunch({
        games: ownedGames,
        baseline: idleBaseline,
        nowMs: now(),
        inferSeconds: inferFromRecentSeconds(),
        personaOnline: true,
      });
      recentAppId = recentGame?.appId || null;
    } else if (session && accountAppId) {
      // Confirmed in-game by Steam profile gameid — reset stagnant clock.
      // Presence alone must not reset it (that froze the 2‑minute idle close).
      session.lastActivityAt = now();
    }

    const effectiveAppId = resolveEffectiveSteamAppId(accountAppId, presenceHint, recentAppId);
    const matchedPresence = effectiveAppId
      ? presence.matchForApp(effectiveAppId)
      : null;
    const presenceLed = Boolean(effectiveAppId && !accountAppId && matchedPresence && !recentAppId);
    const recentLed = Boolean(effectiveAppId && !accountAppId && !presenceLed && recentAppId);
    const requirePresence = Boolean(steamConfig.requirePresence);

    if (!effectiveAppId) {
      if (session) {
        if (!ownedGames) {
          ownedGames = await loadOwnedGames(creds.apiKey, creds.steamId);
        }
        endSession('game-ended', ownedGames);
      } else if (ownedGames) {
        // Stay idle but keep baseline current.
        absorbGamesIntoBaseline(idleBaseline, ownedGames);
      }
      lastAccountAppId = null;
      lastStatus = 'idle';
      lastError = null;
      return;
    }

    const host = matchedPresence?.hostname || null;
    const onAllowedHost = Boolean(matchedPresence && matchedPresence.appId === effectiveAppId);

    if (requirePresence && !onAllowedHost) {
      if (session && session.appId === effectiveAppId) {
        endSession('host-stale', ownedGames);
      } else if (session && session.appId !== effectiveAppId) {
        endSession('game-changed', ownedGames);
      }
      lastAccountAppId = effectiveAppId;
      lastStatus = 'playing_elsewhere';
      lastError = `Playing app ${effectiveAppId} but not on an allowed host (${steamConfig.allowedHosts.join(', ')})`
        + ' — set STEAM_REQUIRE_PRESENCE=0 to show for any PC, or announce from an allowlisted display';
      return;
    }

    if (!session || session.appId !== effectiveAppId) {
      if (session) {
        endSession('game-changed', ownedGames);
      }
      beginSession({
        appId: effectiveAppId,
        host: host || (requirePresence ? null : 'any'),
        recentLed,
        recentGame: recentLed ? recentGame : null,
      });
    } else {
      session.recentLed = recentLed || session.recentLed;
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

    if (!session.pushed || needsDetails) {
      pushOpen(reading);
    } else {
      session.details = reading;
    }
    lastStatus = presenceLed ? 'playing_presence' : (recentLed ? 'playing_recent' : 'playing');
    lastError = presenceLed
      ? 'Showing from local presence hint (Steam profile gameid still catching up)'
      : recentLed
        ? 'Showing from OwnedGames activity beyond idle baseline'
        : (requirePresence ? null : 'Showing for any PC (Steam account in-game)');
  }

  /**
   * @param {Object} [options]
   * @param {'auto'|'now-playing'|'last-played'} [options.requestedMode] `auto`
   *   (the admin test button) falls back to the most recently played game when
   *   nothing is running. The scheduler asks for one specific mode so a
   *   `steam.now-playing` rule can never quietly air a last-played card instead.
   */
  async function pushManualPreview({ device = 'Signal', send, requestedMode = 'auto' } = {}) {
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
    let appId = requestedMode === 'last-played' ? null : summary.gameId;
    let lastPlayedAt = null;

    if (!appId && requestedMode === 'now-playing') {
      return { ok: false, error: 'Nothing is playing on Steam right now' };
    }

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
    reading = {
      ...reading,
      host: null,
      startedAt: mode === 'playing' ? now() : (lastPlayedAt || now()),
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
    // Prefer admin-targeted unicast (same as other Push tiles). Broadcast-only
    // delivery is flaky on many LANs when a specific display is selected.
    const emit = typeof send === 'function' ? send : sendUdpPayload;
    emit(payload);
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
      inferFromRecentSeconds: inferFromRecentSeconds(),
      recentPlayStagnantSeconds: recentPlayStagnantSeconds(),
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
    clearPresence,
    suppressActiveSession,
    statusSnapshot,
    pushManualPreview,
    presence,
    // test helpers
    _getSession: () => session,
    _setSession: (value) => { session = value; },
    _maybeClearSuppressForRestore: () => maybeClearSuppressForRestore(),
    _getBaseline: () => idleBaseline,
    _setBaselineReady: (value) => { baselineReady = Boolean(value); },
  };
}

module.exports = {
  createSteamNowPlaying,
  resolveEffectiveSteamAppId,
  absorbGamesIntoBaseline,
  gameAdvancedBeyondBaseline,
  pickRecentPlayLaunch,
  isRecentSessionStillActive,
  isSteamPersonaOnline,
};
