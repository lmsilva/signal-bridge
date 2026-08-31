/**
 * Periodic Table — pick an element for the board.
 *
 * All 118 elements ship in local JSON. No network at runtime.
 */

const SHIPPED = require('./periodic-table-elements.json');
const { createPeriodicTableSettings } = require('./periodic-table-settings');
const { elementLines, fitsBoard } = require('./periodic-table-layout');

const TYPE = 'periodic.table';

function loadShipped() {
  return Array.isArray(SHIPPED?.elements) ? SHIPPED.elements : [];
}

function loadCategories() {
  if (Array.isArray(SHIPPED?.categories) && SHIPPED.categories.length) {
    return SHIPPED.categories.map((row) => ({
      id: String(row.id || '').trim(),
      label: String(row.label || '').trim(),
      count: Number(row.count) || 0,
    })).filter((row) => row.id);
  }
  const counts = new Map();
  for (const element of loadShipped()) {
    counts.set(element.category, (counts.get(element.category) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([id, count]) => ({ id, label: id, count }));
}

function resolveElements(settings = {}) {
  const allowed = new Set((settings.categories || []).map((value) => String(value).trim()).filter(Boolean));
  return loadShipped().filter((element) => {
    if (allowed.size && !allowed.has(element.category)) {
      return false;
    }
    return fitsBoard(element);
  });
}

function countAvailable(settings = {}) {
  return resolveElements(settings).length;
}

function findElement({ id, number, symbol } = {}) {
  const key = String(id || symbol || '').trim().toLowerCase();
  const atomic = Number(number);
  return loadShipped().find((element) => {
    if (key && element.id === key) {
      return true;
    }
    if (Number.isFinite(atomic) && element.number === atomic) {
      return true;
    }
    return false;
  }) || null;
}

function pickElement(settings = {}, { random = Math.random, id, number, symbol } = {}) {
  const chosen = findElement({ id, number, symbol });
  if (chosen && resolveElements(settings).some((row) => row.id === chosen.id)) {
    return chosen;
  }
  const pool = resolveElements(settings);
  if (!pool.length) {
    return null;
  }
  const recent = new Set(settings.recentIds || []);
  const fresh = pool.filter((element) => !recent.has(element.id));
  const choices = fresh.length ? fresh : pool;
  const index = Math.min(choices.length - 1, Math.floor(Number(random()) * choices.length));
  return choices[Math.max(0, index)] || null;
}

function buildPeriodicTablePayload(element, { asOf } = {}) {
  if (!element || !fitsBoard(element)) {
    return null;
  }
  return {
    type: TYPE,
    asOf: asOf || new Date().toISOString(),
    element: {
      id: element.id,
      number: element.number,
      name: element.name,
      symbol: element.symbol,
      category: element.category,
      categoryLabel: element.categoryLabel,
      weight: element.weight,
      lines: elementLines(element),
    },
  };
}

function createPeriodicTable(config, log) {
  const settingsApi = createPeriodicTableSettings(config, log);

  function snapshot(extra = {}) {
    const settings = settingsApi.get();
    const elements = loadShipped().map((element) => ({
      id: element.id,
      number: element.number,
      name: element.name,
      symbol: element.symbol,
      category: element.category,
      categoryLabel: element.categoryLabel,
      weight: element.weight,
      lines: elementLines(element),
    }));
    return {
      available: countAvailable(settings),
      total: elements.length,
      categories: loadCategories(),
      settings,
      elements,
      ...extra,
    };
  }

  return {
    getSettings: () => settingsApi.get(),
    statusSnapshot(extra = {}) {
      return snapshot(extra);
    },
    updateSettings(patch = {}) {
      settingsApi.update(patch);
      return snapshot();
    },
    nextPayload(options = {}) {
      const settings = settingsApi.get();
      const element = pickElement(settings, options);
      if (!element) {
        return null;
      }
      settingsApi.remember(element.id);
      return buildPeriodicTablePayload(element, options);
    },
  };
}

module.exports = {
  TYPE,
  loadShipped,
  loadCategories,
  resolveElements,
  countAvailable,
  findElement,
  pickElement,
  buildPeriodicTablePayload,
  createPeriodicTable,
};
