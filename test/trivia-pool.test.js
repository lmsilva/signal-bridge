const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createTriviaPool,
  DAY_MS,
  HARD_POOL_CAP,
  EXHAUSTED_TTL_MS,
  FETCH_BATCH_SIZE,
} = require('../src/trivia-pool');
const {
  createTriviaSettings,
  sanitiseSettings,
  defaultSettings,
  roundDurationSeconds,
} = require('../src/trivia-settings');

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'trivia-pool-'));
}

let seq = 0;
function makeQuestion(overrides = {}) {
  seq += 1;
  return {
    id: `q${seq}`,
    provider: 'opentdb',
    categoryId: 'geography',
    categoryLabel: 'Geography',
    difficulty: 'easy',
    type: 'multiple',
    text: `Question ${seq}?`,
    correctAnswer: 'Yes',
    incorrectAnswers: ['No', 'Maybe', 'Perhaps'],
    fetchedAt: new Date(0).toISOString(),
    servedAt: null,
    ...overrides,
  };
}

/** Deterministic RNG so "pick a spread" assertions are not flaky. */
function seededRandom(seed = 1) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

function makePool({ root, providers = [], settings: patch = {}, now = () => 0 } = {}) {
  const ROOT = root || tempRoot();
  const settings = createTriviaSettings({ ROOT }, silentLog);
  settings.update({
    enabledCategoryIds: ['geography', 'history', 'music'],
    enabledDifficulties: ['easy', 'medium'],
    questionsPerSession: 3,
    poolTargetSize: 40,
    poolLowWatermark: 20,
    ...patch,
  });
  const pool = createTriviaPool({
    config: { ROOT }, log: silentLog, providers, settings, now, random: seededRandom(7),
  });
  return { pool, settings, ROOT };
}

/* ------------------------------------------------------------ settings maths */

test('round duration is intro + n*(question+answer) + summary', () => {
  const settings = defaultSettings();
  // 4 + 5*(15+7) + 6
  assert.equal(roundDurationSeconds(settings), 120);
  assert.equal(roundDurationSeconds(settings, { count: 1 }), 4 + 22);
  assert.equal(roundDurationSeconds(settings, { count: 10 }), 4 + 220 + 6);
});

test('a one-question round drops the summary card', () => {
  // Nothing to summarise (trivia.md §6.9).
  const settings = { ...defaultSettings(), showSummaryCard: true };
  assert.equal(
    roundDurationSeconds(settings, { count: 1 }),
    roundDurationSeconds({ ...settings, showSummaryCard: false }, { count: 1 }),
  );
});

test('settings clamp out-of-range values instead of rejecting them', () => {
  const settings = sanitiseSettings({
    questionsPerSession: 99, questionSeconds: -4, avoidRepeatDays: 10000,
  });
  assert.equal(settings.questionsPerSession, 10);
  assert.equal(settings.questionSeconds, 2);
  assert.equal(settings.avoidRepeatDays, 365);
});

test('an empty selection falls back rather than starving every round', () => {
  const settings = sanitiseSettings({ enabledDifficulties: [], enabledCategoryIds: [] });
  assert.ok(settings.enabledDifficulties.length > 0);
  assert.equal(settings.enabledCategoryIds.length, 26);
});

test('unknown providers, difficulties and categories are dropped', () => {
  const settings = sanitiseSettings({
    enabledProviders: ['opentdb', 'made-up'],
    enabledDifficulties: ['easy', 'impossible'],
    enabledCategoryIds: ['geography', 'not-a-category'],
  });
  assert.deepEqual(settings.enabledProviders, ['opentdb']);
  assert.deepEqual(settings.enabledDifficulties, ['easy']);
  assert.deepEqual(settings.enabledCategoryIds, ['geography']);
});

test('settings survive a round trip through disk', () => {
  const ROOT = tempRoot();
  const first = createTriviaSettings({ ROOT }, silentLog);
  first.update({ questionsPerSession: 8, questionSeconds: 20 });
  const second = createTriviaSettings({ ROOT }, silentLog);
  assert.equal(second.get().questionsPerSession, 8);
  assert.equal(second.get().questionSeconds, 20);
});

test('a low watermark above the target is rejected', () => {
  const settings = createTriviaSettings({ ROOT: tempRoot() }, silentLog);
  const result = settings.update({ poolTargetSize: 50, poolLowWatermark: 500 });
  assert.equal(result.ok, false);
  assert.match(result.error, /poolLowWatermark/);
});

/* --------------------------------------------------------------- pool basics */

test('the pool self-stocks to target from empty', async () => {
  let issued = 0;
  const provider = {
    id: 'opentdb',
    async fetchQuestions({ categoryId }) {
      return Array.from({ length: 10 }, () => {
        issued += 1;
        return makeQuestion({ id: `stock-${issued}`, categoryId });
      });
    },
  };
  const { pool } = makePool({ providers: [provider] });

  assert.equal(pool.status().size, 0);
  await pool.refill();
  assert.ok(pool.status().size >= 30, `stocked ${pool.status().size}`);
});

test('refill balances across enabled categories rather than filling one', async () => {
  const provider = {
    id: 'opentdb',
    async fetchQuestions({ categoryId }) {
      return Array.from({ length: 5 }, () => makeQuestion({ categoryId }));
    },
  };
  const { pool } = makePool({ providers: [provider] });
  await pool.refill();

  const counts = pool.status().perCategory;
  assert.equal(counts.geography, 5);
  assert.equal(counts.history, 5);
  assert.equal(counts.music, 5);
});

test('a category with nothing left to give is left alone for a while', async () => {
  // Some subjects hold only a handful of questions and can never reach their
  // share. Re-asking them every pass is how you get rate-limited off a free API.
  const asked = [];
  const provider = {
    id: 'opentdb',
    async fetchQuestions({ categoryId, amount }) {
      asked.push(categoryId);
      return categoryId === 'history'
        ? []
        : Array.from({ length: amount }, () => makeQuestion({ categoryId }));
    },
  };
  let clock = 0;
  const { pool } = makePool({ providers: [provider], now: () => clock });

  await pool.refill();
  assert.ok(asked.includes('history'));

  asked.length = 0;
  clock += 60 * 60 * 1000;
  await pool.refill({ force: true });
  assert.ok(!asked.includes('history'), 'an empty category must not be re-asked an hour later');

  // A day on, it is worth another try — a recycled session token makes the
  // whole category available again.
  asked.length = 0;
  clock += EXHAUSTED_TTL_MS;
  await pool.refill({ force: true });
  assert.ok(asked.includes('history'));
});

test('duplicate question ids are never stored twice', () => {
  const { pool } = makePool();
  const question = makeQuestion({ id: 'dupe' });
  assert.equal(pool.addQuestions([question]), 1);
  assert.equal(pool.addQuestions([{ ...question }]), 0);
  assert.equal(pool.status().size, 1);
});

test('a served-then-pruned question is still deduped by id', () => {
  let clock = 40 * DAY_MS;
  const { pool, settings } = makePool({ now: () => clock });
  settings.update({ avoidRepeatDays: 30 });
  pool.addQuestions([makeQuestion({
    id: 'old', servedAt: new Date(clock - 35 * DAY_MS).toISOString(),
  })]);

  assert.equal(pool.prune().pruned, 1);
  assert.equal(pool.status().size, 0);
  // Its body is gone but re-fetching it must not resurrect it.
  assert.equal(pool.addQuestions([makeQuestion({ id: 'old' })]), 0);
});

test('the pool is capped so it cannot grow without bound', () => {
  const { pool } = makePool();
  pool.addQuestions(Array.from(
    { length: HARD_POOL_CAP + 200 },
    (_, i) => makeQuestion({ id: `bulk-${i}` }),
  ));
  assert.equal(pool.status().size, HARD_POOL_CAP);
});

test('a retryable provider error backs off instead of hammering', async () => {
  let calls = 0;
  const provider = {
    id: 'opentdb',
    async fetchQuestions() {
      calls += 1;
      const error = new Error('rate limit');
      error.retryable = true;
      throw error;
    },
  };
  let clock = 0;
  const { pool } = makePool({ providers: [provider], now: () => clock });

  const first = await pool.refill();
  assert.equal(first.ok, false);
  assert.ok(first.retryInMs > 0);
  assert.equal(calls, 1, 'a retryable error must stop the pass, not continue the loop');

  const second = await pool.refill();
  assert.equal(second.skipped, 'backoff');
  assert.equal(calls, 1);

  // Backoff grows on repeated failure.
  clock += first.retryInMs + 1;
  const third = await pool.refill();
  assert.ok(third.retryInMs > first.retryInMs);
});

test('refill is a no-op once every category has its share', async () => {
  let calls = 0;
  const provider = { id: 'opentdb', async fetchQuestions() { calls += 1; return []; } };
  const { pool } = makePool({ providers: [provider], settings: { poolTargetSize: 30 } });
  const target = pool.categoryTarget();
  for (const categoryId of ['geography', 'history', 'music']) {
    pool.addQuestions(Array.from({ length: target }, () => makeQuestion({ categoryId })));
  }

  assert.equal((await pool.refill()).skipped, 'pool-full');
  assert.equal(calls, 0);
});

test('each category aims for at least one full fetch page', () => {
  const { pool } = makePool({ settings: { poolTargetSize: 30 } });
  assert.ok(pool.categoryTarget() >= FETCH_BATCH_SIZE);
});

test('a full pool still restocks when unplayed questions drop below the watermark', async () => {
  const asked = [];
  const provider = {
    id: 'opentdb',
    async fetchQuestions({ categoryId, amount }) {
      asked.push({ categoryId, amount });
      return Array.from({ length: amount }, () => makeQuestion({ categoryId }));
    },
  };
  const { pool } = makePool({ providers: [provider] });
  const target = pool.categoryTarget();
  const servedAt = new Date(0).toISOString();
  for (const categoryId of ['geography', 'history', 'music']) {
    pool.addQuestions(Array.from(
      { length: target },
      () => makeQuestion({ categoryId, servedAt }),
    ));
  }

  assert.equal(pool.status().available, 0);
  assert.equal(pool.needsRefill(), true);
  await pool.refill();
  assert.ok(asked.length > 0, 'watermark miss must fetch even when counts look full');
});

test('a forced refill still asks when every category is already at its share', async () => {
  const asked = [];
  const provider = {
    id: 'opentdb',
    async fetchQuestions({ categoryId, amount }) {
      asked.push({ categoryId, amount });
      return Array.from({ length: amount }, () => makeQuestion({ categoryId }));
    },
  };
  const { pool } = makePool({ providers: [provider] });
  const target = pool.categoryTarget();
  for (const categoryId of ['geography', 'history', 'music']) {
    pool.addQuestions(Array.from({ length: target }, () => makeQuestion({ categoryId })));
  }

  assert.equal((await pool.refill()).skipped, 'pool-full');
  asked.length = 0;
  const forced = await pool.refill({ force: true });
  assert.equal(forced.ok, true);
  assert.ok(asked.length > 0, 'Fetch more must not no-op just because counts hit the share');
});

test('a pool at its global size but missing categories keeps restocking', async () => {
  /*
   * Regression: "full" used to mean nothing but total question count. Batches
   * arrive one category at a time, so a 300-question target filled up on the
   * first six categories and then declared itself done — leaving every other
   * category permanently empty and every round drawn from the same handful of
   * subjects.
   */
  const asked = [];
  const provider = {
    id: 'opentdb',
    async fetchQuestions({ categoryId, amount }) {
      asked.push({ categoryId, amount });
      return Array.from({ length: amount }, () => makeQuestion({ categoryId }));
    },
  };
  const { pool } = makePool({ providers: [provider], settings: { poolTargetSize: 30 } });
  const target = pool.categoryTarget();
  // Everything the pool holds is one category, already at its share, so the
  // pass should spend its budget on the empty ones.
  pool.addQuestions(Array.from({ length: target }, () => makeQuestion({ categoryId: 'geography' })));

  assert.equal(pool.needsRefill(), true);
  await pool.refill();

  const counts = pool.status().perCategory;
  assert.ok(counts.history >= pool.categoryTarget(), `history stocked ${counts.history}`);
  assert.ok(counts.music >= pool.categoryTarget(), `music stocked ${counts.music}`);
  // The full category is left alone, and the others are asked only for their
  // shortfall rather than a blind full batch.
  assert.ok(!asked.some((call) => call.categoryId === 'geography'));
  assert.ok(asked.every((call) => call.amount <= pool.categoryTarget()));
});

test('refill reports when no provider is enabled', async () => {
  const { pool } = makePool({ providers: [], settings: { enabledProviders: ['opentdb'] } });
  assert.equal((await pool.refill()).skipped, 'no-providers');
});

/* -------------------------------------------------------------- drawSession */

test('drawing a round is synchronous and marks questions served', () => {
  const { pool } = makePool();
  pool.addQuestions(Array.from({ length: 12 }, (_, i) => makeQuestion({ id: `d-${i}` })));

  const round = pool.drawSession();
  assert.equal(round.ok, true);
  assert.equal(round.questions.length, 3);
  assert.ok(round.questions.every((question) => question.servedAt));
  assert.equal(round.relaxation, null);
});

test('a round never repeats a question within itself', () => {
  const { pool } = makePool({ settings: { questionsPerSession: 10 } });
  pool.addQuestions(Array.from({ length: 40 }, (_, i) => makeQuestion({
    id: `u-${i}`, categoryId: ['geography', 'history', 'music'][i % 3],
  })));

  const ids = pool.drawSession().questions.map((question) => question.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('shuffleCategories spreads picks across categories', () => {
  const { pool } = makePool({ settings: { questionsPerSession: 3, shuffleCategories: true } });
  for (const categoryId of ['geography', 'history', 'music']) {
    pool.addQuestions(Array.from({ length: 10 }, () => makeQuestion({ categoryId })));
  }
  const categories = pool.drawSession().questions.map((question) => question.categoryId);
  assert.equal(new Set(categories).size, 3);
});

test('with shuffleCategories off a round stays in one category', () => {
  const { pool } = makePool({ settings: { questionsPerSession: 4, shuffleCategories: false } });
  for (const categoryId of ['geography', 'history', 'music']) {
    pool.addQuestions(Array.from({ length: 10 }, () => makeQuestion({ categoryId })));
  }
  const categories = pool.drawSession().questions.map((question) => question.categoryId);
  assert.equal(new Set(categories).size, 1);
});

test('the relaxation ladder ignores the repeat window first', () => {
  let clock = 100 * DAY_MS;
  const { pool } = makePool({ now: () => clock, settings: { avoidRepeatDays: 30 } });
  // Everything was served yesterday, so nothing is eligible on the strict pass.
  pool.addQuestions(Array.from({ length: 6 }, (_, i) => makeQuestion({
    id: `recent-${i}`, servedAt: new Date(clock - DAY_MS).toISOString(),
  })));

  const round = pool.drawSession();
  assert.equal(round.ok, true);
  assert.equal(round.relaxation, 'ignored-repeat-window');
});

test('the ladder widens difficulty before category', () => {
  const { pool } = makePool({ settings: { enabledDifficulties: ['easy'] } });
  // Only hard questions exist, and only in an enabled category.
  pool.addQuestions(Array.from({ length: 6 }, (_, i) => makeQuestion({
    id: `hard-${i}`, difficulty: 'hard', categoryId: 'history',
  })));

  const round = pool.drawSession();
  assert.equal(round.ok, true);
  assert.equal(round.relaxation, 'widened-difficulty');
  assert.ok(round.questions.every((question) => question.categoryId === 'history'));
});

test('the ladder widens category last', () => {
  const { pool } = makePool();
  // Nothing in any enabled category.
  pool.addQuestions(Array.from({ length: 6 }, (_, i) => makeQuestion({
    id: `off-${i}`, categoryId: 'animals', difficulty: 'hard',
  })));

  const round = pool.drawSession();
  assert.equal(round.ok, true);
  assert.equal(round.relaxation, 'widened-category');
});

test('an under-stocked pool aborts rather than serving a short round', () => {
  const { pool } = makePool({ settings: { questionsPerSession: 5 } });
  pool.addQuestions(Array.from({ length: 2 }, (_, i) => makeQuestion({ id: `few-${i}` })));

  const round = pool.drawSession();
  assert.equal(round.ok, false);
  assert.match(round.error, /too few questions/);
  assert.equal(round.poolSize, 2);
  // Nothing may be marked served by a failed draw.
  assert.equal(pool.status().available, 2);
});

test('question type filters are respected', () => {
  const { pool } = makePool({ settings: { enabledTypes: ['boolean'] } });
  pool.addQuestions(Array.from({ length: 10 }, (_, i) => makeQuestion({
    id: `t-${i}`, type: i < 5 ? 'boolean' : 'multiple',
  })));
  const round = pool.drawSession();
  assert.ok(round.questions.every((question) => question.type === 'boolean'));
});

test('a per-push count override beats the saved setting', () => {
  const { pool } = makePool({ settings: { questionsPerSession: 3 } });
  pool.addQuestions(Array.from({ length: 20 }, (_, i) => makeQuestion({ id: `o-${i}` })));
  assert.equal(pool.drawSession({ count: 7 }).questions.length, 7);
});

test('drawn questions are copies — mutating them cannot corrupt the pool', () => {
  const { pool } = makePool();
  pool.addQuestions(Array.from({ length: 6 }, (_, i) => makeQuestion({ id: `c-${i}` })));
  const round = pool.drawSession();
  round.questions[0].text = 'mutated';
  assert.equal(pool.drawSession({ count: 1 }).questions[0].text.startsWith('Question'), true);
});

/* ------------------------------------------------------------------- status */

test('status flags categories too thin for a full round', () => {
  const { pool } = makePool({ settings: { questionsPerSession: 5 } });
  pool.addQuestions(Array.from({ length: 6 }, () => makeQuestion({ categoryId: 'geography' })));
  pool.addQuestions([makeQuestion({ categoryId: 'history' })]);

  const status = pool.status();
  assert.ok(!status.starvedCategoryIds.includes('geography'));
  assert.ok(status.starvedCategoryIds.includes('history'));
  assert.ok(status.starvedCategoryIds.includes('music'));
});

test('hasContent is false until a full round is available', () => {
  const { pool } = makePool({ settings: { questionsPerSession: 4 } });
  assert.equal(pool.hasContent(), false);
  pool.addQuestions(Array.from({ length: 3 }, (_, i) => makeQuestion({ id: `h-${i}` })));
  assert.equal(pool.hasContent(), false);
  pool.addQuestions([makeQuestion({ id: 'h-4' })]);
  assert.equal(pool.hasContent(), true);
  // A bigger override needs a bigger pool.
  assert.equal(pool.hasContent({ count: 9 }), false);
});

test('the pool survives a restart', () => {
  const ROOT = tempRoot();
  const first = makePool({ root: ROOT });
  first.pool.addQuestions(Array.from({ length: 8 }, (_, i) => makeQuestion({ id: `p-${i}` })));

  const second = makePool({ root: ROOT });
  assert.equal(second.pool.status().size, 8);
});

test('a corrupt pool file starts empty rather than crashing the bridge', () => {
  const ROOT = tempRoot();
  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'data/trivia-pool.json'), '{ not json', 'utf8');
  const { pool } = makePool({ root: ROOT });
  assert.equal(pool.status().size, 0);
});
