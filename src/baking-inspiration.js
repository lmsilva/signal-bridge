/**
 * Baking Inspiration — pick a shipped (or house-edited) five-ingredient idea.
 *
 * Corpus is local JSON from the combinatorial build script. No network at
 * runtime. Recent ids keep scheduled pushes from feeling stale.
 */

const crypto = require('crypto');
const SHIPPED = require('./baking-inspiration-ideas.json');
const {
  cleanTitle,
  cleanIngredients,
  parseIngredients,
  createBakingInspirationSettings,
  MAX_INGREDIENTS,
} = require('./baking-inspiration-settings');
const { fold, wrap, encodeText } = require('./vestaboard/encoder');

const TYPE = 'bake.inspire';
const TITLE_WIDTH = 22;
const ING_ROWS = 4;
const ING_WIDTH = 22;

function loadShipped() {
  return Array.isArray(SHIPPED?.ideas) ? SHIPPED.ideas : [];
}

function foldTitle(title) {
  return fold(cleanTitle(title)).slice(0, TITLE_WIDTH);
}

function foldIngredient(value) {
  return fold(String(value || '').replace(/\s+/g, ' ').trim()).slice(0, ING_WIDTH);
}

function ingredientLines(ingredients) {
  const parts = cleanIngredients(ingredients).map(foldIngredient).filter(Boolean);
  if (!parts.length) {
    return [];
  }
  return wrap(parts.join(' + '), ING_WIDTH);
}

function fitsBoard(title, ingredients) {
  const name = foldTitle(title);
  if (!name || encodeText(name).length > TITLE_WIDTH) {
    return false;
  }
  const ings = cleanIngredients(ingredients);
  if (!ings.length || ings.length > MAX_INGREDIENTS) {
    return false;
  }
  const lines = ingredientLines(ings);
  return lines.length > 0 && lines.length <= ING_ROWS;
}

function newCustomId() {
  return `custom-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

function resolveIdeas(settings = {}) {
  const hidden = new Set(settings.hiddenIds || []);
  const overrides = settings.overrides || {};
  const rows = [];

  for (const idea of loadShipped()) {
    const id = String(idea.id || '').trim();
    if (!id) {
      continue;
    }
    const patch = overrides[id] || {};
    const title = cleanTitle(patch.title != null ? patch.title : idea.title);
    const ingredients = patch.ingredients != null
      ? cleanIngredients(patch.ingredients)
      : cleanIngredients(idea.ingredients);
    rows.push({
      id,
      title,
      ingredients,
      custom: false,
      hidden: hidden.has(id),
      rows: ingredientLines(ingredients).length,
      source: idea.source || 'shipped',
    });
  }

  for (const idea of settings.custom || []) {
    const id = String(idea.id || '').trim();
    const title = cleanTitle(idea.title);
    const ingredients = cleanIngredients(idea.ingredients);
    if (!id || !title || !ingredients.length) {
      continue;
    }
    rows.push({
      id,
      title,
      ingredients,
      custom: true,
      hidden: false,
      rows: ingredientLines(ingredients).length,
      source: 'custom',
    });
  }

  return rows;
}

function matchingIdeas(settings = {}) {
  return resolveIdeas(settings).filter((idea) => (
    !idea.hidden
    && fitsBoard(idea.title, idea.ingredients)
  ));
}

function pickIdea(settings = {}, { random = Math.random } = {}) {
  const pool = matchingIdeas(settings);
  if (!pool.length) {
    return null;
  }
  const recent = new Set(settings.recentIds || []);
  const fresh = pool.filter((idea) => !recent.has(idea.id));
  const choices = fresh.length ? fresh : pool;
  const index = Math.min(choices.length - 1, Math.floor(Number(random()) * choices.length));
  return choices[Math.max(0, index)] || null;
}

function buildBakingInspirationPayload(idea, { asOf } = {}) {
  const title = cleanTitle(idea?.title);
  const ingredients = cleanIngredients(idea?.ingredients);
  if (!fitsBoard(title, ingredients)) {
    return null;
  }
  return {
    type: TYPE,
    asOf: asOf || new Date().toISOString(),
    idea: {
      id: idea.id || '',
      title: foldTitle(title),
      ingredients: ingredients.map(foldIngredient).filter(Boolean),
    },
  };
}

function listIdeas(settings = {}, { query = '', hidden = false, page = 1, pageSize = 20 } = {}) {
  const needle = String(query || '').trim().toLowerCase();
  let rows = resolveIdeas(settings);
  if (!hidden) {
    rows = rows.filter((idea) => !idea.hidden);
  }
  if (needle) {
    rows = rows.filter((idea) => idea.title.toLowerCase().includes(needle)
      || idea.ingredients.join(' ').toLowerCase().includes(needle)
      || idea.id.toLowerCase().includes(needle));
  }
  const size = Math.min(50, Math.max(5, Number(pageSize) || 20));
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(pages, Math.max(1, Number(page) || 1));
  const start = (current - 1) * size;
  return {
    query: needle,
    page: current,
    pageSize: size,
    pages,
    total,
    ideas: rows.slice(start, start + size),
  };
}

function createBakingInspiration(config, log) {
  const settingsApi = createBakingInspirationSettings(config, log);

  function snapshot(extra = {}) {
    const settings = settingsApi.get();
    const all = resolveIdeas(settings);
    return {
      available: all.filter((idea) => !idea.hidden && fitsBoard(idea.title, idea.ingredients)).length,
      total: loadShipped().length + settings.custom.length,
      customCount: settings.custom.length,
      hiddenCount: settings.hiddenIds.length,
      ...extra,
    };
  }

  return {
    getSettings: () => settingsApi.get(),
    statusSnapshot(query) {
      const settings = settingsApi.get();
      return snapshot(listIdeas(settings, query));
    },
    addIdea(title, ingredients) {
      const nextTitle = cleanTitle(title);
      const nextIngredients = parseIngredients(ingredients);
      if (!nextTitle) {
        return { ok: false, error: 'Type a baking idea title' };
      }
      if (!nextIngredients.length) {
        return { ok: false, error: 'Add at least one ingredient' };
      }
      if (!fitsBoard(nextTitle, nextIngredients)) {
        return { ok: false, error: 'That idea is too long for the board (title + ≤5 ingredients)' };
      }
      const settings = settingsApi.get();
      const custom = [...settings.custom, {
        id: newCustomId(),
        title: nextTitle,
        ingredients: nextIngredients,
      }];
      settingsApi.update({ custom });
      return { ok: true, ...this.statusSnapshot() };
    },
    updateIdea(id, { title, ingredients, hidden } = {}) {
      const key = String(id || '').trim();
      if (!key) {
        return { ok: false, error: 'Missing idea id' };
      }
      const settings = settingsApi.get();
      const customIndex = settings.custom.findIndex((row) => row.id === key);
      const shipped = loadShipped().some((row) => row.id === key);

      if (customIndex >= 0) {
        const custom = [...settings.custom];
        if (hidden) {
          custom.splice(customIndex, 1);
        } else {
          const nextTitle = title != null ? cleanTitle(title) : custom[customIndex].title;
          const nextIngredients = ingredients != null
            ? parseIngredients(ingredients)
            : custom[customIndex].ingredients;
          if (!nextTitle || !nextIngredients.length) {
            return { ok: false, error: 'Title and ingredients are required' };
          }
          if (!fitsBoard(nextTitle, nextIngredients)) {
            return { ok: false, error: 'That idea is too long for the board' };
          }
          custom[customIndex] = {
            ...custom[customIndex],
            title: nextTitle,
            ingredients: nextIngredients,
          };
        }
        settingsApi.update({ custom });
        return { ok: true, ...this.statusSnapshot() };
      }

      if (!shipped) {
        return { ok: false, error: 'Unknown baking idea' };
      }

      const hiddenIds = new Set(settings.hiddenIds);
      const overrides = { ...settings.overrides };
      if (hidden === true) {
        hiddenIds.add(key);
      } else if (hidden === false) {
        hiddenIds.delete(key);
      }
      if (title != null || ingredients != null) {
        const original = loadShipped().find((row) => row.id === key);
        const nextTitle = title != null ? cleanTitle(title) : cleanTitle(original?.title);
        const nextIngredients = ingredients != null
          ? parseIngredients(ingredients)
          : cleanIngredients(original?.ingredients);
        if (!nextTitle || !nextIngredients.length) {
          return { ok: false, error: 'Title and ingredients are required' };
        }
        if (!fitsBoard(nextTitle, nextIngredients)) {
          return { ok: false, error: 'That idea is too long for the board' };
        }
        const sameTitle = cleanTitle(original?.title) === nextTitle;
        const sameIngredients = JSON.stringify(cleanIngredients(original?.ingredients))
          === JSON.stringify(nextIngredients);
        if (sameTitle && sameIngredients) {
          delete overrides[key];
        } else {
          overrides[key] = { title: nextTitle, ingredients: nextIngredients };
        }
      }
      settingsApi.update({
        hiddenIds: [...hiddenIds],
        overrides,
      });
      return { ok: true, ...this.statusSnapshot() };
    },
    nextPayload(options = {}) {
      const settings = settingsApi.get();
      const idea = pickIdea(settings, options);
      if (!idea) {
        return null;
      }
      settingsApi.remember(idea.id);
      return buildBakingInspirationPayload(idea, options);
    },
  };
}

module.exports = {
  TYPE,
  TITLE_WIDTH,
  ING_ROWS,
  ING_WIDTH,
  MAX_INGREDIENTS,
  loadShipped,
  foldTitle,
  ingredientLines,
  fitsBoard,
  resolveIdeas,
  matchingIdeas,
  pickIdea,
  listIdeas,
  buildBakingInspirationPayload,
  createBakingInspiration,
};
