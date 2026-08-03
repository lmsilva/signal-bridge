const fs = require('fs');
const path = require('path');

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes is fine — libraries change rarely

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

/**
 * Disk + memory cache for Steam GetOwnedGames.
 *
 * Starting a 700-game tour must not wait on Valve every time — warm the cache
 * on boot / preview and serve pushTour from memory.
 */
function createSteamLibraryCache(config = {}, log = console) {
  const cachePath = config.steamLibraryCachePath
    || path.resolve(config.ROOT || path.resolve(__dirname, '..'), 'data/steam-library-cache.json');
  const ttlMs = Number(config.steamLibraryCacheTtlMs) > 0
    ? Number(config.steamLibraryCacheTtlMs)
    : DEFAULT_TTL_MS;

  let memory = null; // { games, fetchedAt, steamId }

  function readDisk() {
    try {
      if (!fs.existsSync(cachePath)) {
        return null;
      }
      const data = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      if (!Array.isArray(data?.games)) {
        return null;
      }
      return {
        games: data.games,
        fetchedAt: Number(data.fetchedAt) || 0,
        steamId: String(data.steamId || ''),
      };
    } catch (error) {
      log?.warn?.('Could not read Steam library cache', error?.message || error);
      return null;
    }
  }

  function writeDisk(entry) {
    try {
      ensureParentDir(cachePath);
      fs.writeFileSync(
        cachePath,
        `${JSON.stringify({
          steamId: entry.steamId,
          fetchedAt: entry.fetchedAt,
          games: entry.games,
        })}\n`,
        'utf8',
      );
    } catch (error) {
      log?.warn?.('Could not persist Steam library cache', error?.message || error);
    }
  }

  function get(steamId) {
    const id = String(steamId || '');
    if (memory && memory.steamId === id) {
      return memory;
    }
    const disk = readDisk();
    if (disk && disk.steamId === id) {
      memory = disk;
      return disk;
    }
    return null;
  }

  function isFresh(entry, at = Date.now()) {
    return Boolean(entry && (at - Number(entry.fetchedAt || 0)) < ttlMs);
  }

  function set(steamId, games) {
    const entry = {
      steamId: String(steamId || ''),
      fetchedAt: Date.now(),
      games: Array.isArray(games) ? games : [],
    };
    memory = entry;
    writeDisk(entry);
    return entry;
  }

  function count(steamId) {
    return get(steamId)?.games?.length || 0;
  }

  return {
    get,
    set,
    isFresh,
    count,
    cachePath,
    ttlMs,
  };
}

module.exports = {
  createSteamLibraryCache,
  DEFAULT_TTL_MS,
};
