/**
 * Display Scheduler rules: shape, validation, persistence and the maths the UI
 * shows beside each rule (display-scheduler.md §3, §4.5, §5).
 *
 * Kept separate from the engine so the scoring and expected-rate formulas can be
 * asserted without a clock, a store or a tick loop.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const IMPORTANCE_LABELS = {
  1: 'Background',
  2: 'Low',
  3: 'Normal',
  4: 'High',
  5: 'Featured',
};

/**
 * Twelve qualitative hues, assigned at creation and stored on the rule.
 * Deriving colour from list position would reshuffle the whole timeline the
 * moment a rule is renamed or the sort order changes (§8.5).
 */
const RULE_PALETTE = [
  '#5FD0FF', '#6EE7A8', '#F5C453', '#FF7A6B', '#C79BFF', '#7FE3D4',
  '#FFA45C', '#8BB7FF', '#F58EC1', '#B8D06A', '#9AA7FF', '#E8A87C',
];

const MIN_INTERVAL_SECONDS = 60;
const MAX_INTERVAL_SECONDS = 24 * 60 * 60;

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(n)));
}

function isHhMm(value) {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function normaliseWindow(value) {
  if (!value || !isHhMm(value.start) || !isHhMm(value.end)) {
    return undefined;
  }
  return { start: value.start, end: value.end };
}

function normaliseDays(value) {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const days = [...new Set(value.map(Number))]
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    .sort();
  // All seven days is the same as no constraint; storing it as `undefined`
  // keeps "is this rule constrained?" a simple presence check.
  return days.length && days.length < 7 ? days : undefined;
}

function pickColor(existingRules = []) {
  const used = new Set(existingRules.map((rule) => rule.color));
  return RULE_PALETTE.find((color) => !used.has(color))
    || RULE_PALETTE[existingRules.length % RULE_PALETTE.length];
}

/**
 * Coerce anything (an API body, a hand-edited JSON file) into a valid rule.
 * Never throws — a malformed field falls back rather than taking the tick down.
 */
function normaliseRule(raw = {}, { existingRules = [], command = null, now = Date.now() } = {}) {
  const base = raw || {};
  const intervalSeconds = clampInt(
    base.intervalSeconds, MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS, 45 * 60,
  );
  const rule = {
    id: String(base.id || crypto.randomUUID()),
    enabled: base.enabled !== false,
    label: String(base.label || command?.title || base.commandId || 'Rule').slice(0, 80),
    color: /^#[0-9a-fA-F]{6}$/.test(base.color || '') ? base.color : pickColor(existingRules),

    commandId: String(base.commandId || ''),
    params: base.params && typeof base.params === 'object' ? { ...base.params } : {},

    intervalSeconds,
    probability: clampInt(base.probability, 0, 100, 100),
    importance: clampInt(base.importance, 1, 5, 3),

    airingsToday: Math.max(0, clampInt(base.airingsToday, 0, 100000, 0)),
    airingsTodayDate: typeof base.airingsTodayDate === 'string' ? base.airingsTodayDate : null,
    pending: base.pending === true,
    pendingSince: typeof base.pendingSince === 'string' ? base.pendingSince : undefined,
    nextEvalAt: typeof base.nextEvalAt === 'string'
      ? base.nextEvalAt
      : new Date(now).toISOString(),
    lastAiredAt: typeof base.lastAiredAt === 'string' ? base.lastAiredAt : undefined,
  };

  const activeWindow = normaliseWindow(base.activeWindow);
  if (activeWindow) rule.activeWindow = activeWindow;
  const daysOfWeek = normaliseDays(base.daysOfWeek);
  if (daysOfWeek) rule.daysOfWeek = daysOfWeek;
  if (base.cooldownSeconds != null) {
    rule.cooldownSeconds = clampInt(base.cooldownSeconds, 0, MAX_INTERVAL_SECONDS, 0) || undefined;
  }
  if (base.maxPerDay != null) {
    rule.maxPerDay = clampInt(base.maxPerDay, 1, 1000, undefined);
  }
  if (base.jitterPercent != null) {
    rule.jitterPercent = clampInt(base.jitterPercent, 0, 50, 0) || undefined;
  }
  if (base.displayDurationSeconds != null) {
    rule.displayDurationSeconds = clampInt(base.displayDurationSeconds, 5, 3600, undefined);
  }
  // §7.3: default the guard on wherever it is supported — an empty "now
  // playing" panel is worse than showing nothing.
  if (base.guard === 'requires-content') {
    rule.guard = 'requires-content';
  } else if (base.guard === undefined && command?.supportsContentCheck) {
    rule.guard = 'requires-content';
  }
  return rule;
}

/** §3: how far behind its own cadence a rule is, weighted by importance. */
function scoreRule(rule, nowMs) {
  const interval = Math.max(1, Number(rule.intervalSeconds) || 1);
  const lastAired = rule.lastAiredAt ? Date.parse(rule.lastAiredAt) : NaN;
  // A rule that has never aired is treated as two intervals overdue: prompt on
  // screen, but not permanently dominant (§3 "First-airing handling").
  const secondsSinceLastAiring = Number.isFinite(lastAired)
    ? Math.max(0, (nowMs - lastAired) / 1000)
    : interval * 2;
  return (secondsSinceLastAiring / interval) * (Math.max(1, Number(rule.importance) || 3) / 3);
}

/** §4.5. Interval and probability interact unintuitively; the UI shows this. */
function expectedPerDay(rule) {
  const interval = Math.max(1, Number(rule.intervalSeconds) || 1);
  return (86400 / interval) * (Math.max(0, Math.min(100, Number(rule.probability) || 0)) / 100);
}

/**
 * §4.5: the "your scheduler is not broken" numbers.
 *
 * Dice failures are geometrically distributed, so "every 45 min at 90%" is not
 * "roughly every 50 minutes" — one time in ten you wait 90+, and users report
 * that as a bug unless the UI says it up front.
 */
function gapProfile(rule) {
  const interval = Math.max(1, Number(rule.intervalSeconds) || 1);
  const p = Math.max(0, Math.min(100, Number(rule.probability) || 0)) / 100;
  if (p <= 0) {
    return { typicalSeconds: null, occasionalSeconds: null, probability: 0 };
  }
  // Mean attempts to a success is 1/p. For the tail: the smallest n where the
  // chance of n consecutive failures drops under 10%, plus the winning attempt.
  // At 90% that gives 2 intervals — "every 45 min at 90%" waits 90 minutes one
  // time in ten, which is exactly the §4.5 warning.
  const typical = interval / p;
  const occasional = p >= 1
    ? interval
    : interval * (1 + Math.max(1, Math.ceil(Math.log(0.1) / Math.log(1 - p))));
  return { typicalSeconds: Math.round(typical), occasionalSeconds: Math.round(occasional), probability: p };
}

function createRuleStore(filePath, log = console) {
  let rules = [];

  function read() {
    try {
      if (!fs.existsSync(filePath)) {
        return [];
      }
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const list = Array.isArray(parsed) ? parsed : parsed?.rules;
      if (!Array.isArray(list)) {
        return [];
      }
      const out = [];
      for (const raw of list) {
        out.push(normaliseRule(raw, { existingRules: out }));
      }
      return out;
    } catch (error) {
      log?.warn?.('Could not read scheduler rules — starting empty', error?.message || error);
      return [];
    }
  }

  function persist() {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, `${JSON.stringify({ version: 1, rules }, null, 2)}\n`, 'utf8');
    } catch (error) {
      log?.warn?.('Could not persist scheduler rules', error?.message || error);
    }
  }

  rules = read();

  return {
    all: () => rules,
    get: (id) => rules.find((rule) => rule.id === id) || null,
    add(raw, context = {}) {
      const rule = normaliseRule(raw, { ...context, existingRules: rules });
      rules.push(rule);
      persist();
      return rule;
    },
    update(id, patch, context = {}) {
      const index = rules.findIndex((rule) => rule.id === id);
      if (index < 0) {
        return null;
      }
      // Runtime state is not part of the editable surface; merging the patch
      // over the stored rule keeps timers intact across an edit.
      rules[index] = normaliseRule(
        { ...rules[index], ...(patch || {}), id },
        { ...context, existingRules: rules.filter((_, i) => i !== index) },
      );
      persist();
      return rules[index];
    },
    remove(id) {
      const before = rules.length;
      rules = rules.filter((rule) => rule.id !== id);
      if (rules.length === before) {
        return false;
      }
      persist();
      return true;
    },
    replaceAll(list, context = {}) {
      const out = [];
      for (const raw of list || []) {
        out.push(normaliseRule(raw, { ...context, existingRules: out }));
      }
      rules = out;
      persist();
      return rules;
    },
    persist,
    filePath,
  };
}

module.exports = {
  IMPORTANCE_LABELS,
  RULE_PALETTE,
  MIN_INTERVAL_SECONDS,
  MAX_INTERVAL_SECONDS,
  normaliseRule,
  scoreRule,
  expectedPerDay,
  gapProfile,
  pickColor,
  createRuleStore,
};
