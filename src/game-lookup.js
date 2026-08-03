/**
 * Name-keyed game metadata, borrowed from the Steam store.
 *
 * The PlayStation Store's Chihiro JSON is decaying — it still resolves ids but
 * answers `204 No Content` for many EU products and `404` for older US ones, so
 * a PS5 card can end up with no blurb at all. Steam publishes the same games
 * with a real description and real gameplay stills, needs no key, and is only
 * consulted when PlayStation has nothing to say.
 *
 * Never throws: a miss just means the card renders without that band.
 */

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // Blurbs and stills barely move.
const MISS_TTL_MS = 6 * 60 * 60 * 1000;

/** @type {Map<string, { at: number, value: object|null }>} */
const cache = new Map();

/** Editions and re-releases are the same game as far as a blurb is concerned. */
function normaliseName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[™®©]/g, '')
    .replace(/\b(ps[45]|playstation ?[45]|xbox|pc)\b/g, ' ')
    .replace(/\b(deluxe|ultimate|standard|complete|definitive|remastered|remaster|goty|game of the year|digital)\b/g, ' ')
    .replace(/\bedition\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Soundtracks, demos and DLC share a name prefix with the game — skip them. */
const NOT_THE_GAME = /\b(soundtrack|ost|demo|beta|trial|dlc|pack|bundle|season pass|expansion|artbook|upgrade)\b/i;

function pickBestApp(candidates, wantedName) {
  const wanted = normaliseName(wantedName);
  if (!wanted) {
    return null;
  }
  const usable = (candidates || []).filter((row) => row?.name && !NOT_THE_GAME.test(row.name));
  const exact = usable.find((row) => normaliseName(row.name) === wanted);
  if (exact) {
    return exact;
  }
  // Only accept a partial match when one name fully contains the other, so
  // "Split" cannot drag in "Split Second" — and require it to be substantial.
  return usable.find((row) => {
    const found = normaliseName(row.name);
    if (!found) {
      return false;
    }
    const longer = found.length >= wanted.length ? found : wanted;
    const shorter = found.length >= wanted.length ? wanted : found;
    return shorter.length >= 4 && longer.startsWith(shorter);
  }) || null;
}

/**
 * @returns {Promise<null | {
 *   name: string, shortDescription: string, screenshots: string[],
 *   developers: string[], publishers: string[], releaseYear: string|null,
 *   appId: number, source: 'steam',
 * }>}
 */
async function lookupGameByName(name, {
  steamApi = require('./steam-api'),
  now = Date.now,
  maxScreenshots = 3,
} = {}) {
  const key = normaliseName(name);
  if (!key) {
    return null;
  }
  const nowMs = typeof now === 'function' ? now() : now;
  const cached = cache.get(key);
  if (cached) {
    const ttl = cached.value ? CACHE_TTL_MS : MISS_TTL_MS;
    if ((nowMs - cached.at) < ttl) {
      return cached.value;
    }
  }

  let value = null;
  try {
    const results = await steamApi.searchStoreApps(name);
    const best = pickBestApp(results, name);
    if (best) {
      const details = await steamApi.fetchAppDetails(best.appId);
      // Guard the search a second time: appdetails carries the canonical name,
      // and a store search can rank a spin-off above the game itself.
      if (details && pickBestApp([{ appId: best.appId, name: details.name }], name)) {
        value = {
          name: details.name,
          shortDescription: String(details.shortDescription || '').trim(),
          screenshots: (details.screenshots || []).slice(0, maxScreenshots),
          developers: details.developers || [],
          publishers: details.publishers || [],
          releaseYear: details.releaseYear || null,
          appId: best.appId,
          source: 'steam',
        };
      }
    }
  } catch {
    value = null;
  }

  cache.set(key, { at: nowMs, value });
  return value;
}

function clearGameLookupCache() {
  cache.clear();
}

module.exports = {
  normaliseName,
  pickBestApp,
  lookupGameByName,
  clearGameLookupCache,
  CACHE_TTL_MS,
  MISS_TTL_MS,
};
