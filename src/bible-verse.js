/**
 * Bible Verse Of The Day - pick a shipped (or house-edited) verse for the board.
 *
 * Corpus is local KJV JSON. No network at runtime.
 */

const crypto = require('crypto');
const SHIPPED = require('./bible-verse-verses.json');
const {
  cleanText,
  cleanReference,
  createBibleVerseSettings,
} = require('./bible-verse-settings');
const {
  BODY_SLOTS,
  MAX_PAGES,
  verseLines,
  verseLineCount,
  fitsBoard,
} = require('./bible-verse-layout');
const { applyCorpusRemove } = require('./corpus-remove');

const TYPE = 'bible.verse';

function loadShipped() {
  return Array.isArray(SHIPPED?.verses) ? SHIPPED.verses : [];
}

function newCustomId() {
  return `custom-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

function resolveVerses(settings = {}) {
  const hidden = new Set(settings.hiddenIds || []);
  const removed = new Set(settings.removedIds || []);
  const overrides = settings.overrides || {};
  const rows = [];

  for (const verse of loadShipped()) {
    const id = String(verse.id || '').trim();
    if (!id || removed.has(id)) {
      continue;
    }
    const patch = overrides[id] || {};
    const text = cleanText(patch.text != null ? patch.text : verse.text);
    const reference = cleanReference(patch.reference != null ? patch.reference : verse.reference);
    rows.push({
      id,
      text,
      reference,
      custom: false,
      hidden: hidden.has(id),
      rows: verseLineCount(text),
      source: verse.source || 'shipped',
    });
  }

  for (const verse of settings.custom || []) {
    const id = String(verse.id || '').trim();
    const text = cleanText(verse.text);
    const reference = cleanReference(verse.reference);
    if (!id || !text || !reference) {
      continue;
    }
    rows.push({
      id,
      text,
      reference,
      custom: true,
      hidden: false,
      rows: verseLineCount(text),
      source: 'custom',
    });
  }

  return rows;
}

function matchingVerses(settings = {}) {
  return resolveVerses(settings).filter((verse) => (
    !verse.hidden
    && verse.text
    && verse.reference
    && verse.rows > 0
    && verse.rows <= BODY_SLOTS * MAX_PAGES
    && fitsBoard(verse.reference, verse.text)
  ));
}

function pickVerse(settings = {}, { random = Math.random } = {}) {
  const pool = matchingVerses(settings);
  if (!pool.length) {
    return null;
  }
  const recent = new Set(settings.recentIds || []);
  const fresh = pool.filter((verse) => !recent.has(verse.id));
  const choices = fresh.length ? fresh : pool;
  const index = Math.min(choices.length - 1, Math.floor(Number(random()) * choices.length));
  return choices[Math.max(0, index)] || null;
}

function buildBibleVersePayload(verse, { asOf } = {}) {
  const text = cleanText(verse?.text);
  const reference = cleanReference(verse?.reference);
  if (!text || !reference) {
    return null;
  }
  return {
    type: TYPE,
    asOf: asOf || new Date().toISOString(),
    verse: {
      id: verse.id || '',
      text,
      reference,
    },
  };
}

function listVerses(settings = {}, { query = '', hidden = false, page = 1, pageSize = 20 } = {}) {
  const needle = String(query || '').trim().toLowerCase();
  let rows = resolveVerses(settings);
  if (!hidden) {
    rows = rows.filter((verse) => !verse.hidden);
  }
  if (needle) {
    rows = rows.filter((verse) => verse.text.toLowerCase().includes(needle)
      || verse.reference.toLowerCase().includes(needle)
      || verse.id.toLowerCase().includes(needle));
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
    verses: rows.slice(start, start + size),
  };
}

function createBibleVerse(config, log) {
  const settingsApi = createBibleVerseSettings(config, log);

  function snapshot(extra = {}) {
    const settings = settingsApi.get();
    const all = resolveVerses(settings);
    return {
      available: all.filter((verse) => (
        !verse.hidden
        && verse.text
        && verse.reference
        && verse.rows > 0
        && verse.rows <= BODY_SLOTS * MAX_PAGES
        && fitsBoard(verse.reference, verse.text)
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
      if (query && (query.page != null || query.pageSize != null || query.query
        || query.q || query.hidden)) {
        return snapshot(listVerses(settings, query));
      }
      return {
        available: matchingVerses(settings).length,
        total: loadShipped().length + settings.custom.length,
        customCount: settings.custom.length,
        hiddenCount: settings.hiddenIds.length,
      };
    },
    addVerse(text, reference) {
      const next = cleanText(text);
      const where = cleanReference(reference);
      if (!next) {
        return { ok: false, error: 'Type a Bible verse' };
      }
      if (!where) {
        return { ok: false, error: 'Add a scripture reference' };
      }
      const settings = settingsApi.get();
      const custom = [...settings.custom, { id: newCustomId(), text: next, reference: where }];
      settingsApi.update({ custom });
      return { ok: true, ...this.statusSnapshot() };
    },
    updateVerse(id, { text, reference, hidden, remove } = {}) {
      const key = String(id || '').trim();
      if (!key) {
        return { ok: false, error: 'Missing verse id' };
      }
      const settings = settingsApi.get();
      const customIndex = settings.custom.findIndex((row) => row.id === key);
      const shipped = loadShipped().some((row) => row.id === key);
      if (remove) {
        const result = applyCorpusRemove(settings, key, { isShipped: shipped });
        if (!result.ok) {
          return { ok: false, error: 'Unknown verse' };
        }
        settingsApi.update(result.patch);
        return { ok: true, ...this.statusSnapshot() };
      }

      if (customIndex >= 0) {
        const custom = [...settings.custom];
        if (hidden) {
          custom.splice(customIndex, 1);
        } else {
          const nextText = text != null ? cleanText(text) : custom[customIndex].text;
          const nextRef = reference != null ? cleanReference(reference) : custom[customIndex].reference;
          if (!nextText) {
            return { ok: false, error: 'Type a Bible verse' };
          }
          if (!nextRef) {
            return { ok: false, error: 'Add a scripture reference' };
          }
          custom[customIndex] = {
            ...custom[customIndex],
            text: nextText,
            reference: nextRef,
          };
        }
        settingsApi.update({ custom });
        return { ok: true, ...this.statusSnapshot() };
      }

      if (!shipped) {
        return { ok: false, error: 'Unknown verse' };
      }

      const hiddenIds = new Set(settings.hiddenIds);
      const overrides = { ...settings.overrides };
      if (hidden === true) {
        hiddenIds.add(key);
      } else if (hidden === false) {
        hiddenIds.delete(key);
      }
      if (text != null || reference != null) {
        const original = loadShipped().find((row) => row.id === key);
        const nextText = text != null ? cleanText(text) : cleanText(original?.text);
        const nextRef = reference != null ? cleanReference(reference) : cleanReference(original?.reference);
        if (!nextText) {
          return { ok: false, error: 'Type a Bible verse' };
        }
        if (!nextRef) {
          return { ok: false, error: 'Add a scripture reference' };
        }
        if (original
          && cleanText(original.text) === nextText
          && cleanReference(original.reference) === nextRef) {
          delete overrides[key];
        } else {
          overrides[key] = { text: nextText, reference: nextRef };
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
      const verse = pickVerse(settings, options);
      if (!verse) {
        return null;
      }
      settingsApi.remember(verse.id);
      return buildBibleVersePayload(verse, options);
    },
  };
}

module.exports = {
  TYPE,
  BODY_SLOTS,
  MAX_PAGES,
  loadShipped,
  verseLines,
  fitsBoard,
  resolveVerses,
  matchingVerses,
  pickVerse,
  listVerses,
  buildBibleVersePayload,
  createBibleVerse,
};
