const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  DEFAULTS,
  SECONDS_PER_YEAR,
  estimatePopulation,
  formatPopulation,
  formatRate,
  buildWorldPopulationPayload,
  createWorldPopulation,
  sanitiseSettings,
} = require('../src/world-population');
const { worldPopulationFrames } = require('../src/vestaboard/formatters/feeds');

let tempDir;

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'world-pop-'));
});

test('formatPopulation inserts commas', () => {
  assert.equal(formatPopulation(8_266_429_563), '8,266,429,563');
  assert.equal(formatPopulation(999), '999');
});

test('formatRate keeps one decimal for per-second rates', () => {
  assert.equal(formatRate(2.198), '2.2');
  assert.equal(formatRate(4), '4');
});

test('estimatePopulation advances from the baseline by net births', () => {
  const settings = sanitiseSettings({
    basePopulation: 8_000_000_000,
    baseAt: '2026-01-01T00:00:00.000Z',
    birthsPerYear: SECONDS_PER_YEAR, // 1 birth / second
    deathsPerYear: 0,
  });
  const atBase = estimatePopulation(settings, Date.parse(settings.baseAt));
  assert.equal(atBase.population, 8_000_000_000);

  const oneHourLater = estimatePopulation(
    settings,
    Date.parse(settings.baseAt) + (3600 * 1000),
  );
  assert.equal(oneHourLater.population, 8_000_000_000 + 3600);
  assert.ok(Math.abs(oneHourLater.netPerSec - 1) < 1e-9);
});

test('buildWorldPopulationPayload is a vestaboard world.population card', () => {
  const payload = buildWorldPopulationPayload(DEFAULTS, {
    now: Date.parse('2026-01-01T00:00:00.000Z'),
  });
  assert.equal(payload.type, 'world.population');
  assert.equal(payload.population.total, DEFAULTS.basePopulation);
  assert.equal(payload.population.formatted, formatPopulation(DEFAULTS.basePopulation));
  assert.ok(payload.population.netPerSec > 0);

  const frames = worldPopulationFrames(payload);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].source, 'world.population');
  assert.equal(frames[0].rows.length, 6);
});

test('worldPopulationFrames refuse an empty payload', () => {
  assert.deepEqual(worldPopulationFrames({ type: 'world.population' }), []);
  assert.deepEqual(worldPopulationFrames({}), []);
});

test('createWorldPopulation persists settings and builds payloads', () => {
  const settingsPath = path.join(tempDir, 'world-population-settings.json');
  const api = createWorldPopulation({
    worldPopulationSettingsPath: settingsPath,
  });
  const before = api.nextPayload({ now: Date.parse(DEFAULTS.baseAt) });
  assert.equal(before.population.total, DEFAULTS.basePopulation);

  api.updateSettings({
    basePopulation: 9_000_000_000,
    baseAt: '2026-06-01T00:00:00.000Z',
    birthsPerYear: 100_000_000,
    deathsPerYear: 50_000_000,
    sourceLabel: 'HOUSE MODEL',
  });
  assert.ok(fs.existsSync(settingsPath));

  const after = api.nextPayload({ now: Date.parse('2026-06-01T00:00:00.000Z') });
  assert.equal(after.population.total, 9_000_000_000);
  assert.equal(after.population.sourceLabel, 'HOUSE MODEL');

  const reset = api.resetSettings();
  assert.equal(reset.basePopulation, DEFAULTS.basePopulation);
});
