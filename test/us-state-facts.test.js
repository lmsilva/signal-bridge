'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ROWS, validate } = require('../src/vestaboard/encoder');
const { formatLayout } = require('../src/vestaboard/notation');
const { usStateFactsFrames } = require('../src/vestaboard/formatters/feeds');
const {
  VALUE_COL,
  fitsBoard,
  stateRows,
} = require('../src/us-state-facts-layout');
const {
  loadShipped,
  loadRegions,
  resolveStates,
  findState,
  pickState,
  buildUsStateFactsPayload,
  createUsStateFacts,
} = require('../src/us-state-facts');
const { sanitiseSettings } = require('../src/us-state-facts-settings');

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

const framesFor = (id) => {
  const state = findState({ id });
  return usStateFactsFrames(buildUsStateFactsPayload(state));
};

test('the three channel cards render flap for flap', () => {
  const oregon = framesFor('or');
  assert.equal(oregon.length, 1);
  assert.equal(oregon[0].source, 'state.facts');
  assert.equal(oregon[0].label, 'US State Facts');
  assertBoard(oregon[0].rows, [
    '      b OREGON b',
    '',
    'CAPITAL:  SALEM',
    'BIRD:     WESTERN',
    '          MEADOWLARK',
    'FLOWER:   OREGON GRAPE',
  ], 'Oregon card');

  const kentucky = framesFor('ky');
  assertBoard(kentucky[0].rows, [
    '     g KENTUCKY g',
    '',
    'CAPITAL:  FRANKFORT',
    'BIRD:     KENTUCKY',
    '          CARDINAL',
    'FLOWER:   GOLDENROD',
  ], 'Kentucky card');

  const ohio = framesFor('oh');
  assertBoard(ohio[0].rows, [
    '       r OHIO r',
    '',
    'CAPITAL:  COLUMBUS',
    'BIRD:     CARDINAL',
    'FLOWER:   SCARLET',
    '          CARNATION',
  ], 'Ohio card');
});

test('value column lines up under CAPITAL / BIRD / FLOWER', () => {
  assert.equal(VALUE_COL, 10);
});

test('every shipped state fits the six-row layout', () => {
  const states = loadShipped();
  assert.equal(states.length, 50);
  const ids = new Set();
  for (const state of states) {
    assert.ok(state.id, `${state.name} needs an id`);
    assert.equal(ids.has(state.id), false, `duplicate id ${state.id}`);
    ids.add(state.id);
    assert.equal(fitsBoard(state), true, `${state.name} should fit`);
    const rows = stateRows(state);
    assert.equal(rows.length, ROWS);
    assert.equal(validate(rows).ok, true, `${state.name} rows invalid`);
  }
});

test('census regions cover the fifty states', () => {
  const regions = loadRegions();
  assert.equal(regions.length, 4);
  assert.ok(regions.some((row) => row.id === 'northeast'));
  assert.ok(regions.some((row) => row.id === 'midwest'));
  assert.ok(regions.some((row) => row.id === 'south'));
  assert.ok(regions.some((row) => row.id === 'west'));
  assert.equal(regions.reduce((sum, row) => sum + row.count, 0), 50);
});

test('pickState avoids recent ids when possible', () => {
  const pool = resolveStates({});
  const first = pool[0];
  const second = pool[1];
  const settings = sanitiseSettings({ recentIds: [first.id] });
  const picked = pickState(settings, { random: () => 0 });
  assert.notEqual(picked.id, first.id);
  const forced = pickState(settings, { id: second.id });
  assert.equal(forced.id, second.id);
});

test('createUsStateFacts rotates and respects region filters', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'us-state-facts-'));
  const api = createUsStateFacts({
    ROOT: root,
    usStateFactsSettingsPath: path.join(root, 'settings.json'),
  }, console);
  assert.equal(api.statusSnapshot().available, 50);

  api.updateSettings({ regions: ['west'] });
  const westOnly = api.statusSnapshot();
  assert.ok(westOnly.available >= 10);
  assert.ok(westOnly.available < 50);

  const payload = api.nextPayload({ id: 'or' });
  assert.equal(payload.type, 'state.facts');
  assert.equal(payload.state.id, 'or');
  assert.equal(payload.state.name, 'Oregon');
  assert.equal(payload.state.rows.length, ROWS);
  assert.equal(validate(usStateFactsFrames(payload)[0].rows).ok, true);
  assert.equal(usStateFactsFrames(payload)[0].rows.length, ROWS);
});

test('empty payload yields no frames', () => {
  assert.deepEqual(usStateFactsFrames({ type: 'state.facts' }), []);
  assert.deepEqual(usStateFactsFrames({}), []);
});
