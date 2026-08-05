/**
 * Wikimedia REST / pageviews client with mandatory User-Agent.
 */

function buildUserAgent({ contactEmail = '', version = '1.0' } = {}) {
  const email = String(contactEmail || '').trim();
  if (!email || !email.includes('@')) {
    throw new Error('Wiki Common Knowledge requires a contact email for the Wikimedia User-Agent');
  }
  return `SignalBridge/${version} (https://github.com/local/signal-bridge; ${email})`;
}

/** Standard Wikimedia CDN thumbnail steps (non-standard sizes are blocked). */
const WIKIMEDIA_THUMB_STEPS = [320, 500, 960, 1280, 1920];

function pickWikimediaThumbStep(minWidth = 960) {
  const want = Math.max(1, Number(minWidth) || 960);
  for (const step of WIKIMEDIA_THUMB_STEPS) {
    if (step >= want) return step;
  }
  return WIKIMEDIA_THUMB_STEPS[WIKIMEDIA_THUMB_STEPS.length - 1];
}

/**
 * Prefer a bounded Wikimedia thumb over a multi-MB original.
 * Featured feeds often include a ~220–320px thumb; article heroes need ~960px.
 * Originals (especially TIFF/PNG) regularly time out on the display client.
 */
function wikimediaDisplayUrl(url, { minWidth = 960 } = {}) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  const step = pickWikimediaThumbStep(minWidth);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return raw;
  }
  if (!/upload\.wikimedia\.org$/i.test(parsed.hostname)) return raw;

  const path = parsed.pathname;
  const thumbPx = path.match(/\/(\d+)px-/);
  if (thumbPx) {
    const current = Number(thumbPx[1]);
    if (current >= step) return raw;
    parsed.pathname = path.replace(/\/\d+px-/, `/${step}px-`);
    return parsed.toString();
  }

  // Original file: /wikipedia/{project}/{a}/{ab}/{file}
  const original = path.match(/^\/wikipedia\/([^/]+)\/([0-9a-f])\/([0-9a-f]{2})\/([^/]+)$/i);
  if (!original) return raw;
  const [, project, a, ab, file] = original;
  const lower = file.toLowerCase();
  if (/\.(tif|tiff)$/i.test(lower)) {
    parsed.pathname = `/wikipedia/${project}/thumb/${a}/${ab}/${file}/lossy-page1-${step}px-${file}.jpg`;
    return parsed.toString();
  }
  if (/\.svg$/i.test(lower)) {
    parsed.pathname = `/wikipedia/${project}/thumb/${a}/${ab}/${file}/${step}px-${file}.png`;
    return parsed.toString();
  }
  if (/\.(pdf|djvu)$/i.test(lower)) return raw;
  parsed.pathname = `/wikipedia/${project}/thumb/${a}/${ab}/${file}/${step}px-${file}`;
  return parsed.toString();
}

/**
 * Ordered candidate URLs for display: sized thumb → raw thumb → sized original → original.
 */
function displayImageCandidates(article = {}, { minWidth = 960 } = {}) {
  const thumb = String(article.thumbnailUrl || '').trim();
  const original = String(article.originalImageUrl || article.imageUrl || '').trim();
  const out = [];
  const push = (value) => {
    const text = String(value || '').trim();
    if (text && !out.includes(text)) out.push(text);
  };
  if (thumb) {
    push(wikimediaDisplayUrl(thumb, { minWidth }));
    push(thumb);
  }
  if (original) {
    push(wikimediaDisplayUrl(original, { minWidth }));
    push(original);
  }
  return out;
}

function createLimiter(maxConcurrent = 3) {
  let active = 0;
  const queue = [];
  function runNext() {
    if (active >= maxConcurrent || !queue.length) return;
    const { fn, resolve, reject } = queue.shift();
    active += 1;
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        runNext();
      });
  }
  return function limit(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      runNext();
    });
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createWikiClient({
  contactEmail = '',
  apiToken = '',
  lang = 'en',
  fetchImpl = fetch,
  log = console,
  maxConcurrent = 3,
  version = '1.0',
} = {}) {
  const limit = createLimiter(maxConcurrent);
  let userAgent;
  try {
    userAgent = buildUserAgent({ contactEmail, version });
  } catch (error) {
    userAgent = null;
    log?.warn?.(error.message);
  }

  function headers() {
    const h = {
      Accept: 'application/json',
      'User-Agent': userAgent || 'SignalBridge/1.0 (missing-contact@example.invalid)',
    };
    if (apiToken) {
      h.Authorization = `Bearer ${apiToken}`;
    }
    return h;
  }

  async function request(url, { retries = 2 } = {}) {
    if (!userAgent) {
      throw new Error('Set contact email before calling Wikimedia APIs');
    }
    return limit(async () => {
      let lastError = null;
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
          const res = await fetchImpl(url, { headers: headers() });
          if (res.status === 429 && attempt < retries) {
            const retryAfter = Number(res.headers.get('retry-after') || 1);
            await sleep(Math.max(1, retryAfter) * 1000);
            continue;
          }
          if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`Wikimedia ${res.status}: ${body.slice(0, 200)}`);
          }
          return res.json();
        } catch (error) {
          lastError = error;
          if (attempt < retries) {
            await sleep(500 * (attempt + 1));
            continue;
          }
        }
      }
      throw lastError || new Error('Wikimedia request failed');
    });
  }

  function featuredUrl(yyyy, mm, dd) {
    return `https://api.wikimedia.org/feed/v1/wikipedia/${encodeURIComponent(lang)}/featured/${yyyy}/${mm}/${dd}`;
  }

  function pageviewsTopUrl(project, yyyy, mm, dd) {
    return `https://wikimedia.org/api/rest_v1/metrics/pageviews/top/${encodeURIComponent(project)}/all-access/${yyyy}/${mm}/${dd}`;
  }

  function summaryUrl(title) {
    return `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
  }

  function pageviewsArticleUrl(title, start, end) {
    const project = `${lang}.wikipedia`;
    return `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/${encodeURIComponent(project)}/all-access/user/${encodeURIComponent(title)}/daily/${start}/${end}`;
  }

  async function fetchFeatured(date = new Date()) {
    const yyyy = String(date.getUTCFullYear());
    const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(date.getUTCDate()).padStart(2, '0');
    return request(featuredUrl(yyyy, mm, dd));
  }

  async function fetchPageviewsTop(date = new Date()) {
    const yyyy = String(date.getUTCFullYear());
    const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(date.getUTCDate()).padStart(2, '0');
    const project = `${lang}.wikipedia`;
    return request(pageviewsTopUrl(project, yyyy, mm, dd));
  }

  async function fetchSummary(title) {
    return request(summaryUrl(title));
  }

  async function fetchPageviewHistory(title, days = 30, endDate = new Date()) {
    const end = new Date(endDate);
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - (days - 1));
    const fmt = (d) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
    const data = await request(pageviewsArticleUrl(title, fmt(start), fmt(end)));
    return (data.items || []).map((item) => ({
      date: item.timestamp,
      views: Number(item.views) || 0,
    }));
  }

  async function testConnection() {
    try {
      buildUserAgent({ contactEmail, version });
      const data = await fetchFeatured(new Date());
      const count = Array.isArray(data?.mostread?.articles) ? data.mostread.articles.length : 0;
      return { ok: true, articles: count };
    } catch (error) {
      return { ok: false, error: error.message || String(error) };
    }
  }

  return {
    buildUserAgent: () => buildUserAgent({ contactEmail, version }),
    setContactEmail(email) {
      contactEmail = email;
      try {
        userAgent = buildUserAgent({ contactEmail, version });
      } catch {
        userAgent = null;
      }
    },
    setLang(next) {
      lang = String(next || 'en');
    },
    setApiToken(token) {
      apiToken = String(token || '');
    },
    fetchFeatured,
    fetchPageviewsTop,
    fetchSummary,
    fetchPageviewHistory,
    testConnection,
  };
}

/** Normalise featured mostread article into a common shape. */
function normaliseFeaturedArticle(raw = {}, rank = 1) {
  const title = String(raw.normalizedtitle || raw.title || '').replace(/_/g, ' ').trim();
  const views = Number(raw.views) || 0;
  const viewsDelta = Number(raw.views_delta ?? raw.view_history_delta ?? 0) || 0;
  const prev = views - viewsDelta;
  const viewsDeltaPct = prev > 0 ? Math.round((viewsDelta / prev) * 1000) / 10 : null;
  const thumbnail = raw.thumbnail?.source || raw.originalimage?.source || '';
  return {
    pageid: raw.pageid || null,
    title,
    description: String(raw.description || '').trim(),
    extract: String(raw.extract || '').trim(),
    thumbnailUrl: thumbnail,
    originalImageUrl: raw.originalimage?.source || thumbnail || '',
    contentUrl: raw.content_urls?.desktop?.page
      || (title ? `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}` : ''),
    views,
    viewsDelta,
    viewsDeltaPct,
    rank: Number(raw.rank) || rank,
    history: Array.isArray(raw.view_history)
      ? raw.view_history.map((h) => ({ date: h.date, views: Number(h.views) || 0 }))
      : [],
  };
}

function articlesFromFeatured(featured = {}) {
  const list = featured?.mostread?.articles;
  if (!Array.isArray(list)) return [];
  return list.map((item, i) => normaliseFeaturedArticle(item, i + 1));
}

module.exports = {
  buildUserAgent,
  createWikiClient,
  normaliseFeaturedArticle,
  articlesFromFeatured,
  wikimediaDisplayUrl,
  displayImageCandidates,
  pickWikimediaThumbStep,
  WIKIMEDIA_THUMB_STEPS,
};
