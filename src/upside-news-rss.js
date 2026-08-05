/**
 * Positive-news RSS pollers for The Upside News archive.
 */

const { stripHtml, firstSentence, decodeHtmlEntities } = require('./upside-news-text');
const { resolveTopicId } = require('./upside-news-categories');
const { RSS_SOURCES } = require('./upside-news-settings');

function extractTag(block, tag) {
  const cdata = block.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i'));
  if (cdata) {
    return cdata[1].trim();
  }
  const plain = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return plain ? plain[1].trim() : '';
}

function parseRssItems(xml) {
  const text = String(xml || '');
  const items = [];
  const re = /<item\b[\s\S]*?<\/item>/gi;
  let match = re.exec(text);
  while (match) {
    items.push(match[0]);
    match = re.exec(text);
  }
  // Atom fallback.
  if (!items.length) {
    const atom = /<entry\b[\s\S]*?<\/entry>/gi;
    let entry = atom.exec(text);
    while (entry) {
      items.push(entry[0]);
      entry = atom.exec(text);
    }
  }
  return items.map((block) => {
    const title = decodeHtmlEntities(stripHtml(extractTag(block, 'title')));
    let link = extractTag(block, 'link');
    if (!link) {
      const href = block.match(/<link[^>]+href=["']([^"']+)["']/i);
      link = href ? href[1] : '';
    }
    link = stripHtml(link);
    const description = extractTag(block, 'description')
      || extractTag(block, 'summary')
      || extractTag(block, 'content:encoded')
      || extractTag(block, 'content');
    const pubDate = extractTag(block, 'pubDate')
      || extractTag(block, 'published')
      || extractTag(block, 'updated');
    const category = stripHtml(extractTag(block, 'category'));
    const author = stripHtml(
      extractTag(block, 'dc:creator')
      || extractTag(block, 'author')
      || extractTag(block, 'creator'),
    );
    if (!title || !link) {
      return null;
    }
    return {
      title,
      link,
      description,
      pubDate,
      category,
      author,
    };
  }).filter(Boolean);
}

function guessSection(category, title) {
  const hay = `${category || ''} ${title || ''}`.toLowerCase();
  if (/\b(climate|environment|rewild|wildlife|ocean|forest)\b/.test(hay)) {
    return 'environment';
  }
  if (/\b(health|medicine|hospital|vaccine|cancer)\b/.test(hay)) {
    return 'health';
  }
  if (/\b(science|space|nasa|research|discover)\b/.test(hay)) {
    return 'science';
  }
  if (/\b(school|student|education|literacy)\b/.test(hay)) {
    return 'education';
  }
  if (/\b(tech|ai|robot|software|app)\b/.test(hay)) {
    return 'technology';
  }
  if (/\b(sport|olympic|athlete|football|soccer)\b/.test(hay)) {
    return 'sport';
  }
  if (/\b(art|music|film|culture|book)\b/.test(hay)) {
    return 'culture';
  }
  if (/\b(aid|poverty|development|unicef|refugee)\b/.test(hay)) {
    return 'global-development';
  }
  return resolveTopicId(category) !== 'general'
    ? resolveTopicId(category)
    : 'general';
}

function normaliseRssItem(item, source) {
  const published = Date.parse(item.pubDate);
  const sectionId = guessSection(item.category, item.title);
  let standfirst = stripHtml(item.description || '');
  if (standfirst.length > 320) {
    standfirst = firstSentence(standfirst) || standfirst.slice(0, 280);
  }
  return {
    id: `${source.id}:${item.link}`,
    sourceId: source.id,
    sourceLabel: source.label,
    externalId: item.link,
    headline: item.title,
    standfirst,
    sectionId,
    sectionName: item.category || sectionId,
    publishedAt: Number.isFinite(published) ? new Date(published).toISOString() : new Date().toISOString(),
    url: item.link,
    webUrl: item.link,
    byline: item.author || '',
    wordcount: null,
    productionOffice: null,
    keywords: item.category ? [item.category] : [],
    pillarName: null,
    type: 'article',
    score: 0,
    corroboratingSources: 1,
  };
}

async function fetchRssSource(source, { fetchImpl = fetch, log = null } = {}) {
  if (!source?.url) {
    return { ok: false, error: 'Missing feed URL', results: [] };
  }
  let response;
  try {
    response = await fetchImpl(source.url, {
      headers: {
        Accept: 'application/rss+xml, application/xml, text/xml, */*',
        'User-Agent': 'SignalBridge-UpsideNews/1.0',
      },
    });
  } catch (error) {
    log?.warn?.('RSS fetch failed', { id: source.id, error: error?.message || error });
    return { ok: false, error: error?.message || String(error), results: [] };
  }
  if (!response.ok) {
    return { ok: false, error: `HTTP ${response.status}`, results: [] };
  }
  const xml = await response.text();
  const items = parseRssItems(xml).map((item) => normaliseRssItem(item, source));
  return { ok: true, results: items };
}

async function fetchEnabledRss({
  enabledIds = [],
  fetchImpl = fetch,
  log = null,
} = {}) {
  const results = [];
  const statuses = [];
  for (const id of enabledIds) {
    const source = RSS_SOURCES[id];
    if (!source) {
      continue;
    }
    const batch = await fetchRssSource(source, { fetchImpl, log });
    statuses.push({
      id: source.id,
      label: source.label,
      ok: batch.ok,
      count: batch.results?.length || 0,
      error: batch.error || null,
      fetchedAt: new Date().toISOString(),
    });
    if (batch.ok) {
      results.push(...batch.results);
    }
  }
  return { results, statuses };
}

module.exports = {
  parseRssItems,
  normaliseRssItem,
  fetchRssSource,
  fetchEnabledRss,
  guessSection,
};
