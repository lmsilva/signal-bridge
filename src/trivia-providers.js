/**
 * Trivia question sources behind one interface (trivia.md §2.7).
 *
 *   TriviaProvider {
 *     id, attribution, supportsImages, requiresAuth,
 *     listCategories(), fetchQuestions({ amount, categoryId, difficulty, type })
 *   }
 *
 * Two sources ship: Open Trivia DB (primary — no key, 24 categories, session
 * tokens) and The Trivia API (secondary — wider volume, and the upgrade path to
 * native image questions if a paid plan is ever bought). Everything they return
 * is normalised to the canonical `Question` shape in §4 with a canonical
 * category id, so the pool and the display never see a provider id.
 *
 * Three OpenTDB constraints shape this file and, through it, the whole feature:
 * one category per call, 50 questions per call, and one call per IP per five
 * seconds. That is why there is a pool (`trivia-pool.js`) rather than
 * on-demand fetching.
 */

const crypto = require('crypto');
const {
  fromOpentdbId,
  fromTriviaApiSlug,
  getCategory,
  listCategories,
} = require('./trivia-categories');

const OPENTDB_BASE = 'https://opentdb.com';
const TRIVIA_API_BASE = 'https://the-trivia-api.com/v2';

// The documented limit is one call per IP per 5s; 6s leaves room for clock skew
// between us and their rate limiter (trivia.md §11.2).
const OPENTDB_MIN_CALL_GAP_MS = 6000;
const OPENTDB_MAX_AMOUNT = 50;
const REQUEST_TIMEOUT_MS = 12000;
// Enough to halve a 50-question ask down to 1 and still have room for a token
// refresh on either side of it.
const MAX_FETCH_ATTEMPTS = 9;

const OPENTDB_RESPONSE_CODES = {
  0: 'success',
  1: 'no-results',
  2: 'invalid-parameter',
  3: 'token-not-found',
  4: 'token-empty',
  5: 'rate-limit',
};

class TriviaProviderError extends Error {
  constructor(message, { code = null, retryable = false, provider = null } = {}) {
    super(message);
    this.name = 'TriviaProviderError';
    this.code = code;
    this.retryable = retryable;
    this.provider = provider;
  }
}

/** Stable dedupe key: provider + normalised question text. */
function questionId(provider, text) {
  const normalised = String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .trim();
  return crypto.createHash('sha1')
    .update(`${provider}:${normalised}`)
    .digest('hex')
    .slice(0, 20);
}

/**
 * OpenTDB returns base64 rather than HTML entities on request, which is the
 * only unambiguous option — the default encoding leaks `&quot;` and `&#039;`
 * straight onto a wall display (trivia.md §2.2, §11.1).
 */
function decodeBase64(value) {
  if (value == null) {
    return '';
  }
  return Buffer.from(String(value), 'base64').toString('utf8');
}

function shuffle(items, random = Math.random) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

async function defaultFetchJson(url, { timeoutMs = REQUEST_TIMEOUT_MS, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers });
    if (!response.ok) {
      throw new TriviaProviderError(`HTTP ${response.status} from ${url}`, {
        code: `http-${response.status}`,
        retryable: response.status >= 500 || response.status === 429,
      });
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------------------------------------------------- Open Trivia DB */

/**
 * @param {Object} [options]
 * @param {Function} [options.fetchJson] Injected for tests.
 * @param {Function} [options.now]
 * @param {Function} [options.sleep]
 * @param {Object} [options.tokenStore] `{ read(), write(token) }` — tokens are
 *   deleted after 6 hours of inactivity, so persisting one across restarts is
 *   what keeps the no-repeat guarantee useful (trivia.md §2.2).
 */
function createOpentdbProvider({
  fetchJson = defaultFetchJson,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  tokenStore = null,
  log = null,
  minCallGapMs = OPENTDB_MIN_CALL_GAP_MS,
} = {}) {
  // null rather than 0 — "never called" must not be confused with "called at
  // epoch zero", which an injected test clock really can be.
  let lastCallAt = null;
  let token = tokenStore?.read?.() || null;
  let inFlight = Promise.resolve();

  /** Serialise every call through one queue so the 6s gap is never raced. */
  function throttled(fn) {
    const run = inFlight.then(async () => {
      const wait = lastCallAt == null ? 0 : minCallGapMs - (now() - lastCallAt);
      if (wait > 0) {
        await sleep(wait);
      }
      try {
        return await fn();
      } finally {
        lastCallAt = now();
      }
    });
    // Keep the chain alive even when a call rejects.
    inFlight = run.then(() => {}, () => {});
    return run;
  }

  async function acquireToken() {
    const body = await throttled(() => fetchJson(`${OPENTDB_BASE}/api_token.php?command=request`));
    if (Number(body?.response_code) !== 0 || !body?.token) {
      throw new TriviaProviderError('Could not acquire an OpenTDB session token', {
        code: 'token-request-failed', retryable: true, provider: 'opentdb',
      });
    }
    token = body.token;
    tokenStore?.write?.(token);
    log?.info?.('OpenTDB session token acquired');
    return token;
  }

  async function resetToken() {
    if (!token) {
      return acquireToken();
    }
    const body = await throttled(() => fetchJson(
      `${OPENTDB_BASE}/api_token.php?command=reset&token=${encodeURIComponent(token)}`,
    ));
    if (Number(body?.response_code) !== 0) {
      // A reset that fails means the token is gone; take a fresh one.
      token = null;
      return acquireToken();
    }
    log?.info?.('OpenTDB session token reset — question set recycled');
    return token;
  }

  async function listCategoriesRemote() {
    const body = await throttled(() => fetchJson(`${OPENTDB_BASE}/api_category.php`));
    const rows = Array.isArray(body?.trivia_categories) ? body.trivia_categories : [];
    return rows.map((row) => {
      const canonicalId = fromOpentdbId(row.id);
      if (!canonicalId) {
        // A new provider category is worth adding to §3, not swallowing.
        log?.warn?.(`OpenTDB category ${row.id} "${row.name}" is not in the canonical map`);
      }
      return { providerId: row.id, providerLabel: row.name, canonicalId };
    });
  }

  function normalise(row) {
    const text = decodeBase64(row.question);
    const canonicalId = fromOpentdbId(row.category_id)
      // OpenTDB's question rows carry the label, not the id, so fall back to a
      // label match against the provider's own category names.
      || canonicalFromOpentdbLabel(decodeBase64(row.category));
    if (!canonicalId) {
      return null;
    }
    const category = getCategory(canonicalId);
    return {
      id: questionId('opentdb', text),
      provider: 'opentdb',
      categoryId: canonicalId,
      categoryLabel: category?.label || canonicalId,
      difficulty: decodeBase64(row.difficulty) || 'medium',
      type: decodeBase64(row.type) === 'boolean' ? 'boolean' : 'multiple',
      text,
      correctAnswer: decodeBase64(row.correct_answer),
      incorrectAnswers: (row.incorrect_answers || []).map(decodeBase64),
      fetchedAt: new Date(now()).toISOString(),
      servedAt: null,
    };
  }

  /**
   * @param {Object} opts
   * @param {number} opts.amount 1–50 (the API's hard ceiling).
   * @param {string} [opts.categoryId] Canonical id, not an OpenTDB id.
   */
  async function fetchQuestions({ amount = 10, categoryId, difficulty, type } = {}) {
    const category = categoryId ? getCategory(categoryId) : null;
    if (categoryId && (!category || category.opentdbId == null)) {
      // Not an error — OpenTDB simply has no Food & Drink or Society & Culture.
      return [];
    }
    const params = new URLSearchParams({
      amount: String(Math.max(1, Math.min(OPENTDB_MAX_AMOUNT, Math.round(amount)))),
      encode: 'base64',
    });
    if (category) {
      params.set('category', String(category.opentdbId));
    }
    if (difficulty) {
      params.set('difficulty', difficulty);
    }
    if (type) {
      params.set('type', type);
    }

    const describe = `${categoryId || 'any'}/${difficulty || 'any'}/${type || 'any'}`;
    let requested = Number(params.get('amount'));
    let tokenRetries = 0;

    for (let attempt = 0; attempt < MAX_FETCH_ATTEMPTS; attempt += 1) {
      if (!token) {
        await acquireToken();
      }
      params.set('token', token);
      const body = await throttled(() => fetchJson(`${OPENTDB_BASE}/api.php?${params}`));
      const code = Number(body?.response_code);

      switch (code) {
        case 0:
          return (body.results || [])
            .map((row) => normalise({ ...row, category_id: category?.opentdbId }))
            .filter(Boolean);
        case 1:
          // Not enough questions for this query — a real answer, not a failure.
          log?.info?.(`OpenTDB has no more questions for ${describe}`);
          return [];
        case 2:
          throw new TriviaProviderError(
            `OpenTDB rejected a parameter (${params}) — this is a bug`,
            { code: 'invalid-parameter', retryable: false, provider: 'opentdb' },
          );
        case 3:
          // The token expired (they die after 6h idle) or was never valid.
          token = null;
          tokenRetries += 1;
          if (tokenRetries > 2) {
            throw new TriviaProviderError('OpenTDB keeps rejecting our session token', {
              code: 'token-recovery-failed', retryable: true, provider: 'opentdb',
            });
          }
          await acquireToken();
          break;
        case 4:
          /*
           * "Token empty" does not mean the token is broken. It means this
           * *query* has no unseen questions left — and OpenTDB counts a request
           * for more questions than the category holds as exactly that. Most
           * of its 24 categories hold well under 50 per difficulty, so asking
           * for a full batch returns code 4 on the very first call.
           *
           * Ask for less before concluding anything. Only a query that comes
           * back empty at amount=1 is genuinely drained, and that is an answer
           * ([]), not an error — throwing here used to abort the whole
           * replenishment pass and leave every later category permanently at
           * zero.
           */
          if (requested > 1) {
            requested = Math.max(1, Math.floor(requested / 2));
            params.set('amount', String(requested));
            break;
          }
          log?.info?.(`OpenTDB has served every question it has for ${describe}`);
          return [];
        case 5:
          throw new TriviaProviderError('OpenTDB rate limit hit', {
            code: 'rate-limit', retryable: true, provider: 'opentdb',
          });
        default:
          throw new TriviaProviderError(`Unknown OpenTDB response code ${code}`, {
            code: `unknown-${code}`, retryable: true, provider: 'opentdb',
          });
      }
    }
    // Halving from 50 reaches 1 in six steps, so running out of attempts means
    // something other than batch size is wrong.
    log?.warn?.(`OpenTDB gave up on ${describe} after ${MAX_FETCH_ATTEMPTS} attempts`);
    return [];
  }

  return {
    id: 'opentdb',
    supportsImages: false,
    requiresAuth: false,
    attribution: {
      // On-screen credit is the source name only; licence URL stays for records.
      label: 'Open Trivia DB',
      licenceUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    },
    listCategories: listCategoriesRemote,
    fetchQuestions,
    // Exposed for the pool's diagnostics and for tests.
    currentToken: () => token,
    acquireToken,
    resetToken,
  };
}

let opentdbLabelIndex = null;

function canonicalFromOpentdbLabel(label) {
  if (!opentdbLabelIndex) {
    opentdbLabelIndex = new Map();
    for (const category of listCategories()) {
      opentdbLabelIndex.set(category.label.toLowerCase(), category.id);
    }
    // OpenTDB prefixes several of its own labels.
    const prefixed = {
      'entertainment: books': 'books',
      'entertainment: film': 'film',
      'entertainment: music': 'music',
      'entertainment: musicals & theatres': 'musicals-theatre',
      'entertainment: television': 'television',
      'entertainment: video games': 'video-games',
      'entertainment: board games': 'board-games',
      'entertainment: comics': 'comics',
      'entertainment: japanese anime & manga': 'anime-manga',
      'entertainment: cartoon & animations': 'cartoons',
      'science & nature': 'science-nature',
      'science: computers': 'computers',
      'science: mathematics': 'mathematics',
      'science: gadgets': 'gadgets',
    };
    for (const [key, value] of Object.entries(prefixed)) {
      opentdbLabelIndex.set(key, value);
    }
  }
  return opentdbLabelIndex.get(String(label || '').toLowerCase()) || null;
}

/* ------------------------------------------------------------ The Trivia API */

/**
 * The Trivia API needs no key on the free tier; a key only unlocks paid
 * features. Nothing here may be gated behind one (trivia.md §11.8).
 */
function createTriviaApiProvider({
  fetchJson = defaultFetchJson,
  now = () => Date.now(),
  getApiKey = () => null,
  log = null,
} = {}) {
  function headers() {
    const key = getApiKey();
    return key ? { 'x-api-key': key } : {};
  }

  function normalise(row) {
    const canonicalId = fromTriviaApiSlug(row?.category);
    if (!canonicalId) {
      // A broad slug reaching here means it was queried directly, which §3
      // forbids; dropping is safer than mis-filing.
      log?.warn?.(`The Trivia API returned unmapped category "${row?.category}"`);
      return null;
    }
    const category = getCategory(canonicalId);
    const text = String(row?.question?.text || row?.question || '');
    if (!text) {
      return null;
    }
    const incorrect = (row.incorrectAnswers || []).map(String);
    return {
      id: questionId('the-trivia-api', text),
      provider: 'the-trivia-api',
      categoryId: canonicalId,
      categoryLabel: category?.label || canonicalId,
      difficulty: row.difficulty || 'medium',
      type: incorrect.length === 1 ? 'boolean' : 'multiple',
      text,
      correctAnswer: String(row.correctAnswer || ''),
      incorrectAnswers: incorrect,
      fetchedAt: new Date(now()).toISOString(),
      servedAt: null,
    };
  }

  async function fetchQuestions({ amount = 10, categoryId, difficulty, type } = {}) {
    const category = categoryId ? getCategory(categoryId) : null;
    // §3: never query a broad slug on behalf of a narrow canonical category.
    if (categoryId && (!category?.triviaApiSlug || category.triviaApiSlugIsBroad)) {
      return [];
    }
    const params = new URLSearchParams({
      limit: String(Math.max(1, Math.min(50, Math.round(amount)))),
    });
    if (category) {
      params.set('categories', category.triviaApiSlug);
    }
    if (difficulty) {
      params.set('difficulties', difficulty);
    }
    if (type) {
      params.set('types', type === 'boolean' ? 'text_choice' : 'text_choice');
    }
    const body = await fetchJson(
      `${TRIVIA_API_BASE}/questions?${params}`, { headers: headers() },
    );
    const rows = Array.isArray(body) ? body : (body?.questions || []);
    return rows.map(normalise).filter(Boolean);
  }

  async function listCategoriesRemote() {
    return listCategories()
      .filter((category) => category.triviaApiSlug && !category.triviaApiSlugIsBroad)
      .map((category) => ({
        providerId: category.triviaApiSlug,
        providerLabel: category.label,
        canonicalId: category.id,
      }));
  }

  return {
    id: 'the-trivia-api',
    supportsImages: false,
    requiresAuth: false,
    attribution: {
      label: 'The Trivia API',
      licenceUrl: 'https://creativecommons.org/licenses/by-nc/4.0/',
    },
    listCategories: listCategoriesRemote,
    fetchQuestions,
  };
}

module.exports = {
  OPENTDB_MIN_CALL_GAP_MS,
  OPENTDB_MAX_AMOUNT,
  OPENTDB_RESPONSE_CODES,
  MAX_FETCH_ATTEMPTS,
  TriviaProviderError,
  questionId,
  decodeBase64,
  shuffle,
  createOpentdbProvider,
  createTriviaApiProvider,
  canonicalFromOpentdbLabel,
};
