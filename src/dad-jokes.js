/**
 * Dad Jokes — pick a shipped (or house-edited) joke for the board.
 *
 * Corpus is local JSON. No network at runtime. The layout rules live in
 * `dad-jokes-layout.js` so the build tool can measure candidates.
 */

const crypto = require('crypto');
const SHIPPED = require('./dad-jokes-jokes.json');
const { cleanPart, createDadJokesSettings } = require('./dad-jokes-settings');
const { applyCorpusRemove } = require('./corpus-remove');
const { BODY_ROWS, BODY_WIDTH, jokeLines } = require('./dad-jokes-layout');

const TYPE = 'dad.jokes';

function loadShipped() {
  return Array.isArray(SHIPPED?.jokes) ? SHIPPED.jokes : [];
}

function fitsBoard(setup, punchline) {
  const lines = jokeLines(setup, punchline);
  return lines.length > 0 && lines.length <= BODY_ROWS * 2;
}

function newCustomId() {
  return `custom-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

function resolveJokes(settings = {}, { computeRows = true } = {}) {
  const hidden = new Set(settings.hiddenIds || []);
  const removed = new Set(settings.removedIds || []);
  const overrides = settings.overrides || {};
  const rows = [];

  for (const joke of loadShipped()) {
    const id = String(joke.id || '').trim();
    if (!id || removed.has(id)) {
      continue;
    }
    const patch = overrides[id];
    const setup = cleanPart(patch?.setup != null ? patch.setup : joke.setup);
    const punchline = cleanPart(patch?.punchline != null ? patch.punchline : joke.punchline);
    rows.push({
      id,
      setup,
      punchline,
      custom: false,
      hidden: hidden.has(id),
      // Laying out the whole corpus on every list and every pick is too slow,
      // so a shipped joke is assumed to fit until someone edits it.
      rows: computeRows || patch ? jokeLines(setup, punchline).length : (setup ? 1 : 0),
    });
  }

  for (const joke of settings.custom || []) {
    const id = String(joke.id || '').trim();
    const setup = cleanPart(joke.setup);
    if (!id || !setup) {
      continue;
    }
    const punchline = cleanPart(joke.punchline);
    rows.push({
      id,
      setup,
      punchline,
      custom: true,
      hidden: false,
      rows: computeRows ? jokeLines(setup, punchline).length : (fitsBoard(setup, punchline) ? 1 : 0),
    });
  }

  return rows;
}

function matchingJokes(settings = {}) {
  return resolveJokes(settings, { computeRows: false })
    .filter((joke) => !joke.hidden && joke.setup && joke.rows > 0);
}

function countAvailable(settings = {}) {
  return matchingJokes(settings).length;
}

function pickJoke(settings = {}, { random = Math.random } = {}) {
  const pool = matchingJokes(settings);
  if (!pool.length) {
    return null;
  }
  const recent = new Set(settings.recentIds || []);
  const fresh = pool.filter((joke) => !recent.has(joke.id));
  const choices = fresh.length ? fresh : pool;
  const index = Math.min(choices.length - 1, Math.floor(Number(random()) * choices.length));
  return choices[Math.max(0, index)] || null;
}

function buildDadJokesPayload(joke, { asOf } = {}) {
  const setup = cleanPart(joke?.setup);
  if (!setup) {
    return null;
  }
  return {
    type: TYPE,
    asOf: asOf || new Date().toISOString(),
    joke: {
      id: joke.id || '',
      setup,
      punchline: cleanPart(joke?.punchline),
    },
  };
}

function listJokes(settings = {}, { query = '', hidden = false, page = 1, pageSize = 20 } = {}) {
  const needle = String(query || '').trim().toLowerCase();
  let rows = resolveJokes(settings, { computeRows: false });
  if (!hidden) {
    rows = rows.filter((joke) => !joke.hidden);
  }
  if (needle) {
    rows = rows.filter((joke) => joke.setup.toLowerCase().includes(needle)
      || joke.punchline.toLowerCase().includes(needle)
      || joke.id.toLowerCase().includes(needle));
  }
  const size = Math.min(50, Math.max(5, Number(pageSize) || 20));
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(pages, Math.max(1, Number(page) || 1));
  const start = (current - 1) * size;
  const jokes = rows.slice(start, start + size).map((joke) => ({
    ...joke,
    rows: jokeLines(joke.setup, joke.punchline).length,
  }));
  return {
    query: needle,
    page: current,
    pageSize: size,
    pages,
    total,
    jokes,
  };
}

function createDadJokes(config, log) {
  const settingsApi = createDadJokesSettings(config, log);

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
        return snapshot(listJokes(settings, query));
      }
      return snapshot();
    },
    addJoke(setup, punchline) {
      const next = cleanPart(setup);
      if (!next) {
        return { ok: false, error: 'Type the setup' };
      }
      const settings = settingsApi.get();
      const custom = [...settings.custom, {
        id: newCustomId(),
        setup: next,
        punchline: cleanPart(punchline),
      }];
      settingsApi.update({ custom });
      return { ok: true, ...this.statusSnapshot() };
    },
    updateJoke(id, { setup, punchline, hidden, remove } = {}) {
      const key = String(id || '').trim();
      if (!key) {
        return { ok: false, error: 'Missing joke id' };
      }
      const settings = settingsApi.get();
      const customIndex = settings.custom.findIndex((row) => row.id === key);
      const shipped = loadShipped().some((row) => row.id === key);
      if (remove) {
        const result = applyCorpusRemove(settings, key, { isShipped: shipped });
        if (!result.ok) {
          return { ok: false, error: 'Unknown joke' };
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
          if (setup != null) {
            const next = cleanPart(setup);
            if (!next) {
              return { ok: false, error: 'Type the setup' };
            }
            row.setup = next;
          }
          if (punchline != null) {
            row.punchline = cleanPart(punchline);
          }
          custom[customIndex] = row;
        }
        settingsApi.update({ custom });
        return { ok: true, ...this.statusSnapshot() };
      }

      if (!shipped) {
        return { ok: false, error: 'Unknown joke' };
      }

      const hiddenIds = new Set(settings.hiddenIds);
      const overrides = { ...settings.overrides };
      if (hidden === true) {
        hiddenIds.add(key);
      } else if (hidden === false) {
        hiddenIds.delete(key);
      }
      if (setup != null || punchline != null) {
        const original = loadShipped().find((row) => row.id === key) || {};
        const patch = { ...overrides[key] };
        if (setup != null) {
          const next = cleanPart(setup);
          if (!next) {
            return { ok: false, error: 'Type the setup' };
          }
          patch.setup = next;
        }
        if (punchline != null) {
          patch.punchline = cleanPart(punchline);
        }
        // Typing a shipped joke back to what it was is not an edit worth keeping.
        if (patch.setup != null && cleanPart(original.setup) === patch.setup) {
          delete patch.setup;
        }
        if (patch.punchline != null && cleanPart(original.punchline) === patch.punchline) {
          delete patch.punchline;
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
      const joke = pickJoke(settings, options);
      if (!joke) {
        return null;
      }
      settingsApi.remember(joke.id);
      return buildDadJokesPayload(joke, options);
    },
  };
}

module.exports = {
  TYPE,
  BODY_ROWS,
  BODY_WIDTH,
  loadShipped,
  jokeLines,
  fitsBoard,
  resolveJokes,
  matchingJokes,
  countAvailable,
  pickJoke,
  listJokes,
  buildDadJokesPayload,
  createDadJokes,
};
