/**
 * Description → topic category map + artwork registry for Wiki Common Knowledge.
 */

const fs = require('fs');
const path = require('path');

const ARTWORK_ROUTE_PREFIX = '/wiki-common-knowledge-artwork/';

/** Specific rules first; first match wins. */
const CATEGORY_RULES = [
  { id: 'space', keywords: ['astronaut', 'spacecraft', 'nasa', 'esa', 'astronomy', 'galaxy', 'planet', 'moon', 'mars', 'telescope', 'orbit', 'satellite', 'comet', 'asteroid'] },
  { id: 'film', keywords: ['film', 'movie', 'cinema', 'actor', 'actress', 'director', 'oscar', 'hollywood', 'hollywoodvision'] },
  { id: 'music', keywords: ['musician', 'singer', 'album', 'band', 'composer', 'song', 'orchestra', 'rapper', 'pianist'] },
  { id: 'sports', keywords: ['footballer', 'athlete', 'olympics', 'championship', 'cricketer', 'tennis', 'basketball', 'racing driver', 'boxer', 'swimmer'] },
  { id: 'politics', keywords: ['politician', 'president', 'prime minister', 'senator', 'parliament', 'election', 'minister', 'diplomat', 'mayor'] },
  { id: 'science', keywords: ['physicist', 'chemist', 'biologist', 'scientist', 'researcher', 'discovery', 'experiment', 'nobel'] },
  { id: 'technology', keywords: ['software', 'computer', 'programmer', 'internet', 'app', 'startup', 'ai ', 'artificial intelligence', 'engineer'] },
  { id: 'history', keywords: ['historian', 'empire', 'century', 'war of', 'revolution', 'ancient', 'medieval', 'dynasty'] },
  { id: 'people', keywords: ['born', 'died', 'american ', 'british ', 'canadian ', 'australian ', 'writer', 'author', 'activist'] },
  { id: 'geography', keywords: ['city', 'capital', 'country', 'island', 'river', 'mountain', 'province', 'region of'] },
  { id: 'nature', keywords: ['species', 'animal', 'plant', 'bird', 'mammal', 'conservation', 'wildlife', 'forest', 'ocean'] },
  { id: 'culture', keywords: ['museum', 'festival', 'tradition', 'cuisine', 'language', 'literature', 'theatre', 'fashion'] },
  { id: 'business', keywords: ['company', 'corporation', 'ceo', 'businessman', 'entrepreneur', 'brand', 'retail'] },
  { id: 'health', keywords: ['disease', 'medicine', 'doctor', 'hospital', 'vaccine', 'medical', 'physician', 'surgeon'] },
  { id: 'gaming', keywords: ['video game', 'videogame', 'esports', 'game developer', 'nintendo', 'playstation', 'xbox'] },
  { id: 'food', keywords: ['chef', 'restaurant', 'cuisine', 'recipe', 'food', 'cook'] },
  { id: 'transport', keywords: ['aircraft', 'airline', 'railway', 'locomotive', 'ship', 'automobile', 'car '] },
  { id: 'architecture', keywords: ['architect', 'building', 'skyscraper', 'cathedral', 'bridge', 'monument'] },
  { id: 'religion', keywords: ['church', 'temple', 'mosque', 'religion', 'bishop', 'priest', 'theology'] },
  { id: 'misc', keywords: [] },
];

const TOPIC_META = {
  space: { label: 'Space', accent: '#7DD3FC', background: '#0C4A6E' },
  film: { label: 'Film', accent: '#F9A8D4', background: '#831843' },
  music: { label: 'Music', accent: '#C4B5FD', background: '#4C1D95' },
  sports: { label: 'Sports', accent: '#86EFAC', background: '#14532D' },
  politics: { label: 'Politics', accent: '#FCA5A5', background: '#7F1D1D' },
  science: { label: 'Science', accent: '#A5B4FC', background: '#312E81' },
  technology: { label: 'Technology', accent: '#67E8F9', background: '#164E63' },
  history: { label: 'History', accent: '#FCD34D', background: '#78350F' },
  people: { label: 'People', accent: '#FDA4AF', background: '#9F1239' },
  geography: { label: 'Geography', accent: '#6EE7B7', background: '#064E3B' },
  nature: { label: 'Nature', accent: '#BBF7D0', background: '#14532D' },
  culture: { label: 'Culture', accent: '#F0ABFC', background: '#701A75' },
  business: { label: 'Business', accent: '#FDE68A', background: '#713F12' },
  health: { label: 'Health', accent: '#FBCFE8', background: '#9D174D' },
  gaming: { label: 'Gaming', accent: '#A5F3FC', background: '#155E75' },
  food: { label: 'Food', accent: '#FDBA74', background: '#9A3412' },
  transport: { label: 'Transport', accent: '#93C5FD', background: '#1E3A8A' },
  architecture: { label: 'Architecture', accent: '#D4D4D8', background: '#3F3F46' },
  religion: { label: 'Religion', accent: '#E9D5FF', background: '#581C87' },
  misc: { label: 'General', accent: '#E897FF', background: '#7A2396' },
};

const unmatchedLog = [];

function categoriseDescription(description = '') {
  const text = String(description || '').toLowerCase();
  for (const rule of CATEGORY_RULES) {
    if (!rule.keywords.length) continue;
    if (rule.keywords.some((kw) => text.includes(kw))) {
      return rule.id;
    }
  }
  unmatchedLog.push({
    at: new Date().toISOString(),
    description: String(description || '').slice(0, 240),
  });
  if (unmatchedLog.length > 200) unmatchedLog.splice(0, unmatchedLog.length - 200);
  return 'misc';
}

function topicIds() {
  return Object.keys(TOPIC_META);
}

function listTopics() {
  return topicIds().map((id) => ({ id, ...TOPIC_META[id] }));
}

function artworkUrls(baseUrl, topicId) {
  const id = TOPIC_META[topicId] ? topicId : 'misc';
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const prefix = base
    ? `${base}/wiki-common-knowledge-artwork`
    : '/wiki-common-knowledge-artwork';
  return {
    topicId: id,
    imageUrl: `${prefix}/${id}.jpg`,
    fallbackUrl: `${prefix}/misc.jpg`,
  };
}

function loadArtworkDir(root) {
  return path.resolve(root, 'src', 'web', 'wiki-common-knowledge-artwork');
}

function ensureArtworkPlaceholders(root, log = console) {
  const dir = loadArtworkDir(root);
  try {
    fs.mkdirSync(dir, { recursive: true });
    // Prefer copying Upside news artwork when present for visual parity.
    const upsideDir = path.resolve(root, 'src', 'web', 'upside-news-artwork');
    const upsideMap = {
      space: 'science',
      film: 'culture',
      music: 'culture',
      sports: 'sport',
      politics: 'society',
      science: 'science',
      technology: 'technology',
      history: 'society',
      people: 'society',
      geography: 'environment',
      nature: 'environment',
      culture: 'culture',
      business: 'society',
      health: 'science',
      gaming: 'technology',
      food: 'culture',
      transport: 'technology',
      architecture: 'culture',
      religion: 'society',
      misc: 'misc',
    };
    for (const id of topicIds()) {
      const dest = path.join(dir, `${id}.jpg`);
      if (fs.existsSync(dest)) continue;
      const srcName = upsideMap[id] || 'misc';
      const src = path.join(upsideDir, `${srcName}.jpg`);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dest);
      }
    }
  } catch (error) {
    log?.warn?.('Wiki artwork setup failed', error?.message || error);
  }
  return dir;
}

function getUnmatchedLog() {
  return unmatchedLog.slice(-50);
}

module.exports = {
  ARTWORK_ROUTE_PREFIX,
  CATEGORY_RULES,
  TOPIC_META,
  categoriseDescription,
  topicIds,
  listTopics,
  artworkUrls,
  loadArtworkDir,
  ensureArtworkPlaceholders,
  getUnmatchedLog,
};
