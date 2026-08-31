'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ROWS, COLS, validate } = require('../src/vestaboard/encoder');
const { formatLayout } = require('../src/vestaboard/notation');
const { roastMeFrames } = require('../src/vestaboard/formatters/feeds');
const {
  BODY_ROWS,
  loadShipped,
  roastRows,
  matchingRoasts,
  pickRoast,
  listRoasts,
  buildRoastMePayload,
  createRoastMe,
} = require('../src/roast-me');
const { sanitiseSettings } = require('../src/roast-me-settings');

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

const framesFor = (text) => roastMeFrames(buildRoastMePayload({ id: 'demo', text }));

/** Settings that see only the rows the test supplies, not the shipped corpus. */
const onlyCustom = (custom) => sanitiseSettings({
  custom,
  removedIds: loadShipped().map((roast) => roast.id),
});

test('the shipped corpus is board-fit and fit to hang in a kitchen', () => {
  const roasts = loadShipped();
  assert.ok(roasts.length > 1000, `only ${roasts.length} roasts shipped`);

  const seenIds = new Set();
  const seenText = new Set();
  for (const roast of roasts) {
    assert.match(roast.id, /^roast-[0-9a-f]{10}$/);
    assert.equal(seenIds.has(roast.id), false, `duplicate id ${roast.id}`);
    seenIds.add(roast.id);

    const rows = roastRows(roast.text);
    assert.ok(rows.length >= 1 && rows.length <= BODY_ROWS, roast.text);
    for (const line of rows) {
      assert.ok(line.length <= COLS, roast.text);
    }

    const key = rows.join('\n');
    assert.equal(seenText.has(key), false, `duplicate roast ${roast.text}`);
    seenText.add(key);

    // The board hangs where children can read it.
    assert.doesNotMatch(
      roast.text,
      /\b(fuck|shit|bitch|cunt|dick|slut|whore|rape|sex|nigg|fagg|retard)/i,
      roast.text,
    );
  }
});

test('the block is left-aligned and centred down the six rows', () => {
  // The three cards from the marketplace channel, flap for flap.
  const two = framesFor("I treasure the time I don't spend with you.");
  assert.equal(two.length, 1);
  assert.equal(two[0].source, 'roast.me');
  assert.equal(two[0].label, 'Roast Me!');
  assertBoard(two[0].rows, [
    '',
    '',
    "I TREASURE THE TIME I",
    "DON'T SPEND WITH YOU.",
    '',
    '',
  ], 'two-line roast');

  const five = framesFor(
    "I love what you've done with your hair."
    + ' How do you get it to come out of your nostrils like that?',
  );
  assertBoard(five[0].rows, [
    "I LOVE WHAT YOU'VE",
    'DONE WITH YOUR HAIR.',
    'HOW DO YOU GET IT TO',
    'COME OUT OF YOUR',
    'NOSTRILS LIKE THAT?',
    '',
  ], 'five-line roast');

  const four = framesFor(
    'I was going to make a joke about your life, but I see life beat me to the punch.',
  );
  assertBoard(four[0].rows, [
    '',
    'I WAS GOING TO MAKE A',
    'JOKE ABOUT YOUR LIFE,',
    'BUT I SEE LIFE BEAT ME',
    'TO THE PUNCH.',
    '',
  ], 'four-line roast');
});

test('the wrap fills every line rather than saving a word from orphanhood', () => {
  // The house wrapper would pull the trailing "I" down and spend a third row
  // on it. A punchline would rather keep the row.
  assert.deepEqual(roastRows("I treasure the time I don't spend with you."), [
    "I TREASURE THE TIME I",
    "DON'T SPEND WITH YOU.",
  ]);
});

test('an empty roast never flips the board', () => {
  assert.equal(buildRoastMePayload({ id: 'x', text: '   ' }), null);
  assert.deepEqual(roastMeFrames({ type: 'roast.me' }), []);
  assert.deepEqual(roastMeFrames({}), []);
});

test('a roast too long for one frame pages instead of being cut', () => {
  const long = `${'Nobody asked for your opinion and yet here it is again. '.repeat(4)}Sit down.`;
  const frames = roastMeFrames(buildRoastMePayload({ id: 'long', text: long }));
  assert.ok(frames.length >= 2, 'a long roast should page');
  for (const frame of frames) {
    assert.equal(frame.rows.length, ROWS);
    assert.equal(validate(frame.rows).ok, true);
  }
});

test('the rotation skips what it just showed', () => {
  const settings = {
    ...onlyCustom([
      { id: 'a', text: 'You are the reason the shampoo bottle has instructions.' },
      { id: 'b', text: 'I treasure the time I do not spend with you.' },
    ]),
    recentIds: ['a'],
  };
  assert.equal(pickRoast(settings, { random: () => 0 }).id, 'b');
  assert.equal(pickRoast({ ...settings, recentIds: ['a', 'b'] }, { random: () => 0 }).id, 'a');
});

test('the list searches, hides and paginates', () => {
  const settings = onlyCustom(Array.from({ length: 30 }, (_, index) => ({
    id: `c${index}`,
    text: `Roast number ${index} about your taste in music.`,
  })));
  const page = listRoasts(settings, { page: 2, pageSize: 10 });
  assert.equal(page.pages, 3);
  assert.equal(page.roasts.length, 10);
  assert.ok(page.roasts[0].rows >= 1);

  const found = listRoasts(settings, { query: 'number 7 ' });
  assert.equal(found.total, 1);
  assert.match(found.roasts[0].text, /number 7\b/);
});

test('house edits hide, override, add and remove roasts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roast-'));
  const roastMe = createRoastMe({
    ROOT: root,
    roastMeSettingsPath: path.join(root, 'roast-me-settings.json'),
  });
  const shipped = loadShipped()[0];

  const hidden = roastMe.updateRoast(shipped.id, { hidden: true });
  assert.equal(hidden.ok, true);
  assert.ok(hidden.hiddenCount >= 1);
  assert.equal(matchingRoasts(roastMe.getSettings()).some((row) => row.id === shipped.id), false);

  const edited = roastMe.updateRoast(shipped.id, {
    hidden: false,
    text: 'You are the houses favourite cautionary tale.',
  });
  assert.equal(edited.ok, true);
  assert.match(
    matchingRoasts(roastMe.getSettings()).find((row) => row.id === shipped.id).text,
    /cautionary tale/,
  );

  // Typing a shipped roast back to what it was drops the override.
  roastMe.updateRoast(shipped.id, { text: shipped.text });
  assert.deepEqual(roastMe.getSettings().overrides, {});

  const added = roastMe.addRoast('You are the reason this board needed a mute button.');
  assert.equal(added.ok, true);
  assert.equal(added.customCount, 1);
  assert.equal(roastMe.addRoast('   ').ok, false);

  const payload = roastMe.nextPayload({ random: () => 0 });
  assert.equal(payload.type, 'roast.me');
  assert.ok(payload.roast.text);
  assert.ok(roastMe.getSettings().recentIds.includes(payload.roast.id));

  const customId = roastMe.getSettings().custom[0].id;
  assert.equal(roastMe.updateRoast(customId, { remove: true }).ok, true);
  assert.equal(roastMe.getSettings().custom.length, 0);

  assert.equal(roastMe.updateRoast(shipped.id, { remove: true }).ok, true);
  assert.ok(roastMe.getSettings().removedIds.includes(shipped.id));
  assert.equal(
    listRoasts(roastMe.getSettings(), { hidden: true }).roasts.some((row) => row.id === shipped.id),
    false,
  );
  assert.equal(roastMe.updateRoast('nope', { text: 'x' }).ok, false);

  fs.rmSync(root, { recursive: true, force: true });
});
