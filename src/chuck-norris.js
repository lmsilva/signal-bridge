/**
 * Chuck Norris Fun Facts — pick a shipped (or house-edited) joke for the board.
 *
 * Corpus is local JSON from chucknorris.io. No network at runtime.
 */

const crypto = require('crypto');
const SHIPPED = require('./chuck-norris-facts.json');
const { cleanText, createChuckNorrisSettings } = require('./chuck-norris-settings');
const { applyCorpusRemove } = require('./corpus-remove');
const { fold, wrap } = require('./vestaboard/encoder');

const TYPE = 'chuck.facts';
const BODY_ROWS = 5;
const BODY_WIDTH = 22;

function loadShipped() {
  return Array.isArray(SHIPPED?.facts) ? SHIPPED.facts : [];
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

function resolveFacts(settings = {}, { computeRows = true } = {}) {
  const hidden = new Set(settings.hiddenIds || []);
  const removed = new Set(settings.removedIds || []);
  const overrides = settings.overrides || {};
  const rows = [];

  for (const fact of loadShipped()) {
    const id = String(fact.id || '').trim();
    if (!id || removed.has(id)) {
      continue;
    }
    const text = cleanText(overrides[id] != null ? overrides[id] : fact.text);
    const overridden = overrides[id] != null;
    rows.push({
      id,
      text,
      custom: false,
      hidden: hidden.has(id),
      rows: computeRows || overridden ? factRows(text).length : (text ? 1 : 0),
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
      custom: true,
      hidden: false,
      rows: computeRows ? factRows(text).length : (fitsBoard(text) ? 1 : 0),
    });
  }

  return rows;
}

function matchingFacts(settings = {}) {
  return resolveFacts(settings, { computeRows: false })
    .filter((fact) => !fact.hidden && fact.text && fact.rows > 0);
}

function countAvailable(settings = {}) {
  return matchingFacts(settings).length;
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

function buildChuckNorrisPayload(fact, { asOf } = {}) {
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
    },
  };
}

function listFacts(settings = {}, { query = '', hidden = false, page = 1, pageSize = 20 } = {}) {
  const needle = String(query || '').trim().toLowerCase();
  let rows = resolveFacts(settings, { computeRows: false });
  if (!hidden) {
    rows = rows.filter((fact) => !fact.hidden);
  }
  if (needle) {
    rows = rows.filter((fact) => fact.text.toLowerCase().includes(needle)
      || fact.id.toLowerCase().includes(needle));
  }
  const size = Math.min(50, Math.max(5, Number(pageSize) || 20));
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(pages, Math.max(1, Number(page) || 1));
  const start = (current - 1) * size;
  const facts = rows.slice(start, start + size).map((fact) => ({
    ...fact,
    rows: factRows(fact.text).length,
  }));
  return {
    query: needle,
    page: current,
    pageSize: size,
    pages,
    total,
    facts,
  };
}

function createChuckNorris(config, log) {
  const settingsApi = createChuckNorrisSettings(config, log);

  function snapshot(extra = {}) {
    const settings = settingsApi.get();
    return {
      available: countAvailable(settings),
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
      if (query && (query.page != null || query.pageSize != null || query.query
        || query.q || query.hidden)) {
        return snapshot(listFacts(settings, query));
      }
      return snapshot();
    },
    addFact(text) {
      const next = cleanText(text);
      if (!next) {
        return { ok: false, error: 'Type a Chuck Norris fact' };
      }
      const settings = settingsApi.get();
      const custom = [...settings.custom, { id: newCustomId(), text: next }];
      settingsApi.update({ custom });
      return { ok: true, ...this.statusSnapshot() };
    },
    updateFact(id, { text, hidden, remove } = {}) {
      const key = String(id || '').trim();
      if (!key) {
        return { ok: false, error: 'Missing fact id' };
      }
      const settings = settingsApi.get();
      const customIndex = settings.custom.findIndex((row) => row.id === key);
      const shipped = loadShipped().some((row) => row.id === key);
      if (remove) {
        const result = applyCorpusRemove(settings, key, { isShipped: shipped });
        if (!result.ok) {
          return { ok: false, error: 'Unknown fact' };
        }
        settingsApi.update(result.patch);
        return { ok: true, ...this.statusSnapshot() };
      }

      if (customIndex >= 0) {
        const custom = [...settings.custom];
        if (hidden) {
          custom.splice(customIndex, 1);
        } else if (text != null) {
          const next = cleanText(text);
          if (!next) {
            return { ok: false, error: 'Type a Chuck Norris fact' };
          }
          custom[customIndex] = { ...custom[customIndex], text: next };
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
          return { ok: false, error: 'Type a Chuck Norris fact' };
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
      return buildChuckNorrisPayload(fact, options);
    },
  };
}

module.exports = {
  TYPE,
  BODY_ROWS,
  BODY_WIDTH,
  loadShipped,
  factRows,
  fitsBoard,
  resolveFacts,
  matchingFacts,
  pickFact,
  listFacts,
  buildChuckNorrisPayload,
  createChuckNorris,
};
