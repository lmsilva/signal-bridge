'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { validate } = require('../src/vestaboard/encoder');
const { parseLayout, formatLayout } = require('../src/vestaboard/notation');
const { stoicQuotesFrames } = require('../src/vestaboard/formatters/feeds');
const {
  loadShipped,
  quoteRows,
  matchingQuotes,
  pickQuote,
  listQuotes,
  buildStoicQuotesPayload,
  createStoicQuotes,
} = require('../src/stoic-quotes');
const { sanitiseSettings } = require('../src/stoic-quotes-settings');

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

test('the shipped corpus is board-fit Stoic quotes with authors', () => {
  const quotes = loadShipped();
  assert.ok(quotes.length > 200);
  for (const quote of quotes.slice(0, 80)) {
    assert.ok(quote.id);
    assert.ok(quote.text);
    assert.ok(quote.author);
    const rows = quoteRows(quote.text);
    assert.ok(rows.length >= 1 && rows.length <= 4, quote.text);
  }
});

test('buildStoicQuotesPayload is a vestaboard stoic.quotes card', () => {
  const payload = buildStoicQuotesPayload({
    id: 'demo',
    text: 'You have power over your mind, not outside events.',
    author: 'Marcus Aurelius',
  });
  assert.equal(payload.type, 'stoic.quotes');
  assert.equal(payload.quote.author, 'Marcus Aurelius');
  const frames = stoicQuotesFrames(payload);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].source, 'stoic.quotes');
  const drawing = formatLayout(frames[0].rows).split('\n');
  assert.match(drawing[0], /STOIC/);
  assert.match(drawing[drawing.length - 1], /MARCUS AURELIUS/);
  assert.equal(validate(frames[0].rows).ok, true);
});

test('stoic quotes with no text renders nothing', () => {
  assert.deepEqual(stoicQuotesFrames({ type: 'stoic.quotes' }), []);
  assert.deepEqual(stoicQuotesFrames({}), []);
});

test('pickQuote skips recently shown ids until the pool is exhausted', () => {
  const pool = matchingQuotes({});
  assert.ok(pool.length > 10);
  const first = pickQuote({
    recentIds: pool.slice(1).map((row) => row.id),
  });
  assert.equal(first.id, pool[0].id);
});

test('listQuotes searches author and text', () => {
  const page = listQuotes({}, { query: 'seneca', page: 1, pageSize: 5 });
  assert.ok(page.total > 0);
  assert.ok(page.quotes.every((row) => (
    /seneca/i.test(row.text) || /seneca/i.test(row.author)
  )));
});

test('createStoicQuotes can add hide and restore', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-'));
  const api = createStoicQuotes({
    ROOT: root,
    stoicQuotesSettingsPath: path.join(root, 'settings.json'),
  });
  const added = api.addQuote('Waste no more time arguing what a good man should be.', 'Marcus Aurelius');
  assert.equal(added.ok, true);
  assert.ok(added.customCount >= 1);
  const payload = api.nextPayload({ random: () => 0 });
  assert.equal(payload.type, 'stoic.quotes');

  const shipped = loadShipped()[0];
  const hidden = api.updateQuote(shipped.id, { hidden: true });
  assert.equal(hidden.ok, true);
  assert.ok(hidden.hiddenCount >= 1);
});

test('settings keep recent ids when only custom changes', () => {
  const next = sanitiseSettings({
    custom: [{ id: 'c1', text: 'Be still.', author: 'Seneca' }],
  }, {
    recentIds: ['a'],
    hiddenIds: [],
    overrides: {},
    custom: [],
  });
  assert.deepEqual(next.recentIds, ['a']);
  assert.equal(next.custom[0].author, 'Seneca');
});
