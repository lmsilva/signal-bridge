/**
 * Vestaboard Artwork — send a painted board, not a sentence.
 *
 * A piece of artwork is already a full 6x22 grid of flap codes, so there is no
 * layout step: the corpus is local JSON, the household's drawings live in the
 * settings file, and a push hands the grid straight to the formatter.
 *
 * A push picks one of three ways: a random piece, a random starred piece, or
 * one named outright.
 */

const crypto = require('crypto');
const SHIPPED = require('./vestaboard-artwork-designs.json');
const {
  cleanName,
  cleanCells,
  CUSTOM_CAP,
  createVestaboardArtworkSettings,
} = require('./vestaboard-artwork-settings');
const { applyCorpusRemove } = require('./corpus-remove');
const { ROWS, COLS, BLANK } = require('./vestaboard/encoder');

const TYPE = 'vestaboard.artwork';

const MODES = ['random', 'favorite', 'specific'];

function loadShipped() {
  return Array.isArray(SHIPPED?.designs) ? SHIPPED.designs : [];
}

/** An all-blank board is a blank board, not a drawing. */
function isPainted(cells) {
  return Array.isArray(cells) && cells.some((row) => row.some((code) => code !== BLANK));
}

function blankCells() {
  return Array.from({ length: ROWS }, () => new Array(COLS).fill(BLANK));
}

function newCustomId() {
  return `custom-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

/** Both spellings, plural or not, land on the same mode. */
function normaliseMode(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'specific' || raw === 'one' || raw === 'id') {
    return 'specific';
  }
  if (raw.startsWith('favo')) {
    return 'favorite';
  }
  return 'random';
}

function resolveArtwork(settings = {}) {
  const hidden = new Set(settings.hiddenIds || []);
  const removed = new Set(settings.removedIds || []);
  const favourites = new Set(settings.favouriteIds || []);
  const overrides = settings.overrides || {};
  const rows = [];

  for (const design of loadShipped()) {
    const id = String(design.id || '').trim();
    if (!id || removed.has(id)) {
      continue;
    }
    const patch = overrides[id];
    const cells = cleanCells(patch?.cells != null ? patch.cells : design.cells);
    if (!cells) {
      continue;
    }
    rows.push({
      id,
      name: cleanName(patch?.name != null ? patch.name : design.name) || id,
      cells,
      custom: false,
      edited: Boolean(patch),
      hidden: hidden.has(id),
      favourite: favourites.has(id),
      painted: isPainted(cells),
    });
  }

  for (const design of settings.custom || []) {
    const id = String(design.id || '').trim();
    const cells = cleanCells(design.cells);
    if (!id || !cells) {
      continue;
    }
    rows.push({
      id,
      name: cleanName(design.name) || 'Untitled',
      cells,
      custom: true,
      edited: false,
      hidden: false,
      favourite: favourites.has(id),
      painted: isPainted(cells),
    });
  }

  return rows;
}

function matchingArtwork(settings = {}) {
  return resolveArtwork(settings).filter((art) => !art.hidden && art.painted);
}

function countAvailable(settings = {}) {
  return matchingArtwork(settings).length;
}

function countFavourites(settings = {}) {
  return matchingArtwork(settings).filter((art) => art.favourite).length;
}

/**
 * Pick what to send. `specific` is an exact request and fails loudly if the
 * piece has gone; `favorite` falls back to the whole gallery rather than sending
 * nothing when the household has not starred anything yet.
 */
function pickArtwork(settings = {}, { mode, artworkId, random = Math.random } = {}) {
  const pool = matchingArtwork(settings);
  if (!pool.length) {
    return { ok: false, error: 'There is no artwork ready to send' };
  }
  const wanted = normaliseMode(mode);

  if (wanted === 'specific') {
    const id = String(artworkId || '').trim();
    if (!id) {
      return { ok: false, error: 'Pick which artwork to send' };
    }
    const artwork = pool.find((art) => art.id === id);
    if (!artwork) {
      return { ok: false, error: 'That artwork is no longer available' };
    }
    return { ok: true, artwork, mode: wanted, fellBack: false };
  }

  let choices = pool;
  let fellBack = false;
  if (wanted === 'favorite') {
    const starred = pool.filter((art) => art.favourite);
    if (starred.length) {
      choices = starred;
    } else {
      fellBack = true;
    }
  }

  const recent = new Set(settings.recentIds || []);
  const fresh = choices.filter((art) => !recent.has(art.id));
  const from = fresh.length ? fresh : choices;
  const index = Math.min(from.length - 1, Math.floor(Number(random()) * from.length));
  return {
    ok: true, artwork: from[Math.max(0, index)], mode: wanted, fellBack,
  };
}

function buildVestaboardArtworkPayload(artwork, { asOf } = {}) {
  const cells = cleanCells(artwork?.cells);
  if (!cells || !isPainted(cells)) {
    return null;
  }
  return {
    type: TYPE,
    asOf: asOf || new Date().toISOString(),
    artwork: {
      id: artwork.id || '',
      name: cleanName(artwork?.name),
      cells,
    },
  };
}

function listArtwork(settings = {}, {
  query = '', hidden = false, favourites = false, page = 1, pageSize = 12,
} = {}) {
  const needle = String(query || '').trim().toLowerCase();
  let rows = resolveArtwork(settings);
  if (!hidden) {
    rows = rows.filter((art) => !art.hidden);
  }
  if (favourites) {
    rows = rows.filter((art) => art.favourite);
  }
  if (needle) {
    rows = rows.filter((art) => art.name.toLowerCase().includes(needle)
      || art.id.toLowerCase().includes(needle));
  }
  const size = Math.min(50, Math.max(4, Number(pageSize) || 12));
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
    artwork: rows.slice(start, start + size),
  };
}

function createVestaboardArtwork(config, log) {
  const settingsApi = createVestaboardArtworkSettings(config, log);

  function snapshot(extra = {}) {
    const settings = settingsApi.get();
    return {
      available: countAvailable(settings),
      favourites: countFavourites(settings),
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
        || query.q || query.hidden || query.favourites)) {
        return snapshot(listArtwork(settings, query));
      }
      return snapshot();
    },
    /**
     * Could a push with these params find something? A scheduled rule asking for
     * one named piece is not ready once that piece has been removed, so the
     * answer depends on the params and not just on the gallery being non-empty.
     */
    readiness(params = {}) {
      const settings = settingsApi.get();
      const pool = matchingArtwork(settings);
      if (normaliseMode(params?.mode) === 'specific') {
        const id = String(params?.artworkId || '').trim();
        return { available: id && pool.some((art) => art.id === id) ? 1 : 0 };
      }
      return { available: pool.length };
    },
    /** Names and ids only — this is what fills the scheduler's artwork picker. */
    options() {
      const settings = settingsApi.get();
      return matchingArtwork(settings).map((art) => ({
        value: art.id,
        label: art.favourite ? `${art.name} *` : art.name,
      }));
    },
    /** The shipped grids, so the editor can offer them as starting points. */
    templates() {
      return loadShipped().map((design) => ({
        id: design.id,
        name: design.name,
        cells: design.cells.map((row) => [...row]),
      }));
    },
    addArtwork(name, cells) {
      const grid = cleanCells(cells);
      if (!grid) {
        return { ok: false, error: 'That drawing is not a 6 by 22 board' };
      }
      if (!isPainted(grid)) {
        return { ok: false, error: 'Paint something before saving' };
      }
      const settings = settingsApi.get();
      if (settings.custom.length >= CUSTOM_CAP) {
        return { ok: false, error: `You can keep up to ${CUSTOM_CAP} drawings` };
      }
      const id = newCustomId();
      settingsApi.update({
        custom: [...settings.custom, { id, name: cleanName(name) || 'Untitled', cells: grid }],
      });
      return { ok: true, id, ...this.statusSnapshot() };
    },
    updateArtwork(id, {
      name, cells, hidden, favourite, remove,
    } = {}) {
      const key = String(id || '').trim();
      if (!key) {
        return { ok: false, error: 'Missing artwork id' };
      }
      const settings = settingsApi.get();
      const customIndex = settings.custom.findIndex((row) => row.id === key);
      const shipped = loadShipped().some((row) => row.id === key);
      if (remove) {
        const result = applyCorpusRemove(settings, key, { isShipped: shipped });
        if (!result.ok) {
          return { ok: false, error: 'Unknown artwork' };
        }
        settingsApi.update({
          ...result.patch,
          favouriteIds: settings.favouriteIds.filter((item) => item !== key),
        });
        return { ok: true, ...this.statusSnapshot() };
      }

      if (customIndex < 0 && !shipped) {
        return { ok: false, error: 'Unknown artwork' };
      }

      const favouriteIds = new Set(settings.favouriteIds);
      if (favourite === true) {
        favouriteIds.add(key);
      } else if (favourite === false) {
        favouriteIds.delete(key);
      }

      if (customIndex >= 0) {
        const custom = [...settings.custom];
        if (hidden) {
          // A drawing of your own has nothing to fall back to, so hiding it is
          // the same as throwing it away.
          custom.splice(customIndex, 1);
          favouriteIds.delete(key);
        } else {
          const row = { ...custom[customIndex] };
          if (name != null) {
            row.name = cleanName(name) || 'Untitled';
          }
          if (cells != null) {
            const grid = cleanCells(cells);
            if (!grid) {
              return { ok: false, error: 'That drawing is not a 6 by 22 board' };
            }
            if (!isPainted(grid)) {
              return { ok: false, error: 'Paint something before saving' };
            }
            row.cells = grid;
          }
          custom[customIndex] = row;
        }
        settingsApi.update({ custom, favouriteIds: [...favouriteIds] });
        return { ok: true, ...this.statusSnapshot() };
      }

      const hiddenIds = new Set(settings.hiddenIds);
      const overrides = { ...settings.overrides };
      if (hidden === true) {
        hiddenIds.add(key);
      } else if (hidden === false) {
        hiddenIds.delete(key);
      }
      if (name != null || cells != null) {
        const original = loadShipped().find((row) => row.id === key) || {};
        const patch = { ...overrides[key] };
        if (name != null) {
          patch.name = cleanName(name) || cleanName(original.name);
        }
        if (cells != null) {
          const grid = cleanCells(cells);
          if (!grid) {
            return { ok: false, error: 'That drawing is not a 6 by 22 board' };
          }
          if (!isPainted(grid)) {
            return { ok: false, error: 'Paint something before saving' };
          }
          patch.cells = grid;
        }
        // Painting a shipped template back to what it was is not an edit worth
        // keeping, so the override goes away and the template returns.
        if (patch.name != null && cleanName(original.name) === patch.name) {
          delete patch.name;
        }
        if (patch.cells != null
          && JSON.stringify(cleanCells(original.cells)) === JSON.stringify(patch.cells)) {
          delete patch.cells;
        }
        if (Object.keys(patch).length) {
          overrides[key] = patch;
        } else {
          delete overrides[key];
        }
      }
      settingsApi.update({
        hiddenIds: [...hiddenIds],
        favouriteIds: [...favouriteIds],
        overrides,
      });
      return { ok: true, ...this.statusSnapshot() };
    },
    /** Returns `{ ok, payload, artwork, mode, fellBack }` so a push can explain itself. */
    next(options = {}) {
      const settings = settingsApi.get();
      const picked = pickArtwork(settings, options);
      if (!picked.ok) {
        return picked;
      }
      const payload = buildVestaboardArtworkPayload(picked.artwork, options);
      if (!payload) {
        return { ok: false, error: 'That artwork is not a board we can send' };
      }
      settingsApi.remember(picked.artwork.id);
      return { ...picked, payload };
    },
    nextPayload(options = {}) {
      return this.next(options).payload || null;
    },
  };
}

module.exports = {
  TYPE,
  MODES,
  ROWS,
  COLS,
  loadShipped,
  isPainted,
  blankCells,
  normaliseMode,
  resolveArtwork,
  matchingArtwork,
  countAvailable,
  countFavourites,
  pickArtwork,
  listArtwork,
  buildVestaboardArtworkPayload,
  createVestaboardArtwork,
};
