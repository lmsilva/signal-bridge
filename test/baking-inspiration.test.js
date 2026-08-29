const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  TYPE,
  loadShipped,
  fitsBoard,
  pickIdea,
  buildBakingInspirationPayload,
  createBakingInspiration,
} = require('../src/baking-inspiration');
const { bakingInspirationFrames } = require('../src/vestaboard/formatters/feeds');

let tempDir;

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bake-inspire-'));
});

test('shipped baking corpus is large and board-fit', () => {
  const ideas = loadShipped();
  assert.ok(ideas.length >= 1000, `expected a large corpus, got ${ideas.length}`);
  for (const idea of ideas.slice(0, 50)) {
    assert.ok(fitsBoard(idea.title, idea.ingredients), idea.title);
    assert.ok(idea.ingredients.length >= 1 && idea.ingredients.length <= 5);
  }
});

test('buildBakingInspirationPayload is a vestaboard bake.inspire card', () => {
  const idea = loadShipped()[0];
  const payload = buildBakingInspirationPayload(idea);
  assert.equal(payload.type, TYPE);
  assert.equal(payload.type, 'bake.inspire');
  assert.match(payload.idea.title, /./);
  assert.ok(payload.idea.ingredients.length >= 1);

  const frames = bakingInspirationFrames(payload);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].source, 'bake.inspire');
  assert.equal(frames[0].rows.length, 6);
});

test('bakingInspirationFrames refuse an empty payload', () => {
  assert.deepEqual(bakingInspirationFrames({ type: 'bake.inspire' }), []);
  assert.deepEqual(bakingInspirationFrames({}), []);
});

test('pickIdea skips recent ids until the pool is exhausted', () => {
  const ideas = loadShipped().slice(0, 5);
  const settings = {
    recentIds: ideas.slice(0, 4).map((row) => row.id),
    hiddenIds: [],
    overrides: {},
    custom: [],
  };
  const picked = pickIdea(settings, { random: () => 0 });
  assert.equal(picked.id, ideas[4].id);
});

test('createBakingInspiration can add hide and restore', () => {
  const settingsPath = path.join(tempDir, 'baking-inspiration-settings.json');
  const api = createBakingInspiration({
    bakingInspirationSettingsPath: settingsPath,
  });
  assert.ok(api.statusSnapshot().available > 0);

  const payload = api.nextPayload({ random: () => 0 });
  assert.equal(payload.type, 'bake.inspire');

  const added = api.addIdea('HOUSE SHORTBREAD', 'FLOUR, BUTTER, SUGAR');
  assert.equal(added.ok, true);
  assert.ok(added.customCount >= 1);

  const custom = api.statusSnapshot({ query: 'HOUSE SHORTBREAD' }).ideas[0];
  assert.ok(custom);
  const hidden = api.updateIdea(custom.id, { hidden: true });
  assert.equal(hidden.ok, true);
});
