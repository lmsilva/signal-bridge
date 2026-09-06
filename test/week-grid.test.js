/**
 * Shared week-grid helpers (fixed-time slots + quiet-hours week strings).
 * Loads src/web/week-grid.js onto globalThis without a browser / jsdom.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadWeekGrid() {
  const code = fs.readFileSync(path.join(__dirname, '../src/web/week-grid.js'), 'utf8');
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.addEventListener = () => {};
  sandbox.removeEventListener = () => {};
  vm.runInNewContext(code, sandbox, { filename: 'week-grid.js' });
  return sandbox;
}

function fakeHost() {
  return {
    classList: { add() {}, toggle() {}, remove() {} },
    style: { setProperty() {} },
    innerHTML: '',
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    contains() { return false; },
  };
}

function jsonEqual(actual, expected) {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
}

test('week-grid exports createWeekGrid and WeekGrid on globalThis', () => {
  const root = loadWeekGrid();
  assert.equal(typeof root.createWeekGrid, 'function');
  assert.equal(typeof root.WeekGrid.create, 'function');
  assert.equal(typeof root.WeekGrid.summarizeSlots, 'function');
  jsonEqual(root.WeekGrid.DAY_LABELS, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
});

test('clear empties every painted hour', () => {
  const root = loadWeekGrid();
  const grid = root.createWeekGrid(fakeHost(), { mode: 'fires', globalMinute: 0 });
  grid.setSlots([
    { day: 2, hour: 7, minute: 0 },
    { day: 2, hour: 8, minute: 0 },
  ]);
  assert.equal(grid.getSlots().length, 2);
  grid.clear();
  jsonEqual(grid.getSlots(), []);
});

test('getSlots / setSlots round-trip Monday-first fixedTimes', () => {
  const root = loadWeekGrid();
  const grid = root.createWeekGrid(fakeHost(), { mode: 'fires', globalMinute: 0 });
  const slots = [
    { day: 0, hour: 7, minute: 0 },
    { day: 4, hour: 7, minute: 0 },
    { day: 5, hour: 8, minute: 30 },
  ];
  grid.setSlots(slots);
  jsonEqual(grid.getSlots(), slots);
  assert.match(grid.summarize(), /Fires 3x\/week/);
  assert.match(grid.summarize(), /Mon-Fri 07:00|Mon, Fri 07:00/);
});

test('summarizeSlots collapses weekday ranges', () => {
  const root = loadWeekGrid();
  const text = root.WeekGrid.summarizeSlots([
    { day: 0, hour: 7, minute: 0 },
    { day: 1, hour: 7, minute: 0 },
    { day: 2, hour: 7, minute: 0 },
    { day: 3, hour: 7, minute: 0 },
    { day: 4, hour: 7, minute: 0 },
    { day: 5, hour: 8, minute: 0 },
    { day: 6, hour: 8, minute: 0 },
  ]);
  assert.equal(text, 'Fires 7x/week -- Mon-Fri 07:00 | Sat, Sun 08:00');
});

test('setGlobalMinute updates non-override cells', () => {
  const root = loadWeekGrid();
  const grid = root.createWeekGrid(fakeHost(), { mode: 'fires', globalMinute: 0 });
  grid.setSlots([
    { day: 0, hour: 9, minute: 0 },
    { day: 1, hour: 9, minute: 15 },
  ]);
  grid.setGlobalMinute(30);
  const slots = grid.getSlots();
  assert.equal(slots.find((s) => s.day === 0).minute, 30);
  assert.equal(slots.find((s) => s.day === 1).minute, 15);
  assert.equal(grid.getGlobalMinute(), 30);
});

test('quiet mode week strings round-trip', () => {
  const root = loadWeekGrid();
  const grid = root.createWeekGrid(fakeHost(), { mode: 'quiet', globalMinute: 0 });
  const week = [
    '000000011111111111111100',
    '000000011111111111111100',
    '000000011111111111111100',
    '000000011111111111111100',
    '000000011111111111111100',
    '000000011111111111111100',
    '000000011111111111111100',
  ];
  grid.setWeekStrings(week);
  jsonEqual(grid.getWeekStrings(), week);
  assert.match(grid.summarize(), /Mon quiet/);
});

test('paint emits cells back-to-back with no separator text between them', () => {
  const root = loadWeekGrid();
  const host = fakeHost();
  root.createWeekGrid(host, { mode: 'fires', globalMinute: 0 });
  const html = host.innerHTML;
  // A join(' | ') here once leaked a pipe between every element; the grid then
  // wrapped each day onto two rows because the text nodes became grid items.
  assert.ok(!html.includes('|'), 'grid markup must not carry separator text between cells');
  assert.equal((html.match(/class="wg-cell/g) || []).length, 168);
  assert.equal((html.match(/class="wg-hour"/g) || []).length, 24);
  assert.equal((html.match(/data-wg-day="/g) || []).length, 175);
});
