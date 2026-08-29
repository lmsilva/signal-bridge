const test = require('node:test');
const assert = require('node:assert/strict');

const { validate } = require('../src/vestaboard/encoder');
const { parseLayout, formatLayout } = require('../src/vestaboard/notation');
const { weeklyWeatherFrames } = require('../src/vestaboard/formatters/alexa');
const {
  averageTemp,
  daysFromForecast,
  buildWeeklyWeatherPayload,
} = require('../src/weekly-weather');

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

const FORECAST = {
  fetchedAt: '2026-08-28T14:00:00.000Z',
  next7Days: [
    { date: '2026-08-28', highF: 90, lowF: 62, highC: 32, lowC: 17, condition: 'sunny' },
    { date: '2026-08-29', highF: 84, lowF: 60, highC: 29, lowC: 16, condition: 'cloudy' },
    { date: '2026-08-30', highF: 72, lowF: 58, highC: 22, lowC: 14, condition: 'rainy' },
    { date: '2026-08-31', highF: 70, lowF: 55, highC: 21, lowC: 13, condition: 'stormy' },
    { date: '2026-09-01', highF: 68, lowF: 50, highC: 20, lowC: 10, condition: 'snowy' },
    { date: '2026-09-02', highF: 80, lowF: 58, highC: 27, lowC: 14, condition: 'sunny' },
    { date: '2026-09-03', highF: 82, lowF: 60, highC: 28, lowC: 16, condition: 'cloudy' },
  ],
};

test('averageTemp is the mean of high and low, rounded', () => {
  assert.equal(averageTemp({ highF: 90, lowF: 62 }, 'F'), 76);
  assert.equal(averageTemp({ highF: 70, lowF: 55 }, 'F'), 63);
  assert.equal(averageTemp({ highC: 32, lowC: 17 }, 'C'), 25);
  assert.equal(averageTemp({ highF: 80 }, 'F'), 80);
  assert.equal(averageTemp({}, 'F'), null);
});

test('daysFromForecast keeps seven weekday names and condition chips', () => {
  const days = daysFromForecast(FORECAST, { unit: 'F' });
  assert.equal(days.length, 7);
  assert.deepEqual(days.map((day) => day.weekday), ['FRI', 'SAT', 'SUN', 'MON', 'TUE', 'WED', 'THU']);
  assert.deepEqual(days.map((day) => day.temp), [76, 72, 65, 63, 59, 69, 71]);
  assert.equal(days[0].condition, 'sunny');
  assert.equal(days[4].condition, 'snowy');
});

test('daysFromForecast can print Celsius averages', () => {
  const days = daysFromForecast(FORECAST, { unit: 'C' });
  assert.deepEqual(days.map((day) => day.temp), [25, 23, 18, 17, 15, 21, 22]);
});

test('buildWeeklyWeatherPayload is a vestaboard weather.weekly card', () => {
  const payload = buildWeeklyWeatherPayload({
    weather: FORECAST,
    location: { city: 'Lehi', label: 'Lehi, UT', latitude: 40.41, longitude: -111.85 },
  });
  assert.equal(payload.type, 'weather.weekly');
  assert.equal(payload.temperatureUnit, 'F');
  assert.equal(payload.location.city, 'Lehi');
  assert.equal(payload.location.label, 'Lehi, UT');
  assert.equal(payload.days.length, 7);
  assert.equal(payload.asOf, FORECAST.fetchedAt);
});

test('buildWeeklyWeatherPayload is silent without a forecast', () => {
  assert.equal(buildWeeklyWeatherPayload({ weather: {} }), null);
  assert.equal(buildWeeklyWeatherPayload({ weather: { next7Days: [] } }), null);
});

test('weekly weather matches the marketplace two-column report', () => {
  const frames = weeklyWeatherFrames({
    type: 'weather.weekly',
    temperatureUnit: 'F',
    location: { city: 'Phoenix' },
    days: [
      { date: '2026-08-26', weekday: 'WED', temp: 59, condition: 'sunny' },
      { date: '2026-08-27', weekday: 'THU', temp: 61, condition: 'cloudy' },
      { date: '2026-08-28', weekday: 'FRI', temp: 63, condition: 'sunny' },
      { date: '2026-08-29', weekday: 'SAT', temp: 61, condition: 'cloudy' },
      { date: '2026-08-30', weekday: 'SUN', temp: 63, condition: 'sunny' },
      { date: '2026-08-31', weekday: 'MON', temp: 64, condition: 'sunny' },
      { date: '2026-09-01', weekday: 'TUE', temp: 59, condition: 'rainy' },
    ],
  });
  assert.equal(frames.length, 1);
  assert.equal(frames[0].source, 'weather.weekly');
  assertLayout(frames[0].rows, [
    'ww  WEATHER REPORT  ww',
    'w       PHOENIX      w',
    'WED    59FoSUN    63Fo',
    'THU    61FyMON    64Fo',
    'FRI    63FoTUE    59Fb',
    'SAT    61Fy           ',
  ], 'weekly weather marketplace');
});

test('weekly weather starts with today on the top left and uses the city label', () => {
  const payload = buildWeeklyWeatherPayload({
    weather: FORECAST,
    location: { label: 'Lehi, UT' },
  });
  const frames = weeklyWeatherFrames(payload);
  assertLayout(frames[0].rows, [
    'ww  WEATHER REPORT  ww',
    'w        LEHI        w',
    'FRI    76FoTUE    59Fv',
    'SAT    72FyWED    69Fo',
    'SUN    65FbTHU    71Fy',
    'MON    63Fr           ',
  ], 'weekly weather from forecast');
});

test('weekly weather with no days renders nothing', () => {
  assert.deepEqual(weeklyWeatherFrames({ type: 'weather.weekly', days: [] }), []);
  assert.deepEqual(weeklyWeatherFrames({}), []);
});
