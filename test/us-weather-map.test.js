'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ROWS, COLS, CHIPS, validate } = require('../src/vestaboard/encoder');
const { formatLayout } = require('../src/vestaboard/notation');
const { usWeatherMapFrames } = require('../src/vestaboard/formatters/feeds');
const {
  MASK,
  CELLS,
  MODES,
  DEFAULT_SETTINGS,
  TEMPERATURE_BANDS,
  chipForTemperature,
  chipForCondition,
  cleanMode,
  sanitiseSettings,
  legendFor,
  fetchMapReadings,
  buildUsWeatherMapPayload,
  createUsWeatherMap,
} = require('../src/us-weather-map');

/** Readings that put a whole map in one band, so a test can vary one cell. */
function flatReadings({ tempF = 70, code = 0 } = {}) {
  return CELLS.map((cell) => ({
    ...cell, tempF, tempC: Math.round(((tempF - 32) * 5) / 9), code,
  }));
}

const framesFor = (readings, mode = 'temperature') => usWeatherMapFrames(
  buildUsWeatherMapPayload({ readings, mode }),
);

test('the silhouette is the one the channel paints', () => {
  assert.equal(MASK.length, ROWS);
  for (const line of MASK) {
    assert.equal(line.length, COLS);
    assert.match(line, /^[#.]+$/);
  }
  // Traced off the reference cards, which agree with each other flap for flap.
  assert.deepEqual([...MASK], [
    '###############.....##',
    '################..###.',
    '.###################..',
    '..#################...',
    '...###############....',
    '..........#......#....',
  ]);
  assert.equal(CELLS.length, 89);

  // Row 0 columns 15-19 are the Great Lakes, and 20-21 is New England
  // reaching past them. Losing that notch would make the map a blob.
  assert.equal(MASK[0].slice(15, 20), '.....');
  assert.equal(MASK[0].slice(20), '##');
});

test('the projection lands the anchors it was fitted to', () => {
  const at = (row, col) => CELLS.find((cell) => cell.row === row && cell.col === col);

  // The two lonely cells on the bottom row are the only unambiguous points on
  // the map, so they are what the longitude scale was fitted to.
  const texas = at(5, 10);
  assert.ok(Math.abs(texas.lat - 26) < 1.5, `Texas cell at ${texas.lat}`);
  assert.ok(Math.abs(texas.lon - -98) < 1.5, `Texas cell at ${texas.lon}`);

  const florida = at(5, 17);
  assert.ok(Math.abs(florida.lat - 26) < 1.5, `Florida cell at ${florida.lat}`);
  assert.ok(Math.abs(florida.lon - -81) < 1.5, `Florida cell at ${florida.lon}`);

  // Falls out of the other two rather than being fitted: Puget Sound.
  const northwest = at(0, 0);
  assert.ok(Math.abs(northwest.lat - 47.5) < 1.5, `NW cell at ${northwest.lat}`);
  assert.ok(Math.abs(northwest.lon - -122.5) < 1.5, `NW cell at ${northwest.lon}`);

  // Every sampled point has to be somewhere a US weather model covers.
  for (const cell of CELLS) {
    assert.ok(cell.lat > 22 && cell.lat < 50, `${cell.row},${cell.col} lat ${cell.lat}`);
    assert.ok(cell.lon > -126 && cell.lon < -66, `${cell.row},${cell.col} lon ${cell.lon}`);
  }
});

test('white is the cold end of the scale, not the middle', () => {
  // The channel's winter card is white across the north and blue across the
  // south, which only works if white is colder than blue.
  assert.equal(chipForTemperature(10), 'white');
  assert.equal(chipForTemperature(31), 'white');
  assert.equal(chipForTemperature(32), 'blue');
  assert.equal(chipForTemperature(49), 'blue');
  assert.equal(chipForTemperature(50), 'green');
  assert.equal(chipForTemperature(64), 'green');
  assert.equal(chipForTemperature(65), 'yellow');
  assert.equal(chipForTemperature(79), 'yellow');
  assert.equal(chipForTemperature(80), 'orange');
  assert.equal(chipForTemperature(94), 'orange');
  assert.equal(chipForTemperature(95), 'red');
  assert.equal(chipForTemperature(130), 'red');
  assert.equal(chipForTemperature(null), null);
  assert.equal(chipForTemperature('warm'), null);

  // Cold to hot, with no band able to swallow another.
  const edges = TEMPERATURE_BANDS.map((band) => band.maxF);
  assert.deepEqual(edges, [...edges].sort((a, b) => a - b));
});

test('conditions map the WMO codes the channel uses', () => {
  assert.equal(chipForCondition(0), 'yellow');
  assert.equal(chipForCondition(2), 'green');
  assert.equal(chipForCondition(3), 'white');
  assert.equal(chipForCondition(71), 'white');
  assert.equal(chipForCondition(61), 'blue');
  assert.equal(chipForCondition(95), 'violet');
  // A code outside the table is some flavour of cloud, never a hole.
  assert.equal(chipForCondition(4), 'white');
  assert.equal(chipForCondition(null), null);
});

test('a summer map runs cool in the north and hot in the south', () => {
  // Roughly the channel's warm card: green across the top, red at the tips.
  // 55F at the northern border down to 95F at the tips, which is the gradient
  // the channel's warm card shows: green, green, yellow, yellow, orange, red.
  const readings = CELLS.map((cell) => ({
    ...cell, tempF: 55 + cell.row * 8, code: 0,
  }));
  const frames = framesFor(readings);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].source, 'us.weather-map');
  assert.equal(frames[0].label, 'US Weather Map');
  assert.equal(validate(frames[0].rows).ok, true);

  const drawn = formatLayout(frames[0].rows);
  assert.equal(drawn.split('\n').length, ROWS);

  const rows = frames[0].rows;
  assert.equal(rows[0][0], CHIPS.green, 'the north should be cool');
  assert.equal(rows[2][1], CHIPS.yellow, 'the middle should be mild');
  assert.equal(rows[4][3], CHIPS.orange, 'the south should be warm');
  assert.equal(rows[5][10], CHIPS.red, 'the tip of Texas should be hot');
  // Blank stays blank: the notch and the margins are not part of the country.
  assert.equal(rows[0][15], 0);
  assert.equal(rows[5][0], 0);
});

test('a winter map is white over blue', () => {
  const frames = framesFor(CELLS.map((cell) => ({
    ...cell, tempF: cell.row < 3 ? 20 : 40, code: 0,
  })));
  const rows = frames[0].rows;
  assert.equal(rows[0][0], CHIPS.white);
  assert.equal(rows[4][3], CHIPS.blue);
  assert.equal(rows[5][17], CHIPS.blue);
});

test('every land flap is painted and nothing else is', () => {
  const frames = framesFor(flatReadings({ tempF: 70 }));
  const rows = frames[0].rows;
  let painted = 0;
  for (let row = 0; row < ROWS; row += 1) {
    for (let col = 0; col < COLS; col += 1) {
      const land = MASK[row][col] === '#';
      if (land) {
        assert.equal(rows[row][col], CHIPS.yellow, `${row},${col} should be land`);
        painted += 1;
      } else {
        assert.equal(rows[row][col], 0, `${row},${col} should be blank`);
      }
    }
  }
  assert.equal(painted, CELLS.length);
});

test('a map with holes in it is not aired', () => {
  // Half a country is a broken fetch, not a partial map.
  assert.equal(buildUsWeatherMapPayload({ readings: flatReadings().slice(0, 40) }), null);
  assert.equal(buildUsWeatherMapPayload({ readings: [] }), null);
  // A cell the model had no reading for takes the whole map down with it.
  const gappy = flatReadings();
  gappy[12] = { ...gappy[12], tempF: null };
  assert.equal(buildUsWeatherMapPayload({ readings: gappy }), null);

  assert.deepEqual(usWeatherMapFrames({ type: 'us.weather-map' }), []);
  assert.deepEqual(usWeatherMapFrames({}), []);
});

test('the payload carries the readings behind the colours', () => {
  const payload = buildUsWeatherMapPayload({
    readings: CELLS.map((cell, index) => ({
      ...cell, tempF: 40 + index, tempC: 4 + index, code: 0,
    })),
    mode: 'temperature',
    unit: 'F',
  });
  assert.equal(payload.type, 'us.weather-map');
  assert.equal(payload.mode, 'temperature');
  assert.equal(payload.cells.length, CELLS.length);
  assert.equal(payload.range.minF, 40);
  assert.equal(payload.range.maxF, 40 + CELLS.length - 1);
  assert.ok(payload.cells.every((cell) => cell.chip));
});

test('settings are clamped rather than trusted', () => {
  assert.deepEqual(sanitiseSettings({}), DEFAULT_SETTINGS);
  assert.equal(sanitiseSettings({ mode: 'CONDITIONS' }).mode, 'conditions');
  assert.equal(sanitiseSettings({ mode: 'nonsense' }).mode, DEFAULT_SETTINGS.mode);
  assert.equal(sanitiseSettings({ refreshMinutes: 1 }).refreshMinutes, 10);
  assert.equal(sanitiseSettings({ refreshMinutes: 9999 }).refreshMinutes, 360);
  assert.equal(sanitiseSettings({ refreshMinutes: 'soon' }).refreshMinutes, 30);
  assert.equal(cleanMode(''), 'temperature');
  assert.deepEqual(MODES, ['temperature', 'conditions']);
});

test('the legend follows the mode and the house unit', () => {
  const f = legendFor('temperature', 'F');
  assert.equal(f.length, TEMPERATURE_BANDS.length);
  assert.equal(f[0].chip, 'white');
  assert.match(f[0].label, /Below 32F/);
  assert.match(f[f.length - 1].label, /95F and up/);

  const c = legendFor('temperature', 'C');
  assert.match(c[0].label, /Below 0C/);

  const conditions = legendFor('conditions', 'F');
  assert.ok(conditions.some((band) => band.chip === 'violet' && /Storm/i.test(band.label)));
});

test('the whole map is one request, and the order is trusted', async () => {
  const calls = [];
  const readings = await fetchMapReadings({
    fetchImpl: async (url) => {
      calls.push(url);
      const params = new URL(url).searchParams;
      const lats = params.get('latitude').split(',');
      return {
        ok: true,
        json: async () => lats.map((_, index) => ({
          current: { temperature_2m: 50 + index, weather_code: 0 },
        })),
      };
    },
  });
  assert.equal(calls.length, 1, '89 points should cost one call, not 89');
  assert.match(calls[0], /temperature_unit=fahrenheit/);
  assert.equal(readings.length, CELLS.length);
  assert.equal(readings[0].row, CELLS[0].row);
  assert.equal(readings[0].tempF, 50);
  assert.equal(readings[0].tempC, 10);
});

test('a short answer is refused rather than misaligned', async () => {
  await assert.rejects(
    () => fetchMapReadings({
      fetchImpl: async () => ({ ok: true, json: async () => [{ current: { temperature_2m: 60 } }] }),
    }),
    /returned 1 points for 89 cells/,
  );
  await assert.rejects(
    () => fetchMapReadings({ fetchImpl: async () => ({ ok: false, status: 429 }) }),
    /HTTP 429/,
  );
});

test('the map is cached, refreshed on demand, and survives an outage', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'us-weather-map-'));
  let calls = 0;
  let broken = false;
  const fetchImpl = async (url) => {
    calls += 1;
    if (broken) {
      throw new Error('network down');
    }
    const lats = new URL(url).searchParams.get('latitude').split(',');
    return {
      ok: true,
      json: async () => lats.map(() => ({ current: { temperature_2m: 70, weather_code: 0 } })),
    };
  };
  const map = createUsWeatherMap({
    ROOT: root,
    usWeatherMapSettingsPath: path.join(root, 'us-weather-map-settings.json'),
    usWeatherMapFetchImpl: fetchImpl,
  }, { warn() {} });

  // A cold bridge has no map but has not failed either, so it may still air.
  const cold = map.statusSnapshot();
  assert.equal(cold.hasMap, false);
  assert.equal(cold.lastError, null);
  assert.equal(cold.cellCount, CELLS.length);

  const first = await map.nextPayload({ now: 1000 });
  assert.equal(first.cells.length, CELLS.length);
  assert.equal(calls, 1);
  assert.equal(map.statusSnapshot().hasMap, true);

  // Inside the window a second push reuses the readings.
  await map.nextPayload({ now: 2000 });
  assert.equal(calls, 1, 'a push inside the refresh window should not refetch');

  await map.nextPayload({ now: 1000 + 31 * 60 * 1000 });
  assert.equal(calls, 2, 'a push past the refresh window should refetch');

  await map.nextPayload({ now: 2000, force: true });
  assert.equal(calls, 3, 'force should ignore the cache');

  // A stale map beats a blank board.
  broken = true;
  const stale = await map.nextPayload({ now: 9e12 });
  assert.equal(stale.cells.length, CELLS.length);
  assert.match(map.statusSnapshot().lastError, /network down/);

  assert.equal(map.updateSettings({ mode: 'conditions' }).mode, 'conditions');
  assert.equal(map.statusSnapshot().legend[0].label, 'Clear');
  assert.equal(map.resetSettings().mode, 'temperature');

  fs.rmSync(root, { recursive: true, force: true });
});

test('with nothing cached a failed fetch is surfaced, not swallowed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'us-weather-map-'));
  const map = createUsWeatherMap({
    ROOT: root,
    usWeatherMapSettingsPath: path.join(root, 'us-weather-map-settings.json'),
    usWeatherMapFetchImpl: async () => { throw new Error('no route to host'); },
  }, { warn() {} });

  await assert.rejects(() => map.nextPayload(), /no route to host/);
  const status = map.statusSnapshot();
  assert.equal(status.hasMap, false);
  assert.match(status.lastError, /no route to host/);

  fs.rmSync(root, { recursive: true, force: true });
});
