/**
 * Display Scheduler engine (display-scheduler.md §13).
 *
 * Every test drives a virtual clock and a seeded RNG — never real time, never
 * `Math.random`. A statistical assertion that depends on wall-clock timing is
 * not a test, it is a coin flip that fails in CI.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createDisplayScheduler, seededRandom, sanitiseSettings,
} = require('../src/display-scheduler');
const {
  normaliseRule, scoreRule, expectedPerDay, gapProfile, RULE_PALETTE,
} = require('../src/scheduler-rules');
const {
  withinWindow, localDateKey, createActivityLog,
} = require('../src/scheduler-activity');

const HOUR = 3600 * 1000;

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-'));
}

/** A registry with just enough surface for the engine. */
function fakeRegistry(overrides = {}) {
  const commands = {
    'signal.slideshow': {
      id: 'signal.slideshow', title: 'Slideshow', group: 'Signal',
      variableDuration: false, defaultDurationSeconds: 30, supportsContentCheck: true,
    },
    'alexa.weather': {
      id: 'alexa.weather', title: 'Weather', group: 'Alexa',
      variableDuration: false, defaultDurationSeconds: 30, supportsContentCheck: false,
    },
    'steam.now-playing': {
      id: 'steam.now-playing', title: 'Steam', group: 'Steam',
      variableDuration: false, defaultDurationSeconds: 30, supportsContentCheck: true,
    },
    'trivia.show': {
      id: 'trivia.show', title: 'Trivia', group: 'Trivia',
      variableDuration: true, defaultDurationSeconds: null, supportsContentCheck: true,
    },
    ...(overrides.commands || {}),
  };
  const content = { 'steam.now-playing': true, 'trivia.show': true, 'signal.slideshow': true, ...(overrides.content || {}) };
  return {
    get: (id) => commands[id] || null,
    hasContent: (id) => content[id] !== false,
    estimateDuration: (id, params = {}) => {
      if (id === 'trivia.show') return 120;
      if (params.displayDurationSeconds) return params.displayDurationSeconds;
      return commands[id]?.defaultDurationSeconds ?? 30;
    },
    _content: content,
    _commands: commands,
  };
}

/**
 * Build a scheduler on a virtual clock.
 *
 * `clock.t` is the only source of time; nothing here calls `Date.now()`.
 */
function build({
  rules = [], settings = {}, registry = fakeRegistry(), busy = () => false, airImpl,
  isBoardTarget = () => false,
} = {}) {
  const root = tempRoot();
  const clock = { t: Date.parse('2026-03-10T15:00:00Z') };
  const aired = [];
  const scheduler = createDisplayScheduler({
    config: { ROOT: root },
    log: { info() {}, warn() {}, error() {} },
    commandRegistry: registry,
    now: () => clock.t,
    isBusy: busy,
    isBoardTarget,
    // Never install a real interval: `tick()` is called explicitly.
    setTimer: () => null,
    clearTimer: () => {},
    timeZone: 'UTC',
    air: airImpl || ((rule) => { aired.push({ ruleId: rule.id, at: clock.t, target: rule.target }); }),
  });
  scheduler.updateSettings({
    active: true, tickSeconds: 30, globalMinGapSeconds: 0,
    quietHours: null, randomSeed: 12345, ...settings,
  });
  scheduler._clearBootSuppression();
  for (const rule of rules) {
    scheduler.rules.add({ nextEvalAt: new Date(clock.t).toISOString(), ...rule });
  }
  return { scheduler, clock, aired, root, registry };
}

/** Run N ticks, advancing the clock by tickSeconds each time. */
async function runTicks(scheduler, clock, count, stepSeconds = 30) {
  for (let i = 0; i < count; i += 1) {
    await scheduler.tick();
    clock.t += stepSeconds * 1000;
  }
}

// --------------------------------------------------------------- primitives

test('the seeded RNG is reproducible and stays in range', () => {
  const a = seededRandom(42);
  const b = seededRandom(42);
  const values = [];
  for (let i = 0; i < 200; i += 1) {
    const value = a();
    assert.equal(value, b());
    assert.ok(value >= 0 && value < 1, `${value} out of range`);
    values.push(value);
  }
  // A constant generator would pass the checks above.
  assert.ok(new Set(values).size > 190);
  assert.notEqual(seededRandom(43)(), seededRandom(42)());
});

test('score normalises across cadences, so the faster rule wins when further behind', () => {
  const now = Date.parse('2026-03-10T15:00:00Z');
  // §3's worked example: 45m rule waiting 60m beats a 2h rule waiting 130m.
  const fast = { intervalSeconds: 45 * 60, importance: 3, lastAiredAt: new Date(now - 60 * 60 * 1000).toISOString() };
  const slow = { intervalSeconds: 120 * 60, importance: 3, lastAiredAt: new Date(now - 130 * 60 * 1000).toISOString() };
  assert.ok(Math.abs(scoreRule(fast, now) - 1.333) < 0.01);
  assert.ok(Math.abs(scoreRule(slow, now) - 1.083) < 0.01);
  assert.ok(scoreRule(fast, now) > scoreRule(slow, now));
});

test('a rule that has never aired scores 2.0 before weighting', () => {
  const now = Date.parse('2026-03-10T15:00:00Z');
  assert.equal(scoreRule({ intervalSeconds: 600, importance: 3 }, now), 2);
  // Importance still applies to a first airing.
  assert.ok(Math.abs(scoreRule({ intervalSeconds: 600, importance: 1 }, now) - 0.667) < 0.01);
});

test('importance biases contests without creating a caste system', () => {
  const now = Date.parse('2026-03-10T15:00:00Z');
  // §3: a Background rule 3 intervals behind beats a Featured rule that just aired.
  const background = {
    intervalSeconds: 1800, importance: 1,
    lastAiredAt: new Date(now - 3 * 1800 * 1000).toISOString(),
  };
  const featured = {
    intervalSeconds: 1800, importance: 5,
    lastAiredAt: new Date(now - 0.1 * 1800 * 1000).toISOString(),
  };
  assert.ok(scoreRule(background, now) > scoreRule(featured, now));
});

test('expected-per-day and the gap profile match the §4.5 formulas', () => {
  const rule = { intervalSeconds: 45 * 60, probability: 90 };
  assert.ok(Math.abs(expectedPerDay(rule) - 28.8) < 0.01);
  const profile = gapProfile(rule);
  assert.equal(profile.typicalSeconds, 3000);
  // ~10% of the time you wait two intervals or more.
  assert.ok(profile.occasionalSeconds >= 45 * 60 * 2);
  assert.equal(gapProfile({ intervalSeconds: 600, probability: 0 }).typicalSeconds, null);
});

test('retired plex.last-played rules become Feature Presentation auto', () => {
  const rule = normaliseRule({
    commandId: 'plex.last-played',
    label: 'Feature Presentation — last played',
    params: { mode: 'last-played' },
  });
  assert.equal(rule.commandId, 'plex.now-playing');
  assert.equal(rule.label, 'Feature Presentation');
  assert.equal(rule.params.mode, undefined);

  const custom = normaliseRule({
    commandId: 'plex.last-played',
    label: 'Movie night',
  });
  assert.equal(custom.commandId, 'plex.now-playing');
  assert.equal(custom.label, 'Movie night');
});

test('rules get a stable colour from the palette, never a position-derived one', () => {
  const a = normaliseRule({ commandId: 'x' }, { existingRules: [] });
  const b = normaliseRule({ commandId: 'y' }, { existingRules: [a] });
  assert.ok(RULE_PALETTE.includes(a.color));
  assert.notEqual(a.color, b.color);
  // Re-normalising must not reassign it.
  assert.equal(normaliseRule(a, { existingRules: [b] }).color, a.color);
});

test('rule normalisation clamps hostile input instead of throwing', () => {
  const rule = normaliseRule({
    commandId: 'alexa.weather',
    intervalSeconds: 1,
    probability: 5000,
    importance: 99,
    jitterPercent: 900,
    daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
    activeWindow: { start: '25:00', end: 'nope' },
  });
  assert.equal(rule.intervalSeconds, 60);
  assert.equal(rule.probability, 100);
  assert.equal(rule.importance, 5);
  assert.equal(rule.jitterPercent, 50);
  assert.equal(rule.daysOfWeek, undefined, 'all seven days is no constraint');
  assert.equal(rule.activeWindow, undefined);
});

test('content-checked commands default their guard on', () => {
  const guarded = normaliseRule(
    { commandId: 'steam.now-playing' },
    { command: { title: 'Steam', supportsContentCheck: true } },
  );
  assert.equal(guarded.guard, 'requires-content');
  const plain = normaliseRule(
    { commandId: 'alexa.weather' },
    { command: { title: 'Weather', supportsContentCheck: false } },
  );
  assert.equal(plain.guard, undefined);
});

test('existing rules load as target full so boards stay quiet', () => {
  const inherited = normaliseRule({ commandId: 'alexa.weather' });
  assert.equal(inherited.target, 'full');
  assert.equal(normaliseRule({ commandId: 'alexa.weather', target: 'all' }).target, 'all');
  assert.equal(normaliseRule({ commandId: 'alexa.weather', target: '*' }).target, 'all');
  assert.equal(normaliseRule({ commandId: 'alexa.weather', target: 'vestaboard' }).target, 'vestaboard');
  assert.equal(normaliseRule({ commandId: 'alexa.weather', target: 'sim' }).target, 'sim');
});

test('a vestaboard-targeted rule airs even while the overlay is busy', async () => {
  const { scheduler, clock, aired } = build({
    busy: () => true,
    isBoardTarget: (id) => id === 'sim',
    rules: [
      { id: 'weather', commandId: 'alexa.weather', intervalSeconds: 3600, probability: 100, target: 'full' },
      { id: 'board', commandId: 'alexa.weather', intervalSeconds: 3600, probability: 100, target: 'vestaboard' },
    ],
  });
  await scheduler.tick();
  assert.deepEqual(aired.map((row) => row.ruleId), ['board']);
  assert.equal(aired[0].target, 'vestaboard');
  const events = scheduler.activity.query({ limit: 20 });
  assert.equal(events.find((event) => event.ruleId === 'board').target, 'vestaboard');
  assert.equal(events.some((event) => event.ruleId === 'weather'), false);
});

test('a board rule and a full-display rule can air on the same tick', async () => {
  const { scheduler, aired } = build({
    isBoardTarget: (id) => id === 'sim',
    rules: [
      { id: 'weather', commandId: 'alexa.weather', intervalSeconds: 3600, probability: 100, target: 'full' },
      { id: 'board', commandId: 'alexa.weather', intervalSeconds: 3600, probability: 100, target: 'sim' },
    ],
  });
  const result = await scheduler.tick();
  assert.equal(aired.length, 2);
  assert.ok(aired.some((row) => row.ruleId === 'weather' && row.target === 'full'));
  assert.ok(aired.some((row) => row.ruleId === 'board' && row.target === 'sim'));
  assert.equal(result.aired, 'weather');
  assert.equal(result.boardAired, 'board');
});

test('a full-display rule still waits when the overlay is busy', async () => {
  const { scheduler, aired } = build({
    busy: () => true,
    rules: [
      { id: 'weather', commandId: 'alexa.weather', intervalSeconds: 3600, probability: 100 },
    ],
  });
  const result = await scheduler.tick();
  assert.equal(result.reason, 'blocked-display');
  assert.equal(aired.length, 0);
});

// -------------------------------------------------------------- the tick

test('exactly one rule airs per tick, no matter how many are due', async () => {
  const { scheduler, clock, aired } = build({
    rules: [
      { commandId: 'alexa.weather', intervalSeconds: 3600, probability: 100 },
      { commandId: 'alexa.weather', intervalSeconds: 3600, probability: 100 },
      { commandId: 'alexa.weather', intervalSeconds: 3600, probability: 100 },
    ],
  });
  await scheduler.tick();
  assert.equal(aired.length, 1);
  clock.t += 30 * 1000;
  await scheduler.tick();
  assert.equal(aired.length, 2);
  assert.notEqual(aired[0].ruleId, aired[1].ruleId, 'the loser airs next, not a repeat');
});

test('losing the dice advances the timer a full interval', async () => {
  const { scheduler, clock } = build({
    rules: [{ commandId: 'alexa.weather', intervalSeconds: 600, probability: 0 }],
  });
  await scheduler.tick();
  const [rule] = scheduler.rules.all();
  const events = scheduler.activity.query({ limit: 100 });
  assert.equal(events.at(-1).outcome, 'lost-dice');
  assert.ok(events.at(-1).rolledValue >= 0);
  assert.equal(Date.parse(rule.nextEvalAt), clock.t + 600 * 1000);
  assert.equal(rule.pending, false);
});

test('losing the tie-break keeps the rule pending without a re-roll', async () => {
  // Both at 100% so the dice cannot explain the second airing; the loser must
  // carry its win forward. Re-rolling here would silently halve the true rate.
  const { scheduler, clock, aired } = build({
    rules: [
      { id: 'a', commandId: 'alexa.weather', intervalSeconds: 3600, probability: 100 },
      { id: 'b', commandId: 'alexa.weather', intervalSeconds: 3600, probability: 100 },
    ],
  });
  await scheduler.tick();
  const winnerId = aired[0].ruleId;
  const loser = scheduler.rules.all().find((rule) => rule.id !== winnerId);
  assert.equal(loser.pending, true, 'loser stays pending');
  assert.equal(Date.parse(loser.nextEvalAt), clock.t, 'loser timer did not advance');
  const tiebreak = scheduler.activity.query({ ruleId: loser.id, limit: 10 });
  assert.equal(tiebreak.at(-1).outcome, 'lost-tiebreak');
  assert.ok(tiebreak.at(-1).competingRuleIds.length === 2);

  clock.t += 30 * 1000;
  await scheduler.tick();
  assert.equal(aired.at(-1).ruleId, loser.id, 'the pending loser airs on the next free tick');
});

test('a pending rule expires rather than firing hours later out of context', async () => {
  let busy = true;
  const { scheduler, clock } = build({
    rules: [
      { id: 'a', commandId: 'alexa.weather', intervalSeconds: 600, probability: 100 },
      { id: 'b', commandId: 'alexa.weather', intervalSeconds: 600, probability: 100 },
    ],
    busy: () => busy,
  });
  busy = false;
  await scheduler.tick();
  const loser = scheduler.rules.all().find((rule) => rule.pending);
  assert.ok(loser);

  // Display goes busy for well over the rule's interval.
  busy = true;
  clock.t += 20 * 60 * 1000;
  await scheduler.tick();
  busy = false;
  await scheduler.tick();

  const events = scheduler.activity.query({ ruleId: loser.id, limit: 20 });
  assert.ok(
    events.some((event) => event.outcome === 'expired-pending'),
    'a long busy period must expire the pending flag',
  );
});

test('the timer advances from now, so downtime cannot cause a catch-up storm', async () => {
  const { scheduler, clock, aired } = build({
    rules: [{ commandId: 'alexa.weather', intervalSeconds: 600, probability: 100 }],
  });
  await scheduler.tick();
  assert.equal(aired.length, 1);
  // Simulate the bridge being down for six hours.
  clock.t += 6 * HOUR;
  await runTicks(scheduler, clock, 5);
  assert.equal(aired.length, 2, 'one airing, not twelve hours of backlog');
});

test('a restart does not fire a burst of overdue rules', async () => {
  const root = tempRoot();
  const clock = { t: Date.parse('2026-03-10T15:00:00Z') };
  const registry = fakeRegistry();
  const aired = [];
  const make = () => {
    const scheduler = createDisplayScheduler({
      config: { ROOT: root },
      log: { info() {}, warn() {}, error() {} },
      commandRegistry: registry,
      now: () => clock.t,
      setTimer: () => null,
      clearTimer: () => {},
      timeZone: 'UTC',
      air: (rule) => { aired.push(rule.id); },
    });
    return scheduler;
  };

  const first = make();
  first.updateSettings({ active: true, globalMinGapSeconds: 300, quietHours: null, randomSeed: 7 });
  for (let i = 0; i < 4; i += 1) {
    first.rules.add({
      commandId: 'alexa.weather', intervalSeconds: 600, probability: 100,
      nextEvalAt: new Date(clock.t).toISOString(),
    });
  }

  // Down for a day; everything is now wildly overdue.
  clock.t += 24 * HOUR;
  const second = make();
  await runTicks(second, clock, 5);
  // Boot suppression covers the first globalMinGapSeconds; after that the
  // one-airing-per-tick rule plus the global gap keeps it to a trickle.
  assert.ok(aired.length <= 1, `expected at most one airing after restart, got ${aired.length}`);
});

test('nothing airs while the display is busy', async () => {
  let busy = true;
  const { scheduler, clock, aired } = build({
    rules: [{ commandId: 'alexa.weather', intervalSeconds: 600, probability: 100 }],
    busy: () => busy,
  });
  await runTicks(scheduler, clock, 10);
  assert.equal(aired.length, 0);
  busy = false;
  await scheduler.tick();
  assert.equal(aired.length, 1);
});

test('quiet hours and the global gap stop the tick before any rule is considered', async () => {
  const { scheduler, clock, aired } = build({
    rules: [{ commandId: 'alexa.weather', intervalSeconds: 600, probability: 100 }],
    settings: { quietHours: { start: '14:00', end: '18:00' }, globalMinGapSeconds: 600 },
  });
  scheduler._clearBootSuppression();
  const result = await scheduler.tick();
  assert.equal(result.reason, 'blocked-quiet-hours');
  assert.equal(aired.length, 0);
  // No per-rule events either — the gate returns before Stage 2.
  assert.equal(scheduler.activity.query({ limit: 50 }).length, 0);

  clock.t += 4 * HOUR;
  scheduler._clearBootSuppression();
  await scheduler.tick();
  assert.equal(aired.length, 1);
  clock.t += 60 * 1000;
  assert.equal((await scheduler.tick()).reason, 'blocked-global-gap');
});

test('a content guard blocks the airing and advances the timer', async () => {
  const registry = fakeRegistry({ content: { 'steam.now-playing': false } });
  const { scheduler, clock, aired } = build({
    registry,
    rules: [{
      commandId: 'steam.now-playing', intervalSeconds: 600,
      probability: 100, guard: 'requires-content',
    }],
  });
  await scheduler.tick();
  assert.equal(aired.length, 0);
  assert.equal(scheduler.activity.query({ limit: 10 }).at(-1).outcome, 'blocked-guard');
  assert.equal(Date.parse(scheduler.rules.all()[0].nextEvalAt), clock.t + 600 * 1000);

  registry._content['steam.now-playing'] = true;
  clock.t += 600 * 1000;
  await scheduler.tick();
  assert.equal(aired.length, 1);
});

test('a rule pointing at a removed command records error and does not kill the tick', async () => {
  const { scheduler, clock, aired } = build({
    rules: [
      { id: 'broken', commandId: 'nope.gone', intervalSeconds: 600, probability: 100 },
      { id: 'good', commandId: 'alexa.weather', intervalSeconds: 600, probability: 100 },
    ],
  });
  await scheduler.tick();
  assert.equal(aired.length, 1);
  assert.equal(aired[0].ruleId, 'good', 'the healthy rule still airs');
  const broken = scheduler.activity.query({ ruleId: 'broken', limit: 10 });
  assert.equal(broken.at(-1).outcome, 'error');
  assert.match(broken.at(-1).detail, /Unknown command/);
  assert.equal(scheduler.describeRule(scheduler.rules.get('broken')).broken, true);
});

test('an air() that throws is recorded and the tick survives', async () => {
  let shouldThrow = true;
  const { scheduler, clock } = build({
    rules: [{ id: 'a', commandId: 'alexa.weather', intervalSeconds: 600, probability: 100 }],
    airImpl: () => {
      if (shouldThrow) throw new Error('UDP send failed');
      return null;
    },
  });
  await scheduler.tick();
  const events = scheduler.activity.query({ limit: 10 });
  assert.equal(events.at(-1).outcome, 'error');
  assert.match(events.at(-1).detail, /UDP send failed/);

  shouldThrow = false;
  clock.t += 600 * 1000;
  const result = await scheduler.tick();
  assert.equal(result.aired, 'a');
});

test('maxPerDay caps a rule and resets at local midnight, not 24h after boot', async () => {
  const { scheduler, clock, aired } = build({
    rules: [{
      commandId: 'alexa.weather', intervalSeconds: 60, probability: 100, maxPerDay: 2,
    }],
  });
  await runTicks(scheduler, clock, 40, 60);
  assert.equal(aired.length, 2);
  assert.ok(
    scheduler.activity.query({ limit: 200 }).some((event) => event.outcome === 'blocked-cap'),
  );

  // Cross local midnight (clock started at 15:00 UTC).
  clock.t += 10 * HOUR;
  await scheduler.tick();
  assert.equal(aired.length, 3, 'the counter resets on the local date change');
});

test('cooldown blocks a rule for its own window', async () => {
  const { scheduler, clock, aired } = build({
    rules: [{
      commandId: 'alexa.weather', intervalSeconds: 60, probability: 100, cooldownSeconds: 600,
    }],
  });
  await runTicks(scheduler, clock, 5, 60);
  assert.equal(aired.length, 1);
  assert.ok(
    scheduler.activity.query({ limit: 50 }).some((event) => event.outcome === 'blocked-cooldown'),
  );
  clock.t += 11 * 60 * 1000;
  await scheduler.tick();
  assert.equal(aired.length, 2);
});

// ------------------------------------------------------ the core promises

test('starvation is impossible: a Background rule still airs against a Featured rival', async () => {
  // §13's core test. Identical cadence and probability, importance 1 vs 5.
  const { scheduler, clock, aired } = build({
    rules: [
      { id: 'background', commandId: 'alexa.weather', intervalSeconds: 1800, probability: 100, importance: 1 },
      { id: 'featured', commandId: 'alexa.weather', intervalSeconds: 1800, probability: 100, importance: 5 },
    ],
  });
  await runTicks(scheduler, clock, 1000);
  const backgroundAirings = aired.filter((entry) => entry.ruleId === 'background').length;
  const share = backgroundAirings / aired.length;
  assert.ok(aired.length > 20, `expected real traffic, got ${aired.length} airings`);
  assert.ok(
    share >= 0.3,
    `Background rule aired ${(share * 100).toFixed(1)}% of the time — starvation`,
  );
});

test('the observed airing rate tracks the configured probability', async () => {
  // Catches accidental double-rolling: a second roll would show up here as a
  // rate near p² rather than p.
  const { scheduler, clock, aired } = build({
    rules: [{ commandId: 'alexa.weather', intervalSeconds: 600, probability: 50 }],
    settings: { randomSeed: 99 },
  });
  const ticks = 10000;
  await runTicks(scheduler, clock, ticks);

  const elapsedDays = (ticks * 30) / 86400;
  const expected = expectedPerDay({ intervalSeconds: 600, probability: 50 }) * elapsedDays;
  const observed = aired.length;
  // Generous band: the rule re-arms 600s after each *evaluation*, so the exact
  // expectation is bounded, not pointlike. p² would be far outside this.
  assert.ok(
    observed > expected * 0.6 && observed < expected * 1.25,
    `observed ${observed} airings, expected ≈${expected.toFixed(0)}`,
  );
});

test('a 100% rule airs on essentially every interval', async () => {
  const { scheduler, clock, aired } = build({
    rules: [{ commandId: 'alexa.weather', intervalSeconds: 600, probability: 100 }],
  });
  await runTicks(scheduler, clock, 2 * 60 * 2);
  // 2 hours of 30s ticks; a 10-minute rule should manage close to 12 airings.
  assert.ok(aired.length >= 10 && aired.length <= 12, `got ${aired.length}`);
});

// ------------------------------------------------------ variable duration

test('a trivia round holds the display for its whole sequence', async () => {
  const { scheduler, clock, aired } = build({
    rules: [
      { id: 'trivia', commandId: 'trivia.show', intervalSeconds: 900, probability: 100, importance: 5 },
      // 300s interval so its pending flag outlives the 120s round; a 60s rule
      // would legitimately expire mid-round and prove nothing.
      { id: 'weather', commandId: 'alexa.weather', intervalSeconds: 300, probability: 100 },
    ],
    settings: { globalMinGapSeconds: 0 },
  });
  await scheduler.tick();
  assert.equal(aired[0].ruleId, 'trivia');

  // 120-second round; nothing may air inside it even with a 60s rule due.
  const airedDuringRound = [];
  for (let elapsed = 30; elapsed < 120; elapsed += 30) {
    clock.t += 30 * 1000;
    const before = aired.length;
    await scheduler.tick();
    if (aired.length > before) {
      airedDuringRound.push(aired.at(-1).ruleId);
    }
  }
  assert.deepEqual(airedDuringRound, [], 'nothing may air between trivia cards');

  clock.t += 30 * 1000;
  await scheduler.tick();
  assert.equal(aired.at(-1).ruleId, 'weather', 'the display frees up when the round ends');
});

test('lastAiringAt is stamped at sequence end, not sequence start', async () => {
  const { scheduler, clock } = build({
    rules: [{ id: 'trivia', commandId: 'trivia.show', intervalSeconds: 900, probability: 100 }],
  });
  const startedAt = clock.t;
  await scheduler.tick();
  const rule = scheduler.rules.get('trivia');
  assert.equal(
    Date.parse(rule.lastAiredAt), startedAt + 120 * 1000,
    'a 2-minute round must not count as having aired 2 minutes ago',
  );
  assert.equal(Date.parse(scheduler.status().lastAiringAt), startedAt + 120 * 1000);
});

test('an interrupted round records the partial duration, not the plan', async () => {
  const { scheduler, clock } = build({
    rules: [{ id: 'trivia', commandId: 'trivia.show', intervalSeconds: 900, probability: 100 }],
  });
  const startedAt = clock.t;
  await scheduler.tick();
  assert.equal(scheduler.activity.query({ limit: 5 }).at(-1).durationSeconds, 120);

  clock.t = startedAt + 45 * 1000;
  const amended = scheduler.reportInterruption(clock.t);
  assert.equal(amended.durationSeconds, 45);
  assert.equal(amended.interrupted, true);
  const persisted = scheduler.activity.query({ limit: 5 }).at(-1);
  assert.equal(persisted.durationSeconds, 45);
  assert.equal(persisted.interrupted, true);
});

test('a manual push suppresses automated airings for the global gap', async () => {
  const { scheduler, clock, aired } = build({
    rules: [{ commandId: 'alexa.weather', intervalSeconds: 60, probability: 100 }],
    settings: { globalMinGapSeconds: 300 },
  });
  scheduler.noteManualPush(clock.t);
  await runTicks(scheduler, clock, 8);
  assert.equal(aired.length, 0, 'do not yank away what a person just put up');
  clock.t += 300 * 1000;
  await scheduler.tick();
  assert.equal(aired.length, 1);
});

test('the rule editor warns when a round eats a quarter of its interval', () => {
  const { scheduler } = build({
    rules: [
      // A 2-minute round every 5 minutes is 40% of the interval — warn.
      { id: 'tight', commandId: 'trivia.show', intervalSeconds: 300, probability: 100 },
      { id: 'roomy', commandId: 'trivia.show', intervalSeconds: 4 * 3600, probability: 100 },
    ],
  });
  assert.match(scheduler.describeRule(scheduler.rules.get('tight')).durationWarning, /every/);
  assert.equal(scheduler.describeRule(scheduler.rules.get('roomy')).durationWarning, null);
  assert.equal(scheduler.describeRule(scheduler.rules.get('tight')).variableDuration, true);
});

// ------------------------------------------------------- time and windows

test('window maths runs on the local wall clock across a DST transition', () => {
  // US spring-forward: 2026-03-08 02:00 local does not exist in America/Denver.
  const zone = 'America/Denver';
  const evening = { start: '18:00', end: '22:00' };
  // 2026-03-07 19:00 MST = 2026-03-08 02:00 UTC.
  assert.equal(withinWindow(Date.parse('2026-03-08T02:00:00Z'), evening, zone), true);
  // 2026-03-08 19:00 MDT = 2026-03-09 01:00 UTC — one UTC hour later, same
  // local hour. Doing this on UTC hours would give a different answer.
  assert.equal(withinWindow(Date.parse('2026-03-09T01:00:00Z'), evening, zone), true);
  // Fall-back: 2026-11-01, the repeated 01:00 local hour.
  assert.equal(withinWindow(Date.parse('2026-11-01T07:30:00Z'), { start: '01:00', end: '02:00' }, zone), true);
  assert.equal(withinWindow(Date.parse('2026-11-01T08:30:00Z'), { start: '01:00', end: '02:00' }, zone), true);
});

test('a window that wraps midnight covers both sides of it', () => {
  const quiet = { start: '23:00', end: '07:00' };
  assert.equal(withinWindow(Date.parse('2026-03-10T23:30:00Z'), quiet, 'UTC'), true);
  assert.equal(withinWindow(Date.parse('2026-03-10T02:00:00Z'), quiet, 'UTC'), true);
  assert.equal(withinWindow(Date.parse('2026-03-10T12:00:00Z'), quiet, 'UTC'), false);
});

test('a windowed rule is blocked outside its hours and airs inside them', async () => {
  const { scheduler, clock, aired } = build({
    rules: [{
      commandId: 'alexa.weather', intervalSeconds: 600, probability: 100,
      activeWindow: { start: '18:00', end: '22:00' },
    }],
  });
  // Clock starts at 15:00 UTC — outside the window.
  await scheduler.tick();
  assert.equal(aired.length, 0);
  assert.equal(scheduler.activity.query({ limit: 5 }).at(-1).outcome, 'blocked-window');

  clock.t += 4 * HOUR;
  await scheduler.tick();
  assert.equal(aired.length, 1);
});

test('a days-of-week rule only airs on its days', async () => {
  // 2026-03-10 is a Tuesday (weekday 2).
  const { scheduler, clock, aired } = build({
    rules: [{ commandId: 'alexa.weather', intervalSeconds: 600, probability: 100, daysOfWeek: [0, 6] }],
  });
  await scheduler.tick();
  assert.equal(aired.length, 0);
  // Advance to Saturday.
  clock.t += 4 * 24 * HOUR;
  await scheduler.tick();
  assert.equal(aired.length, 1);
});

// -------------------------------------------------------------- activity

test('activity is partitioned by local date and pruned by file', () => {
  const dir = path.join(tempRoot(), 'activity');
  const log = createActivityLog(dir, { timeZone: 'UTC' });
  log.record({ ruleId: 'a', outcome: 'aired', at: new Date().toISOString() });
  const today = localDateKey(Date.now(), 'UTC');
  assert.ok(fs.existsSync(path.join(dir, `${today}.jsonl`)));

  fs.writeFileSync(path.join(dir, '2020-01-01.jsonl'), '{"outcome":"aired"}\n');
  assert.equal(log.prune(30), 1);
  assert.ok(!fs.existsSync(path.join(dir, '2020-01-01.jsonl')));
  assert.ok(fs.existsSync(path.join(dir, `${today}.jsonl`)));
});

test('a corrupt activity line does not lose the rest of the day', () => {
  const dir = path.join(tempRoot(), 'activity');
  fs.mkdirSync(dir, { recursive: true });
  const today = localDateKey(Date.now(), 'UTC');
  const at = new Date().toISOString();
  fs.writeFileSync(path.join(dir, `${today}.jsonl`), [
    JSON.stringify({ id: '1', ruleId: 'a', at, outcome: 'aired' }),
    '{ this is not json',
    JSON.stringify({ id: '2', ruleId: 'a', at, outcome: 'lost-dice' }),
  ].join('\n') + '\n');
  const log = createActivityLog(dir, { timeZone: 'UTC' });
  assert.equal(log.query({ limit: 100 }).length, 2);
});

test('events either side of local midnight are each counted once', () => {
  const dir = path.join(tempRoot(), 'activity');
  const log = createActivityLog(dir, {
    timeZone: 'UTC',
    now: () => Date.parse('2026-03-11T04:00:00Z'),
  });

  log.record({ ruleId: 'a', outcome: 'aired', at: '2026-03-10T22:00:00Z' });
  log.record({ ruleId: 'a', outcome: 'aired', at: '2026-03-10T23:00:00Z' });
  log.record({ ruleId: 'a', outcome: 'aired', at: '2026-03-11T01:00:00Z' });

  const window = { from: '2026-03-10T00:00:00Z', to: '2026-03-11T04:00:00Z' };
  assert.equal(fs.readFileSync(path.join(dir, '2026-03-10.jsonl'), 'utf8').trim().split('\n').length, 2);
  assert.equal(fs.readFileSync(path.join(dir, '2026-03-11.jsonl'), 'utf8').trim().split('\n').length, 1);
  // The in-memory day buffer used to inherit the previous day's events when the
  // date rolled over, so a bridge left running overnight double-counted them.
  assert.equal(log.query(window).length, 3);
  assert.equal(log.stats(window)[0].aired, 3);
});

test('stats aggregate hit rate, gaps and the dominant reason for skipping', () => {
  const dir = path.join(tempRoot(), 'activity');
  const log = createActivityLog(dir, { timeZone: 'UTC' });
  const base = Date.now() - 6 * HOUR;
  log.record({ ruleId: 'steam', outcome: 'aired', at: new Date(base).toISOString(), durationSeconds: 30 });
  log.record({ ruleId: 'steam', outcome: 'aired', at: new Date(base + HOUR).toISOString(), durationSeconds: 30 });
  log.record({ ruleId: 'steam', outcome: 'lost-dice', at: new Date(base + 2 * HOUR).toISOString() });
  for (let i = 0; i < 21; i += 1) {
    log.record({ ruleId: 'steam', outcome: 'blocked-guard', at: new Date(base + 3 * HOUR + i).toISOString() });
  }

  const [stats] = log.stats({ from: new Date(base - HOUR).toISOString() });
  assert.equal(stats.aired, 2);
  assert.equal(stats.evaluations, 24);
  // Hit rate excludes blocks: 2 aired out of 3 genuine contests.
  assert.ok(Math.abs(stats.hitRate - 2 / 3) < 0.001);
  assert.equal(stats.avgGapSeconds, 3600);
  assert.deepEqual(stats.dominantSkip, { outcome: 'blocked-guard', count: 21 });
});

test('stats roll up per-board outcomes on an airing', () => {
  const dir = path.join(tempRoot(), 'activity');
  const log = createActivityLog(dir, { timeZone: 'UTC' });
  const at = new Date().toISOString();
  log.record({
    ruleId: 'board-weather',
    outcome: 'aired',
    at,
    target: 'sim',
    boardOutcomes: [{ boardId: 'sim', reason: 'queued' }],
  });
  log.record({
    ruleId: 'board-weather',
    outcome: 'aired',
    at,
    target: 'sim',
    boardOutcomes: [{ boardId: 'sim', reason: 'gap' }],
  });
  const [stats] = log.stats({ from: new Date(Date.now() - HOUR).toISOString() });
  assert.equal(stats.aired, 2);
  assert.deepEqual(stats.boards.sim, { queued: 1, gap: 1 });
});

test('the heatmap counts only airings, in local hours', () => {
  const dir = path.join(tempRoot(), 'activity');
  const log = createActivityLog(dir, { timeZone: 'UTC' });
  const at = new Date();
  at.setUTCMinutes(30, 0, 0);
  log.record({ ruleId: 'a', outcome: 'aired', at: at.toISOString() });
  log.record({ ruleId: 'a', outcome: 'lost-dice', at: at.toISOString() });
  const rows = log.heatmap({ days: 2 });
  assert.equal(rows.length, 2);
  assert.equal(rows[1].hours[at.getUTCHours()], 1, 'skips must not inflate the heatmap');
});

test('the activity query filters by rule and outcome', () => {
  const dir = path.join(tempRoot(), 'activity');
  const log = createActivityLog(dir, { timeZone: 'UTC' });
  const at = new Date().toISOString();
  log.record({ ruleId: 'a', outcome: 'aired', at });
  log.record({ ruleId: 'b', outcome: 'aired', at });
  log.record({ ruleId: 'a', outcome: 'lost-dice', at });
  assert.equal(log.query({ ruleId: 'a' }).length, 2);
  assert.equal(log.query({ outcomes: ['aired'] }).length, 2);
  assert.equal(log.query({ ruleId: 'a', outcomes: ['aired'] }).length, 1);
});

// ---------------------------------------------------------------- status

test('status reports the next rule due and the live gates', async () => {
  const { scheduler, clock, aired } = build({
    rules: [
      { id: 'soon', commandId: 'alexa.weather', intervalSeconds: 600, probability: 100 },
      { id: 'later', commandId: 'alexa.weather', intervalSeconds: 7200, probability: 100 },
    ],
  });
  await scheduler.tick();
  assert.equal(aired.length, 1);
  const status = scheduler.status();
  assert.equal(status.active, true);
  assert.equal(status.ruleCount, 2);
  assert.equal(status.airingsToday, 1);
  assert.ok(status.nextUp);
  assert.equal(status.displayBusy, false);
});

test('settings sanitisation refuses a tick slower than 60 seconds', () => {
  // §4.1: tick granularity is the resolution of the whole system.
  assert.equal(sanitiseSettings({ tickSeconds: 600 }).tickSeconds, 60);
  assert.equal(sanitiseSettings({ tickSeconds: 0 }).tickSeconds, 5);
  assert.deepEqual(sanitiseSettings({}).quietHours, { start: '23:00', end: '07:00' });
  assert.equal(sanitiseSettings({ quietHours: { start: 'x', end: 'y' } }).quietHours, null);
  assert.equal(sanitiseSettings({}).active, false, 'never start active by default');
});

test('rules and settings survive a restart', async () => {
  const root = tempRoot();
  const registry = fakeRegistry();
  const clock = { t: Date.parse('2026-03-10T15:00:00Z') };
  const make = () => createDisplayScheduler({
    config: { ROOT: root },
    log: { info() {}, warn() {}, error() {} },
    commandRegistry: registry,
    now: () => clock.t,
    setTimer: () => null,
    clearTimer: () => {},
    timeZone: 'UTC',
    air: () => {},
  });

  const first = make();
  // Seeded so the airing below is a fact of the test rather than a 77% chance
  // of one — an unseeded roll failed this on roughly one run in four.
  first.updateSettings({
    active: true, globalMinGapSeconds: 111, quietHours: null, randomSeed: 7,
  });
  const rule = first.rules.add({ commandId: 'alexa.weather', intervalSeconds: 600, probability: 77, label: 'Kept' });
  first._clearBootSuppression();
  await first.tick();

  const second = make();
  assert.equal(second.settings.active, true);
  assert.equal(second.settings.globalMinGapSeconds, 111);
  const restored = second.rules.get(rule.id);
  assert.equal(restored.label, 'Kept');
  assert.equal(restored.probability, 77);
  assert.ok(restored.lastAiredAt, 'runtime state persists across a restart');
});

test('simulate forecasts without touching the real rules or activity log', () => {
  const { scheduler } = build({
    rules: [
      { id: 'a', commandId: 'alexa.weather', intervalSeconds: 1800, probability: 100 },
      { id: 'b', commandId: 'signal.slideshow', intervalSeconds: 3600, probability: 50 },
    ],
    settings: { globalMinGapSeconds: 60 },
  });
  const before = JSON.stringify(scheduler.rules.all());
  const result = scheduler.simulate({ hours: 24, runs: 20, seed: 3 });

  assert.equal(result.forecast, true);
  assert.equal(result.perRule.length, 2);
  assert.ok(result.representative.length > 0);
  assert.ok(result.perRule.every((entry) => entry.simulated >= 0));
  assert.equal(JSON.stringify(scheduler.rules.all()), before, 'simulation must have no side effects');
  assert.equal(scheduler.activity.query({ limit: 10 }).length, 0);
});

test('simulate is deterministic for a given seed', () => {
  const { scheduler } = build({
    rules: [{ id: 'a', commandId: 'alexa.weather', intervalSeconds: 1800, probability: 70 }],
  });
  const a = scheduler.simulate({ hours: 12, runs: 5, seed: 11 });
  const b = scheduler.simulate({ hours: 12, runs: 5, seed: 11 });
  assert.deepEqual(a.representative, b.representative);
});

test('a paused scheduler evaluates nothing at all', async () => {
  const { scheduler, clock, aired } = build({
    rules: [{ commandId: 'alexa.weather', intervalSeconds: 60, probability: 100 }],
    settings: { active: false },
  });
  await runTicks(scheduler, clock, 20);
  assert.equal(aired.length, 0);
  assert.equal(scheduler.activity.query({ limit: 50 }).length, 0);

  scheduler.updateSettings({ active: true });
  await scheduler.tick();
  assert.equal(aired.length, 1);
});

test('a disabled rule is skipped without logging noise every tick', async () => {
  const { scheduler, clock, aired } = build({
    rules: [{ commandId: 'alexa.weather', intervalSeconds: 60, probability: 100, enabled: false }],
  });
  await runTicks(scheduler, clock, 20);
  assert.equal(aired.length, 0);
  // 2,900 rows a day is the budget for meaningful skips; a disabled rule
  // logging 2,880 'disabled' events would swamp it.
  assert.equal(scheduler.activity.query({ limit: 100 }).length, 0);
});

test('air-now bypasses the dice and the interval', async () => {
  const { scheduler, aired } = build({
    rules: [{ id: 'a', commandId: 'alexa.weather', intervalSeconds: 7200, probability: 0 }],
  });
  await scheduler.airRule(scheduler.rules.get('a'), { manual: true });
  assert.equal(aired.length, 1);
  assert.equal(scheduler.activity.query({ limit: 5 }).at(-1).outcome, 'aired');
});
