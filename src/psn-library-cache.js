const fs = require('fs');
const path = require('path');

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
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
    const titleId = String(entry.titleId || entry.id || '').trim();
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
      if (text && !posterCandidates.includes(text)) {
        posterCandidates.push(text);
      }
    }
    return {
      titleId: titleId || null,
      name: name || 'PlayStation Game',
      imageUrl: posterCandidates[0] || null,
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
    all[key] = {
      ...prev,
      ...next,
      posterCandidates: [
        ...new Set([
          ...(Array.isArray(prev.posterCandidates) ? prev.posterCandidates : []),
          ...(next.posterCandidates || []),
        ]),
      ],
      cachedAt: new Date().toISOString(),
    };
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

  function listCached() {
    const all = loadRaw();
    return Object.values(all)
      .filter((row) => row && (row.titleId || row.name))
      .map((row) => normalizeEntry(row))
      .filter(Boolean);
  }

  function mergeLists(...lists) {
    const merged = new Map();
    for (const list of lists) {
      for (const raw of list || []) {
        const entry = normalizeEntry(raw);
        if (!entry) {
          continue;
        }
        const key = String(entry.titleId || entry.name || '').trim().toLowerCase();
        if (!key) {
          continue;
        }
        const prev = merged.get(key);
        if (!prev) {
          merged.set(key, entry);
          continue;
        }
        merged.set(key, {
          ...prev,
          ...entry,
          name: entry.name || prev.name,
          titleId: entry.titleId || prev.titleId,
          posterCandidates: [
            ...new Set([
              ...(prev.posterCandidates || []),
              ...(entry.posterCandidates || []),
            ]),
          ],
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
    listCached,
    mergeLists,
    cachePath,
  };
}

module.exports = {
  createPsnLibraryCache,
};
