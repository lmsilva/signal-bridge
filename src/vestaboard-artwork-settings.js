/**
 * Vestaboard Artwork — house edits on top of the shipped templates.
 *
 * The templates themselves live in `vestaboard-artwork-designs.json`. This file
 * only remembers hidden shipped ids, name/grid overrides, the household's own
 * drawings, which pieces are starred, and the recent-id window so a scheduled
 * rotation does not repeat itself.
 */

const fs = require('fs');
const path = require('path');
const { ROWS, COLS, isLegalCode } = require('./vestaboard/encoder');

const RECENT_CAP = 80;
const NAME_MAX = 48;
// A drawing is 132 codes, so the file stays small but not if it grows forever.
const CUSTOM_CAP = 200;

const FALLBACK = {
  recentIds: [],
  hiddenIds: [],
  removedIds: [],
  favouriteIds: [],
  overrides: {},
  custom: [],
};

function cleanId(value) {
  return String(value || '').trim();
}

function cleanName(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
}

/**
 * A grid is only usable if it is exactly the shape of the board and every code
 * is one the board can actually show. Anything else is dropped rather than
 * repaired, so a half-written grid never reaches the queue.
 */
function cleanCells(value) {
  if (!Array.isArray(value) || value.length !== ROWS) {
    return null;
  }
  const out = [];
  for (const row of value) {
    if (!Array.isArray(row) || row.length !== COLS) {
      return null;
    }
    const cells = [];
    for (const raw of row) {
      const code = Number(raw);
      if (!Number.isInteger(code) || !isLegalCode(code)) {
        return null;
      }
      cells.push(code);
    }
    out.push(cells);
  }
  return out;
}

function uniqueIds(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const id = cleanId(raw);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.push(id);
  }
  return out;
}

function sanitiseCustom(list) {
  const out = [];
  const seen = new Set();
  for (const row of Array.isArray(list) ? list : []) {
    const id = cleanId(row?.id) || `custom-${out.length + 1}`;
    const cells = cleanCells(row?.cells);
    if (!cells || seen.has(id) || out.length >= CUSTOM_CAP) {
      continue;
    }
    seen.add(id);
    out.push({ id, name: cleanName(row?.name), cells });
  }
  return out;
}

/** An override may carry a new name, a new grid, or both. */
function sanitiseOverrides(value) {
  const out = {};
  if (!value || typeof value !== 'object') {
    return out;
  }
  for (const [id, raw] of Object.entries(value)) {
    const key = cleanId(id);
    if (!key || !raw || typeof raw !== 'object') {
      continue;
    }
    const patch = {};
    if (raw.name != null) {
      const name = cleanName(raw.name);
      if (name) {
        patch.name = name;
      }
    }
    if (raw.cells != null) {
      const cells = cleanCells(raw.cells);
      if (cells) {
        patch.cells = cells;
      }
    }
    if (Object.keys(patch).length) {
      out[key] = patch;
    }
  }
  return out;
}

function sanitiseSettings(raw = {}, base = FALLBACK) {
  const incoming = raw || {};
  const recentSource = Array.isArray(incoming.recentIds) ? incoming.recentIds : base.recentIds;
  return {
    recentIds: uniqueIds(recentSource).slice(-RECENT_CAP),
    hiddenIds: uniqueIds(incoming.hiddenIds != null ? incoming.hiddenIds : base.hiddenIds),
    removedIds: uniqueIds(incoming.removedIds != null ? incoming.removedIds : base.removedIds),
    favouriteIds: uniqueIds(
      incoming.favouriteIds != null ? incoming.favouriteIds : base.favouriteIds,
    ),
    overrides: sanitiseOverrides(incoming.overrides != null ? incoming.overrides : base.overrides),
    custom: sanitiseCustom(incoming.custom != null ? incoming.custom : base.custom),
  };
}

function createVestaboardArtworkSettings(config = {}, log = console) {
  const settingsPath = config.vestaboardArtworkSettingsPath
    || path.resolve(
      config.ROOT || path.resolve(__dirname, '..'),
      'data',
      'vestaboard-artwork-settings.json',
    );
  let current = sanitiseSettings({}, FALLBACK);

  function load() {
    try {
      if (!fs.existsSync(settingsPath)) {
        current = sanitiseSettings({}, FALLBACK);
        return current;
      }
      current = sanitiseSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), FALLBACK);
    } catch (error) {
      log?.warn?.('Could not read Vestaboard Artwork settings', error?.message || error);
      current = sanitiseSettings({}, FALLBACK);
    }
    return current;
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
    } catch (error) {
      log?.warn?.('Could not save Vestaboard Artwork settings', error?.message || error);
    }
  }

  load();

  return {
    get: () => ({
      recentIds: [...current.recentIds],
      hiddenIds: [...current.hiddenIds],
      removedIds: [...current.removedIds],
      favouriteIds: [...current.favouriteIds],
      overrides: Object.fromEntries(
        Object.entries(current.overrides).map(([id, patch]) => [id, {
          ...patch,
          ...(patch.cells ? { cells: patch.cells.map((row) => [...row]) } : {}),
        }]),
      ),
      custom: current.custom.map((row) => ({
        ...row,
        cells: row.cells.map((cells) => [...cells]),
      })),
    }),
    update(patch = {}) {
      current = sanitiseSettings({ ...current, ...patch }, current);
      save();
      return this.get();
    },
    remember(id) {
      const next = cleanId(id);
      if (!next) {
        return this.get();
      }
      const recentIds = current.recentIds.filter((item) => item !== next);
      recentIds.push(next);
      current = sanitiseSettings({ ...current, recentIds }, current);
      save();
      return this.get();
    },
    reload: load,
    path: settingsPath,
  };
}

module.exports = {
  RECENT_CAP,
  NAME_MAX,
  CUSTOM_CAP,
  FALLBACK,
  cleanName,
  cleanCells,
  sanitiseSettings,
  createVestaboardArtworkSettings,
};
