/**
 * Family Quotes — pick a shipped (or house-edited) quote for the board.
 *
 * Corpus is local JSON. No network at runtime. The layout rules live in
 * `family-quotes-layout.js` so the build tool can measure candidates.
 */

const crypto = require('crypto');
const SHIPPED = require('./family-quotes-quotes.json');
const { cleanText, cleanAuthor, createFamilyQuotesSettings } = require('./family-quotes-settings');
const { applyCorpusRemove } = require('./corpus-remove');
const { BODY_ROWS, BODY_WIDTH, sentences, quoteLines } = require('./family-quotes-layout');

const TYPE = 'family.quotes';

function loadShipped() {
  return Array.isArray(SHIPPED?.quotes) ? SHIPPED.quotes : [];
}

function fitsBoard(text, author) {
  const lines = quoteLines(text, author);
  return lines.length > 0 && lines.length <= BODY_ROWS * 2;
}

function newCustomId() {
  return `custom-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

function resolveQuotes(settings = {}, { computeRows = true } = {}) {
  const hidden = new Set(settings.hiddenIds || []);
  const removed = new Set(settings.removedIds || []);
  const overrides = settings.overrides || {};
  const rows = [];

  for (const quote of loadShipped()) {
    const id = String(quote.id || '').trim();
    if (!id || removed.has(id)) {
      continue;
    }
    const patch = overrides[id];
    const text = cleanText(patch?.text != null ? patch.text : quote.text);
    const author = cleanAuthor(patch?.author != null ? patch.author : quote.author);
    rows.push({
      id,
      text,
      author,
      custom: false,
      hidden: hidden.has(id),
      // Laying out the whole corpus on every list and every pick is too slow,
      // so a shipped quote is assumed to fit until someone edits it.
      rows: computeRows || patch ? quoteLines(text, author).length : (text ? 1 : 0),
    });
  }

  for (const quote of settings.custom || []) {
    const id = String(quote.id || '').trim();
    const text = cleanText(quote.text);
    if (!id || !text) {
      continue;
    }
    const author = cleanAuthor(quote.author);
    rows.push({
      id,
      text,
      author,
      custom: true,
      hidden: false,
      rows: computeRows ? quoteLines(text, author).length : (fitsBoard(text, author) ? 1 : 0),
    });
  }

  return rows;
}

function matchingQuotes(settings = {}) {
  return resolveQuotes(settings, { computeRows: false })
    .filter((quote) => !quote.hidden && quote.text && quote.rows > 0);
}

function countAvailable(settings = {}) {
  return matchingQuotes(settings).length;
}

function pickQuote(settings = {}, { random = Math.random } = {}) {
  const pool = matchingQuotes(settings);
  if (!pool.length) {
    return null;
  }
  const recent = new Set(settings.recentIds || []);
  const fresh = pool.filter((quote) => !recent.has(quote.id));
  const choices = fresh.length ? fresh : pool;
  const index = Math.min(choices.length - 1, Math.floor(Number(random()) * choices.length));
  return choices[Math.max(0, index)] || null;
}

function buildFamilyQuotesPayload(quote, { asOf } = {}) {
  const text = cleanText(quote?.text);
  if (!text) {
    return null;
  }
  return {
    type: TYPE,
    asOf: asOf || new Date().toISOString(),
    quote: {
      id: quote.id || '',
      text,
      author: cleanAuthor(quote?.author),
    },
  };
}

function listQuotes(settings = {}, { query = '', hidden = false, page = 1, pageSize = 20 } = {}) {
  const needle = String(query || '').trim().toLowerCase();
  let rows = resolveQuotes(settings, { computeRows: false });
  if (!hidden) {
    rows = rows.filter((quote) => !quote.hidden);
  }
  if (needle) {
    rows = rows.filter((quote) => quote.text.toLowerCase().includes(needle)
      || quote.author.toLowerCase().includes(needle)
      || quote.id.toLowerCase().includes(needle));
  }
  const size = Math.min(50, Math.max(5, Number(pageSize) || 20));
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(pages, Math.max(1, Number(page) || 1));
  const start = (current - 1) * size;
  const quotes = rows.slice(start, start + size).map((quote) => ({
    ...quote,
    rows: quoteLines(quote.text, quote.author).length,
  }));
  return {
    query: needle,
    page: current,
    pageSize: size,
    pages,
    total,
    quotes,
  };
}

function createFamilyQuotes(config, log) {
  const settingsApi = createFamilyQuotesSettings(config, log);

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
        return snapshot(listQuotes(settings, query));
      }
      return snapshot();
    },
    addQuote(text, author) {
      const next = cleanText(text);
      if (!next) {
        return { ok: false, error: 'Type a quote' };
      }
      const settings = settingsApi.get();
      const custom = [...settings.custom, {
        id: newCustomId(),
        text: next,
        author: cleanAuthor(author),
      }];
      settingsApi.update({ custom });
      return { ok: true, ...this.statusSnapshot() };
    },
    updateQuote(id, { text, author, hidden, remove } = {}) {
      const key = String(id || '').trim();
      if (!key) {
        return { ok: false, error: 'Missing quote id' };
      }
      const settings = settingsApi.get();
      const customIndex = settings.custom.findIndex((row) => row.id === key);
      const shipped = loadShipped().some((row) => row.id === key);
      if (remove) {
        const result = applyCorpusRemove(settings, key, { isShipped: shipped });
        if (!result.ok) {
          return { ok: false, error: 'Unknown quote' };
        }
        settingsApi.update(result.patch);
        return { ok: true, ...this.statusSnapshot() };
      }

      if (customIndex >= 0) {
        const custom = [...settings.custom];
        if (hidden) {
          custom.splice(customIndex, 1);
        } else {
          const row = { ...custom[customIndex] };
          if (text != null) {
            const next = cleanText(text);
            if (!next) {
              return { ok: false, error: 'Type a quote' };
            }
            row.text = next;
          }
          if (author != null) {
            row.author = cleanAuthor(author);
          }
          custom[customIndex] = row;
        }
        settingsApi.update({ custom });
        return { ok: true, ...this.statusSnapshot() };
      }

      if (!shipped) {
        return { ok: false, error: 'Unknown quote' };
      }

      const hiddenIds = new Set(settings.hiddenIds);
      const overrides = { ...settings.overrides };
      if (hidden === true) {
        hiddenIds.add(key);
      } else if (hidden === false) {
        hiddenIds.delete(key);
      }
      if (text != null || author != null) {
        const original = loadShipped().find((row) => row.id === key) || {};
        const patch = { ...overrides[key] };
        if (text != null) {
          const next = cleanText(text);
          if (!next) {
            return { ok: false, error: 'Type a quote' };
          }
          patch.text = next;
        }
        if (author != null) {
          patch.author = cleanAuthor(author);
        }
        // Typing a shipped quote back to what it was is not an edit worth keeping.
        if (patch.text != null && cleanText(original.text) === patch.text) {
          delete patch.text;
        }
        if (patch.author != null && cleanAuthor(original.author) === patch.author) {
          delete patch.author;
        }
        if (Object.keys(patch).length) {
          overrides[key] = patch;
        } else {
          delete overrides[key];
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
      const quote = pickQuote(settings, options);
      if (!quote) {
        return null;
      }
      settingsApi.remember(quote.id);
      return buildFamilyQuotesPayload(quote, options);
    },
  };
}

module.exports = {
  TYPE,
  BODY_ROWS,
  BODY_WIDTH,
  loadShipped,
  sentences,
  quoteLines,
  fitsBoard,
  resolveQuotes,
  matchingQuotes,
  countAvailable,
  pickQuote,
  listQuotes,
  buildFamilyQuotesPayload,
  createFamilyQuotes,
};
