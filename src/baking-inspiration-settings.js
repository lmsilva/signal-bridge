/**
 * Baking Inspiration — house edits on top of the shipped corpus.
 *
 * Ideas live in `baking-inspiration-ideas.json`. This file only remembers
 * hidden shipped ids, title/ingredient overrides, custom additions, and the
 * recent-id window so a scheduled rotation does not repeat itself.
 */

const fs = require('fs');
const path = require('path');

const RECENT_CAP = 120;
const TITLE_MAX = 40;
const INGREDIENT_MAX = 22;
const MAX_INGREDIENTS = 5;

const FALLBACK = {
  recentIds: [],
  hiddenIds: [],
  removedIds: [],
  overrides: {},
  custom: [],
};

function cleanId(value) {
  return String(value || '').trim();
}

function cleanTitle(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX);
}

function cleanIngredient(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, INGREDIENT_MAX);
}

function cleanIngredients(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const item = cleanIngredient(raw);
    if (!item) {
      continue;
    }
    const key = item.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(item);
    if (out.length >= MAX_INGREDIENTS) {
      break;
    }
  }
  return out;
}

/** Accept an array or a comma / plus / newline separated string. */
function parseIngredients(value) {
  if (Array.isArray(value)) {
    return cleanIngredients(value);
  }
  return cleanIngredients(String(value || '').split(/[,\n+/|]+/));
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
    const title = cleanTitle(row?.title);
    const ingredients = parseIngredients(row?.ingredients);
    if (!title || !ingredients.length || seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.push({ id, title, ingredients });
  }
  return out;
}

function sanitiseOverrides(value) {
  const out = {};
  if (!value || typeof value !== 'object') {
    return out;
  }
  for (const [id, entry] of Object.entries(value)) {
    const key = cleanId(id);
    if (!key || !entry || typeof entry !== 'object') {
      continue;
    }
    const title = entry.title != null ? cleanTitle(entry.title) : null;
    const ingredients = entry.ingredients != null ? parseIngredients(entry.ingredients) : null;
    if (!title && (!ingredients || !ingredients.length)) {
      continue;
    }
    out[key] = {};
    if (title) {
      out[key].title = title;
    }
    if (ingredients && ingredients.length) {
      out[key].ingredients = ingredients;
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
    overrides: sanitiseOverrides(incoming.overrides != null ? incoming.overrides : base.overrides),
    custom: sanitiseCustom(incoming.custom != null ? incoming.custom : base.custom),
  };
}

function createBakingInspirationSettings(config = {}, log = console) {
  const settingsPath = config.bakingInspirationSettingsPath
    || path.resolve(config.ROOT || path.resolve(__dirname, '..'), 'data', 'baking-inspiration-settings.json');
  let current = { ...FALLBACK, overrides: {}, custom: [], hiddenIds: [], removedIds: [], recentIds: [] };

  function load() {
    try {
      if (!fs.existsSync(settingsPath)) {
        current = sanitiseSettings({}, FALLBACK);
        return current;
      }
      current = sanitiseSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), FALLBACK);
    } catch (error) {
      log?.warn?.('Could not read Baking Inspiration settings', error?.message || error);
      current = sanitiseSettings({}, FALLBACK);
    }
    return current;
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
    } catch (error) {
      log?.warn?.('Could not save Baking Inspiration settings', error?.message || error);
    }
  }

  load();

  return {
    get: () => ({
      recentIds: [...current.recentIds],
      hiddenIds: [...current.hiddenIds],
      removedIds: [...current.removedIds],
      overrides: { ...current.overrides },
      custom: current.custom.map((row) => ({
        ...row,
        ingredients: [...row.ingredients],
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
  TITLE_MAX,
  INGREDIENT_MAX,
  MAX_INGREDIENTS,
  FALLBACK,
  cleanTitle,
  cleanIngredient,
  cleanIngredients,
  parseIngredients,
  sanitiseSettings,
  createBakingInspirationSettings,
};
