const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { validate } = require('../src/vestaboard/encoder');
const { parseLayout, formatLayout } = require('../src/vestaboard/notation');
const { plexTop10Frames, plexTop10Title } = require('../src/vestaboard/formatters/feeds');
const {
  DEFAULT_SETTINGS,
  sanitiseSettings,
  parseMovies,
  libraryTopUrl,
  discoverHubUrl,
  fetchLibraryTop10,
  fetchGlobalTop10,
  buildPlexTop10Payload,
  createPlexTop10,
} = require('../src/plex-top10');

const SERVER = 'http://192.168.50.10:32400';

function assertLayout(actual, drawing, label) {
  assert.equal(validate(actual).ok, true, `${label} failed validation`);
  const expected = parseLayout(drawing.join('\n'), { label });
  if (formatLayout(actual) !== formatLayout(expected)) {
    assert.fail(
      `${label} does not match the spec drawing\n\n`
      + `--- expected ---\n${formatLayout(expected)}\n\n`
      + `--- actual ---\n${formatLayout(actual)}\n`,
    );
  }
}

/** Answers by URL substring, and records every URL it was asked for. */
function stubFetch(routes) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url) => {
      calls.push(url);
      for (const [match, body] of routes) {
        if (url.includes(match)) {
          if (body instanceof Error) {
            throw body;
          }
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify(body),
          };
        }
      }
      return { ok: false, status: 404, text: async () => '' };
    },
  };
}

function movieSections() {
  return { MediaContainer: { Directory: [{ key: '1', title: 'Movies', type: 'movie' }] } };
}

function genreDirectory() {
  return {
    MediaContainer: {
      Directory: [
        { key: '11', title: 'Action' },
        { key: '22', title: 'Comedy' },
      ],
    },
  };
}

let tempDir;

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plex-top10-'));
});

test('settings default to the whole library and every genre', () => {
  assert.deepEqual(sanitiseSettings({}), {
    source: 'library',
    genres: [],
    librarySectionKey: '',
    cacheMinutes: 180,
  });
  assert.equal(DEFAULT_SETTINGS.source, 'library');
  assert.equal(sanitiseSettings({ source: 'worldwide' }).source, 'global');
  assert.equal(sanitiseSettings({ source: 'nonsense' }).source, 'library');
  // Duplicates and blanks would double-count in the genre filter.
  assert.deepEqual(sanitiseSettings({ genres: ['Action', 'action', '', 'Comedy'] }).genres, ['Action', 'Comedy']);
  assert.equal(sanitiseSettings({ cacheMinutes: 99999 }).cacheMinutes, 1440);
});

test('the library query asks for most-watched movies and any picked genres', () => {
  const url = libraryTopUrl(SERVER, { sectionKey: '1', genreIds: ['11', '22'] });
  assert.match(url, /\/library\/sections\/1\/all\?/);
  assert.match(url, /type=1/);
  assert.match(url, /sort=viewCount%3Adesc%2ClastViewedAt%3Adesc/);
  assert.match(url, /genre=11%2C22/);
  assert.equal(libraryTopUrl(SERVER, { sectionKey: '1' }).includes('genre='), false);
});

test('library mode ranks by play count and drops anything unwatched', async () => {
  const { fetchImpl } = stubFetch([
    ['/library/sections/1/all', {
      MediaContainer: {
        Metadata: [
          { type: 'movie', title: 'Straw', year: 2025, viewCount: 9, ratingKey: '1' },
          { type: 'movie', title: 'Titan', year: 2024, viewCount: 4, ratingKey: '2' },
          { type: 'movie', title: 'Never Watched', year: 2020, ratingKey: '3' },
        ],
      },
    }],
    ['/library/sections', movieSections()],
  ]);

  const result = await fetchLibraryTop10({ serverUrl: SERVER, token: 'tok', fetchImpl });
  assert.equal(result.sectionKey, '1');
  assert.deepEqual(result.movies.map((movie) => movie.title), ['Straw', 'Titan']);
  assert.equal(result.genresApplied, false);
});

test('library mode turns picked genre names into the tag ids Plex filters on', async () => {
  const { calls, fetchImpl } = stubFetch([
    ['/library/sections/1/all', {
      MediaContainer: { Metadata: [{ type: 'movie', title: 'Get Hard', viewCount: 2 }] },
    }],
    ['/library/sections/1/genre', genreDirectory()],
    ['/library/sections', movieSections()],
  ]);

  const result = await fetchLibraryTop10({
    serverUrl: SERVER, token: 'tok', genres: ['comedy'], fetchImpl,
  });
  assert.equal(result.genresApplied, true);
  assert.equal(calls.some((url) => url.includes('genre=22')), true);

  // A genre this library has never heard of cannot match anything, and asking
  // Plex without the filter would quietly return the unfiltered chart.
  const empty = await fetchLibraryTop10({
    serverUrl: SERVER, token: 'tok', genres: ['Polka'], fetchImpl,
  });
  assert.deepEqual(empty.movies, []);
});

test('global mode walks the Discover hubs until one answers with movies', async () => {
  const { calls, fetchImpl } = stubFetch([
    ['top_watchlisted', new Error('hub is gone')],
    ['trending_for_you', {
      MediaContainer: {
        Hub: [{
          Metadata: [
            { type: 'movie', title: 'Michael', year: 2026, guid: 'plex://movie/a' },
            { type: 'show', title: 'Lanterns', guid: 'plex://show/b' },
            { type: 'movie', title: 'Wonka', year: 2023, guid: 'plex://movie/c' },
          ],
        }],
      },
    }],
  ]);

  const result = await fetchGlobalTop10({ token: 'tok', fetchImpl });
  assert.match(result.hub, /trending_for_you/);
  assert.deepEqual(result.movies.map((movie) => movie.title), ['Michael', 'Wonka']);
  assert.equal(calls.length, 2);
  assert.match(discoverHubUrl('/hubs/sections/home/trending_for_you'), /^https:\/\/discover\.provider\.plex\.tv/);
});

test('global mode only claims a genre filter when Discover sent tags', async () => {
  const tagged = stubFetch([
    ['top_watchlisted', {
      MediaContainer: {
        Metadata: [
          { type: 'movie', title: 'Apex', guid: 'a', Genre: [{ tag: 'Action' }] },
          { type: 'movie', title: 'Send Help', guid: 'b', Genre: [{ tag: 'Comedy' }] },
        ],
      },
    }],
  ]);
  const filtered = await fetchGlobalTop10({
    token: 'tok', genres: ['Action'], fetchImpl: tagged.fetchImpl,
  });
  assert.deepEqual(filtered.movies.map((movie) => movie.title), ['Apex']);
  assert.equal(filtered.genresApplied, true);

  const thin = stubFetch([
    ['top_watchlisted', {
      MediaContainer: { Metadata: [{ type: 'movie', title: 'Apex', guid: 'a' }] },
    }],
  ]);
  const unfiltered = await fetchGlobalTop10({
    token: 'tok', genres: ['Action'], fetchImpl: thin.fetchImpl,
  });
  assert.deepEqual(unfiltered.movies.map((movie) => movie.title), ['Apex']);
  assert.equal(unfiltered.genresApplied, false);
});

test('parseMovies dedupes and reads both hub and browse shapes', () => {
  const movies = parseMovies({
    MediaContainer: {
      Metadata: [{ type: 'movie', title: 'Wonka', guid: 'x' }],
      Hub: [{ Metadata: [{ type: 'movie', title: 'Wonka', guid: 'x' }, { type: 'movie', title: 'Plane', guid: 'y' }] }],
    },
  });
  assert.deepEqual(movies.map((movie) => movie.title), ['Wonka', 'Plane']);
});

test('buildPlexTop10Payload is a vestaboard plex.top10 card', () => {
  const payload = buildPlexTop10Payload(
    [{ title: 'Straw', year: 2025, plays: 9 }, { title: 'Titan', plays: 4 }],
    { source: 'global', genres: ['Action'], genresApplied: true, asOf: '2026-08-29T12:00:00.000Z' },
  );
  assert.equal(payload.type, 'plex.top10');
  assert.equal(payload.chip, 'yellow');
  assert.equal(payload.source, 'global');
  assert.equal(payload.sourceLabel, 'WORLDWIDE');
  assert.deepEqual(payload.movies.map((movie) => movie.rank), [1, 2]);
  assert.equal(payload.asOf, '2026-08-29T12:00:00.000Z');
  assert.equal(buildPlexTop10Payload([]), null);
});

test('Plex Top 10 matches the marketplace card in Plex yellow', () => {
  const payload = buildPlexTop10Payload([
    { title: 'Straw' },
    { title: 'Titan' },
    { title: 'Plane' },
    { title: 'Trainwreck' },
    { title: 'Bee Movie' },
    { title: 'Get Hard' },
    { title: 'World War Z' },
    { title: 'The Super Mario Galaxy Movie' },
    { title: 'Wonka' },
    { title: 'Mission: Impossible' },
  ]);
  const frames = plexTop10Frames(payload);

  assert.equal(frames.length, 2);
  assert.equal(frames[0].source, 'plex.top10');
  assertLayout(frames[0].rows, [
    'yyPLEX TOP 10 MOVIESyy',
    '01 STRAW',
    '02 TITAN',
    '03 PLANE',
    '04 TRAINWRECK',
    '05 BEE MOVIE',
  ], 'plex top 10 page 1');

  // A 19-flap title runs to the last column, exactly like the reference card.
  assertLayout(frames[1].rows, [
    'yyPLEX TOP 10 MOVIESyy',
    '06 GET HARD',
    '07 WORLD WAR Z',
    '08 THE SUPER MARIO',
    '09 WONKA',
    '10 MISSION: IMPOSSIBLE',
  ], 'plex top 10 page 2');
});

test('an over-long title is cut at a word, not mid-word', () => {
  assert.equal(plexTop10Title('The Super Mario Galaxy Movie'), 'THE SUPER MARIO');
  assert.equal(plexTop10Title('Wonka'), 'WONKA');
  assert.equal(plexTop10Title('Antidisestablishmentarianism'), 'ANTIDISESTABLISHMEN');
});

test('a short chart is a single frame and an empty one renders nothing', () => {
  const frames = plexTop10Frames(buildPlexTop10Payload([{ title: 'Wonka' }]));
  assert.equal(frames.length, 1);
  assert.deepEqual(plexTop10Frames({ type: 'plex.top10', movies: [] }), []);
  assert.deepEqual(plexTop10Frames({}), []);
});

test('the service persists settings and reuses the cached chart', async () => {
  const root = path.join(tempDir, 'svc');
  fs.mkdirSync(root, { recursive: true });
  const { calls, fetchImpl } = stubFetch([
    ['/library/sections/1/all', {
      MediaContainer: { Metadata: [{ type: 'movie', title: 'Straw', viewCount: 3 }] },
    }],
    ['/library/sections', movieSections()],
  ]);

  const api = createPlexTop10({ ROOT: root }, console, {
    resolvePlex: () => ({ serverUrl: SERVER, token: 'tok' }),
    fetchImpl,
    now: () => 1000,
  });

  assert.equal(api.statusSnapshot().linked, true);
  const first = await api.nextPayload();
  assert.deepEqual(first.movies.map((movie) => movie.title), ['Straw']);
  const before = calls.length;
  await api.nextPayload();
  assert.equal(calls.length, before, 'a cached chart must not re-ask Plex');

  api.updateSettings({ source: 'global', genres: ['Action'] });
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'data', 'plex-top10-settings.json'), 'utf8'));
  assert.equal(saved.source, 'global');
  assert.deepEqual(saved.genres, ['Action']);
});

test('the service refuses to guess when Plex is not linked', async () => {
  const root = path.join(tempDir, 'unlinked');
  fs.mkdirSync(root, { recursive: true });
  const api = createPlexTop10({ ROOT: root }, console, {
    resolvePlex: () => ({ serverUrl: SERVER, token: '' }),
  });
  assert.equal(api.statusSnapshot().linked, false);
  await assert.rejects(() => api.nextPayload(), /not linked/i);
});
