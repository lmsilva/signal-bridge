/**
 * Persisted trivia preferences (trivia.md §4 `TriviaSettings`).
 *
 * Follows the `slideshow-settings.js` pattern: a small JSON file next to the
 * other bridge state, reloaded from disk on every read because the web server
 * and the listener each hold their own instance and one must not serve a stale
 * copy of what the other just saved.
 */

const fs = require('fs');
const path = require('path');
const { categoryIds } = require('./trivia-categories');

const PROVIDERS = ['opentdb', 'the-trivia-api'];
const DIFFICULTIES = ['easy', 'medium', 'hard'];
const QUESTION_TYPES = ['multiple', 'boolean'];

const MIN_QUESTIONS_PER_SESSION = 1;
const MAX_QUESTIONS_PER_SESSION = 10;
const MIN_PHASE_SECONDS = 2;
const MAX_PHASE_SECONDS = 120;

function defaultSettings() {
  return {
    enabledProviders: ['opentdb'],
    enabledCategoryIds: categoryIds(),
    enabledDifficulties: ['easy', 'medium'],
    enabledTypes: ['multiple', 'boolean'],

    questionsPerSession: 5,
    questionSeconds: 15,
    answerSeconds: 7,
    showIntroCard: true,
    showSummaryCard: true,
    introSeconds: 4,
    summarySeconds: 6,

    shuffleCategories: true,
    avoidRepeatDays: 30,

    poolTargetSize: 300,
    poolLowWatermark: 100,
  };
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(n)));
}

function sanitiseList(value, allowed, fallback) {
  if (!Array.isArray(value)) {
    return [...fallback];
  }
  const allowedSet = new Set(allowed);
  const cleaned = [...new Set(value.map(String))].filter((item) => allowedSet.has(item));
  // An empty selection would starve every round; treat it as "not specified".
  return cleaned.length ? cleaned : [...fallback];
}

/** Normalise anything (a config file, an API body) into valid settings. */
function sanitiseSettings(raw = {}, base = defaultSettings()) {
  const merged = { ...base, ...(raw || {}) };
  return {
    enabledProviders: sanitiseList(merged.enabledProviders, PROVIDERS, base.enabledProviders),
    enabledCategoryIds: sanitiseList(
      merged.enabledCategoryIds, categoryIds(), base.enabledCategoryIds,
    ),
    enabledDifficulties: sanitiseList(
      merged.enabledDifficulties, DIFFICULTIES, base.enabledDifficulties,
    ),
    enabledTypes: sanitiseList(merged.enabledTypes, QUESTION_TYPES, base.enabledTypes),

    questionsPerSession: clampInt(
      merged.questionsPerSession,
      MIN_QUESTIONS_PER_SESSION, MAX_QUESTIONS_PER_SESSION, base.questionsPerSession,
    ),
    questionSeconds: clampInt(
      merged.questionSeconds, MIN_PHASE_SECONDS, MAX_PHASE_SECONDS, base.questionSeconds,
    ),
    answerSeconds: clampInt(
      merged.answerSeconds, MIN_PHASE_SECONDS, MAX_PHASE_SECONDS, base.answerSeconds,
    ),
    showIntroCard: merged.showIntroCard !== false,
    showSummaryCard: merged.showSummaryCard !== false,
    introSeconds: clampInt(
      merged.introSeconds, MIN_PHASE_SECONDS, MAX_PHASE_SECONDS, base.introSeconds,
    ),
    summarySeconds: clampInt(
      merged.summarySeconds, MIN_PHASE_SECONDS, MAX_PHASE_SECONDS, base.summarySeconds,
    ),

    shuffleCategories: merged.shuffleCategories !== false,
    avoidRepeatDays: clampInt(merged.avoidRepeatDays, 0, 365, base.avoidRepeatDays),

    poolTargetSize: clampInt(merged.poolTargetSize, 20, 5000, base.poolTargetSize),
    poolLowWatermark: clampInt(merged.poolLowWatermark, 5, 5000, base.poolLowWatermark),
  };
}

/**
 * Total wall-clock length of a round (trivia.md §8.2).
 *
 * The scheduler needs this to hold the display busy for the whole sequence, and
 * the settings page shows it because "every 15 minutes" means something very
 * different for a 2-minute round than for a 15-second page.
 */
function roundDurationSeconds(settings, overrides = {}) {
  const resolved = { ...settings, ...clean(overrides) };
  const count = clampInt(
    resolved.count ?? resolved.questionsPerSession,
    MIN_QUESTIONS_PER_SESSION, MAX_QUESTIONS_PER_SESSION, settings.questionsPerSession,
  );
  const question = clampInt(
    resolved.questionSeconds, MIN_PHASE_SECONDS, MAX_PHASE_SECONDS, settings.questionSeconds,
  );
  const answer = clampInt(
    resolved.answerSeconds, MIN_PHASE_SECONDS, MAX_PHASE_SECONDS, settings.answerSeconds,
  );
  const intro = resolved.showIntroCard === false ? 0 : resolved.introSeconds;
  // A one-question round has nothing to summarise (trivia.md §6.9).
  const summary = resolved.showSummaryCard === false || count < 2 ? 0 : resolved.summarySeconds;
  return Math.round(intro + count * (question + answer) + summary);
}

function clean(object) {
  const out = {};
  for (const [key, value] of Object.entries(object || {})) {
    if (value !== undefined && value !== null && value !== '') {
      out[key] = value;
    }
  }
  return out;
}

function createTriviaSettings(config = {}, log = console) {
  const settingsPath = config.triviaSettingsPath
    || path.resolve(config.ROOT || path.resolve(__dirname, '..'), 'data/trivia-settings.json');

  let settings = sanitiseSettings(config.trivia || {});

  function loadFromDisk() {
    try {
      if (!fs.existsSync(settingsPath)) {
        return;
      }
      settings = sanitiseSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8')));
    } catch (error) {
      log?.warn?.('Could not read trivia settings — using defaults', error?.message || error);
    }
  }

  loadFromDisk();

  function persist() {
    try {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    } catch (error) {
      log?.warn?.('Could not persist trivia settings', error?.message || error);
    }
  }

  function get() {
    loadFromDisk();
    return { ...settings };
  }

  function update(patch = {}) {
    loadFromDisk();
    const next = sanitiseSettings({ ...settings, ...(patch || {}) }, settings);
    if (next.poolLowWatermark > next.poolTargetSize) {
      return { ok: false, error: 'poolLowWatermark cannot exceed poolTargetSize' };
    }
    settings = next;
    persist();
    return { ok: true, settings: { ...settings } };
  }

  return {
    get,
    update,
    settingsPath,
    roundDurationSeconds: (overrides) => roundDurationSeconds(get(), overrides),
  };
}

module.exports = {
  PROVIDERS,
  DIFFICULTIES,
  QUESTION_TYPES,
  MIN_QUESTIONS_PER_SESSION,
  MAX_QUESTIONS_PER_SESSION,
  MIN_PHASE_SECONDS,
  MAX_PHASE_SECONDS,
  defaultSettings,
  sanitiseSettings,
  roundDurationSeconds,
  createTriviaSettings,
};
