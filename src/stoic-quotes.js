/**
 * Stoic Quotes — pick a shipped (or house-edited) quote for the board.
 *
 * Corpus is local JSON from open Stoic dumps. No network at runtime.
 */

const crypto = require('crypto');
const SHIPPED = require('./stoic-quotes-quotes.json');
const {
  cleanText,
  cleanAuthor,
  createStoicQuotesSettings,
} = require('./stoic-quotes-settings');
const { fold, wrap, encodeText, COLS } = require('./vestaboard/encoder');

const TYPE = 'stoic.quotes';
const QUOTE_ROWS = 4;
const BODY_WIDTH = 22;

function loadShipped() {
  return Array.isArray(SHIPPED?.quotes) ? SHIPPED.quotes : [];
}

function quoteRows(text) {
  const folded = fold(cleanText(text));
  if (!folded) {
    return [];
  }
  return wrap(folded, BODY_WIDTH);
}

function authorLabel(author) {
  const name = fold(cleanAuthor(author));
  if (!name) {
    return '';
  }
  const withDash = `- ${name}`;
  return encodeText(withDash).length <= COLS ? withDash : name.slice(0, COLS);
}

function fitsBoard(text, author) {
  const lines = quoteRows(text);
  return lines.length > 0
    && lines.length <= QUOTE_ROWS
    && Boolean(authorLabel(author));
}

function newCustomId() {
  return `custom-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

function resolveQuotes(settings = {}) {
  const hidden = new Set(settings.hiddenIds || []);
  const overrides = settings.overrides || {};
  const rows = [];

  for (const quote of loadShipped()) {
    const id = String(quote.id || '').trim();
    if (!id) {
      continue;
    }
    const patch = overrides[id] || {};
    const text = cleanText(patch.text != null ? patch.text : quote.text);
    const author = cleanAuthor(patch.author != null ? patch.author : quote.author);
    rows.push({
      id,
      text,
      author,
      custom: false,
      hidden: hidden.has(id),
      rows: quoteRows(text).length,
      source: quote.source || 'shipped',
    });
  }

  for (const quote of settings.custom || []) {
    const id = String(quote.id || '').trim();
    const text = cleanText(quote.text);
    const author = cleanAuthor(quote.author) || 'Unknown';
    if (!id || !text) {
      continue;
    }
    rows.push({
      id,
      text,
      author,
      custom: true,
      hidden: false,
      rows: quoteRows(text).length,
      source: 'custom',
    });
  }

  return rows;
}

function matchingQuotes(settings = {}) {
  return resolveQuotes(settings).filter((quote) => (
    !quote.hidden && quote.text && quote.author && quote.rows > 0 && quote.rows <= QUOTE_ROWS
  ));
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

function buildStoicQuotesPayload(quote, { asOf } = {}) {
  const text = cleanText(quote?.text);
  const author = cleanAuthor(quote?.author);
  if (!text || !author) {
    return null;
  }
  return {
    type: TYPE,
    asOf: asOf || new Date().toISOString(),
    quote: {
      id: quote.id || '',
      text,
      author,
    },
  };
}

function listQuotes(settings = {}, { query = '', hidden = false, page = 1, pageSize = 20 } = {}) {
  const needle = String(query || '').trim().toLowerCase();
  let rows = resolveQuotes(settings);
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
  return {
    query: needle,
    page: current,
    pageSize: size,
    pages,
    total,
    quotes: rows.slice(start, start + size),
  };
}

function createStoicQuotes(config, log) {
  const settingsApi = createStoicQuotesSettings(config, log);

  function snapshot(extra = {}) {
    const settings = settingsApi.get();
    const all = resolveQuotes(settings);
    return {
      available: all.filter((quote) => (
        !quote.hidden && quote.text && quote.author && quote.rows > 0 && quote.rows <= QUOTE_ROWS
      )).length,
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
      return snapshot(listQuotes(settings, query));
    },
    addQuote(text, author) {
      const next = cleanText(text);
      const who = cleanAuthor(author) || 'Unknown';
      if (!next) {
        return { ok: false, error: 'Type a Stoic quote' };
      }
      const settings = settingsApi.get();
      const custom = [...settings.custom, { id: newCustomId(), text: next, author: who }];
      settingsApi.update({ custom });
      return { ok: true, ...this.statusSnapshot() };
    },
    updateQuote(id, { text, author, hidden } = {}) {
      const key = String(id || '').trim();
      if (!key) {
        return { ok: false, error: 'Missing quote id' };
      }
      const settings = settingsApi.get();
      const customIndex = settings.custom.findIndex((row) => row.id === key);
      const shipped = loadShipped().some((row) => row.id === key);

      if (customIndex >= 0) {
        const custom = [...settings.custom];
        if (hidden) {
          custom.splice(customIndex, 1);
        } else {
          const nextText = text != null ? cleanText(text) : custom[customIndex].text;
          const nextAuthor = author != null ? cleanAuthor(author) : custom[customIndex].author;
          if (!nextText) {
            return { ok: false, error: 'Type a Stoic quote' };
          }
          custom[customIndex] = {
            ...custom[customIndex],
            text: nextText,
            author: nextAuthor || 'Unknown',
          };
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
        const original = loadShipped().find((row) => row.id === key);
        const nextText = text != null ? cleanText(text) : cleanText(original?.text);
        const nextAuthor = author != null ? cleanAuthor(author) : cleanAuthor(original?.author);
        if (!nextText) {
          return { ok: false, error: 'Type a Stoic quote' };
        }
        if (original
          && cleanText(original.text) === nextText
          && cleanAuthor(original.author) === nextAuthor) {
          delete overrides[key];
        } else {
          overrides[key] = { text: nextText, author: nextAuthor || 'Unknown' };
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
      return buildStoicQuotesPayload(quote, options);
    },
  };
}

module.exports = {
  TYPE,
  QUOTE_ROWS,
  BODY_WIDTH,
  loadShipped,
  quoteRows,
  authorLabel,
  fitsBoard,
  resolveQuotes,
  matchingQuotes,
  pickQuote,
  listQuotes,
  buildStoicQuotesPayload,
  createStoicQuotes,
};
