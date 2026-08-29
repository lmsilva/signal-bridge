'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { validate } = require('../src/vestaboard/encoder');
const { formatLayout } = require('../src/vestaboard/notation');
const { amazingFactsFrames } = require('../src/vestaboard/formatters/feeds');
const {
  loadShipped,
  factRows,
  matchingFacts,
  pickFact,
  listFacts,
  buildAmazingFactsPayload,
  createAmazingFacts,
} = require('../src/amazing-facts');
const { sanitiseSettings } = require('../src/amazing-facts-settings');

test('the shipped corpus is a large board-fit Amazing Facts dump', () => {
  const facts = loadShipped();
  assert.ok(facts.length > 3000, `expected thousands of facts, got ${facts.length}`);
  for (const fact of facts.slice(0, 80)) {
    assert.ok(fact.id);
    assert.ok(fact.text);
    assert.ok(fact.category);
    const rows = factRows(fact.text);
    assert.ok(rows.length >= 1 && rows.length <= 5, fact.text);
  }
});

test('buildAmazingFactsPayload is a vestaboard amazing.facts card', () => {
  const payload = buildAmazingFactsPayload({
    id: 'demo',
    text: 'Octopuses have three hearts, and two of them stop beating when they swim.',
    category: 'marine',
  });
  assert.equal(payload.type, 'amazing.facts');
  assert.equal(payload.fact.category, 'marine');
  const frames = amazingFactsFrames(payload);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].source, 'amazing.facts');
  const drawing = formatLayout(frames[0].rows).split('\n');
  assert.match(drawing[0], /AMAZING FACT/);
  assert.equal(validate(frames[0].rows).ok, true);
});

test('short amazing facts are vertically centred in the body rows', () => {
  const frames = amazingFactsFrames({
    fact: { text: 'Diet affects epigenetic markers.' },
  });
  assert.equal(frames.length, 1);
  const drawing = formatLayout(frames[0].rows).split('\n');
  assert.match(drawing[0], /AMAZING FACT/);
  // 2 body lines → padTop 1 → blank, line, line, blank, blank under the title.
  assert.equal(drawing[1].trim(), '');
  assert.match(drawing[2], /DIET AFFECTS/);
  assert.match(drawing[3], /EPIGENETIC MARKERS/);
  assert.equal(drawing[4].trim(), '');
  assert.equal(drawing[5].trim(), '');
});

test('full-height amazing facts stay top-aligned', () => {
  const frames = amazingFactsFrames({
    fact: {
      text: 'Aaaaa aaaaa aaaaa aaaaa aaaaa aaaaa aaaaa aaaaa aaaaa aaaaa aaaaa aaaaa aaaaa aaaaa aaaaa aaaaa aaaaa aaaaa aaaaa aaaaa aaaaa aaaaa aaaaa aaaaa aaaaa.',
    },
  });
  assert.ok(frames.length >= 1);
  const drawing = formatLayout(frames[0].rows).split('\n');
  assert.match(drawing[0], /AMAZING FACT/);
  assert.ok(drawing[1].trim().length > 0, 'first body row should hold text when the fact fills five lines');
});

test('amazing facts with no text renders nothing', () => {
  assert.deepEqual(amazingFactsFrames({ type: 'amazing.facts' }), []);
  assert.deepEqual(amazingFactsFrames({}), []);
});

test('pickFact skips recently shown ids until the pool is exhausted', () => {
  const pool = matchingFacts({});
  assert.ok(pool.length > 10);
  const first = pickFact({
    recentIds: pool.slice(1).map((row) => row.id),
  });
  assert.equal(first.id, pool[0].id);
});

test('category filters shrink the matching pool', () => {
  const all = matchingFacts({});
  const astronomy = matchingFacts({ categories: ['astronomy'] });
  assert.ok(astronomy.length > 0);
  assert.ok(astronomy.length < all.length);
  assert.ok(astronomy.every((row) => row.category === 'astronomy'));
});

test('listFacts searches text and can filter by category', () => {
  const page = listFacts({}, { query: 'octopus', page: 1, pageSize: 5 });
  assert.ok(page.total >= 0);
  const byCat = listFacts({}, { category: 'astronomy', page: 1, pageSize: 5 });
  assert.ok(byCat.total > 0);
  assert.ok(byCat.facts.every((row) => row.category === 'astronomy'));
});

test('createAmazingFacts remembers recent picks and accepts custom facts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amazing-facts-'));
  const api = createAmazingFacts({
    ROOT: dir,
    amazingFactsSettingsPath: path.join(dir, 'settings.json'),
  }, console);
  const payload = api.nextPayload();
  assert.ok(payload?.fact?.id);
  assert.equal(api.getSettings().recentIds.includes(payload.fact.id), true);

  const added = api.addFact(
    'Signal Bridge can flip amazing facts onto a Vestaboard without an API key.',
    'technology',
  );
  assert.equal(added.ok, true);
  assert.ok(added.customCount >= 1);

  const filtered = api.updateFilters({ categories: ['technology'] });
  assert.equal(filtered.ok, true);
  assert.deepEqual(api.getSettings().categories, ['technology']);
});

test('sanitiseSettings keeps category pool and custom rows', () => {
  const cleaned = sanitiseSettings({
    categories: ['Astronomy', 'astronomy', ''],
    custom: [{ id: 'c1', text: 'A custom amazing fact that is long enough to keep.', category: 'custom' }],
    hiddenIds: ['a', 'a', ''],
  });
  assert.deepEqual(cleaned.categories, ['astronomy']);
  assert.equal(cleaned.custom.length, 1);
  assert.deepEqual(cleaned.hiddenIds, ['a']);
});
