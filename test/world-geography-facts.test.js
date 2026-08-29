'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { validate } = require('../src/vestaboard/encoder');
const { formatLayout } = require('../src/vestaboard/notation');
const { worldGeographyFactsFrames } = require('../src/vestaboard/formatters/feeds');
const {
  loadShipped,
  factRows,
  matchingFacts,
  pickFact,
  listFacts,
  buildWorldGeographyFactsPayload,
  createWorldGeographyFacts,
} = require('../src/world-geography-facts');
const { sanitiseSettings } = require('../src/world-geography-facts-settings');

test('the shipped corpus is a large board-fit World Geography Facts dump', () => {
  const facts = loadShipped();
  assert.ok(facts.length > 1500, `expected thousands of facts, got ${facts.length}`);
  for (const fact of facts.slice(0, 80)) {
    assert.ok(fact.id);
    assert.ok(fact.text);
    assert.ok(fact.category);
    const rows = factRows(fact.text);
    assert.ok(rows.length >= 1 && rows.length <= 5, fact.text);
  }
});

test('buildWorldGeographyFactsPayload is a vestaboard geo.facts card', () => {
  const payload = buildWorldGeographyFactsPayload({
    id: 'demo',
    text: 'Istanbul is the only major city that spans two continents: Europe and Asia.',
    category: 'cities',
  });
  assert.equal(payload.type, 'geo.facts');
  assert.equal(payload.fact.category, 'cities');
  const frames = worldGeographyFactsFrames(payload);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].source, 'geo.facts');
  const drawing = formatLayout(frames[0].rows).split('\n');
  assert.match(drawing[0], /WORLD GEOGRAPHY/);
  assert.equal(validate(frames[0].rows).ok, true);
});

test('world geography facts with no text renders nothing', () => {
  assert.deepEqual(worldGeographyFactsFrames({ type: 'geo.facts' }), []);
  assert.deepEqual(worldGeographyFactsFrames({}), []);
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
  const capitals = matchingFacts({ categories: ['capitals'] });
  assert.ok(capitals.length > 0);
  assert.ok(capitals.length < all.length);
  assert.ok(capitals.every((row) => row.category === 'capitals'));
});

test('listFacts searches text and can filter by category', () => {
  const page = listFacts({}, { query: 'istanbul', page: 1, pageSize: 5 });
  assert.ok(page.total >= 0);
  const byCat = listFacts({}, { category: 'capitals', page: 1, pageSize: 5 });
  assert.ok(byCat.total > 0);
  assert.ok(byCat.facts.every((row) => row.category === 'capitals'));
});

test('createWorldGeographyFacts remembers recent picks and accepts custom facts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'world-geography-facts-'));
  const api = createWorldGeographyFacts({
    ROOT: dir,
    worldGeographyFactsSettingsPath: path.join(dir, 'settings.json'),
  }, console);
  const payload = api.nextPayload();
  assert.ok(payload?.fact?.id);
  assert.equal(api.getSettings().recentIds.includes(payload.fact.id), true);

  const added = api.addFact(
    'Signal Bridge can flip world geography facts onto a Vestaboard without an API key.',
    'trivia',
  );
  assert.equal(added.ok, true);
  assert.ok(added.customCount >= 1);

  const filtered = api.updateFilters({ categories: ['trivia'] });
  assert.equal(filtered.ok, true);
  assert.deepEqual(api.getSettings().categories, ['trivia']);
});

test('sanitiseSettings keeps category pool and custom rows', () => {
  const cleaned = sanitiseSettings({
    categories: ['Capitals', 'capitals', ''],
    custom: [{ id: 'c1', text: 'A custom geography fact that is long enough to keep.', category: 'custom' }],
    hiddenIds: ['a', 'a', ''],
  });
  assert.deepEqual(cleaned.categories, ['capitals']);
  assert.equal(cleaned.custom.length, 1);
  assert.deepEqual(cleaned.hiddenIds, ['a']);
});
