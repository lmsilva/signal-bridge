const crypto = require('crypto');

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // tour playlists stay fetchable for 6h

/**
 * In-memory playlists for active library tours.
 *
 * UDP cannot carry 700+ games. The bridge stamps a tourId on a tiny start
 * packet; the display pulls the ordered id/name list over HTTP.
 */
function createLibraryTourSessions({ ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
  const sessions = new Map();

  function prune(at = now()) {
    for (const [id, session] of sessions) {
      if (at - session.createdAt > ttlMs) {
        sessions.delete(id);
      }
    }
  }

  function create({ platform, games, secondsPerGame, loop, sort }) {
    prune();
    const tourId = crypto.randomBytes(8).toString('hex');
    const list = (Array.isArray(games) ? games : [])
      .map((game) => ({
        id: String(game.id || game.appId || game.titleId || '').trim(),
        name: String(game.name || '').trim(),
        playtimeForeverMin: Number.isFinite(Number(game.playtimeForeverMin))
          ? Number(game.playtimeForeverMin)
          : null,
        playtimeLabel: game.playtimeLabel || null,
        lastPlayedAt: game.lastPlayedAt ?? null,
        imageUrl: game.imageUrl || game.posterCandidates?.[0] || null,
      }))
      .filter((game) => game.id && game.name);
    if (!list.length) {
      return null;
    }
    const session = {
      tourId,
      platform: platform === 'psn' ? 'psn' : 'steam',
      secondsPerGame,
      loop: loop !== false,
      sort: sort || 'name',
      games: list,
      createdAt: now(),
    };
    sessions.set(tourId, session);
    return session;
  }

  function get(tourId) {
    prune();
    return sessions.get(String(tourId || '').trim()) || null;
  }

  function size() {
    return sessions.size;
  }

  return { create, get, size, prune };
}

module.exports = {
  createLibraryTourSessions,
  DEFAULT_TTL_MS,
};
