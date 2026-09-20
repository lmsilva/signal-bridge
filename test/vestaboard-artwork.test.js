'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  ROWS, COLS, BLANK, CHIPS, UNUSED_CODES, validate,
} = require('../src/vestaboard/encoder');
const { formatLayout, parseLayout } = require('../src/vestaboard/notation');
const { vestaboardArtworkFrames } = require('../src/vestaboard/formatters/feeds');
const { formatterFor, typeOf } = require('../src/vestaboard/router');
const { COMMAND_SOURCE, catalogForClient } = require('../src/vestaboard/priorities');
const {
  TYPE,
  loadShipped,
  isPainted,
  blankCells,
  normaliseMode,
  resolveArtwork,
  matchingArtwork,
  countAvailable,
  countFavourites,
  pickArtwork,
  listArtwork,
  buildVestaboardArtworkPayload,
  createVestaboardArtwork,
} = require('../src/vestaboard-artwork');
const { sanitiseSettings } = require('../src/vestaboard-artwork-settings');

/** The names the household is promised, in the order they ship. */
const SHIPPED_NAMES = [
  'Mountains',
  'American Flag',
  'Japanese Heart',
  'Key to Heart',
  'Turkey',
  'Psychedelic Heart',
  'School Bus',
  'Winter',
  'Cute Bird',
  'Christmas House',
  'Cute Beaver',
  'Dinosaur',
  'Flowers',
  'One in a Minion',
  'Mom Heart',
  'Balloons',
  'Colored Hearts',
  'Cute Duck',
  'Cute Chicks',
  'Grover',
  'Pumpkin',
  'Jolly Santa',
  'Minions',
];

/** Compare a painted grid against a drawing of the whole board. */
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

const shippedById = (id) => loadShipped().find((design) => design.id === id);

const framesFor = (design) => vestaboardArtworkFrames(buildVestaboardArtworkPayload(design));

/** Settings that see only the drawings the test supplies, not the shipped set. */
const onlyCustom = (custom) => sanitiseSettings({
  custom,
  removedIds: loadShipped().map((design) => design.id),
});

/** A cheap one-chip drawing, so a test can name a colour instead of 132 codes. */
function chipAt(colour, row = 0, column = 0) {
  const cells = blankCells();
  cells[row][column] = CHIPS[colour];
  return cells;
}

function tempArtwork() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vestaboard-artwork-'));
  const api = createVestaboardArtwork({
    ROOT: root,
    vestaboardArtworkSettingsPath: path.join(root, 'vestaboard-artwork-settings.json'),
  });
  return { api, root };
}

test('every shipped template is a board the hardware can show', () => {
  const designs = loadShipped();
  assert.deepEqual(designs.map((design) => design.name), SHIPPED_NAMES);

  const seen = new Set();
  for (const design of designs) {
    assert.match(design.id, /^art-[a-z0-9-]+$/);
    assert.equal(seen.has(design.id), false, `duplicate id ${design.id}`);
    seen.add(design.id);

    assert.equal(design.cells.length, ROWS, `${design.name} is not ${ROWS} rows`);
    for (const row of design.cells) {
      assert.equal(row.length, COLS, `${design.name} is not ${COLS} columns`);
      for (const code of row) {
        assert.equal(UNUSED_CODES.has(code), false, `${design.name} uses reserved code ${code}`);
      }
    }
    assert.equal(validate(design.cells).ok, true, `${design.name} failed validation`);
    assert.equal(isPainted(design.cells), true, `${design.name} is blank`);
  }
});

test('the shipped grids flip flap for flap', () => {
  const flag = framesFor(shippedById('art-american-flag'));
  assert.equal(flag.length, 1);
  assert.equal(flag[0].source, TYPE);
  assert.equal(flag[0].label, 'American Flag');
  assertBoard(flag[0].rows, [
    'wbwbwbwbwrrrrrrrrrrrrr',
    'bwbwbwbwbwwwwwwwwwwwww',
    'wbwbwbwbwrrrrrrrrrrrrr',
    'bwbwbwbwbwwwwwwwwwwwww',
    'rrrrrrrrrrrrrrrrrrrrrr',
    'wwwwwwwwwwwwwwwwwwwwww',
  ], 'American Flag');

  // Lettered templates: the picture is decoded from the screenshot, the words
  // are typed, and the two have to land on the same grid without colliding.
  const heart = framesFor(shippedById('art-japanese-heart'));
  assertBoard(heart[0].rows, [
    '           rrr   rrr',
    ' MOTTO    rrrrr rrrrr',
    ' AISHITERUrrrrrrrrrrr',
    ' YO!       rrrrrrrrr',
    '             rrrrr',
    '               r',
  ], 'Japanese Heart');

  const bird = framesFor(shippedById('art-cute-bird'));
  assertBoard(bird[0].rows, [
    'bbbbooobbbbbbbbooobbbb',
    'bbbboroooooooooorobbbb',
    'bbbbboowkooookwoobbbbb',
    'bbbbboooooooooooobbbbb',
    'bbbbooooookkoooooobbbb',
    'bbbboooooowwoooooobbbb',
  ], 'Cute Bird');

  // Words beside a picture rather than over it: the minion's face fills the
  // right half and the line breaks are the design's, not a wrapper's.
  const minion = framesFor(shippedById('art-one-in-a-minion'));
  assertBoard(minion[0].rows, [
    '             yyyyyyy',
    "  YOU'RE    yywyyywyy",
    '  ONE IN    ywkwywkwy',
    '  A MINION  ywwwywwwy',
    '            byyyyyyyb',
    '            ybbbbbbby',
  ], 'One in a Minion');

  // Three letters sitting inside the heart they are addressed to.
  const mom = framesFor(shippedById('art-mom-heart'));
  assertBoard(mom[0].rows, [
    'wwwwwwrrrwwwrrrwwwwwww',
    'wwwwwrrrrrwrrrrrwwwwww',
    'wwwwwrrrrMOMrrrrwwwwww',
    'wwwwwwrrrrrrrrrwwwwwww',
    'wwwwwwwwrrrrrwwwwwwwww',
    'wwwwwwwwwwrwwwwwwwwwww',
  ], 'Mom Heart');

  // Full-bleed with single white flaps scattered through the green as snow: the
  // lone flaps are the ones a decode is most likely to lose.
  const santa = framesFor(shippedById('art-jolly-santa'));
  assertBoard(santa[0].rows, [
    'gwgggrrrrrrrrgggwggwgg',
    'ggggrggrrrrrrrggggwwwg',
    'gggwggwobooobowggggwgg',
    'wggggwwoowwwoowwgwgggg',
    'ggggggwwwwkwwwwggggggw',
    'ggrrrrwwwwwwwwwrrrrggg',
  ], 'Jolly Santa');

  // A carved face is black flaps inside the orange, so the blank-versus-black
  // call the decoder has to make is pinned here too.
  const pumpkin = framesFor(shippedById('art-pumpkin'));
  assertBoard(pumpkin[0].rows, [
    '       ooogorrggggg',
    '     oookoookorr  g',
    '    oookwooowkorr gg',
    '    ooooookooooor',
    '    ookkoooookkor',
    '     oookokokoor',
  ], 'Pumpkin');
});

test('artwork is wired into the router, the formatter table and the priority catalog', () => {
  assert.equal(typeOf({}, 'artwork.show'), TYPE);
  assert.equal(formatterFor('artwork.show'), vestaboardArtworkFrames);
  assert.equal(COMMAND_SOURCE['artwork.show'], TYPE);

  const event = catalogForClient().events.find((row) => row.source === TYPE);
  assert.ok(event, 'artwork is missing from the priority catalog');
  assert.equal(event.label, 'Vestaboard Artwork');
  assert.equal(event.group, 'house');
});

test('the payload carries the grid, and a blank board is not artwork', () => {
  const payload = buildVestaboardArtworkPayload(
    { id: 'art-demo', name: '  Sunset  Ridge ', cells: chipAt('orange') },
    { asOf: '2026-09-19T12:00:00.000Z' },
  );
  assert.equal(payload.type, TYPE);
  assert.equal(payload.asOf, '2026-09-19T12:00:00.000Z');
  assert.equal(payload.artwork.id, 'art-demo');
  assert.equal(payload.artwork.name, 'Sunset Ridge');
  assert.equal(payload.artwork.cells[0][0], CHIPS.orange);

  assert.equal(buildVestaboardArtworkPayload({ cells: blankCells() }), null);
  assert.equal(buildVestaboardArtworkPayload({ cells: [[BLANK]] }), null);
  assert.equal(vestaboardArtworkFrames({}).length, 0);
});

test('the three ways to pick, and what each does when the gallery thins out', () => {
  assert.equal(normaliseMode('Favourites'), 'favorite');
  assert.equal(normaliseMode('favorite'), 'favorite');
  assert.equal(normaliseMode('SPECIFIC'), 'specific');
  assert.equal(normaliseMode('anything else'), 'random');

  const settings = onlyCustom([
    { id: 'a', name: 'Alpha', cells: chipAt('red') },
    { id: 'b', name: 'Beta', cells: chipAt('green') },
    { id: 'c', name: 'Gamma', cells: chipAt('blue') },
  ]);
  assert.equal(countAvailable(settings), 3);
  assert.equal(countFavourites(settings), 0);

  assert.equal(pickArtwork(settings, { random: () => 0 }).artwork.id, 'a');
  assert.equal(pickArtwork(settings, { random: () => 0.99 }).artwork.id, 'c');

  // Nothing starred yet, so Favourites sends something rather than nothing —
  // and says so.
  const noStars = pickArtwork(settings, { mode: 'favorite', random: () => 0 });
  assert.equal(noStars.ok, true);
  assert.equal(noStars.fellBack, true);

  const starred = { ...settings, favouriteIds: ['c'] };
  const favourite = pickArtwork(starred, { mode: 'favorite', random: () => 0 });
  assert.equal(favourite.artwork.id, 'c');
  assert.equal(favourite.fellBack, false);
  assert.equal(countFavourites(starred), 1);

  assert.equal(pickArtwork(settings, { mode: 'specific', artworkId: 'b' }).artwork.id, 'b');
  assert.equal(pickArtwork(settings, { mode: 'specific' }).ok, false);
  assert.match(pickArtwork(settings, { mode: 'specific', artworkId: 'zz' }).error, /no longer/);

  assert.equal(pickArtwork(onlyCustom([]), {}).ok, false);

  // Hiding is for the shipped set — a hidden template leaves the rotation but
  // stays on the shelf, unlike a removed one.
  const shipped = loadShipped();
  const withoutFirst = sanitiseSettings({ hiddenIds: [shipped[0].id] });
  assert.equal(countAvailable(withoutFirst), shipped.length - 1);
  assert.equal(pickArtwork(withoutFirst, { random: () => 0 }).artwork.id, shipped[1].id);
});

test('the rotation skips what it just sent', () => {
  const base = onlyCustom([
    { id: 'a', name: 'Alpha', cells: chipAt('red') },
    { id: 'b', name: 'Beta', cells: chipAt('green') },
  ]);
  assert.equal(pickArtwork({ ...base, recentIds: ['a'] }, { random: () => 0 }).artwork.id, 'b');
  // Once everything is recent the window stops mattering, or nothing could air.
  assert.equal(pickArtwork({ ...base, recentIds: ['a', 'b'] }, { random: () => 0 }).artwork.id, 'a');
});

test('the list searches by name or id, filters and paginates', () => {
  const settings = onlyCustom(Array.from({ length: 30 }, (_, index) => ({
    id: `c${index}`,
    name: `Sketch ${index}`,
    cells: chipAt('violet'),
  })));

  const page = listArtwork(settings, { page: 2, pageSize: 10 });
  assert.equal(page.pages, 3);
  assert.equal(page.artwork.length, 10);
  assert.equal(page.total, 30);

  assert.equal(listArtwork(settings, { query: ' Sketch 7 ' }).total, 1);
  assert.equal(listArtwork(settings, { query: 'c12' }).total, 1);

  assert.equal(listArtwork(sanitiseSettings({ ...settings, favouriteIds: ['c3'] }), {
    favourites: true,
  }).total, 1);

  // Hidden templates only show when the manage sheet asks for them.
  const shipped = loadShipped();
  const hidden = sanitiseSettings({ hiddenIds: [shipped[0].id] });
  assert.equal(listArtwork(hidden).total, shipped.length - 1);
  assert.equal(listArtwork(hidden, { hidden: true }).total, shipped.length);
});

test('the scheduler picker and the template picker only offer real boards', () => {
  const { api, root } = tempArtwork();

  const templates = api.templates();
  assert.equal(templates.length, SHIPPED_NAMES.length);
  assert.deepEqual(templates.map((row) => row.name), SHIPPED_NAMES);
  // A copy, so the editor cannot paint over the shipped corpus in memory.
  templates[0].cells[0][0] = CHIPS.red;
  assert.notEqual(shippedById(templates[0].id).cells[0][0], CHIPS.red);

  const options = api.options();
  assert.equal(options.length, SHIPPED_NAMES.length);
  assert.deepEqual(options[0], { value: 'art-mountains', label: 'Mountains' });

  api.updateArtwork('art-mountains', { favourite: true });
  assert.equal(api.options()[0].label, 'Mountains *');

  api.updateArtwork('art-mountains', { hidden: true });
  assert.equal(api.options().some((row) => row.value === 'art-mountains'), false);

  fs.rmSync(root, { recursive: true, force: true });
});

test('readiness answers for the params the rule actually asked for', () => {
  const { api, root } = tempArtwork();

  assert.equal(api.readiness().available, SHIPPED_NAMES.length);
  assert.equal(api.readiness({ mode: 'specific', artworkId: 'art-turkey' }).available, 1);
  assert.equal(api.readiness({ mode: 'specific', artworkId: 'art-nope' }).available, 0);
  assert.equal(api.readiness({ mode: 'specific' }).available, 0);

  // A rule pinned to one piece stops being ready when that piece is thrown away.
  api.updateArtwork('art-turkey', { remove: true });
  assert.equal(api.readiness({ mode: 'specific', artworkId: 'art-turkey' }).available, 0);
  assert.ok(api.readiness().available > 0);

  fs.rmSync(root, { recursive: true, force: true });
});

test('house edits add, rename, repaint, revert, star, hide and remove', () => {
  const { api, root } = tempArtwork();
  const shipped = loadShipped()[0];

  const added = api.addArtwork('  Our  Sunrise  ', chipAt('yellow'));
  assert.equal(added.ok, true);
  assert.equal(added.customCount, 1);
  assert.equal(api.addArtwork('Nothing', blankCells()).ok, false);
  assert.equal(api.addArtwork('Wrong shape', [[BLANK]]).ok, false);

  const mine = api.getSettings().custom[0];
  assert.equal(mine.name, 'Our Sunrise');
  assert.equal(mine.id, added.id);

  assert.equal(api.updateArtwork(mine.id, { name: 'Sunrise II' }).ok, true);
  assert.equal(api.getSettings().custom[0].name, 'Sunrise II');
  assert.equal(api.updateArtwork(mine.id, { cells: blankCells() }).ok, false);

  // Hiding a drawing of your own throws it away — there is nothing underneath it.
  assert.equal(api.updateArtwork(mine.id, { favourite: true }).ok, true);
  assert.ok(api.getSettings().favouriteIds.includes(mine.id));
  assert.equal(api.updateArtwork(mine.id, { hidden: true }).ok, true);
  assert.equal(api.getSettings().custom.length, 0);
  assert.equal(api.getSettings().favouriteIds.includes(mine.id), false);

  // A shipped template hides and comes back.
  assert.equal(api.updateArtwork(shipped.id, { hidden: true }).ok, true);
  assert.equal(matchingArtwork(api.getSettings()).some((row) => row.id === shipped.id), false);
  api.updateArtwork(shipped.id, { hidden: false });

  const repainted = parseLayout('rrrr\ngggg\nbbbb\nyyyy\nwwww\nkkkk');
  assert.equal(api.updateArtwork(shipped.id, { name: 'House Mountains', cells: repainted }).ok, true);
  const edited = resolveArtwork(api.getSettings()).find((row) => row.id === shipped.id);
  assert.equal(edited.name, 'House Mountains');
  assert.equal(edited.edited, true);
  assert.deepEqual(edited.cells, repainted);

  // Painting it back to the template is not an edit worth keeping.
  api.updateArtwork(shipped.id, { name: shipped.name, cells: shipped.cells });
  assert.deepEqual(api.getSettings().overrides, {});

  assert.equal(api.updateArtwork(shipped.id, { remove: true }).ok, true);
  assert.ok(api.getSettings().removedIds.includes(shipped.id));
  assert.equal(
    listArtwork(api.getSettings(), { hidden: true }).artwork.some((row) => row.id === shipped.id),
    false,
  );

  assert.equal(api.updateArtwork('', { name: 'x' }).ok, false);
  assert.equal(api.updateArtwork('art-nope', { name: 'x' }).ok, false);

  fs.rmSync(root, { recursive: true, force: true });
});

test('a push returns a frameable payload and remembers what it sent', () => {
  const { api, root } = tempArtwork();

  const picked = api.next({ mode: 'specific', artworkId: 'art-winter' });
  assert.equal(picked.ok, true);
  assert.equal(picked.mode, 'specific');
  assert.equal(picked.payload.artwork.name, 'Winter');
  assert.equal(vestaboardArtworkFrames(picked.payload).length, 1);
  assert.ok(api.getSettings().recentIds.includes('art-winter'));

  const status = api.statusSnapshot();
  assert.equal(status.available, SHIPPED_NAMES.length);
  assert.equal(status.total, SHIPPED_NAMES.length);
  assert.equal(status.customCount, 0);

  const listed = api.statusSnapshot({ query: 'heart' });
  const hearts = SHIPPED_NAMES.filter((name) => /heart/i.test(name));
  assert.ok(hearts.length >= 3, 'the corpus should have hearts to find');
  assert.equal(listed.total, hearts.length);
  assert.equal(listed.page, 1);

  assert.ok(api.nextPayload({ mode: 'random', random: () => 0 }).artwork.id);
  assert.equal(api.next({ mode: 'specific', artworkId: 'art-nope' }).ok, false);

  fs.rmSync(root, { recursive: true, force: true });
});

test('the settings file drops half-written grids instead of repairing them', () => {
  const good = chipAt('red');
  const settings = sanitiseSettings({
    custom: [
      { id: 'ok', name: 'Fine', cells: good },
      { id: 'short-row', name: 'Bad', cells: [good[0].slice(0, 5), ...good.slice(1)] },
      { id: 'short-grid', name: 'Bad', cells: good.slice(0, 3) },
      { id: 'illegal', name: 'Bad', cells: [good[0].map(() => 43), ...good.slice(1)] },
      { id: 'ok', name: 'Duplicate', cells: good },
    ],
    favouriteIds: ['ok', 'ok', '  '],
    overrides: {
      'art-turkey': { name: '   ', cells: [[1]] },
      'art-winter': { name: 'Snow Day' },
    },
  });
  assert.deepEqual(settings.custom.map((row) => row.id), ['ok']);
  assert.deepEqual(settings.favouriteIds, ['ok']);
  assert.deepEqual(Object.keys(settings.overrides), ['art-winter']);
  assert.deepEqual(settings.overrides['art-winter'], { name: 'Snow Day' });
});
