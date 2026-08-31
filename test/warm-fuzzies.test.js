'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { COLS, validate } = require('../src/vestaboard/encoder');
const { formatLayout } = require('../src/vestaboard/notation');
const { warmFuzziesFrames } = require('../src/vestaboard/formatters/feeds');
const {
  INDENT,
  INDENT_WIDTH,
  fuzzyLines,
  fuzzyRows,
  layoutMode,
} = require('../src/warm-fuzzies-layout');
const {
  BODY_ROWS,
  loadShipped,
  matchingFuzzies,
  pickFuzzy,
  listFuzzies,
  buildWarmFuzziesPayload,
  createWarmFuzzies,
} = require('../src/warm-fuzzies');
const { sanitiseSettings } = require('../src/warm-fuzzies-settings');

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

const framesFor = (text) => {
  const payload = buildWarmFuzziesPayload({ id: 'demo', text });
  return payload ? warmFuzziesFrames(payload) : [];
};

test('the three channel cards render flap for flap', () => {
  const medal = framesFor('Who raised you? They deserve a medal for a job well done.');
  assert.equal(medal.length, 1);
  assert.equal(medal[0].source, 'warm.fuzzies');
  assert.equal(medal[0].label, 'Warm Fuzzies');
  assertBoard(medal[0].rows, [
    '',
    '  WHO RAISED YOU?',
    '  THEY DESERVE A MEDAL',
    '  FOR A JOB WELL DONE.',
    '',
    '',
  ], 'Who raised you card');

  const interesting = framesFor(
    "That thing you don't like about yourself is what makes you really interesting.",
  );
  assertBoard(interesting[0].rows, [
    '',
    "THAT THING YOU DON'T",
    'LIKE ABOUT YOURSELF IS',
    'WHAT MAKES YOU REALLY',
    'INTERESTING.',
    '',
  ], 'Interesting card');

  const karaoke = framesFor('You always pick the best karaoke song.');
  assertBoard(karaoke[0].rows, [
    '',
    '',
    '  YOU ALWAYS PICK THE',
    '  BEST KARAOKE SONG.',
    '',
    '',
  ], 'Karaoke card');
});

test('layout mode picks centred, indent, or flush', () => {
  assert.equal(layoutMode(['YOU ALWAYS PICK THE', 'BEST KARAOKE SONG.']), 'centered');
  assert.equal(layoutMode(['WHO RAISED YOU?', 'THEY DESERVE A', 'MEDAL FOR A JOB', 'WELL DONE.']), 'indent');
  assert.equal(
    layoutMode([
      "THAT THING YOU DON'T",
      'LIKE ABOUT YOURSELF IS',
      'WHAT MAKES YOU REALLY',
      'INTERESTING.',
    ], { flush: true }),
    'flush',
  );
});

test('indent wraps leave two columns of air and stop at 20', () => {
  for (const line of fuzzyLines('Who raised you? They deserve a medal for a job well done.').lines) {
    assert.ok(line.length <= INDENT_WIDTH, line);
  }
  assert.equal(INDENT_WIDTH, COLS - INDENT);
  assert.equal(INDENT, 2);
});

test('an empty fuzzy never flips the board', () => {
  assert.equal(buildWarmFuzziesPayload({ text: '' }), null);
  assert.deepEqual(warmFuzziesFrames({ type: 'warm.fuzzies' }), []);
  assert.deepEqual(fuzzyRows('   '), []);
});

test('a fuzzy too long for one frame is refused, not paged', () => {
  const long = `${'You make people feel seen and valued every single day '.repeat(4)}always.`;
  assert.equal(framesFor(long).length, 0);
  const parsed = fuzzyLines(long);
  assert.ok(!parsed || parsed.lines.length > BODY_ROWS);
});

test('the shipped corpus is board-fit and family-safe', () => {
  const fuzzies = loadShipped();
  assert.ok(fuzzies.length >= 200);
  for (const fuzzy of fuzzies.slice(0, 80)) {
    assert.ok(fuzzy.id);
    assert.ok(fuzzy.text.length >= 8);
    assert.equal(fuzzyRows(fuzzy.text).length, BODY_ROWS, fuzzy.text);
  }
});

test('pickFuzzy skips recently shown ids until the pool is exhausted', () => {
  const pool = matchingFuzzies();
  const first = pickFuzzy({
    recentIds: pool.slice(1).map((fuzzy) => fuzzy.id),
  });
  assert.equal(first.id, pool[0].id);

  const again = pickFuzzy({
    recentIds: pool.map((fuzzy) => fuzzy.id),
  }, { random: () => 0 });
  assert.ok(again);
});

test('listFuzzies paginates and searches', () => {
  const page = listFuzzies({}, { page: 1, pageSize: 10 });
  assert.ok(page.total >= 200);
  assert.equal(page.fuzzies.length, 10);
  const needle = loadShipped()[0].text.slice(0, 12);
  const found = listFuzzies({}, { query: needle, pageSize: 20 });
  assert.ok(found.total >= 1);
  assert.ok(found.fuzzies.some((fuzzy) => fuzzy.text.includes(needle)));
});

test('house edits add, hide, override, and remove fuzzies', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warm-fuzzies-'));
  const api = createWarmFuzzies({
    warmFuzziesSettingsPath: path.join(dir, 'settings.json'),
  }, console);

  const added = api.addFuzzy('You make test kitchens feel like home.');
  assert.equal(added.ok, true);
  assert.equal(added.customCount, 1);

  const settings = api.getSettings();
  const customId = settings.custom[0].id;
  const hidden = api.updateFuzzy(loadShipped()[0].id, { hidden: true });
  assert.equal(hidden.hiddenCount, 1);

  const edited = api.updateFuzzy(customId, { text: 'You make test kitchens feel cozy.' });
  assert.equal(edited.ok, true);

  const removed = api.updateFuzzy(customId, { remove: true });
  assert.equal(removed.customCount, 0);

  const onlyCustom = sanitiseSettings({
    custom: [{ id: 'custom-x', text: 'You make test kitchens feel cozy.' }],
    removedIds: loadShipped().map((fuzzy) => fuzzy.id),
  });
  const payload = buildWarmFuzziesPayload(pickFuzzy(onlyCustom));
  assert.equal(payload.type, 'warm.fuzzies');
  assert.equal(framesFor(payload.fuzzy.text).length, 1);
});
