const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildTriviaRoundPayload } = require('../src/udp-payload');
const { defaultSettings } = require('../src/trivia-settings');
const { getCategory } = require('../src/trivia-categories');
const { createTriviaService } = require('../src/trivia-service');
const { createCommandRegistry } = require('../src/command-registry');

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

function question(overrides = {}) {
  return {
    id: 'q1',
    provider: 'opentdb',
    categoryId: 'science-nature',
    categoryLabel: 'Science & Nature',
    difficulty: 'medium',
    type: 'multiple',
    text: 'What is the chemical symbol for gold?',
    correctAnswer: 'Au',
    incorrectAnswers: ['Go', 'Gd', 'Ag'],
    fetchedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function buildFive(overrides = {}) {
  return buildTriviaRoundPayload({
    questions: Array.from({ length: 5 }, (_, i) => question({ id: `q${i}` })),
    settings: defaultSettings(),
    artworkBaseUrl: 'https://bridge.local:47810',
    timestamp: 1700000000000,
    ...overrides,
  }, {});
}

/* ------------------------------------------------------------------ payload */

test('a round travels as one packet carrying every card', () => {
  // UDP is unreliable: a packet per card would freeze the display on a question
  // whose answer packet was dropped.
  const payload = buildFive();
  assert.equal(payload.type, 'trivia.round');
  assert.equal(payload.version, 2);
  assert.equal(payload.trivia.questions.length, 5);
  assert.equal(payload.trivia.questionCount, 5);
});

test('displaySeconds covers the whole sequence, not one card', () => {
  const payload = buildFive();
  // 4 intro + 5*(15+7) + 6 summary
  assert.equal(payload.displaySeconds, 120);
  assert.equal(payload.trivia.totalDurationSeconds, 120);
});

test('per-question timing overrides flow into the payload', () => {
  const payload = buildFive({ overrides: { questionSeconds: 20, answerSeconds: 5 } });
  assert.equal(payload.trivia.questionSeconds, 20);
  assert.equal(payload.trivia.answerSeconds, 5);
  assert.equal(payload.displaySeconds, 4 + 5 * 25 + 6);
});

test('every card carries its category artwork and accent', () => {
  const payload = buildFive();
  const card = payload.trivia.questions[0];
  const category = getCategory('science-nature');
  assert.equal(card.accent, category.accent);
  assert.equal(card.background, category.background);
  assert.equal(
    card.artwork.portrait,
    `https://bridge.local:47810${category.artwork.portrait}`,
  );
  assert.equal(
    card.artwork.landscape,
    `https://bridge.local:47810${category.artwork.landscape}`,
  );
});

test('a trailing slash on the artwork base does not double up', () => {
  const payload = buildFive({ artworkBaseUrl: 'https://bridge.local:47810/' });
  assert.doesNotMatch(payload.trivia.questions[0].artwork.portrait, /\/\/trivia-artwork/);
});

test('answers are shuffled but correctIndex always points at the right one', () => {
  for (let i = 0; i < 40; i += 1) {
    const payload = buildTriviaRoundPayload({
      questions: [question()], settings: defaultSettings(),
    }, {});
    const card = payload.trivia.questions[0];
    assert.equal(card.answers.length, 4);
    assert.equal(card.answers[card.correctIndex], 'Au');
    assert.equal(new Set(card.answers).size, 4);
  }
});

test('true/false questions get two tiles in a fixed order', () => {
  // Two lonely tiles in a four-slot grid is explicitly called out as wrong.
  const payload = buildTriviaRoundPayload({
    questions: [question({
      type: 'boolean', correctAnswer: 'False', incorrectAnswers: ['True'],
    })],
    settings: defaultSettings(),
  }, {});
  const card = payload.trivia.questions[0];
  assert.deepEqual(card.answers, ['True', 'False']);
  assert.equal(card.correctIndex, 1);
});

test('attribution lists source names for the on-screen credit', () => {
  const payload = buildTriviaRoundPayload({
    questions: [
      question({ id: 'a', provider: 'opentdb' }),
      question({ id: 'b', provider: 'the-trivia-api' }),
    ],
    settings: defaultSettings(),
    attribution: ['Open Trivia DB', 'The Trivia API'],
  }, {});
  assert.deepEqual(payload.trivia.attribution, [
    'Open Trivia DB', 'The Trivia API',
  ]);
});

test('attribution falls back to the provider ids when none is supplied', () => {
  const payload = buildTriviaRoundPayload({
    questions: [question(), question({ id: 'b', provider: 'the-trivia-api' })],
    settings: defaultSettings(),
  }, {});
  assert.deepEqual(payload.trivia.attribution, ['opentdb', 'the-trivia-api']);
});

test('a single-question round hides progress chrome and the summary', () => {
  const payload = buildTriviaRoundPayload({
    questions: [question()], settings: defaultSettings(),
  }, {});
  assert.equal(payload.trivia.showSummary, false);
  assert.equal(payload.trivia.summarySeconds, 0);
  assert.equal(payload.trivia.questionCount, 1);
});

test('disabling the intro card removes its time from the total', () => {
  const payload = buildFive({
    settings: { ...defaultSettings(), showIntroCard: false },
  });
  assert.equal(payload.trivia.showIntro, false);
  assert.equal(payload.trivia.introSeconds, 0);
  assert.equal(payload.displaySeconds, 5 * 22 + 6);
});

test('an empty question list builds nothing at all', () => {
  assert.equal(buildTriviaRoundPayload({ questions: [] }, {}), null);
  assert.equal(buildTriviaRoundPayload({}, {}), null);
});

test('the payload is JSON-safe for the UDP wire', () => {
  const payload = buildFive();
  assert.deepEqual(JSON.parse(JSON.stringify(payload)), payload);
});

/* ------------------------------------------------------------------ service */

function makeService({ providers = [], config = {} } = {}) {
  const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'trivia-service-'));
  const sent = [];
  const service = createTriviaService({
    config: { ROOT, trivia: { artworkBaseUrl: 'http://bridge.local' }, ...config },
    log: silentLog,
    sendUdpPayload: (payload) => sent.push(payload),
    now: () => 1700000000000,
    providers,
  });
  service.settings.update({
    enabledCategoryIds: ['geography'], questionsPerSession: 3,
  });
  return { service, sent, ROOT };
}

function stockQuestions(count, overrides = {}) {
  return Array.from({ length: count }, (_, i) => question({
    id: `s${i}`, categoryId: 'geography', categoryLabel: 'Geography', difficulty: 'easy',
    ...overrides,
  }));
}

test('pushing a round emits exactly one UDP payload', () => {
  const { service, sent } = makeService();
  service.pool.addQuestions(stockQuestions(10));

  const result = service.push();
  assert.equal(result.ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'trivia.round');
  assert.equal(result.questionCount, 3);
  assert.ok(result.sessionId);
});

test('a starved pool refuses to push anything', () => {
  const { service, sent } = makeService();
  const result = service.push();
  assert.equal(result.ok, false);
  assert.match(result.error, /too few questions/);
  assert.equal(sent.length, 0);
});

test('push honours a targeted send callback', () => {
  const { service, sent } = makeService();
  service.pool.addQuestions(stockQuestions(10));
  const targeted = [];
  service.push({}, { send: (payload) => targeted.push(payload) });
  assert.equal(targeted.length, 1);
  assert.equal(sent.length, 0, 'a targeted push must not also broadcast');
});

test('the service reports content only when a full round is available', () => {
  const { service } = makeService();
  assert.equal(service.hasContent(), false);
  service.pool.addQuestions(stockQuestions(3));
  assert.equal(service.hasContent(), true);
});

test('status exposes the short source name for every enabled provider', () => {
  const { service } = makeService({
    providers: [{
      id: 'opentdb',
      supportsImages: false,
      requiresAuth: false,
      attribution: { label: 'Open Trivia DB', licenceUrl: 'https://x' },
      fetchQuestions: async () => [],
    }],
  });
  const status = service.statusSnapshot();
  assert.equal(status.providers[0].id, 'opentdb');
  assert.equal(status.providers[0].attribution.label, 'Open Trivia DB');
  assert.equal(status.providers[0].enabled, true);
});

test('a whole pass over every category still reaches the far end of the list', async () => {
  /*
   * The failure this guards against is the one that shipped: a source that
   * reports "no more for this query" on the fifth category used to throw, the
   * pass aborted, and every category after it stayed at zero for good. The
   * settings page showed four categories with 50 each and twenty-two with none.
   */
  const asked = [];
  const { service } = makeService({
    providers: [{
      id: 'opentdb',
      attribution: { label: 'Open Trivia DB' },
      async fetchQuestions({ categoryId, amount }) {
        asked.push(categoryId);
        // The fifth category has nothing left to give, exactly as OpenTDB
        // reports for its smaller subjects.
        if (asked.length === 5) {
          return [];
        }
        return Array.from({ length: amount }, (_, i) => question({
          id: `${categoryId}-${asked.length}-${i}`, categoryId,
        }));
      },
    }],
  });
  const applied = service.settings.update({
    enabledCategoryIds: ['general-knowledge', 'books', 'film', 'music', 'musicals-theatre',
      'television', 'video-games', 'science-nature'],
    poolTargetSize: 80,
    poolLowWatermark: 20,
  });
  assert.equal(applied.ok, true);

  const result = await service.pool.refill();
  assert.equal(result.ok, true);

  const counts = service.pool.status().perCategory;
  for (const id of ['television', 'video-games', 'science-nature']) {
    assert.ok(counts[id] > 0, `${id} was never fetched (asked: ${asked.join(', ')})`);
  }
});

test('categoriesWithCounts marks thin categories as starved', () => {
  const { service } = makeService();
  service.pool.addQuestions(stockQuestions(5));
  const categories = service.categoriesWithCounts();
  const geography = categories.find((category) => category.id === 'geography');
  const history = categories.find((category) => category.id === 'history');
  assert.equal(geography.count, 5);
  assert.equal(geography.starved, false);
  assert.equal(history.count, 0);
  assert.equal(history.starved, true);
  assert.equal(categories.length, 26);
});

/* ----------------------------------------------------- command registry glue */

test('trivia.show is registered as the only variable-duration command', () => {
  const registry = createCommandRegistry();
  const trivia = registry.get('trivia.show');
  assert.equal(trivia.variableDuration, true);
  assert.equal(trivia.defaultDurationSeconds, null);
  assert.equal(trivia.supportsContentCheck, true);
  assert.equal(trivia.route, '/api/push/trivia');
});

test('estimateDuration computes a trivia round from live settings', () => {
  const registry = createCommandRegistry({
    getTriviaStatus: () => ({
      settings: {
        questionsPerSession: 5,
        questionSeconds: 15,
        answerSeconds: 7,
        introSeconds: 4,
        summarySeconds: 6,
        showIntroCard: true,
        showSummaryCard: true,
      },
      available: 50,
    }),
  });
  assert.equal(registry.estimateDuration('trivia.show'), 120);
  assert.equal(registry.estimateDuration('trivia.show', { count: 3 }), 4 + 66 + 6);
  assert.equal(
    registry.estimateDuration('trivia.show', { count: 2, questionSeconds: 10, answerSeconds: 5 }),
    4 + 30 + 6,
  );
});

test('trivia hasContent tracks the pool against the requested count', () => {
  let available = 2;
  const registry = createCommandRegistry({
    getTriviaStatus: () => ({ available, questionsPerSession: 5 }),
  });
  assert.equal(registry.hasContent('trivia.show'), false);
  available = 5;
  assert.equal(registry.hasContent('trivia.show'), true);
  assert.equal(registry.hasContent('trivia.show', { count: 8 }), false);
});

test('trivia reports no content when the service is not wired up', () => {
  const registry = createCommandRegistry();
  assert.equal(registry.hasContent('trivia.show'), false);
});

test('artworkBaseUrl prefers the LAN origin over GUEST_PHOTOBOOTH_URL', () => {
  const previous = process.env.GUEST_PHOTOBOOTH_URL;
  process.env.GUEST_PHOTOBOOTH_URL = 'https://signal.example.com/booth';
  try {
    const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'trivia-art-url-'));
    const service = createTriviaService({
      config: {
        ROOT,
        proxyOwnIp: '192.168.1.10',
        webServer: { port: 47810, https: true },
        trivia: {},
      },
      log: silentLog,
      sendUdpPayload: () => {},
      providers: [],
    });
    assert.equal(service.statusSnapshot().artworkBaseUrl, 'https://192.168.1.10:47810');
  } finally {
    if (previous === undefined) {
      delete process.env.GUEST_PHOTOBOOTH_URL;
    } else {
      process.env.GUEST_PHOTOBOOTH_URL = previous;
    }
  }
});

test('artworkBaseUrl falls back to the public origin without a LAN IP', () => {
  const previous = process.env.GUEST_PHOTOBOOTH_URL;
  process.env.GUEST_PHOTOBOOTH_URL = 'https://signal.example.com/booth';
  try {
    const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'trivia-art-url-'));
    const service = createTriviaService({
      config: { ROOT, webServer: { port: 47810, https: true }, trivia: {} },
      log: silentLog,
      sendUdpPayload: () => {},
      providers: [],
    });
    assert.equal(service.statusSnapshot().artworkBaseUrl, 'https://signal.example.com');
  } finally {
    if (previous === undefined) {
      delete process.env.GUEST_PHOTOBOOTH_URL;
    } else {
      process.env.GUEST_PHOTOBOOTH_URL = previous;
    }
  }
});

test('push attributes use short source names without licence text', () => {
  const { service, sent } = makeService({
    providers: [{
      id: 'opentdb',
      attribution: { label: 'Open Trivia DB', licenceUrl: 'https://creativecommons.org/licenses/by-sa/4.0/' },
      fetchQuestions: async () => [],
    }],
  });
  service.pool.addQuestions(stockQuestions(3, { provider: 'opentdb' }));
  const result = service.push({});
  assert.equal(result.ok, true);
  assert.deepEqual(sent[0].trivia.attribution, ['Open Trivia DB']);
  assert.doesNotMatch(sent[0].trivia.attribution.join(' '), /CC BY/i);
});
