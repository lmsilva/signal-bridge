/**
 * Daily Bucket Fillers — pick a shipped (or house-edited) kindness challenge.
 *
 * Corpus is local JSON. No network at runtime.
 */

const crypto = require('crypto');
const SHIPPED = require('./daily-bucket-fillers-fillers.json');
const { cleanText, createDailyBucketFillersSettings } = require('./daily-bucket-fillers-settings');
const { applyCorpusRemove } = require('./corpus-remove');
const { fillerLines, fitsBoard, BODY_ROWS } = require('./daily-bucket-fillers-layout');

const TYPE = 'bucket.fillers';

function loadShipped() {
  return Array.isArray(SHIPPED?.fillers) ? SHIPPED.fillers : [];
}

function fillerRowCount(text) {
  const parsed = fillerLines(text);
  return parsed?.lines?.length || 0;
}

function newCustomId() {
  return `custom-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

function resolveFillers(settings = {}, { computeRows = true } = {}) {
  const hidden = new Set(settings.hiddenIds || []);
  const removed = new Set(settings.removedIds || []);
  const overrides = settings.overrides || {};
  const rows = [];

  for (const filler of loadShipped()) {
    const id = String(filler.id || '').trim();
    if (!id || removed.has(id)) {
      continue;
    }
    const text = cleanText(overrides[id] != null ? overrides[id] : filler.text);
    const overridden = overrides[id] != null;
    rows.push({
      id,
      text,
      custom: false,
      hidden: hidden.has(id),
      rows: computeRows || overridden ? fillerRowCount(text) : (text ? 1 : 0),
    });
  }

  for (const filler of settings.custom || []) {
    const id = String(filler.id || '').trim();
    const text = cleanText(filler.text);
    if (!id || !text) {
      continue;
    }
    rows.push({
      id,
      text,
      custom: true,
      hidden: false,
      rows: computeRows ? fillerRowCount(text) : (fitsBoard(text) ? 1 : 0),
    });
  }

  return rows;
}

function matchingFillers(settings = {}) {
  return resolveFillers(settings, { computeRows: false })
    .filter((filler) => !filler.hidden && filler.text && filler.rows > 0);
}

function countAvailable(settings = {}) {
  return matchingFillers(settings).length;
}

function pickFiller(settings = {}, { random = Math.random } = {}) {
  const pool = matchingFillers(settings);
  if (!pool.length) {
    return null;
  }
  const recent = new Set(settings.recentIds || []);
  const fresh = pool.filter((filler) => !recent.has(filler.id));
  const choices = fresh.length ? fresh : pool;
  const index = Math.min(choices.length - 1, Math.floor(Number(random()) * choices.length));
  return choices[Math.max(0, index)] || null;
}

function buildDailyBucketFillersPayload(filler, { asOf } = {}) {
  const text = cleanText(filler?.text);
  if (!text || !fitsBoard(text)) {
    return null;
  }
  return {
    type: TYPE,
    asOf: asOf || new Date().toISOString(),
    filler: {
      id: filler.id || '',
      text,
    },
  };
}

function listFillers(settings = {}, { query = '', hidden = false, page = 1, pageSize = 20 } = {}) {
  const needle = String(query || '').trim().toLowerCase();
  let rows = resolveFillers(settings, { computeRows: false });
  if (!hidden) {
    rows = rows.filter((filler) => !filler.hidden);
  }
  if (needle) {
    rows = rows.filter((filler) => filler.text.toLowerCase().includes(needle)
      || filler.id.toLowerCase().includes(needle));
  }
  const size = Math.min(50, Math.max(5, Number(pageSize) || 20));
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(pages, Math.max(1, Number(page) || 1));
  const start = (current - 1) * size;
  const fillers = rows.slice(start, start + size).map((filler) => ({
    ...filler,
    rows: fillerRowCount(filler.text),
  }));
  return {
    query: needle,
    page: current,
    pageSize: size,
    pages,
    total,
    fillers,
  };
}

function createDailyBucketFillers(config, log) {
  const settingsApi = createDailyBucketFillersSettings(config, log);

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
        return snapshot(listFillers(settings, query));
      }
      return snapshot();
    },
    addFiller(text) {
      const next = cleanText(text);
      if (!next) {
        return { ok: false, error: 'Type a bucket filler' };
      }
      if (!fitsBoard(next)) {
        return { ok: false, error: 'That challenge is too long for the board' };
      }
      const settings = settingsApi.get();
      const custom = [...settings.custom, { id: newCustomId(), text: next }];
      settingsApi.update({ custom });
      return { ok: true, ...this.statusSnapshot() };
    },
    updateFiller(id, { text, hidden, remove } = {}) {
      const key = String(id || '').trim();
      if (!key) {
        return { ok: false, error: 'Missing filler id' };
      }
      const settings = settingsApi.get();
      const customIndex = settings.custom.findIndex((row) => row.id === key);
      const shipped = loadShipped().some((row) => row.id === key);
      if (remove) {
        const result = applyCorpusRemove(settings, key, { isShipped: shipped });
        if (!result.ok) {
          return { ok: false, error: 'Unknown filler' };
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
            return { ok: false, error: 'Type a bucket filler' };
          }
          if (!fitsBoard(next)) {
            return { ok: false, error: 'That challenge is too long for the board' };
          }
          custom[customIndex] = { ...custom[customIndex], text: next };
        }
        settingsApi.update({ custom });
        return { ok: true, ...this.statusSnapshot() };
      }

      if (!shipped) {
        return { ok: false, error: 'Unknown filler' };
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
          return { ok: false, error: 'Type a bucket filler' };
        }
        if (!fitsBoard(next)) {
          return { ok: false, error: 'That challenge is too long for the board' };
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
      const filler = pickFiller(settings, options);
      if (!filler) {
        return null;
      }
      settingsApi.remember(filler.id);
      return buildDailyBucketFillersPayload(filler, options);
    },
  };
}

module.exports = {
  TYPE,
  BODY_ROWS,
  loadShipped,
  fillerRowCount,
  fitsBoard,
  resolveFillers,
  matchingFillers,
  pickFiller,
  listFillers,
  buildDailyBucketFillersPayload,
  createDailyBucketFillers,
};
