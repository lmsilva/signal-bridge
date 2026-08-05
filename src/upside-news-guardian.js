/**
 * Guardian Open Platform client for The Upside News.
 * https://open-platform.theguardian.com/documentation/
 */

const { stripHtml, firstSentence, decodeHtmlEntities } = require('./upside-news-text');
const { resolveTopicId } = require('./upside-news-categories');

const CONTENT_API = 'https://content.theguardian.com/search';

async function guardianSearch({
  apiKey,
  fromDate,
  toDate,
  section,
  page = 1,
  pageSize = 50,
  fetchImpl = fetch,
} = {}) {
  const key = String(apiKey || '').trim();
  if (!key) {
    return { ok: false, error: 'Guardian API key is not configured', results: [] };
  }
  const url = new URL(CONTENT_API);
  url.searchParams.set('api-key', key);
  url.searchParams.set('page', String(page));
  url.searchParams.set('page-size', String(Math.min(50, Math.max(1, pageSize))));
  url.searchParams.set('order-by', 'newest');
  url.searchParams.set('show-fields', 'headline,trailText,byline,shortUrl,wordcount,standfirst,bodyText,productionOffice');
  url.searchParams.set('show-tags', 'keyword,series,tone');
  url.searchParams.set('show-rights', 'all');
  url.searchParams.set('type', 'article');
  if (fromDate) {
    url.searchParams.set('from-date', fromDate);
  }
  if (toDate) {
    url.searchParams.set('to-date', toDate);
  }
  if (section) {
    url.searchParams.set('section', section);
  }

  let response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: 'application/json' },
    });
  } catch (error) {
    const cause = error?.cause;
    const causeBit = cause?.code || cause?.message || '';
    const detail = [error?.message, causeBit].filter(Boolean).join(' — ');
    return {
      ok: false,
      error: `Could not reach The Guardian API from the bridge (${detail || 'network error'})`,
      results: [],
    };
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    return {
      ok: false,
      error: `Guardian API ${response.status}${body ? `: ${body.slice(0, 160)}` : ''}`,
      results: [],
      status: response.status,
    };
  }

  const json = await response.json();
  const responseBody = json?.response;
  if (responseBody?.status && responseBody.status !== 'ok') {
    return {
      ok: false,
      error: responseBody.message || `Guardian status ${responseBody.status}`,
      results: [],
    };
  }

  const results = (responseBody?.results || []).map(normaliseGuardianResult).filter(Boolean);
  return {
    ok: true,
    results,
    pages: Number(responseBody?.pages) || 1,
    currentPage: Number(responseBody?.currentPage) || page,
    total: Number(responseBody?.total) || results.length,
  };
}

function normaliseGuardianResult(item) {
  if (!item?.id) {
    return null;
  }
  const fields = item.fields || {};
  const rights = item.rights || {};
  if (rights.syndicatable === 'false' || rights.syndicatable === false) {
    return null;
  }
  const headline = decodeHtmlEntities(fields.headline || item.webTitle || '');
  if (!headline) {
    return null;
  }
  let standfirst = stripHtml(fields.trailText || '');
  if (!standfirst) {
    standfirst = stripHtml(fields.standfirst || '');
  }
  if (!standfirst) {
    standfirst = firstSentence(fields.bodyText || '');
  }
  const tags = Array.isArray(item.tags) ? item.tags : [];
  const keywords = tags
    .filter((tag) => tag.type === 'keyword')
    .map((tag) => tag.webTitle)
    .filter(Boolean)
    .slice(0, 3);
  const sectionId = resolveTopicId(item.sectionId);
  return {
    id: `guardian:${item.id}`,
    sourceId: 'guardian',
    sourceLabel: 'The Guardian',
    externalId: item.id,
    headline,
    standfirst,
    sectionId,
    sectionName: item.sectionName || sectionId,
    publishedAt: item.webPublicationDate || null,
    url: fields.shortUrl || item.webUrl || null,
    webUrl: item.webUrl || null,
    byline: decodeHtmlEntities(fields.byline || ''),
    wordcount: Number(fields.wordcount) || null,
    productionOffice: String(fields.productionOffice || '').toLowerCase() || null,
    keywords,
    pillarName: item.pillarName || null,
    type: item.type || 'article',
    score: 0,
    corroboratingSources: 1,
  };
}

async function testGuardianKey(apiKey, { fetchImpl = fetch } = {}) {
  const result = await guardianSearch({
    apiKey,
    pageSize: 1,
    fetchImpl,
  });
  if (!result.ok) {
    return result;
  }
  return { ok: true, total: result.total };
}

/**
 * Pull articles for a date window across allowlisted sections.
 * Caps pages so we stay well under the free daily quota.
 */
async function fetchGuardianPeriod({
  apiKey,
  fromDate,
  toDate,
  sections = [],
  maxPagesPerSection = 2,
  fetchImpl = fetch,
  log = null,
} = {}) {
  const all = [];
  const list = sections.length ? sections : [null];
  for (const section of list) {
    for (let page = 1; page <= maxPagesPerSection; page += 1) {
      const batch = await guardianSearch({
        apiKey,
        fromDate,
        toDate,
        section,
        page,
        pageSize: 50,
        fetchImpl,
      });
      if (!batch.ok) {
        log?.warn?.('Guardian fetch failed', { section, page, error: batch.error });
        break;
      }
      all.push(...batch.results);
      if (page >= (batch.pages || 1)) {
        break;
      }
    }
  }
  return all;
}

module.exports = {
  guardianSearch,
  normaliseGuardianResult,
  testGuardianKey,
  fetchGuardianPeriod,
};
