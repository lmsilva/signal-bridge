/**
 * Persisted settings for Wiki Common Knowledge.
 */

const fs = require('fs');
const path = require('path');

const PERIODS = ['daily', 'weekly', 'monthly', 'yearly'];
const LOOP_MODES = ['once', '2', '3', 'until-dismissed'];

const DEFAULT_DENYLIST = [
  'murder of', 'death of', 'massacre', 'shooting', 'serial killer',
  'killed', 'assassination',
];

function defaultSettings() {
  return {
    period: 'daily',
    items: 5,
    indexSeconds: null,
    articleSeconds: 15,
    loops: 'once',
    lang: 'en',
    showQr: true,
    showSparkline: true,
    skipNoImage: false,
    filterDistressing: true,
    denylist: DEFAULT_DENYLIST,
    contactEmail: '',
    apiToken: '',
  };
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function sanitiseList(value, fallback) {
  if (!Array.isArray(value)) return [...fallback];
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

function cycleSecondsFor({
  items = 5,
  indexSeconds = null,
  articleSeconds = 15,
} = {}) {
  const count = clampInt(items, 3, 8, 5);
  const index = indexSecondsFor(count, indexSeconds);
  const article = clampInt(articleSeconds, 8, 30, 15);
  return index + (count * article);
}

function sanitiseSettings(raw = {}, base = defaultSettings()) {
  const merged = { ...base, ...(raw || {}) };
  const period = PERIODS.includes(merged.period) ? merged.period : base.period;
  const items = clampInt(merged.items, 3, 8, base.items);
  const loops = LOOP_MODES.includes(String(merged.loops))
    ? String(merged.loops)
    : base.loops;
  let indexSeconds = merged.indexSeconds;
  if (indexSeconds === '' || indexSeconds === undefined) indexSeconds = null;
  if (indexSeconds != null) {
    indexSeconds = clampInt(indexSeconds, 6, 60, indexSecondsFor(items));
  }
  const lang = String(merged.lang || 'en').trim().toLowerCase().slice(0, 12) || 'en';
  return {
    period,
    items,
    indexSeconds,
    articleSeconds: clampInt(merged.articleSeconds, 8, 30, base.articleSeconds),
    loops,
    lang,
    showQr: merged.showQr !== false,
    showSparkline: merged.showSparkline !== false,
    skipNoImage: merged.skipNoImage === true,
    filterDistressing: merged.filterDistressing !== false,
    denylist: sanitiseList(merged.denylist, DEFAULT_DENYLIST),
    contactEmail: String(merged.contactEmail || '').trim().slice(0, 200),
    apiToken: String(merged.apiToken || '').trim().slice(0, 500),
  };
}

function createWikiCommonKnowledgeSettings(config = {}, log = console) {
  const settingsPath = config.wikiCommonKnowledgeSettingsPath
    || path.resolve(config.ROOT || path.resolve(__dirname, '..'), 'data', 'wiki-common-knowledge-settings.json');
  let current = defaultSettings();

  function load() {
    try {
      if (!fs.existsSync(settingsPath)) {
        current = defaultSettings();
        return current;
      }
      current = sanitiseSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8')));
    } catch (error) {
      log?.warn?.('Could not read wiki-common-knowledge settings', error?.message || error);
      current = defaultSettings();
    }
    return current;
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
    } catch (error) {
      log?.warn?.('Could not save wiki-common-knowledge settings', error?.message || error);
    }
  }

  load();

  return {
    get: () => ({ ...current }),
    update(patch = {}) {
      current = sanitiseSettings({ ...current, ...patch }, current);
      save();
      return { ...current };
    },
    path: settingsPath,
  };
}

module.exports = {
  PERIODS,
  LOOP_MODES,
  DEFAULT_DENYLIST,
  defaultSettings,
  sanitiseSettings,
  indexSecondsFor,
  cycleSecondsFor,
  createWikiCommonKnowledgeSettings,
};
