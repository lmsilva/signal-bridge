'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ROWS, COLS, validate } = require('../src/vestaboard/encoder');
const { formatLayout } = require('../src/vestaboard/notation');
const { familyQuotesFrames } = require('../src/vestaboard/formatters/feeds');
const { sentences, quoteLines, BODY_WIDTH } = require('../src/family-quotes-layout');
const {
  BODY_ROWS,
  loadShipped,
  matchingQuotes,
  pickQuote,
  listQuotes,
  buildFamilyQuotesPayload,
  createFamilyQuotes,
} = require('../src/family-quotes');
const { sanitiseSettings } = require('../src/family-quotes-settings');

/**
 * Compare against a drawing of the whole board.
 *
 * `parseLayout` eats leading blank lines, and a vertically centred block is
 * mostly leading blank lines, so this matches `formatLayout` row for row.
 */
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

const framesFor = (text, author) => familyQuotesFrames(
  buildFamilyQuotesPayload({ id: 'demo', text, author }),
);

/** Settings that see only the rows the test supplies, not the shipped corpus. */
const onlyCustom = (custom) => sanitiseSettings({
  custom,
  removedIds: loadShipped().map((quote) => quote.id),
});

test('the three channel cards render flap for flap', () => {
  const buffett = framesFor(
    "It didn't matter how big our house was. It mattered that there was love in it.",
    'Peter Buffett',
  );
  assert.equal(buffett.length, 1);
  assert.equal(buffett[0].source, 'family.quotes');
  assert.equal(buffett[0].label, 'Family Quotes');
  assertBoard(buffett[0].rows, [
    "IT DIDN'T MATTER HOW",
    'BIG OUR HOUSE WAS.',
    'IT MATTERED THAT',
    'THERE WAS LOVE IN IT.',
    '-PETER BUFFETT',
    '',
  ], 'Buffett card');

  // The attribution rides the tail of the last sentence when there is room.
  const moore = framesFor(
    'A man travels the world over in search of what he needs, and returns home to find it.',
    'George A. Moore',
  );
  assertBoard(moore[0].rows, [
    'A MAN TRAVELS THE',
    'WORLD OVER IN SEARCH',
    'OF WHAT HE NEEDS, AND',
    'RETURNS HOME TO FIND',
    'IT. -GEORGE A. MOORE',
    '',
  ], 'Moore card');

  const disney = framesFor(
    "Life is beautiful. It's about giving. It's about family.",
    'Walt Disney',
  );
  assertBoard(disney[0].rows, [
    '',
    'LIFE IS BEAUTIFUL.',
    "IT'S ABOUT GIVING.",
    "IT'S ABOUT FAMILY.",
    '-WALT DISNEY',
    '',
  ], 'Disney card');
});

test('each sentence starts its own row', () => {
  assert.deepEqual(
    sentences("Life is beautiful. It's about giving. It's about family."),
    ['Life is beautiful.', "It's about giving.", "It's about family."],
  );
  // Greedy alone would pack the first two sentences onto one row.
  assert.deepEqual(quoteLines('Be kind. Be brave.', ''), ['BE KIND.', 'BE BRAVE.']);
});

test('a title or an initial does not end a sentence', () => {
  assert.deepEqual(
    sentences('Dr. Seuss said it best. Read on.'),
    ['Dr. Seuss said it best.', 'Read on.'],
  );
  assert.deepEqual(sentences('Ask George A. Moore about it.'), ['Ask George A. Moore about it.']);
  assert.deepEqual(
    quoteLines('Home is best.', 'George A. Moore'),
    ['HOME IS BEST. -GEORGE', 'A. MOORE'],
  );
});

test('the wrap leaves the last column empty', () => {
  for (const line of quoteLines(
    'A man travels the world over in search of what he needs, and returns home to find it.',
    'George A. Moore',
  )) {
    assert.ok(line.length <= BODY_WIDTH, line);
  }
  assert.equal(BODY_WIDTH, COLS - 1);
});

test('a quote with no author gets no attribution line', () => {
  assert.deepEqual(quoteLines('Family is everything.', ''), ['FAMILY IS EVERYTHING.']);
  assert.deepEqual(quoteLines('Family is everything.', '   '), ['FAMILY IS EVERYTHING.']);
});

test('an empty quote never flips the board', () => {
  assert.equal(buildFamilyQuotesPayload({ id: 'x', text: '  ' }), null);
  assert.deepEqual(familyQuotesFrames({ type: 'family.quotes' }), []);
  assert.deepEqual(familyQuotesFrames({}), []);
});

test('a quote too long for one frame pages instead of being cut', () => {
  const long = `${'Love is patient and love is kind and love keeps no record. '.repeat(3)}Always.`;
  const frames = familyQuotesFrames(buildFamilyQuotesPayload({ id: 'long', text: long }));
  assert.ok(frames.length >= 2, 'a long quote should page');
  for (const frame of frames) {
    assert.equal(frame.rows.length, ROWS);
    assert.equal(validate(frame.rows).ok, true);
  }
});

test('the shipped corpus is board-fit, attributed and warm', () => {
  const quotes = loadShipped();
  assert.ok(quotes.length > 20, `only ${quotes.length} quotes shipped`);

  const seenIds = new Set();
  const seenText = new Set();
  for (const quote of quotes) {
    assert.match(quote.id, /^quote-[0-9a-f]{10}$/);
    assert.equal(seenIds.has(quote.id), false, `duplicate id ${quote.id}`);
    seenIds.add(quote.id);
    assert.ok(quote.author, `${quote.text} has no author`);

    const lines = quoteLines(quote.text, quote.author);
    assert.ok(lines.length >= 1 && lines.length <= BODY_ROWS, quote.text);
    for (const line of lines) {
      assert.ok(line.length <= BODY_WIDTH, quote.text);
    }

    const key = lines.join('\n');
    assert.equal(seenText.has(key), false, `duplicate quote ${quote.text}`);
    seenText.add(key);

    // This is the warm card; the bleak stuff belongs somewhere else.
    assert.doesNotMatch(quote.text, /\b(death|died|grief|funeral|divorce|hate|war)\b/i, quote.text);
  }
});

test('the rotation skips what it just showed', () => {
  const settings = {
    ...onlyCustom([
      { id: 'a', text: 'Family is everything.', author: 'A' },
      { id: 'b', text: 'Home is where the heart is.', author: 'B' },
    ]),
    recentIds: ['a'],
  };
  assert.equal(pickQuote(settings, { random: () => 0 }).id, 'b');
  assert.equal(pickQuote({ ...settings, recentIds: ['a', 'b'] }, { random: () => 0 }).id, 'a');
});

test('the list searches by quote or author, and paginates', () => {
  const settings = onlyCustom(Array.from({ length: 30 }, (_, index) => ({
    id: `c${index}`,
    text: `Kindness number ${index} begins at home.`,
    author: `Author ${index}`,
  })));
  const page = listQuotes(settings, { page: 2, pageSize: 10 });
  assert.equal(page.pages, 3);
  assert.equal(page.quotes.length, 10);
  assert.ok(page.quotes[0].rows >= 1);

  assert.equal(listQuotes(settings, { query: 'number 7 ' }).total, 1);
  assert.equal(listQuotes(settings, { query: 'author 12' }).total, 1);
});

test('house edits hide, override text and author, add and remove quotes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'family-quotes-'));
  const quotes = createFamilyQuotes({
    ROOT: root,
    familyQuotesSettingsPath: path.join(root, 'family-quotes-settings.json'),
  });
  const shipped = loadShipped()[0];

  const hidden = quotes.updateQuote(shipped.id, { hidden: true });
  assert.equal(hidden.ok, true);
  assert.ok(hidden.hiddenCount >= 1);
  assert.equal(matchingQuotes(quotes.getSettings()).some((row) => row.id === shipped.id), false);

  const edited = quotes.updateQuote(shipped.id, {
    hidden: false,
    text: 'Home is the first school of kindness.',
    author: 'The House',
  });
  assert.equal(edited.ok, true);
  const override = matchingQuotes(quotes.getSettings()).find((row) => row.id === shipped.id);
  assert.match(override.text, /first school of kindness/);
  assert.equal(override.author, 'The House');

  // Typing a shipped quote back to what it was drops the override entirely.
  quotes.updateQuote(shipped.id, { text: shipped.text, author: shipped.author });
  assert.deepEqual(quotes.getSettings().overrides, {});

  const added = quotes.addQuote('Every good day starts at this table.', 'The Kitchen');
  assert.equal(added.ok, true);
  assert.equal(added.customCount, 1);
  assert.equal(quotes.addQuote('   ', 'Nobody').ok, false);

  const payload = quotes.nextPayload({ random: () => 0 });
  assert.equal(payload.type, 'family.quotes');
  assert.ok(payload.quote.text);
  assert.ok(quotes.getSettings().recentIds.includes(payload.quote.id));

  const customId = quotes.getSettings().custom[0].id;
  assert.equal(quotes.updateQuote(customId, { author: 'Renamed' }).ok, true);
  assert.equal(quotes.getSettings().custom[0].author, 'Renamed');
  assert.equal(quotes.updateQuote(customId, { remove: true }).ok, true);
  assert.equal(quotes.getSettings().custom.length, 0);

  assert.equal(quotes.updateQuote(shipped.id, { remove: true }).ok, true);
  assert.ok(quotes.getSettings().removedIds.includes(shipped.id));
  assert.equal(
    listQuotes(quotes.getSettings(), { hidden: true }).quotes.some((row) => row.id === shipped.id),
    false,
  );
  assert.equal(quotes.updateQuote('nope', { text: 'x' }).ok, false);

  fs.rmSync(root, { recursive: true, force: true });
});
