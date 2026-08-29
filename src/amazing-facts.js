/**
 * Amazing Facts — pick a shipped (or house-edited) quirky fact for the board.
 *
 * Corpus is local JSON from the open science-facts-project dump (MIT).
 * No network and no API keys at runtime.
 */

const crypto = require('crypto');
const SHIPPED = require('./amazing-facts-facts.json');
const {
  cleanText,
  cleanCategory,
  createAmazingFactsSettings,
} = require('./amazing-facts-settings');
const { fold, wrap } = require('./vestaboard/encoder');

const TYPE = 'amazing.facts';
const BODY_ROWS = 5;
const BODY_WIDTH = 22;

function loadShipped() {
  return Array.isArray(SHIPPED?.facts) ? SHIPPED.facts : [];
}

function shippedCategories() {
  if (Array.isArray(SHIPPED?.categories) && SHIPPED.categories.length) {
    return SHIPPED.categories.map((row) => ({
      id: cleanCategory(row.id || row),
      count: Number(row.count) || 0,
    })).filter((row) => row.id);
  }
  const counts = new Map();
  for (const fact of loadShipped()) {
    const id = cleanCategory(fact.category) || 'trivia';
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([id, count]) => ({ id, count }));
}

function factRows(text) {
  const folded = fold(cleanText(text));
  if (!folded) {
    return [];
  }
  return wrap(folded, BODY_WIDTH);
}

function fitsBoard(text) {
  const lines = factRows(text);
  return lines.length > 0 && lines.length <= BODY_ROWS * 2;
}

function newCustomId() {
  return `custom-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

function resolveFacts(settings = {}) {
  const hidden = new Set(settings.hiddenIds || []);
  const overrides = settings.overrides || {};
  const rows = [];

  for (const fact of loadShipped()) {
    const id = String(fact.id || '').trim();
    if (!id) {
      continue;
    }
    const text = cleanText(overrides[id] != null ? overrides[id] : fact.text);
    rows.push({
      id,
      text,
      category: cleanCategory(fact.category) || 'trivia',
      custom: false,
      hidden: hidden.has(id),
      rows: factRows(text).length,
      source: fact.source || 'shipped',
    });
  }

  for (const fact of settings.custom || []) {
    const id = String(fact.id || '').trim();
    const text = cleanText(fact.text);
    if (!id || !text) {
      continue;
    }
    rows.push({
      id,
      text,
      category: cleanCategory(fact.category) || 'custom',
      custom: true,
      hidden: false,
      rows: factRows(text).length,
      source: 'custom',
    });
  }

  return rows;
}

function matchingFacts(settings = {}) {
  const allowed = new Set((settings.categories || []).map(cleanCategory).filter(Boolean));
  return resolveFacts(settings).filter((fact) => {
    if (fact.hidden || !fact.text || fact.rows <= 0) {
      return false;
    }
    if (allowed.size && !allowed.has(fact.category)) {
      return false;
    }
    return true;
  });
}

function pickFact(settings = {}, { random = Math.random } = {}) {
  const pool = matchingFacts(settings);
  if (!pool.length) {
    return null;
  }
  const recent = new Set(settings.recentIds || []);
  const fresh = pool.filter((fact) => !recent.has(fact.id));
  const choices = fresh.length ? fresh : pool;
  const index = Math.min(choices.length - 1, Math.floor(Number(random()) * choices.length));
  return choices[Math.max(0, index)] || null;
}

function buildAmazingFactsPayload(fact, { asOf } = {}) {
  const text = cleanText(fact?.text);
  if (!text) {
    return null;
  }
  return {
    type: TYPE,
    asOf: asOf || new Date().toISOString(),
    fact: {
      id: fact.id || '',
      text,
      category: cleanCategory(fact.category) || '',
    },
  };
}

function listFacts(settings = {}, {
  query = '',
  hidden = false,
  page = 1,
  pageSize = 20,
  category = '',
} = {}) {
  const needle = String(query || '').trim().toLowerCase();
  const categoryFilter = cleanCategory(category);
  let rows = resolveFacts(settings);
  if (!hidden) {
    rows = rows.filter((fact) => !fact.hidden);
  }
  if (categoryFilter) {
    rows = rows.filter((fact) => fact.category === categoryFilter);
  }
  if (needle) {
    rows = rows.filter((fact) => fact.text.toLowerCase().includes(needle)
      || fact.category.toLowerCase().includes(needle)
      || fact.id.toLowerCase().includes(needle));
  }
  const size = Math.min(50, Math.max(5, Number(pageSize) || 20));
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(pages, Math.max(1, Number(page) || 1));
  const start = (current - 1) * size;
  return {
    query: needle,
    category: categoryFilter,
    page: current,
    pageSize: size,
    pages,
    total,
    facts: rows.slice(start, start + size),
  };
}

function createAmazingFacts(config, log) {
  const settingsApi = createAmazingFactsSettings(config, log);

  function snapshot(extra = {}) {
    const settings = settingsApi.get();
    const all = resolveFacts(settings);
    const available = matchingFacts(settings).length;
    return {
      available,
      total: loadShipped().length + settings.custom.length,
      customCount: settings.custom.length,
      hiddenCount: settings.hiddenIds.length,
      categories: settings.categories,
      categoryOptions: shippedCategories(),
      attribution: SHIPPED?.attribution || '',
      license: SHIPPED?.license || 'MIT',
      ...extra,
    };
  }

  return {
    getSettings: () => settingsApi.get(),
    statusSnapshot(query) {
      const settings = settingsApi.get();
      return snapshot(listFacts(settings, query));
    },
    updateFilters({ categories } = {}) {
      settingsApi.update({
        categories: categories == null ? [] : categories,
      });
      return { ok: true, ...this.statusSnapshot() };
    },
    addFact(text, category) {
      const next = cleanText(text);
      if (!next) {
        return { ok: false, error: 'Type an amazing fact' };
      }
      if (!fitsBoard(next)) {
        return { ok: false, error: 'That fact is too long for the Vestaboard' };
      }
      const settings = settingsApi.get();
      const custom = [...settings.custom, {
        id: newCustomId(),
        text: next,
        category: cleanCategory(category) || 'custom',
      }];
      settingsApi.update({ custom });
      return { ok: true, ...this.statusSnapshot() };
    },
    updateFact(id, { text, hidden, category } = {}) {
      const key = String(id || '').trim();
      if (!key) {
        return { ok: false, error: 'Missing fact id' };
      }
      const settings = settingsApi.get();
      const customIndex = settings.custom.findIndex((row) => row.id === key);
      const shipped = loadShipped().some((row) => row.id === key);

      if (customIndex >= 0) {
        const custom = [...settings.custom];
        if (hidden) {
          custom.splice(customIndex, 1);
        } else {
          const current = custom[customIndex];
          const nextText = text != null ? cleanText(text) : current.text;
          if (!nextText) {
            return { ok: false, error: 'Type an amazing fact' };
          }
          if (!fitsBoard(nextText)) {
            return { ok: false, error: 'That fact is too long for the Vestaboard' };
          }
          custom[customIndex] = {
            ...current,
            text: nextText,
            category: category != null
              ? (cleanCategory(category) || 'custom')
              : current.category,
          };
        }
        settingsApi.update({ custom });
        return { ok: true, ...this.statusSnapshot() };
      }

      if (!shipped) {
        return { ok: false, error: 'Unknown fact' };
      }

      const hiddenIds = new Set(settings.hiddenIds);
      const overrides = { ...settings.overrides };
      if (hidden === true) {
        hiddenIds.add(key);
      } else if (hidden === false) {
        hiddenIds.delete(key);
      }
      if (text != null) {
        const next = cleanText(text);
        if (!next) {
          return { ok: false, error: 'Type an amazing fact' };
        }
        if (!fitsBoard(next)) {
          return { ok: false, error: 'That fact is too long for the Vestaboard' };
        }
        const original = loadShipped().find((row) => row.id === key);
        if (original && cleanText(original.text) === next) {
          delete overrides[key];
        } else {
          overrides[key] = next;
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
      const fact = pickFact(settings, options);
      if (!fact) {
        return null;
      }
      settingsApi.remember(fact.id);
      return buildAmazingFactsPayload(fact, options);
    },
  };
}

module.exports = {
  TYPE,
  BODY_ROWS,
  BODY_WIDTH,
  loadShipped,
  shippedCategories,
  factRows,
  fitsBoard,
  resolveFacts,
  matchingFacts,
  pickFact,
  listFacts,
  buildAmazingFactsPayload,
  createAmazingFacts,
};
