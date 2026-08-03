const fs = require('fs');
const path = require('path');

// Match Shared Photo Slideshow: Newest first / Oldest first / Shuffle.
const VALID_SORTS = ['recent', 'oldest', 'random'];
const DEFAULT_SORT = 'recent';
const DEFAULT_SECONDS_PER_GAME = 60;
const MIN_SECONDS_PER_GAME = 5;
const MAX_SECONDS_PER_GAME = 300;
const PLATFORMS = ['steam', 'psn'];

// Older builds persisted name/playtime — map them onto the slideshow-style set.
const LEGACY_SORT_MAP = {
  name: 'recent',
  playtime: 'recent',
};

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function clampSecondsPerGame(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return DEFAULT_SECONDS_PER_GAME;
  }
  return Math.max(
    MIN_SECONDS_PER_GAME,
    Math.min(MAX_SECONDS_PER_GAME, Math.round(n)),
  );
}

function normalizeSort(value) {
  const sort = String(value || '').trim().toLowerCase();
  if (VALID_SORTS.includes(sort)) {
    return sort;
  }
  if (LEGACY_SORT_MAP[sort]) {
    return LEGACY_SORT_MAP[sort];
  }
  return DEFAULT_SORT;
}

function normalizePlatform(value) {
  const platform = String(value || '').trim().toLowerCase();
  return PLATFORMS.includes(platform) ? platform : null;
}

function defaultPlatformPrefs() {
  return {
    secondsPerGame: DEFAULT_SECONDS_PER_GAME,
    sort: DEFAULT_SORT,
  };
}

function createLibraryTourSettings(config = {}, log = console) {
  const settingsPath = config.libraryTourSettingsPath
    || path.resolve(config.ROOT || path.resolve(__dirname, '..'), 'data/library-tour-settings.json');

  let steam = defaultPlatformPrefs();
  let psn = defaultPlatformPrefs();

  function platformState(platform) {
    return platform === 'psn' ? psn : steam;
  }

  function setPlatformState(platform, next) {
    if (platform === 'psn') {
      psn = next;
    } else {
      steam = next;
    }
  }

  function loadFromDisk() {
    try {
      if (!fs.existsSync(settingsPath)) {
        return;
      }
      const data = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      // New shape: { steam: {...}, psn: {...} }
      if (data?.steam || data?.psn) {
        for (const platform of PLATFORMS) {
          const row = data[platform] && typeof data[platform] === 'object' ? data[platform] : {};
          setPlatformState(platform, {
            secondsPerGame: row.secondsPerGame != null
              ? clampSecondsPerGame(row.secondsPerGame)
              : DEFAULT_SECONDS_PER_GAME,
            sort: row.sort != null ? normalizeSort(row.sort) : DEFAULT_SORT,
          });
        }
        return;
      }
      // Legacy shared shape: { secondsPerGame, sort } → seed both platforms.
      const sharedSeconds = data?.secondsPerGame != null
        ? clampSecondsPerGame(data.secondsPerGame)
        : DEFAULT_SECONDS_PER_GAME;
      const sharedSort = data?.sort != null ? normalizeSort(data.sort) : DEFAULT_SORT;
      steam = { secondsPerGame: sharedSeconds, sort: sharedSort };
      psn = { secondsPerGame: sharedSeconds, sort: sharedSort };
    } catch (error) {
      log?.warn?.('Could not read library tour settings — using defaults', error?.message || error);
    }
  }

  loadFromDisk();

  function persist() {
    try {
      ensureParentDir(settingsPath);
      fs.writeFileSync(
        settingsPath,
        `${JSON.stringify({ steam, psn }, null, 2)}\n`,
        'utf8',
      );
    } catch (error) {
      log?.warn?.('Could not persist library tour settings', error?.message || error);
    }
  }

  function get() {
    loadFromDisk();
    return {
      steam: { ...steam },
      psn: { ...psn },
    };
  }

  function getFor(platform) {
    loadFromDisk();
    const key = normalizePlatform(platform) || 'steam';
    return { ...platformState(key) };
  }

  function getSecondsPerGame(platform = 'steam') {
    return getFor(platform).secondsPerGame;
  }

  function getSort(platform = 'steam') {
    return getFor(platform).sort;
  }

  function update(patch = {}) {
    loadFromDisk();
    const platform = normalizePlatform(patch.platform);
    if (!platform) {
      return { ok: false, error: 'platform must be steam or psn' };
    }

    const current = platformState(platform);
    let nextSeconds = current.secondsPerGame;
    let nextSort = current.sort;
    let touched = false;

    if (patch.secondsPerGame !== undefined) {
      const n = Number(patch.secondsPerGame);
      if (!Number.isFinite(n)) {
        return { ok: false, error: 'secondsPerGame must be a number between 5 and 300' };
      }
      nextSeconds = clampSecondsPerGame(n);
      touched = true;
    }

    if (patch.sort !== undefined) {
      const raw = String(patch.sort || '').trim().toLowerCase();
      if (!VALID_SORTS.includes(raw) && !LEGACY_SORT_MAP[raw]) {
        return { ok: false, error: `Unknown library tour sort: ${patch.sort || '(none)'}` };
      }
      nextSort = normalizeSort(raw);
      touched = true;
    }

    if (!touched) {
      return { ok: false, error: 'No library tour settings to update' };
    }

    const next = { secondsPerGame: nextSeconds, sort: nextSort };
    setPlatformState(platform, next);
    persist();
    return { ok: true, platform, ...next, steam: { ...steam }, psn: { ...psn } };
  }

  return {
    get,
    getFor,
    getSecondsPerGame,
    getSort,
    update,
    settingsPath,
  };
}

module.exports = {
  createLibraryTourSettings,
  VALID_SORTS,
  PLATFORMS,
  DEFAULT_SORT,
  DEFAULT_SECONDS_PER_GAME,
  MIN_SECONDS_PER_GAME,
  MAX_SECONDS_PER_GAME,
  clampSecondsPerGame,
  normalizeSort,
  normalizePlatform,
};
