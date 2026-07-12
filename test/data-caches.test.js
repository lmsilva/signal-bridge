const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadWeatherCache, saveWeatherCache, resolveCachePath } = require('../src/weather-cache');
const {
  loadAirQualityCache,
  saveAirQualityCache,
  resolveCachePath: resolveAirQualityCachePath,
} = require('../src/air-quality-cache');

function tempConfig(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { ROOT: root };
}

test('weather cache persists and reloads forecast', () => {
  const config = tempConfig('weather-cache-');
  const location = { scope: 'local', resolvedName: 'Home', latitude: 40.3, longitude: -111.9 };
  const weather = { temperatureF: 88, condition: 'sunny' };

  assert.equal(saveWeatherCache(config, { location, weather }), true);
  const loaded = loadWeatherCache(config);
  assert.equal(loaded.weather.temperatureF, 88);
  assert.equal(loaded.location.resolvedName, 'Home');
  assert.ok(loaded.savedAt);
  assert.ok(fs.existsSync(resolveCachePath(config)));
  fs.rmSync(config.ROOT, { recursive: true, force: true });
});

test('weather cache tolerates missing file', () => {
  const config = tempConfig('weather-cache-miss-');
  assert.equal(loadWeatherCache(config), null);
  fs.rmSync(config.ROOT, { recursive: true, force: true });
});

test('air quality cache persists monitors', () => {
  const config = tempConfig('aq-cache-');
  const monitors = [{ id: 'main-floor', label: 'Main Floor', iaqScore: 42, band: 'good' }];
  assert.equal(saveAirQualityCache(config, {
    location: { label: 'Main Floor' },
    reading: { iaqScore: 42, band: 'good' },
    monitors,
  }), true);

  const loaded = loadAirQualityCache(config);
  assert.equal(loaded.monitors.length, 1);
  assert.equal(loaded.monitors[0].iaqScore, 42);
  assert.ok(fs.existsSync(resolveAirQualityCachePath(config)));
  fs.rmSync(config.ROOT, { recursive: true, force: true });
});

test('air quality cache rejects empty monitors', () => {
  const config = tempConfig('aq-cache-empty-');
  assert.equal(saveAirQualityCache(config, { monitors: [] }), false);
  assert.equal(loadAirQualityCache(config), null);
  fs.rmSync(config.ROOT, { recursive: true, force: true });
});
