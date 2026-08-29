'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { validate } = require('../src/vestaboard/encoder');
const { parseLayout, formatLayout } = require('../src/vestaboard/notation');
const { chuckNorrisFrames } = require('../src/vestaboard/formatters/feeds');
const {
  loadShipped,
  factRows,
  matchingFacts,
  pickFact,
  listFacts,
  buildChuckNorrisPayload,
  createChuckNorris,
} = require('../src/chuck-norris');
const { sanitiseSettings } = require('../src/chuck-norris-settings');

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

test('the shipped corpus is board-fit Chuck Norris facts', () => {
  const facts = loadShipped();
  assert.ok(facts.length > 500);
  for (const fact of facts.slice(0, 80)) {
    assert.ok(fact.id);
    assert.match(fact.text, /Chuck Norris/i);
    const rows = factRows(fact.text);
    assert.ok(rows.length >= 1 && rows.length <= 5, fact.text);
  }
});

test('buildChuckNorrisPayload is a vestaboard chuck.facts card', () => {
  const payload = buildChuckNorrisPayload({
    id: 'demo',
    text: 'Chuck Norris counted to infinity. Twice.',
  });
  assert.equal(payload.type, 'chuck.facts');
  assert.equal(payload.fact.id, 'demo');
  const frames = chuckNorrisFrames(payload);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].source, 'chuck.facts');
  assertLayout(frames[0].rows, [
    'oo   CHUCK NORRIS   oo',
    'CHUCK NORRIS COUNTED',
    'TO INFINITY. TWICE.',
    '',
    '',
    '',
  ], 'chuck norris classic');
});

test('an empty fact does not flip the board', () => {
  assert.equal(buildChuckNorrisPayload({ text: '' }), null);
  assert.deepEqual(chuckNorrisFrames({ type: 'chuck.facts' }), []);
});

test('pickFact skips recently shown ids until the pool is exhausted', () => {
  const pool = matchingFacts();
  const first = pickFact({
    recentIds: pool.slice(1).map((fact) => fact.id),
  });
  assert.equal(first.id, pool[0].id);

  const again = pickFact({
    recentIds: pool.map((fact) => fact.id),
  }, { random: () => 0 });
  assert.ok(again.id);
});

test('listFacts searches and paginates the house view', () => {
  const listed = listFacts({}, { query: 'infinity', pageSize: 5 });
  assert.ok(listed.total >= 1);
  assert.ok(listed.facts.every((fact) => /infinity/i.test(fact.text)));
  assert.ok(listed.facts[0].rows >= 1);
});

test('house edits hide, override, and add facts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chuck-'));
  const chuck = createChuckNorris({
    ROOT: root,
    chuckNorrisSettingsPath: path.join(root, 'chuck-norris-settings.json'),
  });
  const shipped = loadShipped()[0];
  const hidden = chuck.updateFact(shipped.id, { hidden: true });
  assert.equal(hidden.ok, true);
  assert.ok(hidden.hiddenCount >= 1);
  assert.equal(matchingFacts(chuck.getSettings()).some((fact) => fact.id === shipped.id), false);

  const edited = chuck.updateFact(shipped.id, {
    hidden: false,
    text: 'Chuck Norris edited this fact for the house.',
  });
  assert.equal(edited.ok, true);
  const override = matchingFacts(chuck.getSettings()).find((fact) => fact.id === shipped.id);
  assert.match(override.text, /edited this fact/);

  const added = chuck.addFact('Chuck Norris can add a house fact.');
  assert.equal(added.ok, true);
  assert.ok(added.customCount >= 1);
  const payload = chuck.nextPayload({ random: () => 0 });
  assert.equal(payload.type, 'chuck.facts');
  assert.ok(payload.fact.text);

  const customId = chuck.getSettings().custom[0].id;
  const removedCustom = chuck.updateFact(customId, { remove: true });
  assert.equal(removedCustom.ok, true);
  assert.equal(chuck.getSettings().custom.some((row) => row.id === customId), false);

  const removedShipped = chuck.updateFact(shipped.id, { remove: true });
  assert.equal(removedShipped.ok, true);
  assert.ok(chuck.getSettings().removedIds.includes(shipped.id));
  assert.equal(matchingFacts(chuck.getSettings()).some((fact) => fact.id === shipped.id), false);
  assert.equal(
    listFacts(chuck.getSettings(), { hidden: true }).facts.some((fact) => fact.id === shipped.id),
    false,
  );

  fs.rmSync(root, { recursive: true, force: true });
});

test('sanitiseSettings keeps recent ids capped and custom text trimmed', () => {
  const settings = sanitiseSettings({
    recentIds: Array.from({ length: 120 }, (_, index) => `id-${index}`),
    custom: [{ id: 'custom-1', text: '  Chuck Norris.  ' }, { text: '' }],
    hiddenIds: ['a', 'a', ''],
    removedIds: ['b', 'b', ''],
  });
  assert.equal(settings.recentIds.length, 80);
  assert.deepEqual(settings.custom, [{ id: 'custom-1', text: 'Chuck Norris.' }]);
  assert.deepEqual(settings.hiddenIds, ['a']);
  assert.deepEqual(settings.removedIds, ['b']);
});
