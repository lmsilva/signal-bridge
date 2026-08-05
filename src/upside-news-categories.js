/**
 * Topic artwork registry for The Upside News (goodnews.md §6.3).
 * Guardian sectionId → local topic pack; unmapped sections fall back to `general`.
 */

const fs = require('fs');
const path = require('path');

const ARTWORK_ROUTE_PREFIX = '/upside-news-artwork/';

/** Guardian sectionId aliases → our topic ids. */
const SECTION_ALIASES = {
  environment: 'environment',
  science: 'science',
  society: 'society',
  lifeandstyle: 'society',
  health: 'health',
  healthcare: 'health',
  world: 'world',
  uk: 'world',
  us: 'world',
  australia: 'world',
  'global-development': 'global-development',
  technology: 'technology',
  culture: 'culture',
  books: 'culture',
  film: 'culture',
  music: 'culture',
  artanddesign: 'culture',
  stage: 'culture',
  education: 'education',
  wildlife: 'wildlife',
  animals: 'wildlife',
  sport: 'sport',
  football: 'sport',
  business: 'business',
  money: 'business',
};

let cached = null;

function loadManifest() {
  const candidates = [
    path.join(__dirname, 'upside-news-categories.json'),
    path.join(__dirname, 'web', 'upside-news-artwork', 'categories.json'),
    path.resolve(__dirname, '..', 'dev assets', 'news-topic-artwork', 'categories.json'),
  ];
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) {
        continue;
      }
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(raw?.categories) && raw.categories.length) {
        return raw.categories;
      }
    } catch {
      // try next
    }
  }
  return [];
}

function listTopics() {
  if (cached) {
    return cached;
  }
  cached = loadManifest().map((entry) => ({
    id: entry.id,
    label: entry.label || entry.id,
    pattern: entry.pattern || null,
    background: entry.background || '#7A2396',
    accent: entry.accent || '#E897FF',
    files: {
      portrait: entry.files?.portrait || `${entry.id}-portrait.jpg`,
      landscape: entry.files?.landscape || `${entry.id}-landscape.jpg`,
    },
  }));
  return cached;
}

function getTopic(id) {
  const key = String(id || '').trim().toLowerCase();
  return listTopics().find((topic) => topic.id === key) || null;
}

function resolveTopicId(sectionId) {
  const raw = String(sectionId || '').trim().toLowerCase();
  if (!raw) {
    return 'general';
  }
  if (getTopic(raw)) {
    return raw;
  }
  if (SECTION_ALIASES[raw]) {
    return SECTION_ALIASES[raw];
  }
  // Guardian sometimes uses nested ids; take the last segment.
  const tail = raw.split('/').pop();
  if (tail && getTopic(tail)) {
    return tail;
  }
  if (tail && SECTION_ALIASES[tail]) {
    return SECTION_ALIASES[tail];
  }
  return 'general';
}

function resolveTopic(sectionId) {
  const id = resolveTopicId(sectionId);
  return getTopic(id) || getTopic('general') || {
    id: 'general',
    label: 'Good News',
    background: '#7A2396',
    accent: '#E897FF',
    files: { portrait: 'general-portrait.jpg', landscape: 'general-landscape.jpg' },
  };
}

function artworkUrls(baseUrl, sectionId) {
  const topic = resolveTopic(sectionId);
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const portrait = topic.files.portrait;
  const landscape = topic.files.landscape;
  if (!base) {
    return { portrait: null, landscape: null, topicId: topic.id };
  }
  return {
    portrait: `${base}${ARTWORK_ROUTE_PREFIX}${portrait}`,
    landscape: `${base}${ARTWORK_ROUTE_PREFIX}${landscape}`,
    topicId: topic.id,
  };
}

function topicIds() {
  return listTopics().map((topic) => topic.id);
}

module.exports = {
  ARTWORK_ROUTE_PREFIX,
  SECTION_ALIASES,
  listTopics,
  getTopic,
  resolveTopicId,
  resolveTopic,
  artworkUrls,
  topicIds,
};
