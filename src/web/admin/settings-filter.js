'use strict';

/**
 * Settings catalog filter — shared by the admin page and Node tests.
 *
 * Push hides category tabs that have no hits for the current search; Settings
 * does the same. Empty search keeps every tab. An explicit pane click is still
 * honored, and the active tab stays visible even at zero hits.
 */

const SETTINGS_VIEW_ORDER = Object.freeze([
  'global', 'accounts', 'youtube', 'games', 'news', 'language', 'travel', 'media',
]);

function normalizeSearchQuery(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function matchesSearchQuery(haystack, query) {
  const q = normalizeSearchQuery(query);
  if (!q) return true;
  const hay = String(haystack || '').toLowerCase().replace(/\s+/g, ' ');
  return q.split(' ').every((term) => term && hay.includes(term));
}

function decodeEntities(text) {
  return String(text || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function htmlToSearchText(html) {
  return decodeEntities(String(html || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' '))
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function attr(tag, name) {
  const match = new RegExp(`\\b${name}="([^"]*)"`, 'i').exec(tag);
  return match ? decodeEntities(match[1]) : '';
}

function classList(tag) {
  return attr(tag, 'class').split(/\s+/).filter(Boolean);
}

function hasClass(tag, name) {
  return classList(tag).includes(name);
}

/** Walk `<div>…</div>` pairs and return top-level blocks (depth 1). */
function topLevelDivs(html) {
  const blocks = [];
  let depth = 0;
  let i = 0;
  let start = -1;
  while (i < html.length) {
    const open = html.indexOf('<div', i);
    const close = html.indexOf('</div>', i);
    if (close < 0) break;
    if (open >= 0 && open < close) {
      if (depth === 0) start = open;
      depth += 1;
      i = open + 4;
    } else {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        blocks.push(html.slice(start, close + 6));
        start = -1;
      }
      i = close + 6;
    }
  }
  return blocks;
}

function sliceElementInner(html, id) {
  const marker = `id="${id}"`;
  const at = html.indexOf(marker);
  if (at < 0) {
    throw new Error(`${id} not found`);
  }
  const open = html.lastIndexOf('<div', at);
  const innerStart = html.indexOf('>', at) + 1;
  const blocks = topLevelDivs(html.slice(open));
  if (!blocks.length) {
    throw new Error(`${id} has no children`);
  }
  // topLevelDivs from the opening tag returns the grid itself as the only
  // depth-0 block. Its inner HTML is what we want.
  const grid = blocks[0];
  return grid.slice(grid.indexOf('>') + 1, grid.lastIndexOf('</div>'));
}

function cardMeta(block) {
  const tagEnd = block.indexOf('>');
  const tag = block.slice(0, tagEnd + 1);
  const placeholders = [...block.matchAll(/\bplaceholder="([^"]*)"/g)].map((m) => decodeEntities(m[1]));
  const options = [...block.matchAll(/<option\b[^>]*>([\s\S]*?)<\/option>/gi)]
    .map((m) => htmlToSearchText(m[1]));
  const nestedHeading = [...topLevelDivs(block.slice(tagEnd + 1))]
    .find((child) => hasClass(child.slice(0, child.indexOf('>') + 1), 'section-label'));
  return {
    id: attr(tag, 'id'),
    group: attr(tag, 'data-settings-group'),
    className: attr(tag, 'class'),
    searchTerms: attr(tag, 'data-search-terms'),
    displayKinds: attr(tag, 'data-display-kinds'),
    text: htmlToSearchText(block),
    placeholders,
    options,
    nestedHeading: nestedHeading
      ? htmlToSearchText(nestedHeading)
      : '',
  };
}

/**
 * Direct children of `#settings-card-grid` must be heading, then one or more
 * cards. A heading nested *inside* a card is a bug — search and show/hide
 * both key off the sibling heading.
 */
function extractSettingsCatalog(html) {
  const inner = sliceElementInner(html, 'settings-card-grid');
  const children = topLevelDivs(inner);
  const cards = [];
  const headings = [];
  let pendingHeading = null;
  const errors = [];

  for (const block of children) {
    const tag = block.slice(0, block.indexOf('>') + 1);
    const group = attr(tag, 'data-settings-group');
    if (hasClass(tag, 'section-label')) {
      pendingHeading = { group, text: htmlToSearchText(block), raw: block };
      headings.push(pendingHeading);
      continue;
    }
    if (!hasClass(tag, 'card')) {
      continue;
    }
    const meta = cardMeta(block);
    if (meta.nestedHeading) {
      errors.push(`${meta.id || meta.className} hides its heading inside the card ("${meta.nestedHeading}")`);
    }
    if (!pendingHeading || pendingHeading.group !== meta.group) {
      // Same-pane run of cards may share the last heading (Accounts).
      const shared = [...headings].reverse().find((h) => h.group === meta.group);
      if (!shared) {
        errors.push(`${meta.id || meta.className} has no sibling heading in pane "${meta.group}"`);
      }
      pendingHeading = shared || pendingHeading;
    }
    const haystack = [
      meta.text,
      meta.searchTerms,
      meta.placeholders.join(' '),
      meta.options.join(' '),
      pendingHeading?.text || '',
    ].join(' ');
    cards.push({
      id: meta.id,
      group: meta.group,
      className: meta.className,
      heading: pendingHeading?.text || '',
      haystack: haystack.toLowerCase().replace(/\s+/g, ' ').trim(),
      kinds: settingsCardKinds(meta),
    });
  }

  return { cards, headings, errors };
}

function parseKindList(value) {
  return String(value || '')
    .split(/[\s,|]+/)
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part === 'full' || part === 'vestaboard');
}

const SETTINGS_CARD_KINDS = Object.freeze({
  'locale-settings-card': ['full', 'vestaboard'],
  'public-url-settings-card': ['full', 'vestaboard'],
  'tinyurl-settings-card': ['full', 'vestaboard'],
  'guest-snaps-settings-card': ['full', 'vestaboard'],
  'guest-book-settings-card': ['vestaboard'],
  'ring-doorbell-settings-card': ['vestaboard'],
  'weather-alerts-settings-card': ['vestaboard'],
  'world-population-settings-card': ['vestaboard'],
  'calendar-clock-settings-card': ['vestaboard'],
  'word-clock-settings-card': ['vestaboard'],
  'red-letter-settings-card': ['vestaboard'],
  'youtube-settings-card': ['full'],
  'upside-news-settings-card': ['full', 'vestaboard'],
  'learn-japanese-settings-card': ['vestaboard'],
  'learn-portuguese-settings-card': ['vestaboard'],
  'learn-spanish-settings-card': ['vestaboard'],
  'learn-french-settings-card': ['vestaboard'],
  'learn-german-settings-card': ['vestaboard'],
  'learn-italian-settings-card': ['vestaboard'],
  'chuck-norris-settings-card': ['vestaboard'],
  'roast-me-settings-card': ['vestaboard'],
  'family-quotes-settings-card': ['vestaboard'],
  'warm-fuzzies-settings-card': ['vestaboard'],
  'daily-bucket-fillers-settings-card': ['vestaboard'],
  'misheard-lyrics-settings-card': ['vestaboard'],
  'periodic-table-settings-card': ['vestaboard'],
  'us-state-facts-settings-card': ['vestaboard'],
  'word-of-the-day-settings-card': ['vestaboard'],
  'dad-jokes-settings-card': ['vestaboard'],
  'us-weather-map-settings-card': ['vestaboard'],
  'amazing-facts-settings-card': ['vestaboard'],
  'world-geography-facts-settings-card': ['vestaboard'],
  'conversation-starters-settings-card': ['vestaboard'],
  'stoic-quotes-settings-card': ['vestaboard'],
  'on-this-day-settings-card': ['vestaboard'],
  'baking-inspiration-settings-card': ['vestaboard'],
  'stock-market-settings-card': ['vestaboard'],
  'currency-rates-settings-card': ['vestaboard'],
  'plex-top10-settings-card': ['vestaboard'],
  'wiki-ck-settings-card': ['full', 'vestaboard'],
  'starlink-tracker-settings-card': ['vestaboard'],
  'space-launch-alerts-settings-card': ['vestaboard'],
  'iss-tracker-settings-card': ['vestaboard'],
  'overhead-settings-card': ['full', 'vestaboard'],
  'flightplan-settings-card': ['full', 'vestaboard'],
  'autodarts-settings-card': ['full', 'vestaboard'],
  'huupe-settings-card': ['full', 'vestaboard'],
  'trivia-settings-card': ['full', 'vestaboard'],
  'word-scramble-settings-card': ['vestaboard'],
  'word-riddles-settings-card': ['vestaboard'],
  'plex-settings-card': ['vestaboard'],
  'credits-settings-card': ['full', 'vestaboard'],
  'vb-settings-card': ['vestaboard'],
});

function settingsCardKinds(meta) {
  const fromAttr = parseKindList(meta.displayKinds);
  if (fromAttr.length) return fromAttr;
  if (meta.id && SETTINGS_CARD_KINDS[meta.id]) {
    return [...SETTINGS_CARD_KINDS[meta.id]];
  }
  const classes = String(meta.className || '').split(/\s+/);
  if (classes.includes('slideshow-settings-card')) return ['full'];
  if (classes.includes('vb-settings-card')) return ['vestaboard'];
  if (meta.group === 'accounts') return ['full', 'vestaboard'];
  return ['full', 'vestaboard'];
}

function kindsMatchFilter(kinds, filter) {
  if (!filter || filter === 'all') return true;
  const list = Array.isArray(kinds) && kinds.length ? kinds : ['full', 'vestaboard'];
  return list.includes(filter);
}

/**
 * @param {object} options
 * @param {Record<string, number>} options.counts
 * @param {string} [options.query]
 * @param {string} [options.kindFilter]
 * @param {string} [options.activeView]
 * @param {string|null} [options.preferredView] explicit tab click — never bounce
 */
function decideSettingsFilter({
  counts = {},
  query = '',
  kindFilter = 'all',
  activeView = 'global',
  preferredView = null,
} = {}) {
  const q = normalizeSearchQuery(query);
  const views = SETTINGS_VIEW_ORDER;
  const total = views.reduce((sum, name) => sum + (counts[name] || 0), 0);
  const explicit = views.includes(preferredView);
  let view = explicit ? preferredView
    : views.includes(activeView) ? activeView
      : 'global';
  if (!explicit && (q || kindFilter !== 'all') && (counts[view] || 0) === 0) {
    view = views.find((name) => (counts[name] || 0) > 0) || view;
  }
  const tabs = {};
  for (const name of views) {
    const count = counts[name] || 0;
    const active = name === view;
    tabs[name] = {
      hidden: Boolean(q) && count === 0 && !active,
      count,
      active,
    };
  }
  return { view, total, tabs, empty: total === 0, query: q, kindFilter };
}

function filterSettingsCatalog(cards, {
  query = '',
  kindFilter = 'all',
  activeView = 'global',
  preferredView = null,
} = {}) {
  const counts = Object.fromEntries(SETTINGS_VIEW_ORDER.map((view) => [view, 0]));
  const matches = [];
  for (const card of cards) {
    const hit = matchesSearchQuery(card.haystack, query)
      && kindsMatchFilter(card.kinds, kindFilter);
    if (hit) {
      matches.push(card);
      if (counts[card.group] != null) counts[card.group] += 1;
    }
  }
  const decided = decideSettingsFilter({
    counts,
    query,
    kindFilter,
    activeView,
    preferredView,
  });
  return {
    ...decided,
    matches,
    counts,
    visible: matches.filter((card) => card.group === decided.view),
  };
}

const api = {
  SETTINGS_VIEW_ORDER,
  SETTINGS_CARD_KINDS,
  normalizeSearchQuery,
  matchesSearchQuery,
  htmlToSearchText,
  extractSettingsCatalog,
  settingsCardKinds,
  kindsMatchFilter,
  decideSettingsFilter,
  filterSettingsCatalog,
};

if (typeof module === 'object' && module.exports) {
  module.exports = api;
}
if (typeof globalThis !== 'undefined') {
  globalThis.SignalSettingsFilter = api;
}
