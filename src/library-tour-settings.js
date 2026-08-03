const fs = require('fs');
const path = require('path');

const VALID_SORTS = ['name', 'playtime', 'recent', 'random'];
const DEFAULT_SORT = 'name';
const DEFAULT_SECONDS_PER_GAME = 60;
const MIN_SECONDS_PER_GAME = 5;
const MAX_SECONDS_PER_GAME = 300;

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
  return VALID_SORTS.includes(sort) ? sort : DEFAULT_SORT;
}

function createLibraryTourSettings(config = {}, log = console) {
  const settingsPath = config.libraryTourSettingsPath
    || path.resolve(config.ROOT || path.resolve(__dirname, '..'), 'data/library-tour-settings.json');

  let secondsPerGame = DEFAULT_SECONDS_PER_GAME;
  let sort = DEFAULT_SORT;

  function loadFromDisk() {
    try {
      if (!fs.existsSync(settingsPath)) {
        return;
      }
      const data = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (data?.secondsPerGame != null) {
        secondsPerGame = clampSecondsPerGame(data.secondsPerGame);
      }
      if (data?.sort != null) {
        sort = normalizeSort(data.sort);
      }
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
        `${JSON.stringify({ secondsPerGame, sort }, null, 2)}\n`,
        'utf8',
      );
    } catch (error) {
      log?.warn?.('Could not persist library tour settings', error?.message || error);
    }
  }

  function get() {
    loadFromDisk();
    return { secondsPerGame, sort };
  }

  function getSecondsPerGame() {
    loadFromDisk();
    return secondsPerGame;
  }

  function getSort() {
    loadFromDisk();
    return sort;
  }

  function update(patch = {}) {
    loadFromDisk();

    let nextSeconds = secondsPerGame;
    let nextSort = sort;
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
      const value = normalizeSort(patch.sort);
      if (!VALID_SORTS.includes(String(patch.sort || '').trim().toLowerCase())) {
        return { ok: false, error: `Unknown library tour sort: ${patch.sort || '(none)'}` };
      }
      nextSort = value;
      touched = true;
    }

    if (!touched) {
      return { ok: false, error: 'No library tour settings to update' };
    }

    secondsPerGame = nextSeconds;
    sort = nextSort;
    persist();
    return { ok: true, secondsPerGame, sort };
  }

  return {
    get,
    getSecondsPerGame,
    getSort,
    update,
    settingsPath,
  };
}

module.exports = {
  createLibraryTourSettings,
  VALID_SORTS,
  DEFAULT_SORT,
  DEFAULT_SECONDS_PER_GAME,
  MIN_SECONDS_PER_GAME,
  MAX_SECONDS_PER_GAME,
  clampSecondsPerGame,
  normalizeSort,
};
