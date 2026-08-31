/**
 * Roast Me! — pick a shipped (or house-edited) roast for the board.
 *
 * Corpus is local JSON. No network at runtime.
 *
 * Unlike the other joke cards there is no title row and no chips: the
 * marketplace channel gives the punchline the whole board, left-aligned with
 * the block centred vertically. That buys a sixth row, and a roast that fills
 * the flaps lands harder than one wearing a header.
 */

const crypto = require('crypto');
const SHIPPED = require('./roast-me-roasts.json');
const { cleanText, createRoastMeSettings } = require('./roast-me-settings');
const { applyCorpusRemove } = require('./corpus-remove');
const { fold, wrap } = require('./vestaboard/encoder');

const TYPE = 'roast.me';
const BODY_ROWS = 6;
const BODY_WIDTH = 22;

function loadShipped() {
  return Array.isArray(SHIPPED?.roasts) ? SHIPPED.roasts : [];
}

/**
 * The roast as board rows.
 *
 * `orphans: false` keeps the greedy fill the channel uses — a two-letter word
 * left hanging costs one flap, whereas pushing it down can cost a whole row.
 */
function roastRows(text) {
  const folded = fold(cleanText(text));
  if (!folded) {
    return [];
  }
  return wrap(folded, BODY_WIDTH, { orphans: false });
}

function fitsBoard(text) {
  const lines = roastRows(text);
  return lines.length > 0 && lines.length <= BODY_ROWS * 2;
}

function newCustomId() {
  return `custom-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

function resolveRoasts(settings = {}, { computeRows = true } = {}) {
  const hidden = new Set(settings.hiddenIds || []);
  const removed = new Set(settings.removedIds || []);
  const overrides = settings.overrides || {};
  const rows = [];

  for (const roast of loadShipped()) {
    const id = String(roast.id || '').trim();
    if (!id || removed.has(id)) {
      continue;
    }
    const text = cleanText(overrides[id] != null ? overrides[id] : roast.text);
    const overridden = overrides[id] != null;
    rows.push({
      id,
      text,
      custom: false,
      hidden: hidden.has(id),
      // Wrapping the whole corpus on every list and every pick is too slow, so
      // a shipped roast is assumed to fit until someone edits it.
      rows: computeRows || overridden ? roastRows(text).length : (text ? 1 : 0),
    });
  }

  for (const roast of settings.custom || []) {
    const id = String(roast.id || '').trim();
    const text = cleanText(roast.text);
    if (!id || !text) {
      continue;
    }
    rows.push({
      id,
      text,
      custom: true,
      hidden: false,
      rows: computeRows ? roastRows(text).length : (fitsBoard(text) ? 1 : 0),
    });
  }

  return rows;
}

function matchingRoasts(settings = {}) {
  return resolveRoasts(settings, { computeRows: false })
    .filter((roast) => !roast.hidden && roast.text && roast.rows > 0);
}

function countAvailable(settings = {}) {
  return matchingRoasts(settings).length;
}

function pickRoast(settings = {}, { random = Math.random } = {}) {
  const pool = matchingRoasts(settings);
  if (!pool.length) {
    return null;
  }
  const recent = new Set(settings.recentIds || []);
  const fresh = pool.filter((roast) => !recent.has(roast.id));
  const choices = fresh.length ? fresh : pool;
  const index = Math.min(choices.length - 1, Math.floor(Number(random()) * choices.length));
  return choices[Math.max(0, index)] || null;
}

function buildRoastMePayload(roast, { asOf } = {}) {
  const text = cleanText(roast?.text);
  if (!text) {
    return null;
  }
  return {
    type: TYPE,
    asOf: asOf || new Date().toISOString(),
    roast: {
      id: roast.id || '',
      text,
    },
  };
}

function listRoasts(settings = {}, { query = '', hidden = false, page = 1, pageSize = 20 } = {}) {
  const needle = String(query || '').trim().toLowerCase();
  let rows = resolveRoasts(settings, { computeRows: false });
  if (!hidden) {
    rows = rows.filter((roast) => !roast.hidden);
  }
  if (needle) {
    rows = rows.filter((roast) => roast.text.toLowerCase().includes(needle)
      || roast.id.toLowerCase().includes(needle));
  }
  const size = Math.min(50, Math.max(5, Number(pageSize) || 20));
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(pages, Math.max(1, Number(page) || 1));
  const start = (current - 1) * size;
  const roasts = rows.slice(start, start + size).map((roast) => ({
    ...roast,
    rows: roastRows(roast.text).length,
  }));
  return {
    query: needle,
    page: current,
    pageSize: size,
    pages,
    total,
    roasts,
  };
}

function createRoastMe(config, log) {
  const settingsApi = createRoastMeSettings(config, log);

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
        return snapshot(listRoasts(settings, query));
      }
      return snapshot();
    },
    addRoast(text) {
      const next = cleanText(text);
      if (!next) {
        return { ok: false, error: 'Type a roast' };
      }
      const settings = settingsApi.get();
      const custom = [...settings.custom, { id: newCustomId(), text: next }];
      settingsApi.update({ custom });
      return { ok: true, ...this.statusSnapshot() };
    },
    updateRoast(id, { text, hidden, remove } = {}) {
      const key = String(id || '').trim();
      if (!key) {
        return { ok: false, error: 'Missing roast id' };
      }
      const settings = settingsApi.get();
      const customIndex = settings.custom.findIndex((row) => row.id === key);
      const shipped = loadShipped().some((row) => row.id === key);
      if (remove) {
        const result = applyCorpusRemove(settings, key, { isShipped: shipped });
        if (!result.ok) {
          return { ok: false, error: 'Unknown roast' };
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
            return { ok: false, error: 'Type a roast' };
          }
          custom[customIndex] = { ...custom[customIndex], text: next };
        }
        settingsApi.update({ custom });
        return { ok: true, ...this.statusSnapshot() };
      }

      if (!shipped) {
        return { ok: false, error: 'Unknown roast' };
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
          return { ok: false, error: 'Type a roast' };
        }
        const original = loadShipped().find((row) => row.id === key);
        // Typing a shipped roast back to what it was is not an edit worth keeping.
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
      const roast = pickRoast(settings, options);
      if (!roast) {
        return null;
      }
      settingsApi.remember(roast.id);
      return buildRoastMePayload(roast, options);
    },
  };
}

module.exports = {
  TYPE,
  BODY_ROWS,
  BODY_WIDTH,
  loadShipped,
  roastRows,
  fitsBoard,
  resolveRoasts,
  matchingRoasts,
  countAvailable,
  pickRoast,
  listRoasts,
  buildRoastMePayload,
  createRoastMe,
};
