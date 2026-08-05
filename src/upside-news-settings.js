/**
 * Persisted settings for The Upside News (goodnews.md §1 / §8).
 */

const fs = require('fs');
const path = require('path');
const { topicIds } = require('./upside-news-categories');

const PERIODS = ['daily', 'weekly', 'monthly', 'yearly'];
const LOOP_MODES = ['once', '2', '3', 'until-dismissed'];
const REGIONS = ['any', 'uk', 'us', 'aus'];

const DEFAULT_DENYLIST = [
  'killed', 'dies', 'death', 'murder', 'war', 'attack', 'crisis', 'scandal',
  'abuse', 'jailed', 'arrested', 'collapse', 'outbreak', 'layoffs', 'resign',
  'backlash', 'warns', 'fears',
];

const DEFAULT_BOOSTLIST = [
  'first', 'breakthrough', 'recovery', 'restored', 'saved', 'record',
  'milestone', 'doubled', 'cure', 'discovered', 'revived', 'wins',
  'thriving', 'comeback', 'rewilding',
];

const DEFAULT_SECTIONS = [
  'environment', 'science', 'global-development', 'society',
  'technology', 'culture', 'education', 'sport',
];

const RSS_SOURCES = {
  'good-news-network': {
    id: 'good-news-network',
    label: 'Good News Network',
    url: 'https://www.goodnewsnetwork.org/feed/',
  },
  'positive-news': {
    id: 'positive-news',
    label: 'Positive News',
    url: 'https://www.positive.news/feed/',
  },
  'reasons-to-be-cheerful': {
    id: 'reasons-to-be-cheerful',
    label: 'Reasons to be Cheerful',
    url: 'https://reasonstobecheerful.world/feed/',
  },
  'optimist-daily': {
    id: 'optimist-daily',
    label: 'The Optimist Daily',
    url: 'https://www.optimistdaily.com/feed/',
  },
};

function defaultSettings() {
  return {
    period: 'daily',
    items: 5,
    indexSeconds: null, // null = auto from items
    storySeconds: 15,
    loops: 'once',
    guardianEnabled: true,
    enabledRssSourceIds: [
      'good-news-network',
      'positive-news',
      'reasons-to-be-cheerful',
    ],
    enabledSectionIds: DEFAULT_SECTIONS,
    region: 'any',
    denylist: DEFAULT_DENYLIST,
    boostlist: DEFAULT_BOOSTLIST,
    showQr: true,
    showReadingTime: true,
    showTopicTags: false,
    pollIntervalMinutes: 60,
  };
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(n)));
}

function sanitiseList(value, fallback) {
  if (!Array.isArray(value)) {
    return [...fallback];
  }
  const cleaned = [...new Set(value.map((item) => String(item || '').trim().toLowerCase())
    .filter(Boolean))];
  return cleaned.length ? cleaned : [...fallback];
}

function indexSecondsFor(items, override = null) {
  if (override != null && Number.isFinite(Number(override))) {
    return clampInt(override, 6, 60, Math.round(4 + 1.6 * items));
  }
  return Math.max(6, Math.round(4 + 1.6 * items));
}

function cycleSecondsFor({ items = 5, indexSeconds = null, storySeconds = 15 } = {}) {
  const count = clampInt(items, 3, 8, 5);
  const index = indexSecondsFor(count, indexSeconds);
  const story = clampInt(storySeconds, 8, 30, 15);
  return index + (count * story);
}

function sanitiseSettings(raw = {}, base = defaultSettings()) {
  const merged = { ...base, ...(raw || {}) };
  const period = PERIODS.includes(merged.period) ? merged.period : base.period;
  const items = clampInt(merged.items, 3, 8, base.items);
  const loops = LOOP_MODES.includes(String(merged.loops))
    ? String(merged.loops)
    : base.loops;
  const region = REGIONS.includes(String(merged.region || '').toLowerCase())
    ? String(merged.region).toLowerCase()
    : base.region;
  const knownRss = Object.keys(RSS_SOURCES);
  const enabledRss = sanitiseList(merged.enabledRssSourceIds, base.enabledRssSourceIds)
    .filter((id) => knownRss.includes(id));
  const knownTopics = new Set(topicIds());
  const enabledSections = sanitiseList(merged.enabledSectionIds, base.enabledSectionIds)
    .filter((id) => knownTopics.has(id) || DEFAULT_SECTIONS.includes(id));

  let indexSeconds = merged.indexSeconds;
  if (indexSeconds === '' || indexSeconds === undefined) {
    indexSeconds = null;
  } else if (indexSeconds != null) {
    indexSeconds = clampInt(indexSeconds, 6, 60, indexSecondsFor(items));
  }

  return {
    period,
    items,
    indexSeconds,
    storySeconds: clampInt(merged.storySeconds, 8, 30, base.storySeconds),
    loops,
    guardianEnabled: merged.guardianEnabled !== false,
    enabledRssSourceIds: enabledRss.length ? enabledRss : [...base.enabledRssSourceIds],
    enabledSectionIds: enabledSections.length ? enabledSections : [...base.enabledSectionIds],
    region,
    denylist: sanitiseList(merged.denylist, base.denylist),
    boostlist: sanitiseList(merged.boostlist, base.boostlist),
    showQr: merged.showQr !== false,
    showReadingTime: merged.showReadingTime !== false,
    showTopicTags: merged.showTopicTags === true,
    pollIntervalMinutes: clampInt(merged.pollIntervalMinutes, 15, 24 * 60, base.pollIntervalMinutes),
  };
}

function createUpsideNewsSettings(config = {}, log = console) {
  const settingsPath = config.upsideNewsSettingsPath
    || path.resolve(config.ROOT || path.resolve(__dirname, '..'), 'data', 'upside-news-settings.json');

  function readFile() {
    try {
      if (!fs.existsSync(settingsPath)) {
        return null;
      }
      return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch (error) {
      log?.warn?.('Could not read upside-news settings', error?.message || error);
      return null;
    }
  }

  function get() {
    return sanitiseSettings(readFile() || {}, defaultSettings());
  }

  function update(patch = {}) {
    const next = sanitiseSettings({ ...get(), ...patch }, defaultSettings());
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    return next;
  }

  return {
    get,
    update,
    settingsPath,
    indexSecondsFor,
    cycleSecondsFor: (overrides = {}) => {
      const current = get();
      return cycleSecondsFor({ ...current, ...overrides });
    },
  };
}

module.exports = {
  PERIODS,
  LOOP_MODES,
  REGIONS,
  RSS_SOURCES,
  DEFAULT_DENYLIST,
  DEFAULT_BOOSTLIST,
  DEFAULT_SECTIONS,
  defaultSettings,
  sanitiseSettings,
  indexSecondsFor,
  cycleSecondsFor,
  createUpsideNewsSettings,
};
