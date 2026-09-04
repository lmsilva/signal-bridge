'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { validate } = require('../src/vestaboard/encoder');
const { formatLayout } = require('../src/vestaboard/notation');
const { bibleVerseFrames } = require('../src/vestaboard/formatters/feeds');
const { composeRows, fitsBoard, versePages } = require('../src/bible-verse-layout');
const {
  loadShipped,
  matchingVerses,
  pickVerse,
  listVerses,
  buildBibleVersePayload,
  createBibleVerse,
} = require('../src/bible-verse');
const { sanitiseSettings } = require('../src/bible-verse-settings');

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

test('the three Romans mockups lock chip geometry and the blank-row rule', () => {
  assertBoard(composeRows('Romans 1:20', [
    'FOR SINCE THE CREATION',
    "OF THE WORLD GOD'S",
    'INVISIBLE',
    'QUALITIES-HIS ETERNAL',
  ]), [
    'vv VERSE OF THE DAY vv',
    'v     ROMANS 1:20    v',
    'FOR SINCE THE CREATION',
    '  OF THE WORLD GOD\'S',
    '       INVISIBLE',
    ' QUALITIES-HIS ETERNAL',
  ], 'Romans 1:20 four-line start');

  assertBoard(composeRows('Romans 1:20', [
    'POWER AND DIVINE',
    'NATURE - HAVE BEEN',
    'CLEARLY SEEN, BEING',
    'UNDERSTOOD FROM WHAT',
  ]), [
    'vv VERSE OF THE DAY vv',
    'v     ROMANS 1:20    v',
    '   POWER AND DIVINE',
    '  NATURE - HAVE BEEN',
    '  CLEARLY SEEN, BEING',
    ' UNDERSTOOD FROM WHAT',
  ], 'Romans 1:20 four-line middle');

  assertBoard(composeRows('Romans 1:20', [
    'HAS BEEN MADE, SO THAT',
    'PEOPLE ARE WITHOUT',
    'EXCUSE.',
  ]), [
    'vv VERSE OF THE DAY vv',
    'v     ROMANS 1:20    v',
    '',
    'HAS BEEN MADE, SO THAT',
    '  PEOPLE ARE WITHOUT',
    '        EXCUSE.',
  ], 'Romans 1:20 short closing frame');
});

test('the shipped corpus is board-fit KJV with a scripture reference', () => {
  const verses = loadShipped();
  assert.ok(verses.length > 700, `only ${verses.length} verses shipped`);
  const seen = new Set();
  for (const verse of verses) {
    assert.ok(verse.id, 'missing id');
    assert.ok(verse.text, verse.id);
    assert.ok(verse.reference, verse.id);
    assert.equal(seen.has(verse.id), false, `duplicate id ${verse.id}`);
    seen.add(verse.id);
    assert.equal(fitsBoard(verse.reference, verse.text), true, verse.id);
  }
  // A rebuild that quietly collapsed to one book would still pass the count.
  const books = new Set(verses.map((verse) => verse.reference.replace(/ \d+:\d+$/, '')));
  assert.ok(books.size > 40, `only ${books.size} books represented`);
});

test('buildBibleVersePayload is a vestaboard bible.verse card', () => {
  const payload = buildBibleVersePayload({
    id: 'ps-23-1',
    text: 'The Lord is my shepherd; I shall not want.',
    reference: 'Psalm 23:1',
  });
  assert.equal(payload.type, 'bible.verse');
  assert.equal(payload.verse.reference, 'Psalm 23:1');
  const frames = bibleVerseFrames(payload);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].source, 'bible.verse');
  const drawing = formatLayout(frames[0].rows).split('\n');
  assert.match(drawing[0], /VERSE OF THE DAY/);
  assert.match(drawing[1], /PSALM 23:1/);
  assert.equal(validate(frames[0].rows).ok, true);
});

test('a longer verse pages under the same header', () => {
  const pages = versePages(
    'John 3:16',
    'For God so loved the world, that he gave his only begotten Son, that whosoever believeth in him should not perish, but have everlasting life.',
  );
  assert.ok(pages.length >= 2);
  assert.equal(formatLayout(pages[0]).split('\n')[0], 'vv VERSE OF THE DAY vv');
  assert.match(formatLayout(pages[1]), /JOHN 3:16/);
});

test('bible verse with no text renders nothing', () => {
  assert.deepEqual(bibleVerseFrames({ type: 'bible.verse' }), []);
  assert.deepEqual(bibleVerseFrames({}), []);
});

test('pickVerse skips recently shown ids until the pool is exhausted', () => {
  const pool = matchingVerses({});
  assert.ok(pool.length > 10);
  const first = pickVerse({
    recentIds: pool.slice(1).map((row) => row.id),
  });
  assert.equal(first.id, pool[0].id);
});

test('listVerses searches reference and text', () => {
  const page = listVerses({}, { query: 'shepherd', page: 1, pageSize: 5 });
  assert.ok(page.total > 0);
  assert.ok(page.verses.every((row) => (
    /shepherd/i.test(row.text) || /shepherd/i.test(row.reference)
  )));
});

test('createBibleVerse can add hide and restore', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bv-'));
  const api = createBibleVerse({
    ROOT: root,
    bibleVerseSettingsPath: path.join(root, 'settings.json'),
  });
  const added = api.addVerse('Jesus wept.', 'John 11:35');
  assert.equal(added.ok, true);
  assert.ok(added.customCount >= 1);
  const payload = api.nextPayload({ random: () => 0 });
  assert.equal(payload.type, 'bible.verse');

  const shipped = loadShipped()[0];
  const hidden = api.updateVerse(shipped.id, { hidden: true });
  assert.equal(hidden.ok, true);
  assert.ok(hidden.hiddenCount >= 1);
});

test('settings keep recent ids when only custom changes', () => {
  const next = sanitiseSettings({
    custom: [{ id: 'c1', text: 'Jesus wept.', reference: 'John 11:35' }],
  }, {
    recentIds: ['a'],
    hiddenIds: [],
    overrides: {},
    custom: [],
  });
  assert.deepEqual(next.recentIds, ['a']);
  assert.equal(next.custom[0].reference, 'John 11:35');
});
