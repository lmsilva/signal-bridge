'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ROWS, COLS, validate } = require('../src/vestaboard/encoder');
const { formatLayout } = require('../src/vestaboard/notation');
const { wordOfTheDayFrames } = require('../src/vestaboard/formatters/feeds');
const {
  TITLE,
  INDENT,
  TEXT_WIDTH,
  DEF_ROWS,
  wordHeadline,
  definitionLines,
  wordLines,
  wordRows,
  fitsBoard,
} = require('../src/word-of-the-day-layout');
const {
  loadShipped,
  loadPartsOfSpeech,
  resolveWords,
  pickWord,
  buildWordOfTheDayPayload,
  createWordOfTheDay,
} = require('../src/word-of-the-day');
const { sanitiseSettings } = require('../src/word-of-the-day-settings');

function assertBoard(rows, drawing, label) {
  assert.equal(validate(rows).ok, true, `${label} failed validation`);
  const actual = formatLayout(rows);
  const expected = drawing.join('\n');
  if (actual !== expected) {
    assert.fail(
      `${label} does not match the spec drawing\n\n`
      + `--- expected ---\n${expected}\n\n`
      + `--- actual ---\n${actual}\n`,
    );
  }
}

const framesFor = (word, pos, definition) => wordOfTheDayFrames(
  buildWordOfTheDayPayload({ id: 'demo', word, pos, definition }),
);

test('the three channel cards render flap for flap', () => {
  const oracy = framesFor('oracy', 'noun', 'The ability to express oneself in speech.');
  assert.equal(oracy.length, 1);
  assert.equal(oracy[0].source, 'word.day');
  assert.equal(oracy[0].label, 'Word of the Day');
  assertBoard(oracy[0].rows, [
    'yy  WORD OF THE DAY yy',
    '       ORACY, N.',
    '',
    '  THE ABILITY',
    '  TO EXPRESS ONESELF',
    '  IN SPEECH.',
  ], 'Oracy card');

  const sympatric = framesFor('sympatric', 'adj', 'Occurring in the same geographical area.');
  assertBoard(sympatric[0].rows, [
    'yy  WORD OF THE DAY yy',
    '    SYMPATRIC, ADJ.',
    '',
    '  OCCURRING IN THE',
    '  SAME GEOGRAPHICAL',
    '  AREA.',
  ], 'Sympatric card');

  const panglossian = framesFor('panglossian', 'noun', 'Optimistic regardless of the circumstances.');
  assertBoard(panglossian[0].rows, [
    'yy  WORD OF THE DAY yy',
    '    PANGLOSSIAN, N.',
    '',
    '  OPTIMISTIC',
    '  REGARDLESS OF THE',
    '  CIRCUMSTANCES.',
  ], 'Panglossian card');
});

test('title and layout constants match the marketplace channel', () => {
  assert.equal(TITLE, 'WORD OF THE DAY');
  assert.equal(INDENT, 2);
  assert.equal(TEXT_WIDTH, COLS - INDENT);
  assert.equal(DEF_ROWS, 3);
});

test('shipped corpus is large and every entry fits the board', () => {
  const words = loadShipped();
  assert.ok(words.length >= 1200);
  const sample = words.filter((_row, index) => index % 997 === 0);
  for (const entry of sample) {
    assert.equal(fitsBoard(entry.word, entry.pos, entry.definition), true, entry.word);
    assert.equal(wordRows(entry.word, entry.pos, entry.definition).length, ROWS);
  }
});

test('part-of-speech labels cover the standard buckets', () => {
  const parts = loadPartsOfSpeech();
  assert.ok(parts.length >= 3);
  assert.ok(parts.some((row) => row.id === 'noun'));
  assert.ok(parts.some((row) => row.id === 'adj' || row.id === 'adjective'));
});

test('picking a known word does not re-layout the 160k corpus', () => {
  const started = Date.now();
  const picked = pickWord({}, { word: 'oracy' });
  const elapsed = Date.now() - started;
  assert.equal(picked.word, 'oracy');
  assert.ok(elapsed < 50, `pickWord took ${elapsed}ms — that freezes the bridge`);
});

test('resolveWords trusts the shipped list instead of calling fitsBoard', () => {
  const started = Date.now();
  const pool = resolveWords({});
  const elapsed = Date.now() - started;
  assert.equal(pool.length, loadShipped().length);
  assert.ok(elapsed < 20, `resolveWords took ${elapsed}ms`);
});

test('pickWord avoids recent ids when possible', () => {
  const pool = resolveWords({});
  const first = pool[0];
  const settings = sanitiseSettings({ recentIds: [first.id] });
  const picked = pickWord(settings, { random: () => 0 });
  assert.notEqual(picked.id, first.id);
});

test('createWordOfTheDay rotates and respects part-of-speech filters', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'word-of-the-day-'));
  const api = createWordOfTheDay({
    ROOT: root,
    wordOfTheDaySettingsPath: path.join(root, 'settings.json'),
  }, console);
  assert.ok(api.statusSnapshot().available >= 1200);

  api.updateSettings({ partsOfSpeech: ['noun'] });
  const nounOnly = api.statusSnapshot();
  assert.ok(nounOnly.available >= 1000);
  assert.ok(nounOnly.available < nounOnly.total);

  const payload = api.nextPayload({ word: 'oracy' });
  assert.equal(payload.type, 'word.day');
  assert.equal(payload.entry.word, 'oracy');
  assert.equal(validate(wordOfTheDayFrames(payload)[0].rows).ok, true);
});

test('headline and definition helpers match entry facts', () => {
  assert.equal(wordHeadline('oracy', 'noun'), 'ORACY, N.');
  assert.equal(definitionLines('The ability to express oneself in speech.').length, 3);
  assert.ok(wordLines('sympatric', 'adj', 'Occurring in the same geographical area.'));
});

test('empty payload yields no frames', () => {
  assert.deepEqual(wordOfTheDayFrames({ type: 'word.day' }), []);
  assert.deepEqual(wordOfTheDayFrames({}), []);
});
