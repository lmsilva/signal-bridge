/**
 * Warm Fuzzies — pick a shipped (or house-edited) compliment for the board.
 *
 * Corpus is local JSON. No network at runtime.
 */

const crypto = require('crypto');
const SHIPPED = require('./warm-fuzzies-fuzzies.json');
const { cleanText, createWarmFuzziesSettings } = require('./warm-fuzzies-settings');
const { applyCorpusRemove } = require('./corpus-remove');
const { fuzzyLines, fitsBoard, BODY_ROWS } = require('./warm-fuzzies-layout');

const TYPE = 'warm.fuzzies';

function loadShipped() {
  return Array.isArray(SHIPPED?.fuzzies) ? SHIPPED.fuzzies : [];
}

function fuzzyRowCount(text) {
  const parsed = fuzzyLines(text);
  return parsed?.lines?.length || 0;
}

function newCustomId() {
  return `custom-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

function resolveFuzzies(settings = {}, { computeRows = true } = {}) {
  const hidden = new Set(settings.hiddenIds || []);
  const removed = new Set(settings.removedIds || []);
  const overrides = settings.overrides || {};
  const rows = [];

  for (const fuzzy of loadShipped()) {
    const id = String(fuzzy.id || '').trim();
    if (!id || removed.has(id)) {
      continue;
    }
    const text = cleanText(overrides[id] != null ? overrides[id] : fuzzy.text);
    const overridden = overrides[id] != null;
    rows.push({
      id,
      text,
      custom: false,
      hidden: hidden.has(id),
      rows: computeRows || overridden ? fuzzyRowCount(text) : (text ? 1 : 0),
    });
  }

  for (const fuzzy of settings.custom || []) {
    const id = String(fuzzy.id || '').trim();
    const text = cleanText(fuzzy.text);
    if (!id || !text) {
      continue;
    }
    rows.push({
      id,
      text,
      custom: true,
      hidden: false,
      rows: computeRows ? fuzzyRowCount(text) : (fitsBoard(text) ? 1 : 0),
    });
  }

  return rows;
}

function matchingFuzzies(settings = {}) {
  return resolveFuzzies(settings, { computeRows: false })
    .filter((fuzzy) => !fuzzy.hidden && fuzzy.text && fuzzy.rows > 0);
}

function countAvailable(settings = {}) {
  return matchingFuzzies(settings).length;
}

function pickFuzzy(settings = {}, { random = Math.random } = {}) {
  const pool = matchingFuzzies(settings);
  if (!pool.length) {
    return null;
  }
  const recent = new Set(settings.recentIds || []);
  const fresh = pool.filter((fuzzy) => !recent.has(fuzzy.id));
  const choices = fresh.length ? fresh : pool;
  const index = Math.min(choices.length - 1, Math.floor(Number(random()) * choices.length));
  return choices[Math.max(0, index)] || null;
}

function buildWarmFuzziesPayload(fuzzy, { asOf } = {}) {
  const text = cleanText(fuzzy?.text);
  if (!text || !fitsBoard(text)) {
    return null;
  }
  return {
    type: TYPE,
    asOf: asOf || new Date().toISOString(),
    fuzzy: {
      id: fuzzy.id || '',
      text,
    },
  };
}

function listFuzzies(settings = {}, { query = '', hidden = false, page = 1, pageSize = 20 } = {}) {
  const needle = String(query || '').trim().toLowerCase();
  let rows = resolveFuzzies(settings, { computeRows: false });
  if (!hidden) {
    rows = rows.filter((fuzzy) => !fuzzy.hidden);
  }
  if (needle) {
    rows = rows.filter((fuzzy) => fuzzy.text.toLowerCase().includes(needle)
      || fuzzy.id.toLowerCase().includes(needle));
  }
  const size = Math.min(50, Math.max(5, Number(pageSize) || 20));
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(pages, Math.max(1, Number(page) || 1));
  const start = (current - 1) * size;
  const fuzzies = rows.slice(start, start + size).map((fuzzy) => ({
    ...fuzzy,
    rows: fuzzyRowCount(fuzzy.text),
  }));
  return {
    query: needle,
    page: current,
    pageSize: size,
    pages,
    total,
    fuzzies,
  };
}

function createWarmFuzzies(config, log) {
  const settingsApi = createWarmFuzziesSettings(config, log);

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
        return snapshot(listFuzzies(settings, query));
      }
      return snapshot();
    },
    addFuzzy(text) {
      const next = cleanText(text);
      if (!next) {
        return { ok: false, error: 'Type a warm fuzzy' };
      }
      if (!fitsBoard(next)) {
        return { ok: false, error: 'That message is too long for the board' };
      }
      const settings = settingsApi.get();
      const custom = [...settings.custom, { id: newCustomId(), text: next }];
      settingsApi.update({ custom });
      return { ok: true, ...this.statusSnapshot() };
    },
    updateFuzzy(id, { text, hidden, remove } = {}) {
      const key = String(id || '').trim();
      if (!key) {
        return { ok: false, error: 'Missing fuzzy id' };
      }
      const settings = settingsApi.get();
      const customIndex = settings.custom.findIndex((row) => row.id === key);
      const shipped = loadShipped().some((row) => row.id === key);
      if (remove) {
        const result = applyCorpusRemove(settings, key, { isShipped: shipped });
        if (!result.ok) {
          return { ok: false, error: 'Unknown fuzzy' };
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
            return { ok: false, error: 'Type a warm fuzzy' };
          }
          if (!fitsBoard(next)) {
            return { ok: false, error: 'That message is too long for the board' };
          }
          custom[customIndex] = { ...custom[customIndex], text: next };
        }
        settingsApi.update({ custom });
        return { ok: true, ...this.statusSnapshot() };
      }

      if (!shipped) {
        return { ok: false, error: 'Unknown fuzzy' };
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
          return { ok: false, error: 'Type a warm fuzzy' };
        }
        if (!fitsBoard(next)) {
          return { ok: false, error: 'That message is too long for the board' };
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
      const fuzzy = pickFuzzy(settings, options);
      if (!fuzzy) {
        return null;
      }
      settingsApi.remember(fuzzy.id);
      return buildWarmFuzziesPayload(fuzzy, options);
    },
  };
}

module.exports = {
  TYPE,
  BODY_ROWS,
  loadShipped,
  fuzzyRowCount,
  fitsBoard,
  resolveFuzzies,
  matchingFuzzies,
  pickFuzzy,
  listFuzzies,
  buildWarmFuzziesPayload,
  createWarmFuzzies,
};
