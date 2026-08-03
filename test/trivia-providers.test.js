const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createOpentdbProvider,
  createTriviaApiProvider,
  decodeBase64,
  questionId,
  TriviaProviderError,
} = require('../src/trivia-providers');
const {
  listCategories,
  getCategory,
  fromOpentdbId,
  fromTriviaApiSlug,
  triviaApiQuerySlugs,
  categoryIds,
} = require('../src/trivia-categories');

const b64 = (value) => Buffer.from(String(value), 'utf8').toString('base64');

function opentdbRow(overrides = {}) {
  return {
    category: b64('Science & Nature'),
    type: b64('multiple'),
    difficulty: b64('medium'),
    question: b64('What is the chemical symbol for gold?'),
    correct_answer: b64('Au'),
    incorrect_answers: [b64('Go'), b64('Gd'), b64('Ag')],
    ...overrides,
  };
}

/** Collects calls and replies from a scripted queue. */
function scriptedFetch(responses) {
  const calls = [];
  return {
    calls,
    fetchJson: async (url) => {
      calls.push(url);
      const next = responses.shift();
      if (typeof next === 'function') {
        return next(url);
      }
      if (next === undefined) {
        throw new Error(`Unexpected extra request: ${url}`);
      }
      return next;
    },
  };
}

function makeProvider(responses, extra = {}) {
  const scripted = scriptedFetch(responses);
  const provider = createOpentdbProvider({
    fetchJson: scripted.fetchJson,
    // No real waiting in tests, but the gap logic still runs.
    sleep: async () => {},
    now: () => 0,
    tokenStore: { read: () => 'seed-token', write: () => {} },
    ...extra,
  });
  return { provider, calls: scripted.calls };
}

/* ------------------------------------------------------- canonical registry */

test('the canonical registry has exactly 26 categories', () => {
  assert.equal(listCategories().length, 26);
  assert.equal(new Set(categoryIds()).size, 26);
});

test('every category has artwork for both orientations', () => {
  for (const category of listCategories()) {
    assert.match(category.artwork.portrait, /^\/trivia-artwork\/.+-portrait\.webp$/);
    assert.match(category.artwork.landscape, /^\/trivia-artwork\/.+-landscape\.webp$/);
    assert.match(category.accent, /^#[0-9A-Fa-f]{6}$/);
    assert.match(category.background, /^#[0-9A-Fa-f]{6}$/);
  }
});

test('OpenTDB numeric ids map back to canonical ids', () => {
  assert.equal(fromOpentdbId(9), 'general-knowledge');
  assert.equal(fromOpentdbId(17), 'science-nature');
  assert.equal(fromOpentdbId(32), 'cartoons');
  assert.equal(fromOpentdbId(999), null);
});

test('a broad Trivia API slug never resolves to a narrow canonical category', () => {
  // arts_and_literature covers books, fine art and theatre; §3 says it may only
  // be filed under its primary, otherwise "Books" fills with theatre questions.
  assert.equal(fromTriviaApiSlug('arts_and_literature'), 'art');
  assert.notEqual(fromTriviaApiSlug('arts_and_literature'), 'books');
  assert.equal(fromTriviaApiSlug('science'), 'science-nature');
  assert.notEqual(fromTriviaApiSlug('science'), 'computers');
  assert.equal(fromTriviaApiSlug('film_and_tv'), 'film');
  assert.notEqual(fromTriviaApiSlug('film_and_tv'), 'television');
});

test('query slugs exclude broad mappings', () => {
  assert.deepEqual(triviaApiQuerySlugs(['books']), []);
  assert.deepEqual(triviaApiQuerySlugs(['computers']), []);
  assert.deepEqual(triviaApiQuerySlugs(['art']), ['arts_and_literature']);
  assert.deepEqual(triviaApiQuerySlugs(['geography']), ['geography']);
});

test('food-drink and society-culture exist only on The Trivia API', () => {
  assert.equal(getCategory('food-drink').opentdbId, null);
  assert.equal(getCategory('food-drink').triviaApiSlug, 'food_and_drink');
  assert.equal(getCategory('society-culture').opentdbId, null);
});

/* ------------------------------------------------------------------ decoding */

test('base64 decoding leaves no HTML entities behind', () => {
  // The default (HTML-entity) encoding puts &quot; straight on the wall.
  const raw = 'Who said "I\'ll be back"? — Ünicode & ampersands';
  assert.equal(decodeBase64(b64(raw)), raw);
  assert.doesNotMatch(decodeBase64(b64(raw)), /&(quot|#039|amp);/);
});

test('question ids are stable across punctuation and case noise', () => {
  assert.equal(
    questionId('opentdb', 'What is the capital of France?'),
    questionId('opentdb', '  what is the CAPITAL of france  '),
  );
  assert.notEqual(
    questionId('opentdb', 'What is the capital of France?'),
    questionId('the-trivia-api', 'What is the capital of France?'),
  );
});

/* -------------------------------------------------------------- OpenTDB path */

test('a successful fetch decodes every string and files a canonical category', async () => {
  const { provider } = makeProvider([{ response_code: 0, results: [opentdbRow()] }]);
  const [question] = await provider.fetchQuestions({ amount: 1, categoryId: 'science-nature' });

  assert.equal(question.text, 'What is the chemical symbol for gold?');
  assert.equal(question.correctAnswer, 'Au');
  assert.deepEqual(question.incorrectAnswers, ['Go', 'Gd', 'Ag']);
  assert.equal(question.categoryId, 'science-nature');
  assert.equal(question.categoryLabel, 'Science & Nature');
  assert.equal(question.difficulty, 'medium');
  assert.equal(question.type, 'multiple');
  assert.equal(question.provider, 'opentdb');
  assert.equal(question.servedAt, null);
});

test('requests always ask for base64 encoding and carry the token', async () => {
  const { provider, calls } = makeProvider([{ response_code: 0, results: [] }]);
  await provider.fetchQuestions({ amount: 10, categoryId: 'geography', difficulty: 'easy' });
  const url = new URL(calls[0]);
  assert.equal(url.searchParams.get('encode'), 'base64');
  assert.equal(url.searchParams.get('token'), 'seed-token');
  assert.equal(url.searchParams.get('category'), '22');
  assert.equal(url.searchParams.get('difficulty'), 'easy');
});

test('amount is clamped to the API maximum of 50', async () => {
  const { provider, calls } = makeProvider([{ response_code: 0, results: [] }]);
  await provider.fetchQuestions({ amount: 500 });
  assert.equal(new URL(calls[0]).searchParams.get('amount'), '50');
});

test('code 1 (no results) returns an empty list rather than throwing', async () => {
  const { provider } = makeProvider([{ response_code: 1, results: [] }]);
  assert.deepEqual(await provider.fetchQuestions({ amount: 5 }), []);
});

test('code 2 (invalid parameter) throws loudly and is not retryable', async () => {
  const { provider } = makeProvider([{ response_code: 2 }]);
  await assert.rejects(
    () => provider.fetchQuestions({ amount: 5 }),
    (error) => error instanceof TriviaProviderError
      && error.code === 'invalid-parameter'
      && error.retryable === false,
  );
});

test('code 3 (token not found) reacquires a token and retries', async () => {
  const { provider, calls } = makeProvider([
    { response_code: 3 },
    { response_code: 0, token: 'fresh-token' },
    { response_code: 0, results: [opentdbRow()] },
  ]);
  const questions = await provider.fetchQuestions({ amount: 1, categoryId: 'science-nature' });
  assert.equal(questions.length, 1);
  assert.ok(calls[1].includes('api_token.php?command=request'));
  assert.equal(new URL(calls[2]).searchParams.get('token'), 'fresh-token');
  assert.equal(provider.currentToken(), 'fresh-token');
});

test('code 4 (token empty) asks for a smaller batch before giving up', async () => {
  // "Token empty" is mostly a size complaint: with a session token, asking for
  // more questions than the category holds is reported the same way as having
  // drained it. Most OpenTDB categories hold well under a full batch, so the
  // first ask for 50 comes back as code 4 and has to be narrowed.
  const { provider, calls } = makeProvider([
    { response_code: 4 },
    { response_code: 4 },
    { response_code: 0, results: [opentdbRow()] },
  ]);
  const questions = await provider.fetchQuestions({ amount: 50, categoryId: 'science-nature' });
  assert.equal(questions.length, 1);
  assert.deepEqual(
    calls.map((call) => new URL(call).searchParams.get('amount')),
    ['50', '25', '12'],
  );
  // The token is never reset on the way: resetting recycles the no-repeat
  // history for every category, not just this one.
  assert.ok(!calls.some((call) => call.includes('command=reset')));
  assert.equal(provider.currentToken(), 'seed-token');
});

test('a genuinely drained category returns empty rather than failing the pass', async () => {
  // This is the bug that left twenty categories permanently at zero: throwing
  // here aborted the whole replenishment pass, so every category after the
  // first small one was never fetched at all.
  const { provider } = makeProvider(Array.from({ length: 12 }, () => ({ response_code: 4 })));
  assert.deepEqual(await provider.fetchQuestions({ amount: 50, categoryId: 'science-nature' }), []);
});

test('a token OpenTDB keeps rejecting is a retryable error, not an empty answer', async () => {
  const { provider } = makeProvider([
    { response_code: 3 },
    { response_code: 0, token: 'one' },
    { response_code: 3 },
    { response_code: 0, token: 'two' },
    { response_code: 3 },
  ]);
  await assert.rejects(
    () => provider.fetchQuestions({ amount: 5, categoryId: 'science-nature' }),
    (error) => error.code === 'token-recovery-failed' && error.retryable === true,
  );
});

test('code 5 (rate limit) throws a retryable error', async () => {
  const { provider } = makeProvider([{ response_code: 5 }]);
  await assert.rejects(
    () => provider.fetchQuestions({ amount: 5 }),
    (error) => error.code === 'rate-limit' && error.retryable === true,
  );
});

test('an unknown response code is retryable rather than silently empty', async () => {
  const { provider } = makeProvider([{ response_code: 42 }]);
  await assert.rejects(
    () => provider.fetchQuestions({ amount: 5 }),
    /Unknown OpenTDB response code 42/,
  );
});

test('calls are spaced at least six seconds apart', async () => {
  // The documented limit is 5s per IP; 6s leaves room for clock skew.
  let clock = 0;
  const waits = [];
  const scripted = scriptedFetch([
    { response_code: 0, results: [] },
    { response_code: 0, results: [] },
    { response_code: 0, results: [] },
  ]);
  const provider = createOpentdbProvider({
    fetchJson: scripted.fetchJson,
    now: () => clock,
    sleep: async (ms) => { waits.push(ms); clock += ms; },
    tokenStore: { read: () => 'seed-token', write: () => {} },
  });

  await provider.fetchQuestions({ amount: 1 });
  await provider.fetchQuestions({ amount: 1 });
  await provider.fetchQuestions({ amount: 1 });

  // First call goes immediately (clock starts at 0 = "never called"); the two
  // that follow each wait out the full gap.
  const realWaits = waits.filter((ms) => ms > 0);
  assert.equal(realWaits.length, 2);
  assert.ok(realWaits.every((ms) => ms >= 6000), `waits were ${realWaits}`);
});

test('concurrent fetches are serialised so the gap is never raced', async () => {
  let clock = 0;
  const scripted = scriptedFetch([
    { response_code: 0, results: [] },
    { response_code: 0, results: [] },
  ]);
  const provider = createOpentdbProvider({
    fetchJson: scripted.fetchJson,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    tokenStore: { read: () => 'seed-token', write: () => {} },
  });

  await Promise.all([
    provider.fetchQuestions({ amount: 1 }),
    provider.fetchQuestions({ amount: 1 }),
  ]);
  assert.equal(scripted.calls.length, 2);
  assert.ok(clock >= 6000, 'the second call must have waited out the gap');
});

test('a rejected call does not wedge the request queue', async () => {
  const { provider } = makeProvider([
    { response_code: 5 },
    { response_code: 0, results: [opentdbRow()] },
  ]);
  await assert.rejects(() => provider.fetchQuestions({ amount: 1 }));
  const questions = await provider.fetchQuestions({ amount: 1, categoryId: 'science-nature' });
  assert.equal(questions.length, 1);
});

test('a category OpenTDB does not carry is skipped without a request', async () => {
  const { provider, calls } = makeProvider([]);
  assert.deepEqual(await provider.fetchQuestions({ amount: 5, categoryId: 'food-drink' }), []);
  assert.equal(calls.length, 0);
});

test('an unmapped provider category is logged, not swallowed', async () => {
  const warnings = [];
  const { provider } = makeProvider([{
    trivia_categories: [
      { id: 9, name: 'General Knowledge' },
      { id: 99, name: 'Underwater Basket Weaving' },
    ],
  }], { log: { warn: (message) => warnings.push(message), info: () => {} } });

  const categories = await provider.listCategories();
  assert.equal(categories[0].canonicalId, 'general-knowledge');
  assert.equal(categories[1].canonicalId, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /99/);
});

test('a persisted token is reused instead of requesting a new one', async () => {
  const written = [];
  const { provider, calls } = makeProvider([{ response_code: 0, results: [] }], {
    tokenStore: { read: () => 'from-disk', write: (token) => written.push(token) },
  });
  await provider.fetchQuestions({ amount: 1 });
  assert.equal(new URL(calls[0]).searchParams.get('token'), 'from-disk');
  assert.deepEqual(written, []);
});

test('a newly acquired token is persisted', async () => {
  const written = [];
  const { provider } = makeProvider([
    { response_code: 0, token: 'brand-new' },
    { response_code: 0, results: [] },
  ], {
    tokenStore: { read: () => null, write: (token) => written.push(token) },
  });
  await provider.fetchQuestions({ amount: 1 });
  assert.deepEqual(written, ['brand-new']);
});

test('the provider advertises a short on-screen name and a licence URL', () => {
  const { provider } = makeProvider([]);
  assert.equal(provider.attribution.label, 'Open Trivia DB');
  assert.match(provider.attribution.licenceUrl, /creativecommons\.org\/licenses\/by-sa/);
  assert.equal(provider.requiresAuth, false);
  assert.equal(provider.supportsImages, false);
});

/* -------------------------------------------------------- The Trivia API path */

test('The Trivia API normalises into the canonical shape', async () => {
  const provider = createTriviaApiProvider({
    fetchJson: async () => [{
      category: 'geography',
      difficulty: 'hard',
      question: { text: 'What is the capital of Bhutan?' },
      correctAnswer: 'Thimphu',
      incorrectAnswers: ['Paro', 'Punakha', 'Jakar'],
    }],
    now: () => 0,
  });
  const [question] = await provider.fetchQuestions({ amount: 1, categoryId: 'geography' });
  assert.equal(question.categoryId, 'geography');
  assert.equal(question.provider, 'the-trivia-api');
  assert.equal(question.type, 'multiple');
  assert.equal(question.text, 'What is the capital of Bhutan?');
});

test('The Trivia API is never queried on behalf of a narrow category', async () => {
  let called = false;
  const provider = createTriviaApiProvider({ fetchJson: async () => { called = true; return []; } });
  // "Books" maps only to the broad arts_and_literature slug.
  assert.deepEqual(await provider.fetchQuestions({ amount: 5, categoryId: 'books' }), []);
  assert.deepEqual(await provider.fetchQuestions({ amount: 5, categoryId: 'computers' }), []);
  assert.equal(called, false);
});

test('a two-answer Trivia API question is typed as boolean', async () => {
  const provider = createTriviaApiProvider({
    fetchJson: async () => [{
      category: 'geography',
      difficulty: 'easy',
      question: { text: 'Australia is a continent.' },
      correctAnswer: 'True',
      incorrectAnswers: ['False'],
    }],
  });
  const [question] = await provider.fetchQuestions({ amount: 1, categoryId: 'geography' });
  assert.equal(question.type, 'boolean');
});

test('an api key is sent only when one is configured', async () => {
  const seen = [];
  let key = null;
  const provider = createTriviaApiProvider({
    fetchJson: async (_url, options) => { seen.push(options?.headers || {}); return []; },
    getApiKey: () => key,
  });
  await provider.fetchQuestions({ amount: 1 });
  assert.equal(seen[0]['x-api-key'], undefined);
  key = 'secret';
  await provider.fetchQuestions({ amount: 1 });
  assert.equal(seen[1]['x-api-key'], 'secret');
});
