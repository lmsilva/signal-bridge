const crypto = require('crypto');
const { resolveCardBaseUrl } = require('./steam-library-tour');

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const DISPLAY_MEDIA_KINDS = ['screenshot', 'cover'];

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.max(min, Math.min(max, Math.round(number)))
    : fallback;
}

function absoluteUrl(value, baseUrl = '') {
  const path = String(value || '').trim();
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!base) return path.startsWith('/') ? path : `/${path}`;
  return `${base}${path.startsWith('/') ? '' : '/'}${path}`;
}

function sortGames(games, order = 'recent', random = Math.random) {
  const rows = [...(games || [])];
  switch (order) {
    case 'oldest':
      rows.sort((a, b) => {
        if (!a.beatenAt && !b.beatenAt) return (Number(a.induction) || 0) - (Number(b.induction) || 0);
        if (!a.beatenAt) return 1;
        if (!b.beatenAt) return -1;
        return String(a.beatenAt).localeCompare(String(b.beatenAt))
          || (Number(a.induction) || 0) - (Number(b.induction) || 0);
      });
      break;
    case 'random':
      for (let index = rows.length - 1; index > 0; index -= 1) {
        const other = Math.floor(random() * (index + 1));
        [rows[index], rows[other]] = [rows[other], rows[index]];
      }
      break;
    case 'alpha':
      rows.sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), undefined, {
        numeric: true,
        sensitivity: 'base',
      }));
      break;
    case 'recent':
    default:
      rows.sort((a, b) => {
        if (!a.beatenAt && !b.beatenAt) return (Number(b.induction) || 0) - (Number(a.induction) || 0);
        if (!a.beatenAt) return 1;
        if (!b.beatenAt) return -1;
        return String(b.beatenAt).localeCompare(String(a.beatenAt))
          || (Number(b.induction) || 0) - (Number(a.induction) || 0);
      });
  }
  return rows;
}

function createRollCreditsPayload({
  rollCredits,
  config = {},
  ttlMs = DEFAULT_TTL_MS,
  now = () => Date.now(),
  random = Math.random,
} = {}) {
  if (!rollCredits?.store || !rollCredits?.media) {
    throw new Error('Roll Credits payload builder needs the shared Roll Credits service');
  }
  const sessions = new Map();

  function prune() {
    const at = now();
    for (const [tourId, session] of sessions) {
      if (at - session.createdAt > ttlMs) sessions.delete(tourId);
    }
  }

  function settingsSnapshot() {
    return rollCredits.getSettings?.() || rollCredits.settings?.get?.() || {};
  }

  function mediaUrl(item, baseUrl, thumbnail = false) {
    const relative = thumbnail && item?.thumbPath ? item.thumbPath : item?.path;
    return relative ? absoluteUrl(rollCredits.media.publicUrl(relative), baseUrl) : null;
  }

  function resolveDisplayMedia(game, settings, baseUrl) {
    const configured = Array.isArray(game?.mediaPriorityOverride) && game.mediaPriorityOverride.length
      ? game.mediaPriorityOverride
      : (settings?.mediaPriority || ['video', 'screenshot', 'cover']);
    const priority = configured.filter((kind) => DISPLAY_MEDIA_KINDS.includes(kind));
    for (const kind of DISPLAY_MEDIA_KINDS) {
      if (!priority.includes(kind)) priority.push(kind);
    }
    const ready = (game?.media || [])
      .filter((item) => item && item.hidden !== true && item.status === 'ready'
        && item.path && DISPLAY_MEDIA_KINDS.includes(item.kind))
      .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
    const selectedKind = priority.find((kind) => ready.some((item) => item.kind === kind)) || null;
    const heroItem = selectedKind ? ready.find((item) => item.kind === selectedKind) : null;
    const screenshots = ready
      .filter((item) => item.kind === 'screenshot' && item.id !== heroItem?.id)
      .slice(0, 3)
      .map((item) => ({
        id: item.id,
        kind: item.kind,
        url: mediaUrl(item, baseUrl),
        thumbUrl: mediaUrl(item, baseUrl, true),
      }));
    return {
      selectedKind,
      hero: heroItem ? {
        id: heroItem.id,
        kind: heroItem.kind,
        url: mediaUrl(heroItem, baseUrl),
        thumbUrl: mediaUrl(heroItem, baseUrl, true),
      } : null,
      screenshots,
    };
  }

  function cardFor(game, { baseUrl = '', settings = settingsSnapshot() } = {}) {
    if (!game) return null;
    const system = rollCredits.store.getSystemById?.(game.system);
    return {
      id: game.id,
      title: game.title || 'Unknown game',
      system: game.system || 'other',
      systemLabel: system?.label || game.system || 'Other',
      beatenAt: game.beatenAt || null,
      beatenDateUnknown: game.beatenDateUnknown === true || !game.beatenAt,
      beatenWith: game.beatenWith || null,
      induction: Number(game.induction) || null,
      difficulty: game.difficulty || null,
      description: game.description || game.meta?.description || '',
      publisher: game.publisher || game.meta?.publisher || null,
      developer: game.developer || game.meta?.developer || null,
      releaseDate: game.releaseDate || game.meta?.releaseDate || null,
      genres: game.genres || game.meta?.genres || [],
      maxPlayers: game.maxPlayers ?? game.meta?.maxPlayers ?? null,
      media: resolveDisplayMedia(game, settings, baseUrl),
    };
  }

  function getCard(gameId, options = {}) {
    return cardFor(rollCredits.getGame?.(String(gameId || '')), {
      ...options,
      baseUrl: options.baseUrl != null ? options.baseUrl : resolveCardBaseUrl(config),
    });
  }

  function buildTourStart({
    loop = true,
    secondsPerGame,
    dashboardSeconds,
    order,
    gameLimit,
    baseUrl,
  } = {}) {
    prune();
    const settings = settingsSnapshot();
    const display = settings.display || {};
    const perGame = clampInt(secondsPerGame, 5, 300, display.secondsPerGame || 12);
    const dashboard = clampInt(dashboardSeconds, 10, 120, display.dashboardSeconds || 25);
    const resolvedOrder = ['recent', 'oldest', 'random', 'alpha'].includes(order)
      ? order : (display.order || 'recent');
    const allGames = sortGames(rollCredits.store.getAllGames(), resolvedOrder, random);
    const explicitLimit = clampInt(gameLimit, 0, 500, 0);
    const scheduledLimit = loop === false
      ? clampInt(display.scheduledGameLimit, 0, Number.MAX_SAFE_INTEGER, 0)
      : 0;
    const limit = explicitLimit > 0 ? explicitLimit : scheduledLimit;
    const walked = limit > 0 ? allGames.slice(0, limit) : allGames;
    if (!walked.length) return null;

    const tourId = crypto.randomBytes(8).toString('hex');
    const origin = baseUrl != null ? String(baseUrl).replace(/\/+$/, '') : resolveCardBaseUrl(config);
    const stats = rollCredits.getStats();
    if (stats?.latest) stats.latest = cardFor(stats.latest, { baseUrl: origin, settings });
    const session = {
      tourId,
      games: walked.map((game) => ({
        id: game.id,
        title: game.title || 'Unknown game',
        system: game.system || 'other',
        induction: Number(game.induction) || null,
      })),
      count: allGames.length,
      walkedCount: walked.length,
      loop: loop !== false,
      secondsPerGame: perGame,
      dashboardSeconds: dashboard,
      order: resolvedOrder,
      createdAt: now(),
    };
    sessions.set(tourId, session);
    const duration = dashboard + walked.length * perGame + 4;
    return {
      version: 2,
      type: 'roll-credits.tour',
      timestamp: new Date(now()).toISOString(),
      tourId,
      count: allGames.length,
      walkedCount: walked.length,
      loop: loop !== false,
      persistent: loop !== false,
      displaySeconds: loop !== false ? 0 : duration,
      secondsPerGame: perGame,
      dashboardSeconds: dashboard,
      order: resolvedOrder,
      playlistPath: `/api/roll-credits/playlist/${tourId}`,
      cardBaseUrl: origin,
      stats,
    };
  }

  function getPlaylist(tourId) {
    prune();
    return sessions.get(String(tourId || '').trim()) || null;
  }

  return {
    buildTourStart,
    getPlaylist,
    getCard,
    sortGames,
    resolveDisplayMedia,
    sessions,
    prune,
  };
}

module.exports = {
  createRollCreditsPayload,
  sortGames,
  absoluteUrl,
  DEFAULT_TTL_MS,
};
