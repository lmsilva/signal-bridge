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

const { kindsOf, COMMANDS } = require('./command-registry');

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

/** Default hold on screen for any rule (15 minutes). */
const DEFAULT_HOLD_SECONDS = 15 * 60;
const MIN_HOLD_SECONDS = 60;
const MAX_HOLD_SECONDS = 240 * 60;

/**
 * Brief / UI weekdays are Monday-first (Mon=0 … Sun=6).
 * Engine `localParts().weekday` and `daysOfWeek` are Sunday-first (Sun=0 … Sat=6).
 * Convert at the boundary — never inline the arithmetic at call sites.
 */
function mondayIndexToSunday(day) {
  const d = Number(day);
  if (!Number.isInteger(d) || d < 0 || d > 6) return null;
  return (d + 1) % 7;
}

function sundayIndexToMonday(day) {
  const d = Number(day);
  if (!Number.isInteger(d) || d < 0 || d > 6) return null;
  return (d + 6) % 7;
}

/**
 * Fixed fire slots: `{ day: 0-6 Mon=0, hour: 0-23, minute: 0-59 }`.
 * Dedupes identical slots and sorts by day → hour → minute.
 */
function normaliseFixedTimes(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set();
  const out = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const day = Number(raw.day);
    const hour = Number(raw.hour);
    const minute = Number(raw.minute);
    if (!Number.isInteger(day) || day < 0 || day > 6) continue;
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) continue;
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) continue;
    const key = `${day}:${hour}:${minute}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ day, hour, minute });
  }
  out.sort((a, b) => (a.day - b.day) || (a.hour - b.hour) || (a.minute - b.minute));
  return out;
}

function normaliseScheduleType(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'fixed' || raw === 'fixed-time' || raw === 'fixed_time') {
    return 'fixed';
  }
  return 'cadence';
}

function normaliseHoldSeconds(value, fallback = DEFAULT_HOLD_SECONDS) {
  return clampInt(value, MIN_HOLD_SECONDS, MAX_HOLD_SECONDS, fallback);
}

const TARGET_CLASSES = new Set(['all', 'full', 'vestaboard']);

/** Retired command ids that still appear in saved rules. */
const LEGACY_COMMAND_IDS = Object.freeze({
  'plex.last-played': 'plex.now-playing',
});

const LEGACY_COMMAND_LABELS = Object.freeze({
  'plex.last-played': 'Feature Presentation — last played',
});

function resolveCommandId(commandId) {
  const id = String(commandId || '');
  return LEGACY_COMMAND_IDS[id] || id;
}

/**
 * `"all"` | `"full"` | `"vestaboard"` | a display id.
 *
 * Missing / blank uses the command's natural home: Vestaboard-only skills
 * default to the boards; everything else stays on the Windows overlay so
 * pre-board rule files do not suddenly flip the kitchen.
 */
function defaultTargetForCommand(command) {
  const kinds = kindsOf(command);
  if (kinds.length === 1 && kinds[0] === 'vestaboard') {
    return 'vestaboard';
  }
  return 'full';
}

function normaliseTarget(value, { command = null } = {}) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) {
    return defaultTargetForCommand(command);
  }
  const lower = raw.toLowerCase();
  if (lower === '*' || lower === 'all') {
    return 'all';
  }
  if (TARGET_CLASSES.has(lower)) {
    return lower;
  }
  return raw;
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
  const rawCommandId = String(base.commandId || '');
  const commandId = resolveCommandId(rawCommandId);
  const resolvedCommand = command
    || COMMANDS.find((entry) => entry.id === commandId)
    || null;
  const intervalSeconds = clampInt(
    base.intervalSeconds, MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS, 45 * 60,
  );
  const params = base.params && typeof base.params === 'object' ? { ...base.params } : {};
  if (rawCommandId === 'plex.last-played' && params.mode === 'last-played') {
    delete params.mode;
  }
  let label = String(base.label || resolvedCommand?.title || commandId || 'Rule').slice(0, 80);
  if (rawCommandId !== commandId && label === LEGACY_COMMAND_LABELS[rawCommandId]) {
    label = resolvedCommand?.title || 'Feature Presentation';
  }
  const rule = {
    id: String(base.id || crypto.randomUUID()),
    enabled: base.enabled !== false,
    label,
    color: /^#[0-9a-fA-F]{6}$/.test(base.color || '') ? base.color : pickColor(existingRules),

    commandId,
    params,

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
  // Hold on screen (both overlay and Vestaboard). Legacy
  // `displayDurationSeconds` is accepted as an alias on read. Absent means
  // "use the command's own duration" — do not force the 15-minute UI default
  // onto every pre-existing cadence rule.
  const holdRaw = base.holdSeconds != null ? base.holdSeconds : base.displayDurationSeconds;
  if (holdRaw != null && holdRaw !== '') {
    rule.holdSeconds = normaliseHoldSeconds(holdRaw, DEFAULT_HOLD_SECONDS);
    rule.displayDurationSeconds = rule.holdSeconds;
  }

  rule.scheduleType = normaliseScheduleType(base.scheduleType || base.mode);
  const fixedTimes = normaliseFixedTimes(base.fixedTimes || base.fixedSlots);
  if (rule.scheduleType === 'fixed') {
    rule.fixedTimes = fixedTimes;
    // Fixed rules ignore cadence dice; keep interval as a long backstop so
    // anything that still reads it does not fire every minute.
    if (!Number.isFinite(Number(base.intervalSeconds))) {
      rule.intervalSeconds = MAX_INTERVAL_SECONDS;
    }
    rule.probability = 100;
    // Fixed slots need an on-screen hold (and a lateness drop window). The
    // UI default of 15 minutes applies whenever the body omitted one.
    if (rule.holdSeconds == null) {
      rule.holdSeconds = DEFAULT_HOLD_SECONDS;
      rule.displayDurationSeconds = DEFAULT_HOLD_SECONDS;
    }
  } else if (fixedTimes.length) {
    // Preserve painted slots even while the rule is in cadence mode, so the
    // editor can flip types without wiping the week grid.
    rule.fixedTimes = fixedTimes;
  }

  if (base.quietHoursExempt === true) {
    rule.quietHoursExempt = true;
  }

  // Existing rules have no target; prefer the command's natural home so
  // Vestaboard-only skills do not quietly air into the Windows overlay void.
  rule.target = normaliseTarget(base.target, { command: resolvedCommand });
  // §7.3: default the guard on wherever it is supported — an empty "now
  // playing" panel is worse than showing nothing.
  if (base.guard === 'requires-content') {
    rule.guard = 'requires-content';
  } else if (base.guard === undefined && resolvedCommand?.supportsContentCheck) {
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
  if (rule?.scheduleType === 'fixed') {
    const slots = Array.isArray(rule.fixedTimes) ? rule.fixedTimes.length : 0;
    // Seven Monday-first days; average slots per civil day.
    return slots / 7;
  }
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
        return { rules: [], migrated: false };
      }
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const list = Array.isArray(parsed) ? parsed : parsed?.rules;
      if (!Array.isArray(list)) {
        return { rules: [], migrated: false };
      }
      const out = [];
      let migrated = false;
      for (const raw of list) {
        const rule = normaliseRule(raw, { existingRules: out });
        if (rule.commandId !== String(raw?.commandId || '')) {
          migrated = true;
        }
        out.push(rule);
      }
      return { rules: out, migrated };
    } catch (error) {
      log?.warn?.('Could not read scheduler rules — starting empty', error?.message || error);
      return { rules: [], migrated: false };
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

  const loaded = read();
  rules = loaded.rules;
  if (loaded.migrated) {
    persist();
  }

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
  DEFAULT_HOLD_SECONDS,
  MIN_HOLD_SECONDS,
  MAX_HOLD_SECONDS,
  TARGET_CLASSES,
  resolveCommandId,
  normaliseRule,
  normaliseTarget,
  normaliseFixedTimes,
  normaliseScheduleType,
  normaliseHoldSeconds,
  mondayIndexToSunday,
  sundayIndexToMonday,
  scoreRule,
  expectedPerDay,
  gapProfile,
  pickColor,
  createRuleStore,
};
