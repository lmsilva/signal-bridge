'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { COLS, validate } = require('../src/vestaboard/encoder');
const { formatLayout } = require('../src/vestaboard/notation');
const { dailyBucketFillersFrames } = require('../src/vestaboard/formatters/feeds');
const {
  INDENT,
  INDENT_WIDTH,
  fillerLines,
  fillerRows,
  layoutMode,
} = require('../src/daily-bucket-fillers-layout');
const {
  BODY_ROWS,
  loadShipped,
  matchingFillers,
  pickFiller,
  listFillers,
  buildDailyBucketFillersPayload,
  createDailyBucketFillers,
} = require('../src/daily-bucket-fillers');
const { sanitiseSettings } = require('../src/daily-bucket-fillers-settings');

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
  const payload = buildDailyBucketFillersPayload({ id: 'demo', text });
  return payload ? dailyBucketFillersFrames(payload) : [];
};

test('the three channel cards render flap for flap', () => {
  const library = framesFor('Leave a kind note in a library book for the next reader.');
  assert.equal(library.length, 1);
  assert.equal(library[0].source, 'bucket.fillers');
  assert.equal(library[0].label, 'Daily Bucket Fillers');
  assertBoard(library[0].rows, [
    '',
    '  LEAVE A KIND NOTE',
    '  IN A LIBRARY BOOK',
    '  FOR THE NEXT',
    '  READER.',
    '',
  ], 'Library note card');

  const playlist = framesFor('Make a feel good playlist and share it with someone.');
  assertBoard(playlist[0].rows, [
    '',
    '  MAKE A FEEL GOOD',
    '  PLAYLIST AND SHARE',
    '  IT WITH SOMEONE.',
    '',
    '',
  ], 'Playlist card');

  const donate = framesFor('Donate toys you no longer use.');
  assertBoard(donate[0].rows, [
    '',
    '',
    '    DONATE TOYS YOU',
    '    NO LONGER USE.',
    '',
    '',
  ], 'Donate toys card');
});

test('layout mode picks centred, indent, or flush', () => {
  assert.equal(layoutMode(['DONATE TOYS YOU', 'NO LONGER USE.']), 'centered');
  assert.equal(layoutMode(['LEAVE A KIND NOTE', 'IN A LIBRARY BOOK', 'FOR THE NEXT', 'READER.']), 'indent');
  assert.equal(
    layoutMode([
      'LEAVE A KIND NOTE IN A',
      'LIBRARY BOOK FOR THE',
      'NEXT READER.',
    ], { flush: true }),
    'flush',
  );
});

test('indent wraps leave two columns of air', () => {
  const parsed = fillerLines('Leave a kind note in a library book for the next reader.');
  assert.equal(parsed.mode, 'indent');
  for (const line of parsed.lines) {
    assert.ok(line.length <= INDENT_WIDTH, line);
  }
  assert.equal(INDENT_WIDTH, COLS - INDENT);
  assert.equal(INDENT, 2);
});

test('an empty filler never flips the board', () => {
  assert.equal(buildDailyBucketFillersPayload({ text: '' }), null);
  assert.deepEqual(dailyBucketFillersFrames({ type: 'bucket.fillers' }), []);
  assert.deepEqual(fillerRows('   '), []);
});

test('a filler too long for one frame is refused, not paged', () => {
  const long = `${'Leave a kind note in a library book for the next reader every single day '.repeat(4)}always.`;
  assert.equal(framesFor(long).length, 0);
  const parsed = fillerLines(long);
  assert.ok(!parsed || parsed.lines.length > BODY_ROWS);
});

test('the shipped corpus is board-fit and family-safe', () => {
  const fillers = loadShipped();
  assert.ok(fillers.length >= 200);
  for (const filler of fillers.slice(0, 80)) {
    assert.ok(filler.id);
    assert.ok(filler.text.length >= 8);
    assert.equal(fillerRows(filler.text).length, BODY_ROWS, filler.text);
  }
});

test('pickFiller skips recently shown ids until the pool is exhausted', () => {
  const pool = matchingFillers();
  const first = pickFiller({
    recentIds: pool.slice(1).map((filler) => filler.id),
  });
  assert.equal(first.id, pool[0].id);

  const again = pickFiller({
    recentIds: pool.map((filler) => filler.id),
  }, { random: () => 0 });
  assert.ok(again);
});

test('listFillers paginates and searches', () => {
  const page = listFillers({}, { page: 1, pageSize: 10 });
  assert.ok(page.total >= 200);
  assert.equal(page.fillers.length, 10);
  const needle = loadShipped()[0].text.slice(0, 12);
  const found = listFillers({}, { query: needle, pageSize: 20 });
  assert.ok(found.total >= 1);
  assert.ok(found.fillers.some((filler) => filler.text.includes(needle)));
});

test('house edits add, hide, override, and remove fillers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-bucket-fillers-'));
  const api = createDailyBucketFillers({
    dailyBucketFillersSettingsPath: path.join(dir, 'settings.json'),
  }, console);

  const added = api.addFiller('Leave a kind note on a neighbor’s porch.');
  assert.equal(added.ok, true);
  assert.equal(added.customCount, 1);

  const settings = api.getSettings();
  const customId = settings.custom[0].id;
  const hidden = api.updateFiller(loadShipped()[0].id, { hidden: true });
  assert.equal(hidden.hiddenCount, 1);

  const edited = api.updateFiller(customId, { text: 'Leave a kind note on a neighbor porch.' });
  assert.equal(edited.ok, true);

  const removed = api.updateFiller(customId, { remove: true });
  assert.equal(removed.customCount, 0);

  const onlyCustom = sanitiseSettings({
    custom: [{ id: 'custom-x', text: 'Leave a kind note on a neighbor porch.' }],
    removedIds: loadShipped().map((filler) => filler.id),
  });
  const payload = buildDailyBucketFillersPayload(pickFiller(onlyCustom));
  assert.equal(payload.type, 'bucket.fillers');
  assert.equal(framesFor(payload.filler.text).length, 1);
});
