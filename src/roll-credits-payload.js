const crypto = require('crypto');
const fs = require('fs');
const { resolveCardBaseUrl } = require('./steam-library-tour');

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
// The wall cannot decode video, so a clip only reaches it as the short looping
// WebP built at ingest; a row without that preview is not display material.
const DISPLAY_MEDIA_KINDS = ['video', 'screenshot', 'cover'];

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
      // Induction order already encodes beat date plus any manual arrangement,
      // so the wall follows whatever the management page shows.
      rows.sort((a, b) => (Number(a.induction) || 0) - (Number(b.induction) || 0));
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
      rows.sort((a, b) => (Number(b.induction) || 0) - (Number(a.induction) || 0));
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

  /** A clip is only shippable once its looping preview has been rendered. */
  function displayable(item) {
    return item.kind === 'video' ? Boolean(item.previewPath) : Boolean(item.path);
  }

  function cacheBust(url, item) {
    if (!url) return url;
    let revision = item?.previewRevision;
    if (revision == null && item?.previewPath && typeof rollCredits.media.absolutePath === 'function') {
      try {
        revision = Math.round(fs.statSync(rollCredits.media.absolutePath(item.previewPath)).mtimeMs);
      } catch {
        revision = null;
      }
    }
    if (revision == null && item?.frameCount) revision = item.frameCount;
    if (revision == null) return url;
    return `${url}${url.includes('?') ? '&' : '?'}v=${revision}`;
  }

  /** Videos travel as their WebP loop, with the poster still as the fallback. */
  function displayUrls(item, baseUrl) {
    if (item.kind !== 'video') {
      return {
        url: mediaUrl(item, baseUrl),
        thumbUrl: mediaUrl(item, baseUrl, true),
        animated: false,
      };
    }
    return {
      url: cacheBust(
        absoluteUrl(rollCredits.media.publicUrl(item.previewPath), baseUrl),
        item,
      ),
      thumbUrl: item.thumbPath
        ? absoluteUrl(rollCredits.media.publicUrl(item.thumbPath), baseUrl)
        : null,
      animated: true,
    };
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
        && DISPLAY_MEDIA_KINDS.includes(item.kind) && displayable(item))
      .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
    const videos = ready.filter((item) => item.kind === 'video');
    const covers = ready.filter((item) => item.kind === 'cover');
    const shotItems = ready.filter((item) => item.kind === 'screenshot');
    let heroItem = null;
    if (priority[0] === 'video' && videos.length) {
      heroItem = videos[0];
    } else if (covers.length && shotItems.length) {
      // Prefer cover as hero when screenshots exist so the wall can show gameplay
      // stills in the strip instead of an empty portrait screenshot band.
      heroItem = covers[0];
    } else {
      const selectedKind = priority.find((kind) => ready.some((item) => item.kind === kind)) || null;
      heroItem = selectedKind ? ready.find((item) => item.kind === selectedKind) : null;
    }
    const screenshots = shotItems
      .filter((item) => item.id !== heroItem?.id)
      .slice(0, 3)
      .map((item) => ({
        id: item.id,
        kind: item.kind,
        ...displayUrls(item, baseUrl),
      }));
    return {
      selectedKind: heroItem?.kind || null,
      hero: heroItem ? {
        id: heroItem.id,
        kind: heroItem.kind,
        ...displayUrls(heroItem, baseUrl),
      } : null,
      // Poster / cover / first screenshot — the wall paints this until the
      // looping WebP has a local copy. Never the source .mp4.
      still: stillOf(heroItem, ready, baseUrl),
      screenshots,
    };
  }

  function stillOf(heroItem, ready, baseUrl) {
    if (heroItem?.kind !== 'video') return null;
    if (heroItem.thumbPath) {
      return {
        id: heroItem.id,
        kind: 'video',
        url: absoluteUrl(rollCredits.media.publicUrl(heroItem.thumbPath), baseUrl),
        thumbUrl: null,
        animated: false,
      };
    }
    const cover = ready.find((item) => item.kind === 'cover');
    if (cover) {
      return { id: cover.id, kind: 'cover', ...displayUrls(cover, baseUrl) };
    }
    const shot = ready.find((item) => item.kind === 'screenshot');
    if (shot) {
      return { id: shot.id, kind: 'screenshot', ...displayUrls(shot, baseUrl) };
    }
    return null;
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

  function compactGame(game) {
    const system = rollCredits.store.getSystemById?.(game.system);
    return {
      id: game.id,
      title: game.title || 'Unknown game',
      system: game.system || 'other',
      systemLabel: system?.label || game.system || 'Other',
      beatenAt: game.beatenAt || null,
      induction: Number(game.induction) || null,
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
    const stats = rollCredits.getStats() || {};
    if (stats.latest) {
      try {
        stats.latest = cardFor(stats.latest, { baseUrl: origin, settings }) || stats.latest;
      } catch {
        // Keep the store row. The board only needs title / system / beatenAt.
      }
    }
    const compact = walked.map((game) => compactGame(game));
    const session = {
      tourId,
      games: compact,
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
      games: compact,
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
