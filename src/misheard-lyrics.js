/**
 * Misheard Lyrics — pick a shipped (or house-edited) mondegreen for the board.
 *
 * Corpus is local JSON. No network at runtime. The layout rules live in
 * `misheard-lyrics-layout.js` so the build tool can measure candidates.
 */

const crypto = require('crypto');
const SHIPPED = require('./misheard-lyrics-lyrics.json');
const { cleanText, cleanArtist, createMisheardLyricsSettings } = require('./misheard-lyrics-settings');
const { applyCorpusRemove } = require('./corpus-remove');
const { BODY_ROWS, TEXT_WIDTH, lyricLines } = require('./misheard-lyrics-layout');

const TYPE = 'misheard.lyrics';

function loadShipped() {
  return Array.isArray(SHIPPED?.lyrics) ? SHIPPED.lyrics : [];
}

function fitsBoard(text, artist) {
  const lines = lyricLines(text, artist);
  return lines.length > 0 && lines.length <= BODY_ROWS;
}

function newCustomId() {
  return `custom-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

function resolveLyrics(settings = {}, { computeRows = true } = {}) {
  const hidden = new Set(settings.hiddenIds || []);
  const removed = new Set(settings.removedIds || []);
  const overrides = settings.overrides || {};
  const rows = [];

  for (const lyric of loadShipped()) {
    const id = String(lyric.id || '').trim();
    if (!id || removed.has(id)) {
      continue;
    }
    const patch = overrides[id];
    const text = cleanText(patch?.text != null ? patch.text : lyric.text);
    const artist = cleanArtist(patch?.artist != null ? patch.artist : lyric.artist);
    rows.push({
      id,
      text,
      artist,
      custom: false,
      hidden: hidden.has(id),
      rows: computeRows || patch ? lyricLines(text, artist).length : (text ? 1 : 0),
    });
  }

  for (const lyric of settings.custom || []) {
    const id = String(lyric.id || '').trim();
    const text = cleanText(lyric.text);
    if (!id || !text) {
      continue;
    }
    const artist = cleanArtist(lyric.artist);
    rows.push({
      id,
      text,
      artist,
      custom: true,
      hidden: false,
      rows: computeRows ? lyricLines(text, artist).length : (fitsBoard(text, artist) ? 1 : 0),
    });
  }

  return rows;
}

function matchingLyrics(settings = {}) {
  return resolveLyrics(settings, { computeRows: false })
    .filter((lyric) => !lyric.hidden && lyric.text && lyric.rows > 0);
}

function countAvailable(settings = {}) {
  return matchingLyrics(settings).length;
}

function pickLyric(settings = {}, { random = Math.random } = {}) {
  const pool = matchingLyrics(settings);
  if (!pool.length) {
    return null;
  }
  const recent = new Set(settings.recentIds || []);
  const fresh = pool.filter((lyric) => !recent.has(lyric.id));
  const choices = fresh.length ? fresh : pool;
  const index = Math.min(choices.length - 1, Math.floor(Number(random()) * choices.length));
  return choices[Math.max(0, index)] || null;
}

function buildMisheardLyricsPayload(lyric, { asOf } = {}) {
  const text = cleanText(lyric?.text);
  if (!text) {
    return null;
  }
  return {
    type: TYPE,
    asOf: asOf || new Date().toISOString(),
    lyric: {
      id: lyric.id || '',
      text,
      artist: cleanArtist(lyric?.artist),
    },
  };
}

function listLyrics(settings = {}, { query = '', hidden = false, page = 1, pageSize = 20 } = {}) {
  const needle = String(query || '').trim().toLowerCase();
  let rows = resolveLyrics(settings, { computeRows: false });
  if (!hidden) {
    rows = rows.filter((lyric) => !lyric.hidden);
  }
  if (needle) {
    rows = rows.filter((lyric) => lyric.text.toLowerCase().includes(needle)
      || lyric.artist.toLowerCase().includes(needle)
      || lyric.id.toLowerCase().includes(needle));
  }
  const size = Math.min(50, Math.max(5, Number(pageSize) || 20));
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(pages, Math.max(1, Number(page) || 1));
  const start = (current - 1) * size;
  const lyrics = rows.slice(start, start + size).map((lyric) => ({
    ...lyric,
    rows: lyricLines(lyric.text, lyric.artist).length,
  }));
  return {
    query: needle,
    page: current,
    pageSize: size,
    pages,
    total,
    lyrics,
  };
}

function createMisheardLyrics(config, log) {
  const settingsApi = createMisheardLyricsSettings(config, log);

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
        return snapshot(listLyrics(settings, {
          query: query.query || query.q,
          hidden: query.hidden,
          page: query.page,
          pageSize: query.pageSize,
        }));
      }
      return snapshot();
    },
    addLyric(text, artist) {
      const next = cleanText(text);
      if (!next) {
        return { ok: false, error: 'Type a misheard lyric' };
      }
      const who = cleanArtist(artist);
      if (!who) {
        return { ok: false, error: 'Name the artist' };
      }
      if (!fitsBoard(next, who)) {
        return { ok: false, error: 'That lyric is too long for one frame' };
      }
      const settings = settingsApi.get();
      const custom = [...settings.custom, {
        id: newCustomId(),
        text: next,
        artist: who,
      }];
      settingsApi.update({ custom });
      return { ok: true, ...this.statusSnapshot() };
    },
    updateLyric(id, { text, artist, hidden, remove } = {}) {
      const key = String(id || '').trim();
      if (!key) {
        return { ok: false, error: 'Missing lyric id' };
      }
      const settings = settingsApi.get();
      const customIndex = settings.custom.findIndex((row) => row.id === key);
      const shipped = loadShipped().some((row) => row.id === key);
      if (remove) {
        const result = applyCorpusRemove(settings, key, { isShipped: shipped });
        if (!result.ok) {
          return { ok: false, error: 'Unknown lyric' };
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
              return { ok: false, error: 'Type a misheard lyric' };
            }
            row.text = next;
          }
          if (artist != null) {
            const who = cleanArtist(artist);
            if (!who) {
              return { ok: false, error: 'Name the artist' };
            }
            row.artist = who;
          }
          if (!fitsBoard(row.text, row.artist)) {
            return { ok: false, error: 'That lyric is too long for one frame' };
          }
          custom[customIndex] = row;
        }
        settingsApi.update({ custom });
        return { ok: true, ...this.statusSnapshot() };
      }

      if (!shipped) {
        return { ok: false, error: 'Unknown lyric' };
      }

      const hiddenIds = new Set(settings.hiddenIds);
      const overrides = { ...settings.overrides };
      if (hidden === true) {
        hiddenIds.add(key);
      } else if (hidden === false) {
        hiddenIds.delete(key);
      }
      if (text != null || artist != null) {
        const original = loadShipped().find((row) => row.id === key) || {};
        const patch = { ...overrides[key] };
        if (text != null) {
          const next = cleanText(text);
          if (!next) {
            return { ok: false, error: 'Type a misheard lyric' };
          }
          patch.text = next;
        }
        if (artist != null) {
          const who = cleanArtist(artist);
          if (!who) {
            return { ok: false, error: 'Name the artist' };
          }
          patch.artist = who;
        }
        const nextText = patch.text != null ? patch.text : cleanText(original.text);
        const nextArtist = patch.artist != null ? patch.artist : cleanArtist(original.artist);
        if (!fitsBoard(nextText, nextArtist)) {
          return { ok: false, error: 'That lyric is too long for one frame' };
        }
        if (patch.text != null && cleanText(original.text) === patch.text) {
          delete patch.text;
        }
        if (patch.artist != null && cleanArtist(original.artist) === patch.artist) {
          delete patch.artist;
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
      const lyric = pickLyric(settings, options);
      if (!lyric) {
        return null;
      }
      settingsApi.remember(lyric.id);
      return buildMisheardLyricsPayload(lyric, options);
    },
  };
}

module.exports = {
  TYPE,
  BODY_ROWS,
  TEXT_WIDTH,
  loadShipped,
  lyricLines,
  fitsBoard,
  resolveLyrics,
  matchingLyrics,
  countAvailable,
  pickLyric,
  listLyrics,
  buildMisheardLyricsPayload,
  createMisheardLyrics,
};
