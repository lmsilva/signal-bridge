/**
 * Fail-soft PlayStation Store (Chihiro) enrichment.
 *
 * Unofficial JSON — never throws to callers; timeouts / 404 / shape changes
 * simply return null so Now Playing still works from presence + trophies.
 *
 * Resolve path:
 *   titleId (PPSA01668_00) → title container → Full Game product id
 *   → product container → long_desc + mediaList.screenshots + star_rating
 */

const DEFAULT_TIMEOUT_MS = 4500;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h
// Chihiro answers 204 for products it no longer serves, which is indistinguishable
// from a title Sony has simply not indexed yet — retry those sooner than a hit.
const MISS_CACHE_TTL_MS = 30 * 60 * 1000;

// A product id names its own storefront: EP6959-… is European, UP0177-… American.
// Asking the wrong region is a reliable way to get nothing back.
const REGION_BY_PREFIX = {
  EP: { country: 'GB', lang: 'en' },
  UP: { country: 'US', lang: 'en' },
  JP: { country: 'JP', lang: 'ja' },
  HP: { country: 'HK', lang: 'en' },
};

function regionForProductId(productId) {
  const prefix = String(productId || '').trim().slice(0, 2).toUpperCase();
  return REGION_BY_PREFIX[prefix] || null;
}

/** @type {Map<string, { at: number, value: object|null }>} */
const cache = new Map();

function stripHtml(html) {
  return String(html || '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*p\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** Drop PS5 BC / legal preamble; keep the marketing blurb. */
function cleanStoreDescription(html, { maxChars = 480 } = {}) {
  let text = stripHtml(html);
  if (!text) {
    return '';
  }
  // Common storefront preamble before the real pitch.
  const cutMarkers = [
    /Roll through /i,
    /Join the /i,
    /Experience /i,
    /Play as /i,
    /In \w+.+, /i,
  ];
  for (const marker of cutMarkers) {
    const match = text.match(marker);
    if (match && match.index != null && match.index > 40) {
      text = text.slice(match.index);
      break;
    }
  }
  // Truncate at a sentence if possible.
  if (text.length > maxChars) {
    const slice = text.slice(0, maxChars);
    const lastStop = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '));
    text = (lastStop > 120 ? slice.slice(0, lastStop + 1) : `${slice.trim()}…`).trim();
  }
  return text;
}

async function fetchJson(url, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    return null;
  }
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'SignalBridge/1.0 (PSN Now Playing; +local)',
      },
      signal: controller?.signal,
    });
    if (!res?.ok || res.status === 204) {
      return null;
    }
    const body = await res.text();
    if (!body || !body.trim()) {
      return null;
    }
    return JSON.parse(body);
  } catch {
    return null;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function chihiroContainerUrl(id, { country = 'US', lang = 'en' } = {}) {
  const safe = encodeURIComponent(String(id || '').trim());
  return `https://store.playstation.com/store/api/chihiro/00_09_000/container/${country}/${lang}/999/${safe}`;
}

function pickFullGameProductId(titleContainer) {
  const links = Array.isArray(titleContainer?.links) ? titleContainer.links : [];
  const full = links.find((link) => {
    const type = String(link?.game_contentType || link?.gameContentTypesList?.[0]?.name || '');
    return /full\s*game/i.test(type) && link?.id;
  });
  if (full?.id) {
    return String(full.id);
  }
  // Fallback: first downloadable_game that isn't a bundle.
  const dl = links.find((link) => {
    const cat = String(link?.top_category || '');
    const name = String(link?.name || '');
    return cat === 'downloadable_game'
      && !/bundle/i.test(name)
      && link?.id;
  });
  return dl?.id ? String(dl.id) : null;
}

function parseProductEnrichment(product) {
  if (!product || typeof product !== 'object') {
    return null;
  }
  const shots = Array.isArray(product.mediaList?.screenshots)
    ? product.mediaList.screenshots
      .map((row) => String(row?.url || '').trim())
      .filter(Boolean)
    : [];
  const desc = cleanStoreDescription(product.long_desc || product.longDesc || '');
  const star = product.star_rating || product.starRating || null;
  const starScore = star?.score != null ? Number(star.score) : null;
  const starTotal = star?.total != null ? Number(star.total) : null;
  const contentRating = product.content_rating || product.contentRating || null;
  const ratingLabel = String(
    contentRating?.description
    || contentRating?.name
    || '',
  ).trim() || null;

  if (!desc && !shots.length && starScore == null) {
    return null;
  }
  return {
    productId: String(product.id || '').trim() || null,
    shortDescription: desc || '',
    screenshots: shots.slice(0, 3),
    allScreenshotCount: shots.length,
    starRating: Number.isFinite(starScore) ? starScore : null,
    starRatingCount: Number.isFinite(starTotal) ? starTotal : null,
    contentRating: ratingLabel,
    publisher: String(product.provider_name || product.providerName || '').trim() || null,
    source: 'chihiro',
  };
}

/**
 * Resolve titleId → Store enrichment. Cached; never throws.
 */
async function fetchStoreEnrichmentForTitle({
  titleId,
  name = '',
  country = 'US',
  lang = 'en',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) {
  const key = String(titleId || '').trim().toUpperCase();
  if (!key) {
    return null;
  }
  const cached = cache.get(key);
  const nowMs = typeof now === 'function' ? now() : now;
  if (cached && (nowMs - cached.at) < (cached.value ? CACHE_TTL_MS : MISS_CACHE_TTL_MS)) {
    return cached.value;
  }

  try {
    const titleContainer = await fetchJson(chihiroContainerUrl(key, { country, lang }), {
      timeoutMs,
      fetchImpl,
    });
    let productId = pickFullGameProductId(titleContainer);

    // Name tumbler fallback when title container has no Full Game link.
    if (!productId && name) {
      const q = encodeURIComponent(String(name).trim());
      const tumbler = await fetchJson(
        `https://store.playstation.com/store/api/chihiro/00_09_000/tumbler/${country}/${lang}/999/${q}?suggested_size=10&mode=game`,
        { timeoutMs, fetchImpl },
      );
      const links = Array.isArray(tumbler?.links) ? tumbler.links : [];
      const nameNeedle = String(name).trim().toLowerCase();
      const match = links.find((link) => {
        const n = String(link?.name || link?.title_name || '').toLowerCase();
        return n && (n === nameNeedle || n.includes(nameNeedle) || nameNeedle.includes(n.split(' ps')[0].trim()));
      }) || links[0];
      productId = match?.id ? String(match.id) : null;
    }

    if (!productId) {
      cache.set(key, { at: nowMs, value: null });
      return null;
    }

    // Try the requested storefront first, then the one the product id belongs to.
    const regions = [{ country, lang }];
    const home = regionForProductId(productId);
    if (home && (home.country !== country || home.lang !== lang)) {
      regions.push(home);
    }

    let value = null;
    for (const region of regions) {
      const product = await fetchJson(chihiroContainerUrl(productId, region), {
        timeoutMs,
        fetchImpl,
      });
      value = parseProductEnrichment(product);
      if (value) {
        break;
      }
    }
    cache.set(key, { at: nowMs, value });
    return value;
  } catch {
    cache.set(key, { at: nowMs, value: null });
    return null;
  }
}

function clearStoreEnrichmentCache() {
  cache.clear();
}

module.exports = {
  stripHtml,
  cleanStoreDescription,
  chihiroContainerUrl,
  regionForProductId,
  pickFullGameProductId,
  parseProductEnrichment,
  fetchStoreEnrichmentForTitle,
  clearStoreEnrichmentCache,
  DEFAULT_TIMEOUT_MS,
  CACHE_TTL_MS,
  MISS_CACHE_TTL_MS,
};
