const fs = require('fs');
const path = require('path');

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function isJunkImageUrl(url) {
  const text = String(url || '').trim().toLowerCase();
  if (!text) {
    return true;
  }
  return text.includes('example.com') || text.includes('example.org');
}

function isStrongImageUrl(url) {
  const text = String(url || '').trim().toLowerCase();
  if (!text || isJunkImageUrl(text)) {
    return false;
  }
  return text.includes('playstation.com')
    || text.includes('sonyentertainmentnetwork.com')
    || text.includes('playstation.net');
}

function pickBestImageUrl(...groups) {
  const candidates = [];
  for (const group of groups) {
    for (const url of Array.isArray(group) ? group : [group]) {
      const text = String(url || '').trim();
      if (text && !candidates.includes(text)) {
        candidates.push(text);
      }
    }
  }
  return candidates.find((url) => isStrongImageUrl(url))
    || candidates.find((url) => !isJunkImageUrl(url))
    || null;
}

function createPsnLibraryCache(config = {}, log = console) {
  const cachePath = config.psnLibraryCachePath
    || path.resolve(config.ROOT || path.resolve(__dirname, '..'), 'data/psn-library-cache.json');

  function loadRaw() {
    try {
      if (!fs.existsSync(cachePath)) {
        return {};
      }
      const data = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch (error) {
      log?.warn?.('Could not read PSN library cache — starting empty', error?.message || error);
      return {};
    }
  }

  function persist(entries) {
    try {
      ensureParentDir(cachePath);
      fs.writeFileSync(cachePath, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
    } catch (error) {
      log?.warn?.('Could not persist PSN library cache', error?.message || error);
    }
  }

  function normalizeEntry(entry = {}) {
    const titleId = String(entry.titleId || entry.id || entry.appId || '').trim();
    const name = String(entry.name || '').trim();
    if (!titleId && !name) {
      return null;
    }
    const posterCandidates = [];
    for (const url of [
      ...(Array.isArray(entry.posterCandidates) ? entry.posterCandidates : []),
      entry.imageUrl,
      entry.headerImage,
    ]) {
      const text = String(url || '').trim();
      if (text && !isJunkImageUrl(text) && !posterCandidates.includes(text)) {
        posterCandidates.push(text);
      }
    }
    // Prefer a real PlayStation CDN URL; never keep example.com fixtures.
    const imageUrl = pickBestImageUrl(posterCandidates, entry.imageUrl, entry.headerImage);
    if (imageUrl && !posterCandidates.includes(imageUrl)) {
      posterCandidates.unshift(imageUrl);
    }
    return {
      titleId: titleId || null,
      name: name || 'PlayStation Game',
      imageUrl,
      posterCandidates,
      playtimeForeverMin: Number.isFinite(Number(entry.playtimeForeverMin))
        ? Number(entry.playtimeForeverMin)
        : null,
      lastPlayedAt: Number.isFinite(Number(entry.lastPlayedAt))
        ? Number(entry.lastPlayedAt)
        : null,
      cachedAt: entry.cachedAt || new Date().toISOString(),
    };
  }

  function rememberTitle(entry = {}) {
    const next = normalizeEntry(entry);
    if (!next?.titleId) {
      return null;
    }
    const all = loadRaw();
    const key = next.titleId;
    const prev = all[key] && typeof all[key] === 'object' ? all[key] : {};
    const merged = normalizeEntry({
      ...prev,
      ...next,
      posterCandidates: [
        ...(Array.isArray(prev.posterCandidates) ? prev.posterCandidates : []),
        ...(next.posterCandidates || []),
      ],
      imageUrl: pickBestImageUrl(next.imageUrl, next.posterCandidates, prev.imageUrl, prev.posterCandidates),
      cachedAt: new Date().toISOString(),
    });
    all[key] = merged;
    persist(all);
    return all[key];
  }

  function rememberTitleFromReading(reading = {}) {
    return rememberTitle({
      titleId: reading.titleId,
      name: reading.name,
      posterCandidates: reading.posterCandidates,
      headerImage: reading.headerImage,
      playtimeForeverMin: reading.playtimeForeverMin,
      lastPlayedAt: reading.lastPlayedAt,
    });
  }

  /** Persist a full library snapshot (tour warm) — replaces per-title only cache. */
  function setLibrary(games = []) {
    const all = {};
    for (const raw of games || []) {
      const entry = normalizeEntry(raw);
      if (!entry?.titleId) {
        continue;
      }
      all[entry.titleId] = {
        ...entry,
        cachedAt: new Date().toISOString(),
      };
    }
    persist(all);
    return Object.keys(all).length;
  }

  function listCached() {
    const all = loadRaw();
    return Object.values(all)
      .filter((row) => row && (row.titleId || row.name))
      .map((row) => normalizeEntry(row))
      .filter((row) => row && row.titleId);
  }

  function count() {
    return listCached().length;
  }

  /**
   * Merge library lists. Later lists win for playtime/lastPlayed, but a strong
   * PlayStation image URL is never overwritten by a junk/fixture URL.
   */
  function mergeLists(...lists) {
    const merged = new Map();
    for (const list of lists) {
      for (const raw of list || []) {
        const entry = normalizeEntry(raw);
        if (!entry?.titleId) {
          continue;
        }
        const key = String(entry.titleId).trim().toLowerCase();
        const prev = merged.get(key);
        if (!prev) {
          merged.set(key, entry);
          continue;
        }
        const imageUrl = pickBestImageUrl(
          entry.imageUrl,
          entry.posterCandidates,
          prev.imageUrl,
          prev.posterCandidates,
        );
        const posterCandidates = [];
        for (const url of [
          imageUrl,
          ...(entry.posterCandidates || []),
          ...(prev.posterCandidates || []),
        ]) {
          if (url && !isJunkImageUrl(url) && !posterCandidates.includes(url)) {
            posterCandidates.push(url);
          }
        }
        merged.set(key, {
          ...prev,
          ...entry,
          name: entry.name || prev.name,
          titleId: entry.titleId || prev.titleId,
          imageUrl,
          posterCandidates,
          playtimeForeverMin: Math.max(
            Number(prev.playtimeForeverMin) || 0,
            Number(entry.playtimeForeverMin) || 0,
          ) || null,
          lastPlayedAt: Math.max(
            Number(prev.lastPlayedAt) || 0,
            Number(entry.lastPlayedAt) || 0,
          ) || null,
        });
      }
    }
    return [...merged.values()];
  }

  return {
    rememberTitle,
    rememberTitleFromReading,
    setLibrary,
    listCached,
    count,
    mergeLists,
    cachePath,
    pickBestImageUrl,
    isJunkImageUrl,
  };
}

module.exports = {
  createPsnLibraryCache,
  pickBestImageUrl,
  isJunkImageUrl,
  isStrongImageUrl,
};
