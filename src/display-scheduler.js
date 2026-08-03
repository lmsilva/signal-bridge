/**
 * Display Scheduler — the three-stage tick (display-scheduler.md §4).
 *
 * The scheduler is the lowest-priority page source in the system (§6): it fills
 * idle time and never competes. Everything below follows from one constraint —
 * the display can only show one thing at a time — plus three rules that are
 * easy to get subtly wrong:
 *
 *   - Losing the dice **advances** the timer, so "every 45 minutes at 90%"
 *     means what a user expects.
 *   - Losing the tie-break does **not** advance and does **not** re-roll.
 *     Re-rolling would silently compound the probability and make the observed
 *     rate lower than configured.
 *   - Pending expires after one interval, so a rule that waited out a long busy
 *     period does not fire hours later out of context.
 *
 * The clock and the RNG are injected so the whole engine can be driven by a
 * virtual clock in tests and never touches real time there (§13).
 */

const fs = require('fs');
const path = require('path');
const { createRuleStore, scoreRule, expectedPerDay, gapProfile } = require('./scheduler-rules');
const {
  createActivityLog, localDateKey, localParts, withinWindow,
} = require('./scheduler-activity');

const DEFAULT_SETTINGS = {
  active: false,
  tickSeconds: 30,
  globalMinGapSeconds: 300,
  // §11.2: ship quiet hours enabled with a default, not off.
  quietHours: { start: '23:00', end: '07:00' },
  respectPresence: false,
  historyRetentionDays: 30,
  randomSeed: null,
};

const MAX_TICK_SECONDS = 60;

/**
 * Mulberry32 — small, fast, and reproducible from a 32-bit seed so a failing
 * statistical test can be replayed exactly. Never seeded in production (§11.10).
 */
function seededRandom(seed) {
  let state = (Number(seed) || 0) >>> 0;
  return function next() {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sanitiseSettings(raw = {}, base = DEFAULT_SETTINGS) {
  const merged = { ...base, ...(raw || {}) };
  const int = (value, min, max, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
  };
  const window = merged.quietHours;
  const validWindow = window
    && /^([01]\d|2[0-3]):[0-5]\d$/.test(window.start || '')
    && /^([01]\d|2[0-3]):[0-5]\d$/.test(window.end || '');
  return {
    active: merged.active === true,
    // Tick granularity is the resolution of the whole system (§4.1).
    tickSeconds: int(merged.tickSeconds, 5, MAX_TICK_SECONDS, base.tickSeconds),
    globalMinGapSeconds: int(merged.globalMinGapSeconds, 0, 86400, base.globalMinGapSeconds),
    quietHours: validWindow ? { start: window.start, end: window.end } : null,
    respectPresence: merged.respectPresence === true,
    historyRetentionDays: int(merged.historyRetentionDays, 1, 365, base.historyRetentionDays),
    randomSeed: Number.isFinite(Number(merged.randomSeed)) && merged.randomSeed !== null
      ? Number(merged.randomSeed)
      : null,
  };
}

/**
 * @param {Object} deps
 * @param {Function} deps.air            (rule, command) => Promise|void — fires the page.
 * @param {Function} deps.isBusy         () => boolean — §6 precedence check.
 * @param {Object}   deps.commandRegistry
 * @param {Function} [deps.now]          Injectable clock (ms).
 * @param {Function} [deps.setTimer]     Injectable scheduler for the tick loop.
 */
function createDisplayScheduler(deps = {}) {
  const {
    config = {},
    log = console,
    commandRegistry = null,
    air = null,
    isBusy = () => false,
    isPresent = () => true,
    now = () => Date.now(),
    setTimer = setInterval,
    clearTimer = clearInterval,
    timeZone = config.voiceEvents?.localTimeZone || null,
  } = deps;

  const root = config.ROOT || path.resolve(__dirname, '..');
  const rulesPath = config.schedulerRulesPath || path.join(root, 'data/scheduler-rules.json');
  const activityDir = config.schedulerActivityDir || path.join(root, 'data/scheduler-activity');
  const settingsPath = config.schedulerSettingsPath
    || path.join(root, 'data/scheduler-settings.json');

  const store = createRuleStore(rulesPath, log);
  const activity = createActivityLog(activityDir, { log, timeZone, now });

  let settings = sanitiseSettings(config.displayScheduler || {});
  try {
    if (fs.existsSync(settingsPath)) {
      settings = sanitiseSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), settings);
    }
  } catch (error) {
    log?.warn?.('Could not read scheduler settings — using defaults', error?.message || error);
  }

  let random = settings.randomSeed == null ? Math.random : seededRandom(settings.randomSeed);
  let lastAiringAt = null;
  let timer = null;
  // §4.6: suppress airings for one global gap after boot so the display settles
  // rather than firing everything that went overdue while we were down.
  let suppressUntil = now() + settings.globalMinGapSeconds * 1000;
  let lastPruneDate = null;
  let ticking = false;
  // The sequence currently on screen, so an interruption can record what
  // actually aired rather than what was planned (§7.4).
  let activeAiring = null;

  function persistSettings() {
    try {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    } catch (error) {
      log?.warn?.('Could not persist scheduler settings', error?.message || error);
    }
  }

  // ------------------------------------------------------------- gates

  function inQuietHours(nowMs) {
    return Boolean(settings.quietHours) && withinWindow(nowMs, settings.quietHours, timeZone);
  }

  function outsideWindow(rule, nowMs) {
    if (rule.daysOfWeek && !rule.daysOfWeek.includes(localParts(nowMs, timeZone).weekday)) {
      return true;
    }
    return Boolean(rule.activeWindow) && !withinWindow(nowMs, rule.activeWindow, timeZone);
  }

  function rollDailyCounter(rule, nowMs) {
    // §11.9: reset at local midnight, not 24 hours after process start.
    const today = localDateKey(nowMs, timeZone);
    if (rule.airingsTodayDate !== today) {
      rule.airingsToday = 0;
      rule.airingsTodayDate = today;
    }
  }

  function atDailyCap(rule) {
    return Boolean(rule.maxPerDay) && rule.airingsToday >= rule.maxPerDay;
  }

  function inCooldown(rule, nowMs) {
    if (!rule.cooldownSeconds || !rule.lastAiredAt) {
      return false;
    }
    return nowMs - Date.parse(rule.lastAiredAt) < rule.cooldownSeconds * 1000;
  }

  function advance(rule, nowMs) {
    let base = rule.intervalSeconds;
    if (rule.jitterPercent) {
      base *= 1 + ((random() * 2 - 1) * rule.jitterPercent) / 100;
    }
    // Always from now, never from the previous nextEvalAt — anchoring to the
    // old value causes catch-up storms after downtime (§4.4).
    rule.nextEvalAt = new Date(nowMs + base * 1000).toISOString();
    rule.pending = false;
    delete rule.pendingSince;
  }

  function record(rule, outcome, extra = {}) {
    return activity.record({ ruleId: rule.id, at: new Date(now()).toISOString(), outcome, ...extra });
  }

  // -------------------------------------------------------------- tick

  function collectCandidates(nowMs) {
    const candidates = [];
    for (const rule of store.all()) {
      try {
        rollDailyCounter(rule, nowMs);

        if (!rule.enabled) {
          continue;
        }

        if (rule.pending) {
          const since = Date.parse(rule.pendingSince || rule.nextEvalAt);
          if (Number.isFinite(since) && nowMs - since > rule.intervalSeconds * 1000) {
            record(rule, 'expired-pending');
            advance(rule, nowMs);
            continue;
          }
          // Already won its dice on an earlier tick; re-enters without a re-roll.
          candidates.push(rule);
          continue;
        }

        if (nowMs < Date.parse(rule.nextEvalAt)) {
          continue;
        }

        const command = commandRegistry?.get?.(rule.commandId);
        if (!command) {
          // §11.13: a rule pointing at a removed command is skipped, not fatal.
          record(rule, 'error', { detail: `Unknown command: ${rule.commandId}` });
          advance(rule, nowMs);
          continue;
        }

        if (outsideWindow(rule, nowMs)) {
          record(rule, 'blocked-window');
          advance(rule, nowMs);
          continue;
        }
        if (atDailyCap(rule)) {
          record(rule, 'blocked-cap');
          advance(rule, nowMs);
          continue;
        }
        if (inCooldown(rule, nowMs)) {
          record(rule, 'blocked-cooldown');
          advance(rule, nowMs);
          continue;
        }

        const rolled = random() * 100;
        if (rolled >= rule.probability) {
          record(rule, 'lost-dice', { rolledValue: Math.round(rolled * 10) / 10 });
          advance(rule, nowMs);
          continue;
        }

        if (rule.guard === 'requires-content'
          && !commandRegistry.hasContent(rule.commandId, rule.params)) {
          record(rule, 'blocked-guard', { detail: 'No content available' });
          advance(rule, nowMs);
          continue;
        }

        rule.pending = true;
        rule.pendingSince = new Date(nowMs).toISOString();
        candidates.push(rule);
      } catch (error) {
        record(rule, 'error', { detail: error?.message || String(error) });
        advance(rule, nowMs);
      }
    }
    return candidates;
  }

  async function tick() {
    if (ticking) {
      return null;
    }
    ticking = true;
    try {
      return await runTick();
    } finally {
      ticking = false;
    }
  }

  async function runTick() {
    const nowMs = now();
    maybePrune(nowMs);

    if (!settings.active) {
      return { aired: null, reason: 'paused' };
    }
    if (inQuietHours(nowMs)) {
      return { aired: null, reason: 'blocked-quiet-hours' };
    }
    if (nowMs < suppressUntil) {
      return { aired: null, reason: 'blocked-global-gap' };
    }
    if (lastAiringAt && nowMs - lastAiringAt < settings.globalMinGapSeconds * 1000) {
      return { aired: null, reason: 'blocked-global-gap' };
    }
    if (isBusy()) {
      return { aired: null, reason: 'blocked-display' };
    }
    if (settings.respectPresence && !isPresent()) {
      return { aired: null, reason: 'blocked-presence' };
    }

    const candidates = collectCandidates(nowMs);
    store.persist();
    if (!candidates.length) {
      return { aired: null, reason: 'no-candidates' };
    }

    const scored = candidates
      .map((rule) => ({ rule, score: scoreRule(rule, nowMs) }))
      .sort((a, b) => b.score - a.score);
    const winner = scored[0];
    const competingRuleIds = scored.map((entry) => entry.rule.id);

    const event = await airRule(winner.rule, {
      score: winner.score,
      competingRuleIds,
      nowMs,
    });

    for (const loser of scored.slice(1)) {
      // Stays pending: no re-roll, no timer advance (§4.3).
      record(loser.rule, 'lost-tiebreak', {
        score: loser.score,
        competingRuleIds,
      });
    }
    store.persist();
    return { aired: winner.rule.id, event, candidates: competingRuleIds };
  }

  /**
   * Fire one rule and hold the display for its duration.
   *
   * `lastAiringAt` is stamped when the sequence **completes**, not when it
   * starts. For a fixed page the difference is negligible; for a two-minute
   * trivia round it is the whole point (§7.4).
   */
  async function airRule(rule, { score = null, competingRuleIds = [], nowMs = now(), manual = false } = {}) {
    const command = commandRegistry?.get?.(rule.commandId);
    if (!command) {
      const event = record(rule, 'error', { detail: `Unknown command: ${rule.commandId}` });
      advance(rule, nowMs);
      return event;
    }

    const planned = commandRegistry.estimateDuration(rule.commandId, {
      ...rule.params,
      displayDurationSeconds: rule.displayDurationSeconds,
    }) || command.defaultDurationSeconds || 60;

    let event;
    try {
      await air?.(rule, command, { durationSeconds: planned, manual });
      event = record(rule, 'aired', {
        score,
        competingRuleIds: competingRuleIds.length > 1 ? competingRuleIds : undefined,
        durationSeconds: planned,
      });
    } catch (error) {
      // §11.13 — a failing air must not take the tick down.
      const event2 = record(rule, 'error', { detail: error?.message || String(error) });
      advance(rule, nowMs);
      store.persist();
      return event2;
    }

    rule.pending = false;
    delete rule.pendingSince;
    rollDailyCounter(rule, nowMs);
    rule.airingsToday += 1;
    // Both the rule's own cadence and the global gap are measured from the end
    // of the sequence, so nothing airs between trivia question 2 and 3.
    const endsAt = nowMs + planned * 1000;
    rule.lastAiredAt = new Date(endsAt).toISOString();
    advance(rule, endsAt);
    lastAiringAt = endsAt;
    activeAiring = { ruleId: rule.id, eventId: event.id, startedAt: nowMs, plannedSeconds: planned };
    store.persist();
    return event;
  }

  /**
   * Called when a sequence is cut short (manual push, interrupt, pause).
   * Records what actually happened rather than the plan (§7.4).
   */
  function reportInterruption(atMs = now()) {
    if (!activeAiring) {
      return null;
    }
    const elapsed = Math.max(0, Math.round((atMs - activeAiring.startedAt) / 1000));
    const amended = elapsed < activeAiring.plannedSeconds
      ? activity.amend(activeAiring.eventId, { durationSeconds: elapsed, interrupted: true })
      : null;
    if (amended) {
      const rule = store.get(activeAiring.ruleId);
      if (rule) {
        rule.lastAiredAt = new Date(atMs).toISOString();
        store.persist();
      }
      lastAiringAt = atMs;
    }
    activeAiring = null;
    return amended;
  }

  /**
   * A human deliberately put something on screen; don't yank it away (§6).
   */
  function noteManualPush(atMs = now()) {
    reportInterruption(atMs);
    lastAiringAt = atMs;
  }

  function maybePrune(nowMs) {
    const today = localDateKey(nowMs, timeZone);
    if (lastPruneDate === today) {
      return;
    }
    lastPruneDate = today;
    activity.prune(settings.historyRetentionDays);
  }

  // ------------------------------------------------------------- status

  function nextUp(nowMs = now()) {
    let best = null;
    for (const rule of store.all()) {
      if (!rule.enabled) continue;
      const dueAt = rule.pending ? nowMs : Date.parse(rule.nextEvalAt);
      if (!Number.isFinite(dueAt)) continue;
      if (!best || dueAt < best.dueAt) {
        best = { ruleId: rule.id, label: rule.label, dueAt };
      }
    }
    if (!best) {
      return null;
    }
    return {
      ...best,
      dueAt: new Date(best.dueAt).toISOString(),
      inSeconds: Math.max(0, Math.round((best.dueAt - nowMs) / 1000)),
    };
  }

  function status() {
    const nowMs = now();
    const todayKey = localDateKey(nowMs, timeZone);
    const todayEvents = activity.query({
      from: new Date(nowMs - 24 * 60 * 60 * 1000).toISOString(),
      to: new Date(nowMs).toISOString(),
      limit: Number.MAX_SAFE_INTEGER,
    });
    const aired = todayEvents.filter((event) => event.outcome === 'aired').length;
    const contested = todayEvents.filter(
      (event) => ['aired', 'lost-dice', 'lost-tiebreak'].includes(event.outcome),
    ).length;
    return {
      active: settings.active,
      running: Boolean(timer),
      date: todayKey,
      settings,
      ruleCount: store.all().length,
      enabledRuleCount: store.all().filter((rule) => rule.enabled).length,
      airingsToday: aired,
      evaluationsToday: todayEvents.length,
      hitRate: contested ? aired / contested : null,
      lastAiringAt: lastAiringAt ? new Date(lastAiringAt).toISOString() : null,
      nextUp: nextUp(nowMs),
      inQuietHours: inQuietHours(nowMs),
      displayBusy: Boolean(isBusy()),
      suppressedUntil: nowMs < suppressUntil ? new Date(suppressUntil).toISOString() : null,
    };
  }

  /** Rule + its live derived readouts, for both the settings page and the API. */
  function describeRule(rule) {
    const command = commandRegistry?.get?.(rule.commandId) || null;
    const estimated = command
      ? commandRegistry.estimateDuration(rule.commandId, {
        ...rule.params,
        displayDurationSeconds: rule.displayDurationSeconds,
      })
      : null;
    return {
      ...rule,
      commandTitle: command?.title || null,
      commandGroup: command?.group || null,
      broken: !command,
      variableDuration: Boolean(command?.variableDuration),
      commandSupportsContentCheck: Boolean(command?.supportsContentCheck),
      estimatedDurationSeconds: estimated,
      expectedPerDay: Math.round(expectedPerDay(rule) * 10) / 10,
      gapProfile: gapProfile(rule),
      // §7.4: "every 15 minutes" for a two-minute round is a different choice
      // than the user thinks they are making.
      durationWarning: estimated && estimated > rule.intervalSeconds * 0.25
        ? `This page runs about ${Math.round(estimated / 60)}m of every `
          + `${Math.round(rule.intervalSeconds / 60)}m interval`
        : null,
    };
  }

  // ---------------------------------------------------------- simulation

  /**
   * Run the engine forward in memory with no side effects (§9).
   *
   * Stochastic, so the caller asks for many runs: we return one representative
   * timeline plus per-rule expected counts across all of them.
   */
  function simulate({ hours = 24, runs = 200, seed = 1 } = {}) {
    const startMs = now();
    const horizon = hours * 3600 * 1000;
    const tickMs = settings.tickSeconds * 1000;
    const totals = new Map();
    let representative = [];

    for (let run = 0; run < Math.max(1, runs); run += 1) {
      const rng = seededRandom(seed + run);
      const state = store.all().filter((rule) => rule.enabled).map((rule) => ({
        id: rule.id,
        label: rule.label,
        color: rule.color,
        intervalSeconds: rule.intervalSeconds,
        probability: rule.probability,
        importance: rule.importance,
        maxPerDay: rule.maxPerDay,
        activeWindow: rule.activeWindow,
        daysOfWeek: rule.daysOfWeek,
        commandId: rule.commandId,
        nextEvalAt: Math.max(startMs, Date.parse(rule.nextEvalAt) || startMs),
        lastAiredAt: rule.lastAiredAt ? Date.parse(rule.lastAiredAt) : null,
        airingsToday: 0,
        pending: false,
      }));
      const airings = [];
      let simLastAiring = lastAiringAt;

      for (let t = startMs; t < startMs + horizon; t += tickMs) {
        if (inQuietHours(t)) continue;
        if (simLastAiring && t - simLastAiring < settings.globalMinGapSeconds * 1000) continue;

        const candidates = [];
        for (const rule of state) {
          if (rule.pending) {
            candidates.push(rule);
            continue;
          }
          if (t < rule.nextEvalAt) continue;
          if (outsideWindow(rule, t)) { rule.nextEvalAt = t + rule.intervalSeconds * 1000; continue; }
          if (rule.maxPerDay && rule.airingsToday >= rule.maxPerDay) {
            rule.nextEvalAt = t + rule.intervalSeconds * 1000;
            continue;
          }
          if (rng() * 100 >= rule.probability) {
            rule.nextEvalAt = t + rule.intervalSeconds * 1000;
            continue;
          }
          rule.pending = true;
          candidates.push(rule);
        }
        if (!candidates.length) continue;

        const winner = candidates
          .map((rule) => ({
            rule,
            score: scoreRule(
              { ...rule, lastAiredAt: rule.lastAiredAt ? new Date(rule.lastAiredAt).toISOString() : undefined },
              t,
            ),
          }))
          .sort((a, b) => b.score - a.score)[0].rule;

        const duration = commandRegistry?.estimateDuration?.(winner.commandId, {}) || 60;
        const endsAt = t + duration * 1000;
        airings.push({
          ruleId: winner.id,
          label: winner.label,
          color: winner.color,
          at: new Date(t).toISOString(),
          durationSeconds: duration,
        });
        winner.pending = false;
        winner.lastAiredAt = endsAt;
        winner.airingsToday += 1;
        winner.nextEvalAt = endsAt + winner.intervalSeconds * 1000;
        simLastAiring = endsAt;
        totals.set(winner.id, (totals.get(winner.id) || 0) + 1);
      }
      if (run === 0) {
        representative = airings;
      }
    }

    const effectiveRuns = Math.max(1, runs);
    return {
      forecast: true,
      hours,
      runs: effectiveRuns,
      from: new Date(startMs).toISOString(),
      to: new Date(startMs + horizon).toISOString(),
      representative,
      perRule: store.all().filter((rule) => rule.enabled).map((rule) => ({
        ruleId: rule.id,
        label: rule.label,
        color: rule.color,
        expected: Math.round(expectedPerDay(rule) * (hours / 24) * 10) / 10,
        simulated: Math.round(((totals.get(rule.id) || 0) / effectiveRuns) * 10) / 10,
      })),
    };
  }

  // ------------------------------------------------------------ control

  function start() {
    if (timer) {
      return;
    }
    suppressUntil = now() + settings.globalMinGapSeconds * 1000;
    timer = setTimer(() => {
      tick().catch((error) => log?.warn?.('Scheduler tick failed', error?.message || error));
    }, settings.tickSeconds * 1000);
    timer?.unref?.();
    log?.info?.(
      `Display Scheduler ${settings.active ? 'active' : 'paused'} — `
      + `${store.all().length} rule(s), ${settings.tickSeconds}s tick`,
    );
  }

  function stop() {
    if (timer) {
      clearTimer(timer);
      timer = null;
    }
  }

  function updateSettings(patch = {}) {
    const previousTick = settings.tickSeconds;
    settings = sanitiseSettings({ ...settings, ...(patch || {}) }, settings);
    random = settings.randomSeed == null ? Math.random : seededRandom(settings.randomSeed);
    persistSettings();
    if (timer && settings.tickSeconds !== previousTick) {
      stop();
      start();
    }
    return settings;
  }

  return {
    // Engine
    tick,
    start,
    stop,
    airRule,
    reportInterruption,
    noteManualPush,

    // State
    status,
    nextUp,
    describeRule,
    simulate,
    get settings() { return { ...settings }; },
    updateSettings,

    // Stores. Mutations go through the engine so a new rule is stamped with the
    // engine's clock and inherits its command's guard default.
    rules: {
      ...store,
      all: () => store.all(),
      get: (id) => store.get(id),
      add: (raw) => store.add(raw, {
        now: now(),
        command: commandRegistry?.get?.(raw?.commandId) || null,
      }),
      update: (id, patch) => store.update(id, patch, {
        now: now(),
        command: commandRegistry?.get?.(patch?.commandId ?? store.get(id)?.commandId) || null,
      }),
    },
    activity,

    // Test seams
    _setLastAiringAt: (ms) => { lastAiringAt = ms; },
    _clearBootSuppression: () => { suppressUntil = 0; },
  };
}

module.exports = {
  DEFAULT_SETTINGS,
  MAX_TICK_SECONDS,
  seededRandom,
  sanitiseSettings,
  createDisplayScheduler,
};
