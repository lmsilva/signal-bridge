const { ensurePsnAuth, fetchPlayedTitles, enrichPsnTitle } = require('./psn-api');
const { resolvePsnCredentials } = require('./psn-session');
const { createPsnLibraryCache } = require('./psn-library-cache');
const { buildGameLibraryTourPayload, buildPsnNowPlayingPayload } = require('./udp-payload');
const { sortGames, resolveCardBaseUrl } = require('./steam-library-tour');
const { createLibraryTourSessions } = require('./library-tour-sessions');

function getPsnApi() {
  return require('psn-api');
}

function mapPsnPlaylistGame(entry) {
  const titleId = String(entry.titleId || entry.id || '').trim();
  const imageUrl = entry.imageUrl
    || entry.headerImage
    || (Array.isArray(entry.posterCandidates) ? entry.posterCandidates[0] : null)
    || null;
  return {
    id: titleId,
    name: String(entry.name || '').trim() || 'PlayStation Game',
    imageUrl,
    playtimeForeverMin: entry.playtimeForeverMin ?? null,
    playtimeLabel: entry.playtimeLabel || null,
    lastPlayedAt: entry.lastPlayedAt ?? null,
  };
}

async function fetchPurchasedTitles(authorization, accountId, {
  api = getPsnApi(),
  pageSize = 100,
  maxTitles = 500,
} = {}) {
  if (typeof api.getPurchasedGames !== 'function') {
    return [];
  }
  const out = [];
  let offset = 0;
  while (out.length < maxTitles) {
    const response = await api.getPurchasedGames(authorization, accountId || 'me', {
      limit: pageSize,
      offset,
    });
    const titles = Array.isArray(response?.titles) ? response.titles : [];
    if (!titles.length) {
      break;
    }
    for (const title of titles) {
      out.push({
        titleId: String(title.titleId || title.id || '').trim(),
        name: String(title.localizedName || title.name || '').trim(),
        imageUrl: title.localizedImageUrl || title.imageUrl || null,
        posterCandidates: [title.localizedImageUrl, title.imageUrl].filter(Boolean),
        playtimeForeverMin: null,
        lastPlayedAt: null,
      });
    }
    if (titles.length < pageSize) {
      break;
    }
    offset += titles.length;
  }
  return out.slice(0, maxTitles);
}

function createPsnLibraryTour({
  config,
  log,
  sendUdpPayload,
  settings = null,
  cache = null,
  apiHelpers = null,
  sessions = null,
} = {}) {
  const psnConfig = config.psn || {};
  const tourSettings = settings;
  const libraryCache = cache || createPsnLibraryCache(config, log);
  const tourSessions = sessions || createLibraryTourSessions();
  const helpers = apiHelpers || {
    ensurePsnAuth,
    fetchPlayedTitles,
    fetchPurchasedTitles,
    enrichPsnTitle,
  };
  let lastCount = 0;
  let refreshInFlight = null;
  let memoryGames = null;
  let memoryAt = 0;
  const MEMORY_TTL_MS = 15 * 60 * 1000;
  const enrichCache = new Map();
  const ENRICH_TTL_MS = 15 * 60 * 1000;

  async function fetchAndCache() {
    const creds = resolvePsnCredentials(psnConfig);
    if (!creds.configured) {
      return { ok: false, error: 'PSN is not linked — paste NPSSO in Admin → Settings', games: [] };
    }
    try {
      const auth = await helpers.ensurePsnAuth(psnConfig);
      const [played, purchased] = await Promise.all([
        helpers.fetchPlayedTitles(auth.authorization, auth.accountId).catch(() => []),
        helpers.fetchPurchasedTitles(auth.authorization, auth.accountId).catch(() => []),
      ]);
      const cached = libraryCache.listCached();
      const merged = libraryCache.mergeLists(purchased, played, cached);
      memoryGames = merged;
      memoryAt = Date.now();
      lastCount = merged.length;
      return { ok: true, games: merged, onlineId: auth.onlineId || creds.onlineId || null, fromCache: false };
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
        log?.warn?.('PSN library background refresh failed', error?.message || error);
        return { ok: false, error: error?.message || String(error), games: [] };
      })
      .finally(() => {
        refreshInFlight = null;
      });
    return refreshInFlight;
  }

  async function loadGames({ preferCache = true, allowNetwork = true } = {}) {
    const creds = resolvePsnCredentials(psnConfig);
    if (!creds.configured) {
      return { ok: false, error: 'PSN is not linked — paste NPSSO in Admin → Settings', games: [] };
    }
    const memoryFresh = memoryGames?.length && (Date.now() - memoryAt) < MEMORY_TTL_MS;
    if (preferCache && memoryFresh) {
      lastCount = memoryGames.length;
      return {
        ok: true,
        games: memoryGames,
        onlineId: creds.onlineId || null,
        fromCache: true,
      };
    }
    // Disk title cache alone is incomplete for a tour, but better than blocking
    // when we already warmed memory once this process.
    if (preferCache && memoryGames?.length) {
      lastCount = memoryGames.length;
      refreshInBackground();
      return {
        ok: true,
        games: memoryGames,
        onlineId: creds.onlineId || null,
        fromCache: true,
        stale: true,
      };
    }
    if (!allowNetwork) {
      return { ok: false, error: 'PSN library cache is empty', games: [] };
    }
    return fetchAndCache();
  }

  async function preview() {
    const loaded = await loadGames({ preferCache: true, allowNetwork: true });
    const prefs = tourSettings?.get?.() || {};
    const sorted = sortGames(
      loaded.games.map((game) => ({
        appId: game.titleId,
        name: game.name,
        playtimeForeverMin: game.playtimeForeverMin,
        lastPlayedAt: game.lastPlayedAt,
      })),
      prefs.sort,
    );
    lastCount = sorted.length;
    return {
      ok: loaded.ok,
      error: loaded.error || null,
      count: sorted.length,
      configured: Boolean(resolvePsnCredentials(psnConfig).configured),
      sort: prefs.sort || 'name',
      secondsPerGame: prefs.secondsPerGame || 60,
      onlineId: loaded.onlineId || null,
      fromCache: Boolean(loaded.fromCache),
    };
  }

  function libraryCount() {
    return lastCount;
  }

  function warmCount() {
    return preview();
  }

  function findCachedTitle(titleId) {
    const id = String(titleId || '');
    return (memoryGames || []).find((game) => String(game.titleId || game.id) === id)
      || libraryCache.listCached().find((game) => String(game.titleId || game.id) === id)
      || null;
  }

  async function enrichCard(titleId, { name = null } = {}) {
    const id = String(titleId || '').trim();
    if (!id) {
      return { ok: false, error: 'Missing PSN title id' };
    }
    const cached = enrichCache.get(id);
    if (cached && (Date.now() - cached.at) < ENRICH_TTL_MS) {
      return { ok: true, platform: 'psn', psn: cached.psn, cached: true };
    }
    const creds = resolvePsnCredentials(psnConfig);
    if (!creds.configured) {
      return { ok: false, error: 'PSN is not linked' };
    }
    let auth;
    try {
      auth = await helpers.ensurePsnAuth(psnConfig);
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }

    let playedTitles = [];
    try {
      playedTitles = await helpers.fetchPlayedTitles(auth.authorization, auth.accountId);
    } catch {
      playedTitles = [];
    }
    const fromLibrary = findCachedTitle(id);
    const presenceGame = {
      titleId: id,
      name: name || fromLibrary?.name || playedTitles.find((t) => t.titleId === id)?.name || id,
      npTitleIconUrl: fromLibrary?.imageUrl || fromLibrary?.posterCandidates?.[0] || null,
      conceptIconUrl: fromLibrary?.imageUrl || null,
      platform: fromLibrary?.platform || null,
    };

    let reading;
    try {
      reading = await helpers.enrichPsnTitle(
        auth.authorization,
        auth.accountId,
        presenceGame,
        {
          playedTitles,
          onlineId: auth.onlineId,
          mode: 'library-tour',
        },
      );
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
    if (!reading) {
      return { ok: false, error: 'Could not load PSN title details' };
    }
    reading = {
      ...reading,
      startedAt: reading.lastPlayedAt || Date.now(),
      elapsedSec: 0,
      onlineId: auth.onlineId || reading.onlineId,
      mode: 'library-tour',
    };
    const payload = buildPsnNowPlayingPayload(reading, config, {
      mode: 'library-tour',
      dismissible: true,
      trigger: 'psn-library-tour-card',
    });
    if (!payload?.psn) {
      return { ok: false, error: 'Failed to build PSN library card' };
    }
    payload.psn.mode = 'library-tour';
    enrichCache.set(id, { at: Date.now(), psn: payload.psn });
    return { ok: true, platform: 'psn', psn: payload.psn, cached: false };
  }

  function getPlaylist(tourId) {
    const session = tourSessions.get(tourId);
    if (!session || session.platform !== 'psn') {
      return null;
    }
    return session;
  }

  async function pushTour({
    secondsPerGame,
    sort,
    device = 'Signal',
    trigger = 'psn-library-tour',
    send,
    loop = true,
    cardBaseUrl = null,
  } = {}) {
    const loaded = await loadGames({ preferCache: true, allowNetwork: true });
    if (!loaded.ok) {
      return { ok: false, error: loaded.error || 'PSN library unavailable' };
    }
    const prefs = tourSettings?.get?.() || {};
    const perGame = secondsPerGame ?? prefs.secondsPerGame ?? 60;
    const order = sort || prefs.sort || 'name';
    const sorted = sortGames(
      loaded.games.map((game) => ({
        appId: game.titleId,
        name: game.name,
        playtimeForeverMin: game.playtimeForeverMin,
        lastPlayedAt: game.lastPlayedAt,
        raw: game,
      })),
      order,
    );
    const playlist = sorted
      .map((game) => mapPsnPlaylistGame(game.raw || game))
      .filter((game) => game.id && game.name);
    if (!playlist.length) {
      return { ok: false, error: 'PSN library is empty' };
    }
    lastCount = playlist.length;
    const looping = loop !== false;
    const session = tourSessions.create({
      platform: 'psn',
      games: playlist,
      secondsPerGame: perGame,
      loop: looping,
      sort: order,
    });
    if (!session) {
      return { ok: false, error: 'Failed to create library tour session' };
    }
    const payload = buildGameLibraryTourPayload({
      platform: 'psn',
      tourId: session.tourId,
      count: session.games.length,
      seedGames: [session.games[0]],
      secondsPerGame: perGame,
      device,
      trigger,
      loop: looping,
      cardBaseUrl: cardBaseUrl != null ? cardBaseUrl : resolveCardBaseUrl(config),
    });
    if (!payload) {
      return { ok: false, error: 'Failed to build library tour payload' };
    }
    const holdSeconds = session.games.length * payload.gameTour.secondsPerGame;
    const emit = typeof send === 'function' ? send : sendUdpPayload;
    emit(payload, { holdSeconds });
    log?.info?.('PSN library tour pushed', {
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
    libraryCache,
    libraryCount,
    warmCount,
    refreshInBackground,
    sessions: tourSessions,
  };
}

module.exports = {
  createPsnLibraryTour,
  fetchPurchasedTitles,
  mapPsnTourGame: mapPsnPlaylistGame,
  mapPsnPlaylistGame,
};
