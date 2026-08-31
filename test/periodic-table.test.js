'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ROWS, COLS, validate } = require('../src/vestaboard/encoder');
const { formatLayout } = require('../src/vestaboard/notation');
const { periodicTableFrames } = require('../src/vestaboard/formatters/feeds');
const {
  TITLE,
  elementLines,
  elementRows,
  elementHeadline,
  categoryLabel,
  formatWeight,
  fitsBoard,
} = require('../src/periodic-table-layout');
const {
  loadShipped,
  loadCategories,
  resolveElements,
  findElement,
  pickElement,
  buildPeriodicTablePayload,
  createPeriodicTable,
} = require('../src/periodic-table');
const { sanitiseSettings } = require('../src/periodic-table-settings');

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

const framesFor = (number) => {
  const element = findElement({ number });
  return periodicTableFrames(buildPeriodicTablePayload(element));
};

test('the three channel cards render flap for flap', () => {
  const hydrogen = framesFor(1);
  assert.equal(hydrogen.length, 1);
  assert.equal(hydrogen[0].source, 'periodic.table');
  assert.equal(hydrogen[0].label, 'Periodic Table');
  assertBoard(hydrogen[0].rows, [
    '    PERIODIC TABLE',
    '',
    '   1 - HYDROGEN (H)',
    '',
    '       NONMETAL',
    '         1.008',
  ], 'Hydrogen card');

  const calcium = framesFor(20);
  assertBoard(calcium[0].rows, [
    '    PERIODIC TABLE',
    '',
    '   20 - CALCIUM (CA)',
    '',
    ' ALKALINE EARTH METAL',
    '        40.078',
  ], 'Calcium card');

  const iodine = framesFor(53);
  assertBoard(iodine[0].rows, [
    '    PERIODIC TABLE',
    '',
    '    53 - IODINE (I)',
    '',
    '        HALOGEN',
    '        126.904',
  ], 'Iodine card');
});

test('title row matches the marketplace channel', () => {
  assert.equal(TITLE, 'PERIODIC TABLE');
  assert.ok(TITLE.length <= COLS);
});

test('every shipped element fits the six-row layout', () => {
  const elements = loadShipped();
  assert.equal(elements.length, 118);
  for (const element of elements) {
    assert.equal(fitsBoard(element), true, `${element.name} should fit`);
    const lines = elementLines(element);
    assert.equal(lines.length, ROWS);
    const rows = elementRows(element);
    assert.equal(rows.length, ROWS);
    assert.equal(validate(rows).ok, true, `${element.name} rows invalid`);
  }
});

test('category labels cover the standard groups', () => {
  const categories = loadCategories();
  assert.ok(categories.length >= 10);
  assert.ok(categories.some((row) => row.id === 'nonmetal'));
  assert.ok(categories.some((row) => row.id === 'halogen'));
  assert.ok(categories.some((row) => row.id === 'alkaline-earth-metal'));
});

test('pickElement avoids recent ids when possible', () => {
  const pool = resolveElements({});
  const first = pool[0];
  const second = pool[1];
  const settings = sanitiseSettings({ recentIds: [first.id] });
  const picked = pickElement(settings, { random: () => 0 });
  assert.notEqual(picked.id, first.id);
  const forced = pickElement(settings, { number: second.number });
  assert.equal(forced.number, second.number);
});

test('createPeriodicTable rotates and respects category filters', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'periodic-table-'));
  const api = createPeriodicTable({
    ROOT: root,
    periodicTableSettingsPath: path.join(root, 'settings.json'),
  }, console);
  assert.equal(api.statusSnapshot().available, 118);

  api.updateSettings({ categories: ['halogen'] });
  const halogenOnly = api.statusSnapshot();
  assert.ok(halogenOnly.available >= 5);
  assert.ok(halogenOnly.available < 118);

  const payload = api.nextPayload({ number: 53 });
  assert.equal(payload.type, 'periodic.table');
  assert.equal(payload.element.number, 53);
  assert.equal(payload.element.lines.length, ROWS);
  assert.equal(validate(periodicTableFrames(payload)[0].rows).ok, true);
  assert.equal(periodicTableFrames(payload)[0].rows.length, ROWS);
});

test('headline and weight helpers match element facts', () => {
  const hydrogen = findElement({ number: 1 });
  assert.equal(elementHeadline(hydrogen), '1 - HYDROGEN (H)');
  assert.equal(categoryLabel(hydrogen.category), 'NONMETAL');
  assert.equal(formatWeight(hydrogen.weight), '1.008');
});

test('empty payload yields no frames', () => {
  assert.deepEqual(periodicTableFrames({ type: 'periodic.table' }), []);
  assert.deepEqual(periodicTableFrames({}), []);
});
