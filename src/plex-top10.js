/**
 * Plex Top 10 Movies — the marketplace "Netflix Top 10" card in Plex yellow.
 *
 * Two sources, chosen in Settings:
 *   - `library`  the house server's most-watched movies (`sort=viewCount:desc`
 *                on the movie section, unwatched rows dropped).
 *   - `global`   Plex Discover's chart hubs, i.e. what is popular across the
 *                Plex platform. Discover's hub keys are not part of the
 *                documented API, so DISCOVER_HUBS is tried in order and the
 *                first one that yields movies wins.
 *
 * Genres are optional; an empty list means every genre. Library mode filters
 * server-side by tag id, global mode filters on whatever `Genre` tags the hub
 * returns and reports `genresApplied: false` when Discover sent none.
 *
 * The token is never logged and never leaves `plex-api`'s header builder.
 */

const fs = require('fs');
const path = require('path');
const {
  normaliseServerUrl,
  fetchPlexJson,
  plexError,
  asArray,
} = require('./plex-api');

const TYPE = 'plex.top10';
const TITLE = 'Plex Top 10 Movies';
const BOARD_TITLE = 'PLEX TOP 10 MOVIES';
const MAX_ENTRIES = 10;

/** Plex's brand yellow, in place of the Netflix card's red. */
const CHIP = 'yellow';

const DISCOVER_BASE = 'https://discover.provider.plex.tv';

/**
 * Discover chart hubs, best first. `top_watchlisted` backs the public
 * "Most Watchlisted This Week" list on watch.plex.tv; `trending_for_you` is
 * what the Plex apps request for the home row. Undocumented, hence the
 * ordered fallbacks rather than one hard-coded path.
 */
const DISCOVER_HUBS = Object.freeze([
  '/hubs/sections/home/top_watchlisted',
  '/hubs/sections/home/trending_for_you',
  '/hubs/promoted?contentDirectoryID=home&count=20',
]);

const SOURCES = Object.freeze(['library', 'global']);

const SOURCE_LABELS = Object.freeze({
  library: 'MY LIBRARY',
  global: 'WORLDWIDE',
});

const DEFAULT_SETTINGS = Object.freeze({
  source: 'library',
  genres: [],
  librarySectionKey: '',
  cacheMinutes: 180,
});

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(n)));
}

function sanitiseSource(value, fallback = 'library') {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'world' || raw === 'worldwide' || raw === 'discover') {
    return 'global';
  }
  if (raw === 'mine' || raw === 'local' || raw === 'server') {
    return 'library';
  }
  return SOURCES.includes(raw) ? raw : fallback;
}

function sanitiseGenres(list) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const name = String(raw || '').trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(name);
  }
  return out;
}

function sanitiseSettings(raw = {}, base = DEFAULT_SETTINGS) {
  const merged = { ...base, ...(raw && typeof raw === 'object' ? raw : {}) };
  return {
    source: sanitiseSource(merged.source, base.source || 'library'),
    genres: sanitiseGenres(merged.genres),
    librarySectionKey: String(merged.librarySectionKey || '').trim(),
    cacheMinutes: clampInt(merged.cacheMinutes, 0, 1440, base.cacheMinutes ?? 180),
  };
}

// --------------------------------------------------------------- parsing

function tagNames(entry) {
  return asArray(entry?.Genre || entry?.genre)
    .map((tag) => String(tag?.tag || tag?.title || tag || '').trim())
    .filter(Boolean);
}

function parseMovie(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  const type = String(entry.type || '').trim().toLowerCase();
  if (type && type !== 'movie') {
    return null;
  }
  const title = String(entry.title || '').trim();
  if (!title) {
    return null;
  }
  const year = Number(entry.year);
  const plays = Number(entry.viewCount);
  return {
    id: String(entry.guid || entry.ratingKey || entry.key || title).trim(),
    title,
    year: Number.isFinite(year) && year > 1800 ? year : null,
    plays: Number.isFinite(plays) && plays > 0 ? plays : 0,
    genres: tagNames(entry),
  };
}

/** Hub responses nest items under `Hub[].Metadata`; browse responses do not. */
function parseMovies(body) {
  const container = body?.MediaContainer || body || {};
  const direct = asArray(container.Metadata || container.metadata);
  const hubbed = asArray(container.Hub || container.hub)
    .flatMap((hub) => asArray(hub?.Metadata || hub?.metadata));
  const seen = new Set();
  const out = [];
  for (const movie of [...direct, ...hubbed].map(parseMovie)) {
    if (!movie || seen.has(movie.id)) {
      continue;
    }
    seen.add(movie.id);
    out.push(movie);
  }
  return out;
}

function parseDirectories(body, { type = null } = {}) {
  const container = body?.MediaContainer || body || {};
  return asArray(container.Directory || container.directory)
    .map((dir) => ({
      key: String(dir?.key || '').trim(),
      title: String(dir?.title || '').trim(),
      type: String(dir?.type || '').trim().toLowerCase(),
    }))
    .filter((dir) => dir.key && dir.title && (!type || dir.type === type));
}

// ------------------------------------------------------------------ urls

function sectionsUrl(serverUrl) {
  return `${normaliseServerUrl(serverUrl)}/library/sections`;
}

function sectionGenresUrl(serverUrl, sectionKey) {
  return `${normaliseServerUrl(serverUrl)}/library/sections/${encodeURIComponent(sectionKey)}/genre`;
}

/**
 * Most-watched first. We ask for more than ten because unwatched rows sort in
 * behind the watched ones and get dropped below.
 */
function libraryTopUrl(serverUrl, { sectionKey, genreIds = [], limit = MAX_ENTRIES } = {}) {
  const params = new URLSearchParams({
    type: '1',
    sort: 'viewCount:desc,lastViewedAt:desc',
    'X-Plex-Container-Start': '0',
    'X-Plex-Container-Size': String(Math.max(limit, MAX_ENTRIES) * 4),
  });
  if (genreIds.length) {
    params.set('genre', genreIds.join(','));
  }
  const base = normaliseServerUrl(serverUrl);
  return `${base}/library/sections/${encodeURIComponent(sectionKey)}/all?${params.toString()}`;
}

function discoverHubUrl(hub) {
  const [pathPart, query] = String(hub).split('?');
  const params = new URLSearchParams(query || '');
  params.set('includeMeta', '1');
  params.set('includeExternalMetadata', '1');
  params.set('X-Plex-Container-Start', '0');
  params.set('X-Plex-Container-Size', '30');
  return `${DISCOVER_BASE}${pathPart}?${params.toString()}`;
}

// ---------------------------------------------------------------- fetching

async function fetchMovieSections({ serverUrl, token, ...rest } = {}) {
  const body = await fetchPlexJson(sectionsUrl(serverUrl), { token, ...rest });
  return parseDirectories(body, { type: 'movie' });
}

async function fetchLibraryGenres({ serverUrl, token, sectionKey, ...rest } = {}) {
  if (!sectionKey) {
    return [];
  }
  const body = await fetchPlexJson(sectionGenresUrl(serverUrl, sectionKey), { token, ...rest });
  return parseDirectories(body).map(({ key, title }) => ({ key, title }));
}

async function resolveSectionKey({ serverUrl, token, sectionKey, ...rest } = {}) {
  if (sectionKey) {
    return sectionKey;
  }
  const sections = await fetchMovieSections({ serverUrl, token, ...rest });
  if (!sections.length) {
    throw plexError('No movie library found on the Plex server', { kind: 'config' });
  }
  return sections[0].key;
}

/** Genre names are what the admin picks; Plex filters want the tag ids. */
async function resolveGenreIds({ serverUrl, token, sectionKey, genres = [], ...rest } = {}) {
  if (!genres.length) {
    return [];
  }
  const available = await fetchLibraryGenres({ serverUrl, token, sectionKey, ...rest });
  const byName = new Map(available.map((row) => [row.title.toLowerCase(), row.key]));
  return genres
    .map((name) => byName.get(String(name).toLowerCase()))
    .filter(Boolean);
}

async function fetchLibraryTop10({
  serverUrl,
  token,
  sectionKey = '',
  genres = [],
  limit = MAX_ENTRIES,
  ...rest
} = {}) {
  const base = normaliseServerUrl(serverUrl);
  if (!base) {
    throw plexError('Plex server URL is empty', { kind: 'config' });
  }
  const key = await resolveSectionKey({ serverUrl: base, token, sectionKey, ...rest });
  const genreIds = await resolveGenreIds({
    serverUrl: base, token, sectionKey: key, genres, ...rest,
  });
  // Every requested genre is unknown to this library: nothing can match.
  if (genres.length && !genreIds.length) {
    return { movies: [], sectionKey: key, genresApplied: true };
  }
  const body = await fetchPlexJson(
    libraryTopUrl(base, { sectionKey: key, genreIds, limit }),
    { token, ...rest },
  );
  const movies = parseMovies(body)
    .filter((movie) => movie.plays > 0)
    .slice(0, limit);
  return { movies, sectionKey: key, genresApplied: Boolean(genres.length) };
}

function matchesGenres(movie, wanted) {
  if (!wanted.length) {
    return true;
  }
  const have = movie.genres.map((name) => name.toLowerCase());
  return wanted.some((name) => have.includes(String(name).toLowerCase()));
}

async function fetchGlobalTop10({
  token,
  genres = [],
  limit = MAX_ENTRIES,
  hubs = DISCOVER_HUBS,
  ...rest
} = {}) {
  let lastError = null;
  for (const hub of hubs) {
    let candidates = [];
    try {
      candidates = parseMovies(await fetchPlexJson(discoverHubUrl(hub), { token, ...rest }));
    } catch (error) {
      lastError = error;
      continue;
    }
    if (!candidates.length) {
      continue;
    }
    if (!genres.length) {
      return { movies: candidates.slice(0, limit), hub, genresApplied: false };
    }
    // Discover hubs are thin; without tags there is nothing to filter on, so
    // say so rather than quietly returning an empty board.
    const tagged = candidates.some((movie) => movie.genres.length);
    if (!tagged) {
      return { movies: candidates.slice(0, limit), hub, genresApplied: false };
    }
    const filtered = candidates.filter((movie) => matchesGenres(movie, genres));
    return { movies: filtered.slice(0, limit), hub, genresApplied: true };
  }
  if (lastError) {
    throw lastError;
  }
  throw plexError('Plex Discover returned no movies', { kind: 'http' });
}

// ----------------------------------------------------------------- payload

function buildPlexTop10Payload(movies, {
  source = 'library',
  genres = [],
  genresApplied = false,
  asOf = new Date(),
} = {}) {
  const rows = (Array.isArray(movies) ? movies : [])
    .filter((movie) => movie?.title)
    .slice(0, MAX_ENTRIES)
    .map((movie, index) => ({
      rank: index + 1,
      title: String(movie.title).trim(),
      year: movie.year ?? null,
      plays: Number(movie.plays) || 0,
    }));
  if (!rows.length) {
    return null;
  }
  const kind = sanitiseSource(source);
  return {
    type: TYPE,
    title: TITLE,
    boardTitle: BOARD_TITLE,
    chip: CHIP,
    source: kind,
    sourceLabel: SOURCE_LABELS[kind],
    genres: sanitiseGenres(genres),
    genresApplied: Boolean(genresApplied),
    asOf: asOf instanceof Date ? asOf.toISOString() : String(asOf),
    movies: rows,
  };
}

// ---------------------------------------------------------------- settings

function createPlexTop10Settings(config = {}, log = console) {
  const settingsPath = config.plexTop10SettingsPath
    || path.resolve(config.ROOT || path.resolve(__dirname, '..'), 'data', 'plex-top10-settings.json');
  let current = sanitiseSettings({}, DEFAULT_SETTINGS);

  function load() {
    try {
      if (!fs.existsSync(settingsPath)) {
        current = sanitiseSettings({}, DEFAULT_SETTINGS);
        return current;
      }
      current = sanitiseSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), DEFAULT_SETTINGS);
    } catch (error) {
      log?.warn?.('Could not read Plex Top 10 settings', error?.message || error);
      current = sanitiseSettings({}, DEFAULT_SETTINGS);
    }
    return current;
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
    } catch (error) {
      log?.warn?.('Could not save Plex Top 10 settings', error?.message || error);
    }
  }

  load();

  return {
    get: () => ({ ...current, genres: [...current.genres] }),
    update(patch = {}) {
      current = sanitiseSettings({ ...current, ...patch }, DEFAULT_SETTINGS);
      save();
      return this.get();
    },
    reset() {
      current = sanitiseSettings({}, DEFAULT_SETTINGS);
      save();
      return this.get();
    },
    reload: load,
    path: settingsPath,
  };
}

// ----------------------------------------------------------------- service

/**
 * `resolvePlex` hands back `{ serverUrl, token }` — the web server already
 * owns Plex settings and the encrypted token, so this module does not read
 * either from disk.
 */
function createPlexTop10(config = {}, log = console, {
  resolvePlex = () => ({ serverUrl: '', token: '' }),
  fetchImpl = undefined,
  now = () => Date.now(),
} = {}) {
  const settingsApi = createPlexTop10Settings(config, log);
  let cache = null;

  function cacheKey(settings) {
    return JSON.stringify([
      settings.source,
      settings.librarySectionKey,
      [...settings.genres].sort(),
    ]);
  }

  function cached(settings) {
    if (!cache || cache.key !== cacheKey(settings)) {
      return null;
    }
    const ttl = settings.cacheMinutes * 60000;
    return ttl > 0 && now() - cache.at < ttl ? cache.payload : null;
  }

  async function collect(options = {}) {
    const settings = settingsApi.get();
    const { serverUrl, token } = resolvePlex() || {};
    if (!String(token || '').trim()) {
      throw plexError('Plex is not linked — add a token under Settings → Media', {
        kind: 'auth',
        status: 401,
      });
    }
    const rest = { fetchImpl };
    if (settings.source === 'global') {
      const result = await fetchGlobalTop10({ token, genres: settings.genres, ...rest });
      return buildPlexTop10Payload(result.movies, {
        source: 'global',
        genres: settings.genres,
        genresApplied: result.genresApplied,
        asOf: options.asOf || new Date(),
      });
    }
    const result = await fetchLibraryTop10({
      serverUrl,
      token,
      sectionKey: settings.librarySectionKey,
      genres: settings.genres,
      ...rest,
    });
    return buildPlexTop10Payload(result.movies, {
      source: 'library',
      genres: settings.genres,
      genresApplied: result.genresApplied,
      asOf: options.asOf || new Date(),
    });
  }

  async function nextPayload(options = {}) {
    const settings = settingsApi.get();
    if (!options.refresh) {
      const hit = cached(settings);
      if (hit) {
        return hit;
      }
    }
    const payload = await collect(options);
    cache = payload ? { key: cacheKey(settings), at: now(), payload } : null;
    return payload;
  }

  return {
    TYPE,
    getSettings: () => settingsApi.get(),
    updateSettings: (patch) => {
      cache = null;
      return settingsApi.update(patch);
    },
    resetSettings: () => {
      cache = null;
      return settingsApi.reset();
    },
    async listGenres() {
      const settings = settingsApi.get();
      const { serverUrl, token } = resolvePlex() || {};
      if (!String(token || '').trim() || !normaliseServerUrl(serverUrl)) {
        return [];
      }
      const sectionKey = await resolveSectionKey({
        serverUrl, token, sectionKey: settings.librarySectionKey, fetchImpl,
      });
      const genres = await fetchLibraryGenres({ serverUrl, token, sectionKey, fetchImpl });
      return genres.map((row) => row.title);
    },
    /**
     * Registry content check. Cheap and synchronous: the scheduler only needs
     * to know the board is configured, not that Plex answered this second.
     */
    statusSnapshot() {
      const settings = settingsApi.get();
      const { token } = resolvePlex() || {};
      return {
        settings,
        defaults: { ...DEFAULT_SETTINGS },
        linked: Boolean(String(token || '').trim()),
        cachedAt: cache ? new Date(cache.at).toISOString() : null,
        available: cache?.payload?.movies?.length || 0,
      };
    },
    nextPayload,
  };
}

module.exports = {
  TYPE,
  TITLE,
  BOARD_TITLE,
  CHIP,
  MAX_ENTRIES,
  SOURCES,
  SOURCE_LABELS,
  DISCOVER_BASE,
  DISCOVER_HUBS,
  DEFAULT_SETTINGS,
  sanitiseSource,
  sanitiseGenres,
  sanitiseSettings,
  parseMovie,
  parseMovies,
  parseDirectories,
  sectionsUrl,
  sectionGenresUrl,
  libraryTopUrl,
  discoverHubUrl,
  fetchMovieSections,
  fetchLibraryGenres,
  fetchLibraryTop10,
  fetchGlobalTop10,
  buildPlexTop10Payload,
  createPlexTop10Settings,
  createPlexTop10,
};
