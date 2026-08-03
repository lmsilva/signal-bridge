const { resolveSteamCredentials } = require('./steam-session');
const {
  fetchOwnedGames,
  libraryCapsuleUrls,
  fetchAppDetails,
  fetchOwnedGamePlaytime,
  fetchAchievementProgress,
  fetchCurrentPlayers,
  formatPlaytimeHours,
} = require('./steam-api');
const { buildGameLibraryTourPayload, buildSteamNowPlayingPayload } = require('./udp-payload');
const { createSteamLibraryCache } = require('./steam-library-cache');
const { createLibraryTourSessions } = require('./library-tour-sessions');

function sortGames(games, sort = 'recent') {
  const list = [...(games || [])];
  switch (sort) {
    case 'oldest':
      // Oldest last-played first; never-played titles stay at the end.
      list.sort((a, b) => {
        const aTime = Number(a.lastPlayedAt) || 0;
        const bTime = Number(b.lastPlayedAt) || 0;
        if (!aTime && !bTime) return 0;
        if (!aTime) return 1;
        if (!bTime) return -1;
        return aTime - bTime;
      });
      break;
    case 'random':
      for (let i = list.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
      }
      break;
    case 'recent':
    default:
      // Newest first (slideshow "Newest first"). Never-played (0) sink to the end.
      list.sort((a, b) => (Number(b.lastPlayedAt) || 0) - (Number(a.lastPlayedAt) || 0));
      break;
  }
  return list;
}

/** Thin playlist rows — no poster URL fan-out (UDP/HTTP size). */
function toPlaylistGames(games) {
  return (games || []).map((game) => ({
    id: String(game.appId || game.id),
    name: game.name || `App ${game.appId || game.id}`,
    playtimeForeverMin: game.playtimeForeverMin ?? null,
    playtimeLabel: formatPlaytimeHours(game.playtimeForeverMin),
    lastPlayedAt: game.lastPlayedAt ?? null,
  }));
}

/**
 * Origin the display uses for playlist + card enrich HTTP.
 * Prefer a public HTTPS origin (GUEST_PHOTOBOOTH_URL) when set — real cert —
 * then fall back to PROXY_OWN_IP:47810 (self-signed; client tolerates that).
 */
function resolveCardBaseUrl(config = {}) {
  if (config.libraryTour?.cardBaseUrl) {
    return String(config.libraryTour.cardBaseUrl).replace(/\/+$/, '');
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

function createSteamLibraryTour({
  config,
  log,
  sendUdpPayload,
  settings = null,
  steamApi = null,
  libraryCache = null,
  sessions = null,
} = {}) {
  const api = steamApi || {
    fetchOwnedGames,
    libraryCapsuleUrls,
    fetchAppDetails,
    fetchOwnedGamePlaytime,
    fetchAchievementProgress,
    fetchCurrentPlayers,
    formatPlaytimeHours,
  };
  const tourSettings = settings;
  const cache = libraryCache || createSteamLibraryCache(config, log);
  const tourSessions = sessions || createLibraryTourSessions();
  let lastCount = 0;
  let refreshInFlight = null;
  const enrichCache = new Map();
  const ENRICH_TTL_MS = 15 * 60 * 1000;

  function credentials() {
    return resolveSteamCredentials(config.steam || {});
  }

  async function fetchAndCache() {
    const creds = credentials();
    if (!creds.apiKey || !creds.steamId) {
      return { ok: false, error: 'Steam is not linked — authenticate in Admin → Settings', games: [] };
    }
    try {
      const owned = await api.fetchOwnedGames(creds.apiKey, creds.steamId);
      cache.set(creds.steamId, owned);
      lastCount = owned.length;
      return { ok: true, games: owned, personaName: creds.personaName || null, fromCache: false };
    } catch (error) {
      return { ok: false, error: error?.message || String(error), games: [] };
    }
  }

  function refreshInBackground() {
    if (refreshInFlight) {
      return refreshInFlight;
    }
    refreshInFlight = fetchAndCache()
      .catch((error) => {
        log?.warn?.('Steam library background refresh failed', error?.message || error);
        return { ok: false, error: error?.message || String(error), games: [] };
      })
      .finally(() => {
        refreshInFlight = null;
      });
    return refreshInFlight;
  }

  /**
   * Prefer a warm cache so Start tour returns in milliseconds. Stale/missing
   * cache triggers a network fetch (and warms disk for the next push).
   */
  async function loadGames({ allowNetwork = true, preferCache = true } = {}) {
    const creds = credentials();
    if (!creds.apiKey || !creds.steamId) {
      return { ok: false, error: 'Steam is not linked — authenticate in Admin → Settings', games: [] };
    }
    const cached = cache.get(creds.steamId);
    if (preferCache && cached?.games?.length) {
      lastCount = cached.games.length;
      if (!cache.isFresh(cached)) {
        refreshInBackground();
      }
      return {
        ok: true,
        games: cached.games,
        personaName: creds.personaName || null,
        fromCache: true,
        stale: !cache.isFresh(cached),
      };
    }
    if (!allowNetwork) {
      return {
        ok: Boolean(cached?.games?.length),
        games: cached?.games || [],
        error: cached?.games?.length ? null : 'Steam library cache is empty',
        fromCache: true,
      };
    }
    return fetchAndCache();
  }

  function prefs() {
    if (typeof tourSettings?.getFor === 'function') {
      return tourSettings.getFor('steam') || {};
    }
    return tourSettings?.get?.()?.steam || tourSettings?.get?.() || {};
  }

  async function preview() {
    const loaded = await loadGames({ preferCache: true, allowNetwork: true });
    const tourPrefs = prefs();
    const sorted = sortGames(loaded.games, tourPrefs.sort);
    lastCount = sorted.length;
    return {
      ok: loaded.ok,
      error: loaded.error || null,
      count: sorted.length,
      configured: Boolean(credentials().steamId),
      sort: tourPrefs.sort || 'recent',
      secondsPerGame: tourPrefs.secondsPerGame || 60,
      fromCache: Boolean(loaded.fromCache),
    };
  }

  function libraryCount() {
    const creds = credentials();
    if (creds.steamId) {
      const cached = cache.count(creds.steamId);
      if (cached > 0) {
        lastCount = cached;
      }
    }
    return lastCount;
  }

  function warmCount() {
    return preview();
  }

  async function enrichGameDetails(apiKey, steamId, appId) {
    const [details, playtime, achievements, players] = await Promise.all([
      api.fetchAppDetails(appId),
      api.fetchOwnedGamePlaytime(apiKey, steamId, appId).catch(() => null),
      api.fetchAchievementProgress(apiKey, steamId, appId).catch(() => ({
        earned: null,
        total: null,
        available: false,
      })),
      api.fetchCurrentPlayers(appId),
    ]);
    if (!details) {
      return null;
    }
    // Prefer library-cache playtime (instant, no second OwnedGames scan) when
    // the per-app playtime helper misses.
    const cachedGame = cache.get(steamId)?.games
      ?.find((game) => String(game.appId) === String(appId));
    const playtimeForeverMin = playtime?.playtimeForeverMin
      ?? cachedGame?.playtimeForeverMin
      ?? null;
    const lastPlayedAt = playtime?.lastPlayedAt
      ?? cachedGame?.lastPlayedAt
      ?? null;
    return {
      ...details,
      playtimeForeverMin,
      playtimeLabel: (api.formatPlaytimeHours || formatPlaytimeHours)(playtimeForeverMin),
      lastPlayedAt,
      achievements,
      currentPlayers: players,
    };
  }

  async function enrichCard(appId) {
    const id = String(appId || '').trim();
    if (!id) {
      return { ok: false, error: 'Missing Steam app id' };
    }
    const cached = enrichCache.get(id);
    if (cached && (Date.now() - cached.at) < ENRICH_TTL_MS) {
      return { ok: true, platform: 'steam', steam: cached.steam, cached: true };
    }
    const creds = credentials();
    if (!creds.apiKey || !creds.steamId) {
      return { ok: false, error: 'Steam is not linked' };
    }
    let reading;
    try {
      reading = await enrichGameDetails(creds.apiKey, creds.steamId, id);
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
    if (!reading) {
      // Still return a thin card so the tour keeps moving.
      const cachedGame = cache.get(creds.steamId)?.games
        ?.find((game) => String(game.appId) === id);
      if (!cachedGame) {
        return { ok: false, error: `Could not load Steam store details for app ${id}` };
      }
      reading = {
        appId: Number(id),
        name: cachedGame.name,
        shortDescription: '',
        developers: [],
        publishers: [],
        releaseYear: null,
        tags: [],
        posterCandidates: libraryCapsuleUrls(id),
        headerImage: null,
        screenshots: [],
        playtimeForeverMin: cachedGame.playtimeForeverMin,
        playtimeLabel: formatPlaytimeHours(cachedGame.playtimeForeverMin),
        lastPlayedAt: cachedGame.lastPlayedAt,
        achievements: { earned: null, total: null, available: false },
        currentPlayers: null,
      };
    }
    reading = {
      ...reading,
      appId: Number(reading.appId) || Number(id),
      host: null,
      startedAt: reading.lastPlayedAt || Date.now(),
      elapsedSec: 0,
      personaName: creds.personaName || null,
    };
    const payload = buildSteamNowPlayingPayload(reading, config, {
      mode: 'library-tour',
      dismissible: true,
      trigger: 'steam-library-tour-card',
    });
    if (!payload?.steam) {
      return { ok: false, error: 'Failed to build Steam library card' };
    }
    payload.steam.mode = 'library-tour';
    enrichCache.set(id, { at: Date.now(), steam: payload.steam });
    return { ok: true, platform: 'steam', steam: payload.steam, cached: false };
  }

  function getPlaylist(tourId) {
    const session = tourSessions.get(tourId);
    if (!session || session.platform !== 'steam') {
      return null;
    }
    return session;
  }

  async function pushTour({
    secondsPerGame,
    sort,
    device = 'Signal',
    trigger = 'steam-library-tour',
    send,
    loop = true,
    cardBaseUrl = null,
  } = {}) {
    // Cache-first: Start tour must not block on GetOwnedGames for 700 titles.
    const loaded = await loadGames({ preferCache: true, allowNetwork: true });
    if (!loaded.ok) {
      return { ok: false, error: loaded.error || 'Steam library unavailable' };
    }
    const tourPrefs = prefs();
    const perGame = secondsPerGame ?? tourPrefs.secondsPerGame ?? 60;
    const order = sort || tourPrefs.sort || 'recent';
    const sorted = sortGames(loaded.games, order);
    const playlist = toPlaylistGames(sorted);
    if (!playlist.length) {
      return { ok: false, error: 'Steam library is empty' };
    }
    lastCount = playlist.length;
    const looping = loop !== false;
    const session = tourSessions.create({
      platform: 'steam',
      games: playlist,
      secondsPerGame: perGame,
      loop: looping,
      sort: order,
    });
    if (!session) {
      return { ok: false, error: 'Failed to create library tour session' };
    }
    const base = cardBaseUrl != null ? cardBaseUrl : resolveCardBaseUrl(config);
    const payload = buildGameLibraryTourPayload({
      platform: 'steam',
      tourId: session.tourId,
      count: session.games.length,
      seedGames: [session.games[0]],
      secondsPerGame: perGame,
      device,
      trigger,
      loop: looping,
      cardBaseUrl: base,
    });
    if (!payload) {
      return { ok: false, error: 'Failed to build library tour payload' };
    }
    const holdSeconds = session.games.length * payload.gameTour.secondsPerGame;
    const emit = typeof send === 'function' ? send : sendUdpPayload;
    emit(payload, { holdSeconds });
    log?.info?.('Steam library tour pushed', {
      tourId: session.tourId,
      count: session.games.length,
      secondsPerGame: payload.gameTour.secondsPerGame,
      sort: order,
      loop: looping,
      holdSeconds,
      fromCache: Boolean(loaded.fromCache),
    });
    return {
      ok: true,
      tourId: session.tourId,
      count: session.games.length,
      secondsPerGame: payload.gameTour.secondsPerGame,
      estimatedDurationSeconds: holdSeconds,
      loop: looping,
      fromCache: Boolean(loaded.fromCache),
    };
  }

  return {
    preview,
    pushTour,
    enrichCard,
    getPlaylist,
    loadGames,
    sortGames,
    toPlaylistGames,
    toTourGames: toPlaylistGames,
    libraryCount,
    warmCount,
    refreshInBackground,
    resolveCardBaseUrl: () => resolveCardBaseUrl(config),
    libraryCache: cache,
    sessions: tourSessions,
  };
}

module.exports = {
  createSteamLibraryTour,
  sortGames,
  toTourGames: toPlaylistGames,
  toPlaylistGames,
  resolveCardBaseUrl,
};
