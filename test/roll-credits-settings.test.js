const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createRollCreditsSettings,
  DEFAULTS,
  VALID_ORDERS,
} = require('../src/roll-credits-settings');

function tempSettingsPath() {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'roll-credits-settings-unit-')),
    'roll-credits-settings.json',
  );
}

test('Roll Credits settings expose the required defaults', () => {
  const settings = createRollCreditsSettings({ rollCreditsSettingsPath: tempSettingsPath() });
  assert.deepEqual(settings.get(), JSON.parse(JSON.stringify(DEFAULTS)));
  assert.deepEqual(VALID_ORDERS, ['recent', 'oldest', 'random', 'alpha']);
});

test('Roll Credits settings clamp ranges and reject unsupported enum values', () => {
  const settingsPath = tempSettingsPath();
  const settings = createRollCreditsSettings({ rollCreditsSettingsPath: settingsPath });
  const result = settings.update({
    youtube: { defaultResolution: 999 },
    scrape: { maxScreenshots: 99 },
    display: {
      secondsPerGame: 2,
      dashboardSeconds: 500,
      order: 'unknown',
      scheduledGameLimit: -5,
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.settings.youtube.defaultResolution, 720);
  assert.equal(result.settings.scrape.maxScreenshots, 12);
  assert.equal(result.settings.display.secondsPerGame, 5);
  assert.equal(result.settings.display.dashboardSeconds, 120);
  assert.equal(result.settings.display.order, 'recent');
  assert.equal(result.settings.display.scheduledGameLimit, 0);

  const second = settings.update({
    youtube: { defaultResolution: 1080 },
    scrape: { maxScreenshots: 0 },
    display: { secondsPerGame: 301, dashboardSeconds: 1, order: 'alpha' },
  });
  assert.equal(second.settings.youtube.defaultResolution, 1080);
  assert.equal(second.settings.scrape.maxScreenshots, 1);
  assert.equal(second.settings.display.secondsPerGame, 300);
  assert.equal(second.settings.display.dashboardSeconds, 10);
  assert.equal(second.settings.display.order, 'alpha');
});

test('Roll Credits settings save atomically and retain complete priority lists', () => {
  const settingsPath = tempSettingsPath();
  const settings = createRollCreditsSettings({ rollCreditsSettingsPath: settingsPath });
  settings.update({
    mediaPriority: ['cover', 'video'],
    scrape: { providerOrder: ['steam'] },
  });

  const disk = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.deepEqual(disk.mediaPriority, ['cover', 'video', 'screenshot']);
  assert.deepEqual(disk.scrape.providerOrder, ['steam', 'igdb']);
  assert.equal(
    fs.readdirSync(path.dirname(settingsPath)).some((name) => name.endsWith('.tmp')),
    false,
  );
});

test('get reloads from disk so separate settings instances stay in sync', () => {
  const settingsPath = tempSettingsPath();
  const admin = createRollCreditsSettings({ rollCreditsSettingsPath: settingsPath });
  const pushHandler = createRollCreditsSettings({ rollCreditsSettingsPath: settingsPath });

  admin.update({ display: { order: 'oldest', secondsPerGame: 40 } });
  assert.equal(pushHandler.get().display.order, 'oldest');
  assert.equal(pushHandler.get().display.secondsPerGame, 40);

  fs.writeFileSync(settingsPath, `${JSON.stringify({
    ...pushHandler.get(),
    display: { ...pushHandler.get().display, dashboardSeconds: 70 },
  }, null, 2)}\n`, 'utf8');
  assert.equal(admin.get().display.dashboardSeconds, 70);
});
