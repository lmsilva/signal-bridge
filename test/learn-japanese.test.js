const test = require('node:test');
const assert = require('node:assert/strict');

const { validate } = require('../src/vestaboard/encoder');
const { parseLayout, formatLayout } = require('../src/vestaboard/notation');
const { learnJapaneseFrames } = require('../src/vestaboard/formatters/feeds');
const {
  loadLexicon,
  matchingWords,
  pickWord,
  buildLearnJapanesePayload,
} = require('../src/learn-japanese');
const {
  sanitiseSettings,
  FALLBACK,
  createLearnJapaneseSettings,
} = require('../src/learn-japanese-settings');
const { kanaToRomaji } = require('../tools/build-learn-japanese-words');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

test('the shipped lexicon is romaji JLPT N5/N4 with a part of speech', () => {
  const words = loadLexicon();
  assert.ok(words.length > 1000);
  const levels = new Set(words.map((word) => word.level));
  assert.equal(levels.has('N5'), true);
  assert.equal(levels.has('N4'), true);
  for (const word of words.slice(0, 50)) {
    assert.match(word.romaji, /^[a-z']+$/);
    assert.ok(word.english);
    assert.ok(word.pos);
    assert.match(word.id, /./);
  }
  assert.ok(words.some((word) => word.romaji === 'taberu' && word.pos === 'verb'));
  assert.ok(words.some((word) => word.romaji === 'ookii' && word.pos === 'adj'));
});

test('kanaToRomaji uses Hepburn and topic-marker greetings', () => {
  assert.equal(kanaToRomaji('たべる'), 'taberu');
  assert.equal(kanaToRomaji('がっこう'), 'gakkou');
  assert.equal(kanaToRomaji('とうきょう'), 'toukyou');
  assert.equal(kanaToRomaji('こんにちは'), 'konnichiwa');
  assert.equal(kanaToRomaji('は'), 'wa');
  assert.equal(kanaToRomaji('を'), 'o');
});

test('matchingWords honours JLPT level and part-of-speech filters', () => {
  const n5verbs = matchingWords({ levels: ['N5'], partsOfSpeech: ['verb'] });
  assert.ok(n5verbs.length > 20);
  assert.ok(n5verbs.every((word) => word.level === 'N5' && word.pos === 'verb'));
  assert.deepEqual(matchingWords({ levels: ['N5'], partsOfSpeech: ['other'] }), []);
});

test('pickWord skips recently shown ids until the pool is exhausted', () => {
  const pool = matchingWords({ levels: ['N5'], partsOfSpeech: ['verb'] });
  const first = pickWord({
    levels: ['N5'],
    partsOfSpeech: ['verb'],
    recentIds: pool.slice(1).map((word) => word.id),
  });
  assert.equal(first.id, pool[0].id);

  const again = pickWord({
    levels: ['N5'],
    partsOfSpeech: ['verb'],
    recentIds: pool.map((word) => word.id),
  }, { random: () => 0 });
  assert.ok(again);
});

test('buildLearnJapanesePayload is a vestaboard japanese.learn card', () => {
  const payload = buildLearnJapanesePayload({
    id: 'taberu-to-eat-n5',
    romaji: 'taberu',
    english: 'to eat',
    pos: 'verb',
    level: 'N5',
  }, { asOf: '2026-08-28T12:00:00.000Z' });
  assert.equal(payload.type, 'japanese.learn');
  assert.equal(payload.word.romaji, 'taberu');
  assert.equal(payload.word.english, 'to eat');
  assert.equal(payload.asOf, '2026-08-28T12:00:00.000Z');
  assert.equal(buildLearnJapanesePayload({}), null);
});

test('Learn Japanese matches the hinomaru marketplace card', () => {
  const frames = learnJapaneseFrames({
    type: 'japanese.learn',
    word: { romaji: 'taberu', english: 'to eat', pos: 'verb', level: 'N5' },
  });
  assert.equal(frames.length, 1);
  assert.equal(frames[0].source, 'japanese.learn');
  assertLayout(frames[0].rows, [
    'ww  LEARN JAPANESE  rr',
    '                      ',
    '        TABERU        ',
    '         VERB         ',
    '        TO EAT        ',
    'ww        N5        rr',
  ], 'learn japanese taberu');
});

test('a long English gloss wraps and keeps the flag footer', () => {
  const frames = learnJapaneseFrames({
    type: 'japanese.learn',
    word: {
      romaji: 'gasorinsutando',
      english: 'petrol station',
      pos: 'noun',
      level: 'N4',
    },
  });
  assertLayout(frames[0].rows, [
    'ww  LEARN JAPANESE  rr',
    '                      ',
    '    GASORINSUTANDO    ',
    '         NOUN         ',
    '    PETROL STATION    ',
    'ww        N4        rr',
  ], 'learn japanese long noun');
});

test('learn japanese with no word renders nothing', () => {
  assert.deepEqual(learnJapaneseFrames({ type: 'japanese.learn' }), []);
  assert.deepEqual(learnJapaneseFrames({}), []);
});

test('settings keep recent ids when only the filters change', () => {
  const next = sanitiseSettings({ levels: ['N5'] }, {
    ...FALLBACK,
    recentIds: ['taberu-to-eat-n5'],
  });
  assert.deepEqual(next.levels, ['N5']);
  assert.deepEqual(next.recentIds, ['taberu-to-eat-n5']);
});

test('createLearnJapaneseSettings persists filters and recent ids', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-'));
  const api = createLearnJapaneseSettings({ ROOT: root });
  api.update({ levels: ['N5'], partsOfSpeech: ['verb'] });
  api.remember('taberu-to-eat-n5');
  const again = createLearnJapaneseSettings({ ROOT: root });
  assert.deepEqual(again.get().levels, ['N5']);
  assert.deepEqual(again.get().partsOfSpeech, ['verb']);
  assert.deepEqual(again.get().recentIds, ['taberu-to-eat-n5']);
});
