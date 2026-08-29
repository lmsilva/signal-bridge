const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { validate } = require('../src/vestaboard/encoder');
const { parseLayout, formatLayout } = require('../src/vestaboard/notation');
const { learnLanguageFrames } = require('../src/vestaboard/formatters/feeds');
const {
  LANGUAGES,
  languageIds,
  loadLexicon,
  matchingWords,
  pickWord,
  buildLearnLanguagePayload,
  createLearnLanguage,
} = require('../src/learn-language');
const {
  FALLBACK,
  sanitiseSettings,
  createLearnLanguageSettings,
} = require('../src/learn-language-settings');

function assertLayout(actual, drawing, label) {
  assert.equal(validate(actual).ok, true, `${label} failed validation`);
  const expected = parseLayout(drawing.join('\n'), { label });
  if (formatLayout(actual) !== formatLayout(expected)) {
    assert.fail(
      `${label} does not match the spec drawing\n\n`
      + `--- expected ---\n${formatLayout(expected)}\n\n`
      + `--- actual ---\n${formatLayout(actual)}\n`,
    );
  }
}

let tempDir;

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-lang-'));
});

test('each European language ships an A1/A2 lexicon', () => {
  assert.deepEqual(languageIds(), ['portuguese', 'spanish', 'french', 'german', 'italian']);
  for (const id of languageIds()) {
    const words = loadLexicon(id);
    assert.ok(words.length > 250, `${id} should ship a real word list`);
    const levels = new Set(words.map((word) => word.level));
    assert.equal(levels.has('A1'), true, `${id} needs A1`);
    assert.equal(levels.has('A2'), true, `${id} needs A2`);
    for (const word of words.slice(0, 40)) {
      assert.ok(word.word, `${id} row missing word`);
      assert.ok(word.english, `${id} row missing english`);
      assert.ok(word.pos, `${id} row missing pos`);
      assert.match(word.id, /./);
    }
  }
  assert.ok(loadLexicon('portuguese').some((word) => word.word === 'comboio'));
  assert.ok(loadLexicon('spanish').some((word) => word.word === 'comer' && word.pos === 'verb'));
  assert.ok(loadLexicon('french').some((word) => word.word === 'bonjour'));
  assert.ok(loadLexicon('german').some((word) => word.word === 'essen'));
  assert.ok(loadLexicon('italian').some((word) => word.word === 'ciao'));
});

test('matchingWords honours CEFR level and part-of-speech filters', () => {
  const a1verbs = matchingWords('spanish', { levels: ['A1'], partsOfSpeech: ['verb'] });
  assert.ok(a1verbs.length > 20);
  assert.ok(a1verbs.every((word) => word.level === 'A1' && word.pos === 'verb'));
  assert.deepEqual(matchingWords('spanish', { levels: ['A1'], partsOfSpeech: ['other'] }).length >= 0, true);
});

test('pickWord skips recently shown ids until the pool is exhausted', () => {
  const pool = matchingWords('french', { levels: ['A1'], partsOfSpeech: ['noun'] });
  const first = pickWord('french', {
    levels: ['A1'],
    partsOfSpeech: ['noun'],
    recentIds: pool.slice(1).map((word) => word.id),
  });
  assert.equal(first.id, pool[0].id);
});

test('buildLearnLanguagePayload is a vestaboard spanish.learn card', () => {
  const payload = buildLearnLanguagePayload('spanish', {
    id: 'comer-to-eat-a1',
    word: 'comer',
    english: 'to eat',
    pos: 'verb',
    level: 'A1',
  }, { asOf: '2026-08-29T12:00:00.000Z' });
  assert.equal(payload.type, 'spanish.learn');
  assert.equal(payload.word.word, 'comer');
  assert.equal(payload.chips.left, 'red');
  assert.equal(payload.chips.right, 'yellow');
  assert.equal(buildLearnLanguagePayload('spanish', {}), null);
});

test('Learn Spanish matches the marketplace word card', () => {
  const frames = learnLanguageFrames({
    type: 'spanish.learn',
    language: 'spanish',
    title: 'Learn Spanish',
    chips: { left: 'red', right: 'yellow' },
    word: { word: 'comer', english: 'to eat', pos: 'verb', level: 'A1' },
  });
  assert.equal(frames.length, 1);
  assert.equal(frames[0].source, 'spanish.learn');
  assertLayout(frames[0].rows, [
    'rr  LEARN SPANISH   yy',
    '                      ',
    '     WORD: COMER      ',
    '        (VERB)        ',
    '    MEANS: TO EAT     ',
    'rr    LEVEL: A1     yy',
  ], 'learn spanish comer');
});

test('Learn Portuguese uses green and red flag chips', () => {
  const frames = learnLanguageFrames(buildLearnLanguagePayload('portuguese', {
    word: 'casa',
    english: 'house',
    pos: 'noun',
    level: 'A1',
  }));
  const drawing = formatLayout(frames[0].rows).split('\n');
  assert.match(drawing[0], /^gg/);
  assert.match(drawing[0], /rr$/);
  assert.match(drawing[0], /LEARN PORTUGUESE/);
  assert.match(drawing[2], /WORD: CASA/);
});

test('a wrapping gloss drops the MEANS label and keeps the level footer', () => {
  const frames = learnLanguageFrames({
    type: 'german.learn',
    language: 'german',
    title: 'Learn German',
    chips: LANGUAGES.german.chips,
    word: {
      word: 'Krankenhaus',
      english: 'very large city hospital',
      pos: 'noun',
      level: 'A2',
    },
  });
  const drawing = formatLayout(frames[0].rows).split('\n');
  assert.match(drawing[0], /LEARN GERMAN/);
  assert.equal(drawing[3].includes('MEANS:'), false);
  assert.match(drawing[5], /LEVEL: A2/);
});

test('learn language with no word renders nothing', () => {
  assert.deepEqual(learnLanguageFrames({ type: 'italian.learn' }), []);
  assert.deepEqual(learnLanguageFrames({}), []);
});

test('createLearnLanguage persists filters and recent ids', () => {
  const root = path.join(tempDir, 'pt');
  fs.mkdirSync(root, { recursive: true });
  const api = createLearnLanguage('portuguese', { ROOT: root });
  api.updateSettings({ levels: ['A1'], partsOfSpeech: ['verb'] });
  const payload = api.nextPayload({ random: () => 0 });
  assert.equal(payload.type, 'portuguese.learn');
  const again = createLearnLanguageSettings(
    { id: 'portuguese', title: 'Learn Portuguese' },
    { ROOT: root },
  );
  assert.deepEqual(again.get().levels, ['A1']);
  assert.deepEqual(again.get().partsOfSpeech, ['verb']);
  assert.ok(again.get().recentIds.length >= 1);
  assert.deepEqual(sanitiseSettings({ levels: ['A1'] }, {
    ...FALLBACK,
    recentIds: ['casa-house-a1'],
  }).recentIds, ['casa-house-a1']);
});
