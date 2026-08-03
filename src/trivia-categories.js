/**
 * Canonical trivia category registry (trivia.md §3).
 *
 * 26 categories: OpenTDB's 24 plus the two The Trivia API covers that OpenTDB
 * does not. Every question in the pool is filed against a canonical id, never a
 * provider id, so the settings page shows one coherent set of checkboxes rather
 * than two overlapping lists.
 *
 * Colours, artwork filenames and measured contrast come from
 * `trivia-categories.json`, which the artwork generator produced; the
 * provider mapping lives here because no provider knows about it.
 */

const fs = require('fs');
const path = require('path');

const ARTWORK_ROUTE_PREFIX = '/trivia-artwork/';

/**
 * Provider mapping per §3.
 *
 * `broad: true` marks a Trivia API slug that is coarser than the canonical
 * category — `arts_and_literature` returns books, fine art and theatre mixed
 * together. Those slugs are used for *reading back* a result's category, never
 * for querying: filing a broad-slug result under a narrow canonical category
 * would quietly fill "Books" with theatre questions.
 */
const PROVIDER_MAP = {
  'general-knowledge': { opentdb: 9, triviaApi: 'general_knowledge' },
  books: { opentdb: 10, triviaApi: 'arts_and_literature', broad: true },
  film: { opentdb: 11, triviaApi: 'film_and_tv' },
  music: { opentdb: 12, triviaApi: 'music' },
  'musicals-theatre': { opentdb: 13, triviaApi: 'arts_and_literature', broad: true },
  television: { opentdb: 14, triviaApi: 'film_and_tv', broad: true },
  'video-games': { opentdb: 15, triviaApi: null },
  'board-games': { opentdb: 16, triviaApi: 'sport_and_leisure', broad: true },
  'science-nature': { opentdb: 17, triviaApi: 'science' },
  computers: { opentdb: 18, triviaApi: 'science', broad: true },
  mathematics: { opentdb: 19, triviaApi: 'science', broad: true },
  mythology: { opentdb: 20, triviaApi: 'society_and_culture', broad: true },
  sports: { opentdb: 21, triviaApi: 'sport_and_leisure' },
  geography: { opentdb: 22, triviaApi: 'geography' },
  history: { opentdb: 23, triviaApi: 'history' },
  politics: { opentdb: 24, triviaApi: 'society_and_culture', broad: true },
  art: { opentdb: 25, triviaApi: 'arts_and_literature' },
  celebrities: { opentdb: 26, triviaApi: null },
  animals: { opentdb: 27, triviaApi: null },
  vehicles: { opentdb: 28, triviaApi: null },
  comics: { opentdb: 29, triviaApi: null },
  gadgets: { opentdb: 30, triviaApi: null },
  'anime-manga': { opentdb: 31, triviaApi: null },
  cartoons: { opentdb: 32, triviaApi: null },
  'food-drink': { opentdb: null, triviaApi: 'food_and_drink' },
  'society-culture': { opentdb: null, triviaApi: 'society_and_culture' },
};

let cached = null;

function artworkFile(categories, id, orientation) {
  const entry = categories.find((category) => category.id === id);
  return entry?.files?.[orientation] || `${id}-${orientation}.jpg`;
}

function loadArtworkManifest() {
  const file = path.join(__dirname, 'trivia-categories.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(raw?.categories) ? raw.categories : [];
}

/** Canonical categories, artwork metadata merged in. Cached after first call. */
function listCategories() {
  if (cached) {
    return cached;
  }
  const artwork = loadArtworkManifest();
  cached = Object.entries(PROVIDER_MAP).map(([id, providers]) => {
    const art = artwork.find((category) => category.id === id) || {};
    return {
      id,
      label: art.label || id,
      pattern: art.pattern || null,
      background: art.background || '#101820',
      accent: art.accent || '#8BB7FF',
      tone: art.tone ?? 1,
      minContrastVsWhite: art.minContrastVsWhite ?? null,
      opentdbId: providers.opentdb,
      triviaApiSlug: providers.triviaApi,
      // True when triviaApiSlug is coarser than this canonical category.
      triviaApiSlugIsBroad: Boolean(providers.broad),
      artwork: {
        portrait: ARTWORK_ROUTE_PREFIX + artworkFile(artwork, id, 'portrait'),
        landscape: ARTWORK_ROUTE_PREFIX + artworkFile(artwork, id, 'landscape'),
      },
    };
  });
  return cached;
}

function getCategory(id) {
  return listCategories().find((category) => category.id === id) || null;
}

function categoryIds() {
  return listCategories().map((category) => category.id);
}

/** Canonical id for an OpenTDB numeric category id, or null if unmapped. */
function fromOpentdbId(opentdbId) {
  const numeric = Number(opentdbId);
  const match = listCategories().find((category) => category.opentdbId === numeric);
  return match ? match.id : null;
}

/**
 * Canonical id for a Trivia API slug.
 *
 * Only returns categories the slug is *primary* for. A broad slug like
 * `arts_and_literature` maps to `art` (its primary), never to `books` or
 * `musicals-theatre`, which is the §3 rule that keeps the pool honest.
 */
function fromTriviaApiSlug(slug) {
  const wanted = String(slug || '').trim().toLowerCase();
  const match = listCategories().find(
    (category) => category.triviaApiSlug === wanted && !category.triviaApiSlugIsBroad,
  );
  return match ? match.id : null;
}

/** Slugs safe to *query* The Trivia API with for these canonical categories. */
function triviaApiQuerySlugs(canonicalIds) {
  const wanted = new Set(canonicalIds || []);
  const slugs = new Set();
  for (const category of listCategories()) {
    if (wanted.has(category.id) && category.triviaApiSlug && !category.triviaApiSlugIsBroad) {
      slugs.add(category.triviaApiSlug);
    }
  }
  return [...slugs];
}

module.exports = {
  ARTWORK_ROUTE_PREFIX,
  PROVIDER_MAP,
  listCategories,
  getCategory,
  categoryIds,
  fromOpentdbId,
  fromTriviaApiSlug,
  triviaApiQuerySlugs,
};
