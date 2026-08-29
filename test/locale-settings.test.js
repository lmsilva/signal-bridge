const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  FALLBACK,
  sanitiseSettings,
  seedFromConfig,
  hasLocation,
  applyToConfig,
  toWeatherLocation,
  createLocaleSettings,
} = require('../src/locale-settings');

test('sanitiseSettings keeps city, ZIP, coords and clamps the unit', () => {
  const settings = sanitiseSettings({
    city: '  Lehi ',
    postalCode: '84043',
    region: 'UT',
    latitude: '40.41',
    longitude: '-111.85',
    timeZone: 'America/Denver',
    label: 'Lehi, UT',
    temperatureUnit: 'c',
  });
  assert.equal(settings.city, 'Lehi');
  assert.equal(settings.postalCode, '84043');
  assert.equal(settings.latitude, 40.41);
  assert.equal(settings.longitude, -111.85);
  assert.equal(settings.temperatureUnit, 'C');
  assert.equal(settings.timeZone, 'America/Denver');
  assert.equal(settings.currencyCode, 'USD');
});

test('sanitiseSettings keeps a house currency code and maps RMB to CNY', () => {
  const settings = sanitiseSettings({ currencyCode: 'rmb' });
  assert.equal(settings.currencyCode, 'CNY');
  assert.equal(sanitiseSettings({ currencyCode: ' eur ' }).currencyCode, 'EUR');
});

test('sanitiseSettings drops non-finite coords and defaults the unit to F', () => {
  const settings = sanitiseSettings({ latitude: 'east', longitude: '', temperatureUnit: 'kelvin' });
  assert.equal(settings.latitude, null);
  assert.equal(settings.longitude, null);
  assert.equal(settings.temperatureUnit, 'F');
  assert.equal(settings.timeZone, FALLBACK.timeZone);
});

test('seedFromConfig copies the existing default location onto the house pin', () => {
  const seeded = seedFromConfig({
    voiceEvents: {
      defaultLocation: { name: 'Saratoga Springs, UT', latitude: 40.35, longitude: -111.9 },
      localTimeZone: 'America/Denver',
    },
  });
  assert.equal(seeded.city, 'Saratoga Springs, UT');
  assert.equal(seeded.label, 'Saratoga Springs, UT');
  assert.equal(seeded.latitude, 40.35);
  assert.equal(seeded.longitude, -111.9);
  assert.equal(seeded.timeZone, 'America/Denver');
  assert.equal(hasLocation(seeded), true);
});

test('applyToConfig points weather and clocks at the house pin', () => {
  const config = { voiceEvents: { defaultLocation: { name: 'Old' } } };
  applyToConfig(config, {
    city: 'Lehi',
    label: 'Lehi, UT',
    latitude: 40.41,
    longitude: -111.85,
    timeZone: 'America/Denver',
  });
  assert.deepEqual(config.voiceEvents.defaultLocation, {
    name: 'Lehi, UT',
    latitude: 40.41,
    longitude: -111.85,
  });
  assert.equal(config.voiceEvents.localTimeZone, 'America/Denver');
  assert.equal(config.alarmSync.localTimeZone, 'America/Denver');
});

test('applyToConfig leaves an existing pin alone when the new settings have no coords', () => {
  const config = {
    voiceEvents: {
      defaultLocation: { name: 'Home', latitude: 1, longitude: 2 },
    },
  };
  applyToConfig(config, { city: 'Lehi', latitude: null, longitude: null });
  assert.equal(config.voiceEvents.defaultLocation.latitude, 1);
});

test('toWeatherLocation is null until both coordinates exist', () => {
  assert.equal(toWeatherLocation({ latitude: 40, longitude: null }), null);
  const loc = toWeatherLocation({
    label: 'Lehi, UT',
    city: 'Lehi',
    latitude: 40.41,
    longitude: -111.85,
    timeZone: 'America/Denver',
  });
  assert.equal(loc.scope, 'local');
  assert.equal(loc.resolvedName, 'Lehi, UT');
  assert.equal(loc.latitude, 40.41);
  assert.equal(loc.timezone, 'America/Denver');
});

test('createLocaleSettings seeds from config when the file is missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'locale-'));
  const config = {
    ROOT: root,
    voiceEvents: {
      defaultLocation: { name: 'Lehi, UT', latitude: 40.41, longitude: -111.85 },
      localTimeZone: 'America/Denver',
    },
  };
  const store = createLocaleSettings(config, { warn() {} });
  assert.equal(fs.existsSync(store.path), false);
  assert.equal(store.hasLocation(), true);
  assert.equal(store.get().city, 'Lehi, UT');
  assert.equal(config.voiceEvents.defaultLocation.latitude, 40.41);
});

test('createLocaleSettings persists an update and reloads it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'locale-'));
  const config = { ROOT: root, voiceEvents: {} };
  const store = createLocaleSettings(config, { warn() {} });
  const saved = store.update({
    city: 'Lehi',
    postalCode: '84043',
    region: 'UT',
    label: 'Lehi, UT',
    latitude: 40.41,
    longitude: -111.85,
    timeZone: 'America/Denver',
    temperatureUnit: 'C',
  });
  assert.equal(saved.temperatureUnit, 'C');
  assert.equal(fs.existsSync(store.path), true);

  const again = createLocaleSettings({ ROOT: root, voiceEvents: {} }, { warn() {} });
  assert.equal(again.get().postalCode, '84043');
  assert.equal(again.get().temperatureUnit, 'C');
  assert.equal(again.weatherLocation().latitude, 40.41);
});
