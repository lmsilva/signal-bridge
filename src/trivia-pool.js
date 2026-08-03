/**
 * The local question pool (trivia.md §5).
 *
 * This is the core architectural piece, not an optimisation. OpenTDB allows one
 * category per call, 50 questions per call, and one call per IP per five
 * seconds — a mixed five-category round fetched on demand would take 25 seconds
 * of wall time with the display sitting blank. So a background worker keeps a
 * local table stocked and `drawSession()` reads from it synchronously.
 *
 * Storage is a single JSON file, matching the rest of the bridge's state. Served
 * questions keep their id for dedupe long after their body is pruned.
 */

const fs = require('fs');
const path = require('path');
const { getCategory, categoryIds } = require('./trivia-categories');
const { roundDurationSeconds } = require('./trivia-settings');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_REFILL_INTERVAL_MS = 15 * 60 * 1000;
// Backoff for OpenTDB code 5 and any 5xx (trivia.md §5.1).
const BACKOFF_BASE_MS = 30 * 1000;
const BACKOFF_MAX_MS = 30 * 60 * 1000;
const FETCH_BATCH_SIZE = 50;
// Cap total growth so a long-running bridge cannot fill the disk (§5.3).
const HARD_POOL_CAP = 5000;
// How long to leave a category alone after it says it has nothing more.
const EXHAUSTED_TTL_MS = 24 * 60 * 60 * 1000;

function emptyStore() {
  return {
    version: 1,
    questions: [],
    servedIds: {},
    // categoryId → ISO time we were last told there is nothing more to fetch.
    exhausted: {},
    lastRefillAt: null,
    lastError: null,
  };
}

function readStore(filePath, log) {
  try {
    if (!fs.existsSync(filePath)) {
      return emptyStore();
    }
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return {
      ...emptyStore(),
      ...data,
      questions: Array.isArray(data?.questions) ? data.questions : [],
      servedIds: data?.servedIds && typeof data.servedIds === 'object' ? data.servedIds : {},
      exhausted: data?.exhausted && typeof data.exhausted === 'object' ? data.exhausted : {},
    };
  } catch (error) {
    log?.warn?.('Could not read trivia pool — starting empty', error?.message || error);
    return emptyStore();
  }
}

function writeStore(filePath, store, log) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(store)}\n`, 'utf8');
  } catch (error) {
    log?.warn?.('Could not persist trivia pool', error?.message || error);
  }
}

/** Questions eligible under a filter, ignoring recency. */
function matching(questions, { categoryIds: cats, difficulties, types }) {
  return questions.filter((question) => {
    if (cats?.length && !cats.includes(question.categoryId)) {
      return false;
    }
    if (difficulties?.length && !difficulties.includes(question.difficulty)) {
      return false;
    }
    if (types?.length && !types.includes(question.type)) {
      return false;
    }
    return true;
  });
}

function notServedRecently(questions, servedIds, avoidRepeatDays, nowMs) {
  if (!avoidRepeatDays) {
    return questions;
  }
  const cutoff = nowMs - avoidRepeatDays * DAY_MS;
  return questions.filter((question) => {
    const servedAt = question.servedAt
      ? Date.parse(question.servedAt)
      : Date.parse(servedIds[question.id] || '');
    return !Number.isFinite(servedAt) || servedAt < cutoff;
  });
}

/**
 * Spread picks across categories rather than clustering them (§5.1).
 * Round-robins the available categories so a 5-question round from a pool that
 * happens to be 80% Geography still shows five different subjects.
 */
function pickSpread(candidates, count, random) {
  const byCategory = new Map();
  for (const question of candidates) {
    if (!byCategory.has(question.categoryId)) {
      byCategory.set(question.categoryId, []);
    }
    byCategory.get(question.categoryId).push(question);
  }
  for (const list of byCategory.values()) {
    shuffleInPlace(list, random);
  }
  const buckets = shuffleInPlace([...byCategory.values()], random);
  const picked = [];
  let index = 0;
  while (picked.length < count && buckets.some((bucket) => bucket.length)) {
    const bucket = buckets[index % buckets.length];
    if (bucket.length) {
      picked.push(bucket.pop());
    }
    index += 1;
  }
  return picked;
}

function pickSingleCategory(candidates, count, random) {
  const byCategory = new Map();
  for (const question of candidates) {
    if (!byCategory.has(question.categoryId)) {
      byCategory.set(question.categoryId, []);
    }
    byCategory.get(question.categoryId).push(question);
  }
  // Only categories that can fill the whole round, so we never silently mix.
  const viable = [...byCategory.values()].filter((list) => list.length >= count);
  const source = viable.length
    ? viable[Math.floor(random() * viable.length)]
    : [...byCategory.values()].sort((a, b) => b.length - a.length)[0] || [];
  return shuffleInPlace([...source], random).slice(0, count);
}

function shuffleInPlace(items, random) {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

/**
 * @param {Object} deps
 * @param {Object[]} deps.providers Ordered by preference; the first that can
 *   serve a category wins.
 * @param {Object} deps.settings `createTriviaSettings()` instance.
 */
function createTriviaPool({
  config = {},
  log = console,
  providers = [],
  settings,
  now = () => Date.now(),
  random = Math.random,
  refillIntervalMs = DEFAULT_REFILL_INTERVAL_MS,
} = {}) {
  const poolPath = config.triviaPoolPath
    || path.resolve(config.ROOT || path.resolve(__dirname, '..'), 'data/trivia-pool.json');

  let store = readStore(poolPath, log);
  let refilling = false;
  let refillTimer = null;
  let backoffUntil = 0;
  let consecutiveFailures = 0;
  // Round-robin cursor so replenishment does not always start at the same
  // category and starve the tail of the list.
  let categoryCursor = 0;

  function persist() {
    writeStore(poolPath, store, log);
  }

  function enabledProviders() {
    const wanted = settings.get().enabledProviders;
    return providers.filter((provider) => wanted.includes(provider.id));
  }

  function perCategoryCounts() {
    const counts = {};
    for (const id of categoryIds()) {
      counts[id] = 0;
    }
    for (const question of store.questions) {
      counts[question.categoryId] = (counts[question.categoryId] || 0) + 1;
    }
    return counts;
  }

  /**
   * A category the sources have already said they cannot fill any further.
   *
   * Some subjects hold only a handful of questions, so they never reach their
   * share and would otherwise be re-asked on every pass forever. Remembering
   * the refusal for a day keeps us off a free public API's rate limiter; the
   * memory is short because a reset session token makes everything available
   * again.
   */
  function isExhausted(categoryId) {
    const at = Date.parse(store.exhausted?.[categoryId] || '');
    return Number.isFinite(at) && now() - at < EXHAUSTED_TTL_MS;
  }

  /** Enabled categories at least one enabled provider can actually serve. */
  function fetchableCategories(current, { includeExhausted = true } = {}) {
    return current.enabledCategoryIds.filter((id) => {
      const category = getCategory(id);
      if (!category || (category.opentdbId == null && !category.triviaApiSlug)) {
        return false;
      }
      return includeExhausted || !isExhausted(id);
    });
  }

  /**
   * How many questions each category should hold (§5.1).
   *
   * A single global `poolTargetSize` is not enough on its own: 300 questions
   * arriving 50 at a time fills six categories and then stops, leaving the
   * other twenty permanently empty and every round drawn from the same handful
   * of subjects. Sharing the target out gives replenishment a per-category
   * deficit to chase, and the floor keeps a category able to carry a whole
   * round on its own when "spread across categories" is off.
   */
  function categoryTarget(current) {
    const enabled = fetchableCategories(current).length;
    const share = Math.ceil(current.poolTargetSize / Math.max(1, enabled));
    return Math.max(current.questionsPerSession, share);
  }

  /**
   * Categories to fetch next, emptiest first so the pool converges on balance
   * rather than filling with whatever came back first (§5.1).
   */
  function replenishOrder(current) {
    const counts = perCategoryCounts();
    const enabled = fetchableCategories(current, { includeExhausted: false });
    const rotated = enabled
      .slice(categoryCursor % Math.max(1, enabled.length))
      .concat(enabled.slice(0, categoryCursor % Math.max(1, enabled.length)));
    return rotated.sort((a, b) => (counts[a] || 0) - (counts[b] || 0));
  }

  /** True while any enabled category is still short of its share. */
  function needsRefill(current) {
    const counts = perCategoryCounts();
    const target = categoryTarget(current);
    return store.questions.length < HARD_POOL_CAP
      && fetchableCategories(current, { includeExhausted: false })
        .some((id) => (counts[id] || 0) < target);
  }

  function addQuestions(incoming) {
    const known = new Set(store.questions.map((question) => question.id));
    // A served-and-pruned question is still known — that is the whole reason
    // servedIds outlives the question body.
    for (const id of Object.keys(store.servedIds)) {
      known.add(id);
    }
    let added = 0;
    for (const question of incoming) {
      if (!question?.id || known.has(question.id)) {
        continue;
      }
      known.add(question.id);
      store.questions.push(question);
      added += 1;
    }
    if (store.questions.length > HARD_POOL_CAP) {
      store.questions = store.questions.slice(-HARD_POOL_CAP);
    }
    return added;
  }

  /** One replenishment pass. Safe to call concurrently — later calls no-op. */
  async function refill({ force = false } = {}) {
    if (refilling) {
      return { ok: false, skipped: 'already-running' };
    }
    if (!force && now() < backoffUntil) {
      return { ok: false, skipped: 'backoff', retryInMs: backoffUntil - now() };
    }
    const current = settings.get();
    if (!force && !needsRefill(current)) {
      return { ok: false, skipped: 'pool-full', size: store.questions.length };
    }
    const active = enabledProviders();
    if (!active.length) {
      return { ok: false, skipped: 'no-providers' };
    }

    refilling = true;
    let added = 0;
    const errors = [];
    try {
      const order = replenishOrder(current);
      const target = categoryTarget(current);
      const counts = perCategoryCounts();
      categoryCursor += 1;
      for (const categoryId of order) {
        if (store.questions.length >= HARD_POOL_CAP) {
          break;
        }
        // Ask only for the shortfall. Smaller asks are also far more likely to
        // succeed: most OpenTDB categories hold fewer than 50 questions at a
        // given difficulty, and over-asking is what it reports as "token empty".
        const deficit = target - (counts[categoryId] || 0);
        if (deficit <= 0) {
          continue;
        }
        const difficulty = current.enabledDifficulties[
          Math.floor(random() * current.enabledDifficulties.length)
        ];
        let served = false;
        for (const provider of active) {
          try {
            const questions = await provider.fetchQuestions({
              amount: Math.min(FETCH_BATCH_SIZE, deficit),
              categoryId,
              difficulty,
            });
            added += addQuestions(questions);
            if (questions.length) {
              served = true;
              break;
            }
          } catch (error) {
            errors.push(`${provider.id}/${categoryId}: ${error?.message || error}`);
            if (error?.retryable) {
              // Rate limit or 5xx — stop this pass rather than hammer on.
              throw error;
            }
          }
        }
        if (served) {
          delete store.exhausted[categoryId];
        } else {
          // Every source came back empty: stop asking for a while.
          store.exhausted[categoryId] = new Date(now()).toISOString();
        }
      }
      consecutiveFailures = 0;
      backoffUntil = 0;
      store.lastRefillAt = new Date(now()).toISOString();
      store.lastError = errors.length ? errors[errors.length - 1] : null;
      persist();
      log?.info?.(`Trivia pool refilled: +${added} (${store.questions.length} ready)`);
      return { ok: true, added, size: store.questions.length, errors };
    } catch (error) {
      consecutiveFailures += 1;
      const wait = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (consecutiveFailures - 1));
      backoffUntil = now() + wait;
      store.lastError = error?.message || String(error);
      persist();
      log?.warn?.(
        `Trivia refill failed (${store.lastError}) — backing off ${Math.round(wait / 1000)}s`,
      );
      return { ok: false, error: store.lastError, added, retryInMs: wait };
    } finally {
      refilling = false;
    }
  }

  /**
   * Free the bodies of questions served longer ago than `avoidRepeatDays`,
   * keeping their ids so dedupe still works (§5.3).
   */
  function prune() {
    const current = settings.get();
    const cutoff = now() - Math.max(1, current.avoidRepeatDays) * DAY_MS;
    const kept = [];
    let pruned = 0;
    for (const question of store.questions) {
      const servedAt = question.servedAt ? Date.parse(question.servedAt) : NaN;
      if (Number.isFinite(servedAt) && servedAt < cutoff) {
        store.servedIds[question.id] = question.servedAt;
        pruned += 1;
        continue;
      }
      kept.push(question);
    }
    store.questions = kept;
    if (pruned) {
      persist();
      log?.info?.(`Trivia pool pruned ${pruned} expired question(s)`);
    }
    return { pruned, size: store.questions.length };
  }

  /**
   * Assemble a round synchronously (trivia.md §5.1).
   *
   * Relaxes constraints in a fixed order — recency, then difficulty, then
   * category — and aborts rather than returning a short round. A half-populated
   * trivia round on a wall display is worse than none.
   */
  function drawSession(overrides = {}) {
    const current = settings.get();
    const count = Math.max(1, Math.min(10, Math.round(
      Number(overrides.count) || current.questionsPerSession,
    )));
    const wantCategories = overrides.categoryIds?.length
      ? overrides.categoryIds
      : current.enabledCategoryIds;
    const wantDifficulties = overrides.difficulty
      ? [overrides.difficulty]
      : current.enabledDifficulties;
    const wantTypes = current.enabledTypes;
    const nowMs = now();

    const ladder = [
      {
        relaxation: null,
        candidates: () => notServedRecently(
          matching(store.questions, {
            categoryIds: wantCategories,
            difficulties: wantDifficulties,
            types: wantTypes,
          }),
          store.servedIds, current.avoidRepeatDays, nowMs,
        ),
      },
      {
        relaxation: 'ignored-repeat-window',
        candidates: () => matching(store.questions, {
          categoryIds: wantCategories,
          difficulties: wantDifficulties,
          types: wantTypes,
        }),
      },
      {
        relaxation: 'widened-difficulty',
        candidates: () => matching(store.questions, {
          categoryIds: wantCategories, difficulties: null, types: wantTypes,
        }),
      },
      {
        relaxation: 'widened-category',
        candidates: () => matching(store.questions, {
          categoryIds: null, difficulties: null, types: wantTypes,
        }),
      },
    ];

    let chosen = null;
    let relaxation = null;
    for (const step of ladder) {
      const candidates = step.candidates();
      if (candidates.length >= count) {
        relaxation = step.relaxation;
        chosen = current.shuffleCategories && !overrides.singleCategory
          ? pickSpread(candidates, count, random)
          : pickSingleCategory(candidates, count, random);
        break;
      }
    }

    if (!chosen || chosen.length < count) {
      return {
        ok: false,
        error: `Trivia pool has too few questions for a ${count}-question round`
          + ` (${store.questions.length} in pool)`,
        poolSize: store.questions.length,
      };
    }

    const servedAt = new Date(nowMs).toISOString();
    for (const question of chosen) {
      question.servedAt = servedAt;
      store.servedIds[question.id] = servedAt;
    }
    persist();

    return {
      ok: true,
      relaxation,
      questions: chosen.map((question) => ({ ...question })),
      durationSeconds: roundDurationSeconds(current, { ...overrides, count }),
    };
  }

  function status() {
    const current = settings.get();
    const counts = perCategoryCounts();
    const eligible = notServedRecently(
      matching(store.questions, {
        categoryIds: current.enabledCategoryIds,
        difficulties: current.enabledDifficulties,
        types: current.enabledTypes,
      }),
      store.servedIds, current.avoidRepeatDays, now(),
    );
    // Categories the user enabled that cannot fill a round on their own.
    const starved = current.enabledCategoryIds.filter(
      (id) => (counts[id] || 0) < current.questionsPerSession,
    );
    return {
      size: store.questions.length,
      available: eligible.length,
      categoryTarget: categoryTarget(current),
      restocking: needsRefill(current),
      // Same test the scheduler applies, so the settings page and the scheduler
      // never disagree about whether trivia can air.
      hasContent: eligible.length >= current.questionsPerSession,
      perCategory: counts,
      starvedCategoryIds: starved,
      servedIdCount: Object.keys(store.servedIds).length,
      lastRefillAt: store.lastRefillAt,
      lastError: store.lastError,
      refilling,
      backoffUntil: backoffUntil ? new Date(backoffUntil).toISOString() : null,
      questionsPerSession: current.questionsPerSession,
      settings: current,
    };
  }

  /** Enough eligible questions for a full round — the scheduler's content check. */
  function hasContent(overrides = {}) {
    const current = settings.get();
    const count = Math.max(1, Math.min(10, Math.round(
      Number(overrides.count) || current.questionsPerSession,
    )));
    return status().available >= count;
  }

  function start() {
    if (refillTimer) {
      return;
    }
    // Kick immediately so a cold bridge starts stocking straight away, then
    // settle into the interval.
    refill().catch(() => {});
    refillTimer = setInterval(() => {
      if (needsRefill(settings.get())) {
        refill().catch(() => {});
      }
      prune();
    }, refillIntervalMs);
    refillTimer.unref?.();
  }

  function stop() {
    if (refillTimer) {
      clearInterval(refillTimer);
      refillTimer = null;
    }
  }

  return {
    poolPath,
    start,
    stop,
    refill,
    prune,
    drawSession,
    status,
    hasContent,
    categoryTarget: () => categoryTarget(settings.get()),
    needsRefill: () => needsRefill(settings.get()),
    // Test seams.
    addQuestions: (questions) => {
      const added = addQuestions(questions);
      persist();
      return added;
    },
    reload: () => { store = readStore(poolPath, log); },
  };
}

module.exports = {
  DAY_MS,
  HARD_POOL_CAP,
  EXHAUSTED_TTL_MS,
  FETCH_BATCH_SIZE,
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  matching,
  notServedRecently,
  pickSpread,
  pickSingleCategory,
  createTriviaPool,
};
