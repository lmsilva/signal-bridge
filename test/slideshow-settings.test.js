const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createSlideshowSettings,
  clampSecondsPerPhoto,
  DEFAULT_SECONDS_PER_PHOTO,
} = require('../src/slideshow-settings');

function tempSettingsPath() {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'slideshow-settings-unit-')),
    'slideshow-settings.json',
  );
}

test('clampSecondsPerPhoto clamps to 5–60 and rounds', () => {
  assert.equal(clampSecondsPerPhoto(1), 5);
  assert.equal(clampSecondsPerPhoto(60.4), 60);
  assert.equal(clampSecondsPerPhoto(12.6), 13);
  assert.equal(clampSecondsPerPhoto('nope'), DEFAULT_SECONDS_PER_PHOTO);
});

test('createSlideshowSettings defaults and persists order + secondsPerPhoto', () => {
  const settingsPath = tempSettingsPath();
  const settings = createSlideshowSettings({ slideshowSettingsPath: settingsPath });
  assert.deepEqual(settings.get(), { order: 'recent', secondsPerPhoto: 5 });

  const updated = settings.update({ order: 'random', secondsPerPhoto: 25 });
  assert.equal(updated.ok, true);
  assert.deepEqual(settings.get(), { order: 'random', secondsPerPhoto: 25 });

  const reloaded = createSlideshowSettings({ slideshowSettingsPath: settingsPath });
  assert.deepEqual(reloaded.get(), { order: 'random', secondsPerPhoto: 25 });
});

test('createSlideshowSettings can update seconds without changing order', () => {
  const settingsPath = tempSettingsPath();
  const settings = createSlideshowSettings({ slideshowSettingsPath: settingsPath });
  settings.setOrder('oldest');
  const result = settings.setSecondsPerPhoto(40);
  assert.equal(result.ok, true);
  assert.equal(result.order, 'oldest');
  assert.equal(result.secondsPerPhoto, 40);
});

test('createSlideshowSettings migrates order-only files with default seconds', () => {
  const settingsPath = tempSettingsPath();
  fs.writeFileSync(settingsPath, `${JSON.stringify({ order: 'oldest' }, null, 2)}\n`, 'utf8');
  const settings = createSlideshowSettings({ slideshowSettingsPath: settingsPath });
  assert.deepEqual(settings.get(), { order: 'oldest', secondsPerPhoto: 5 });
});

test('getOrder reloads from disk so a second instance sees admin updates', () => {
  const settingsPath = tempSettingsPath();
  const admin = createSlideshowSettings({ slideshowSettingsPath: settingsPath });
  const voice = createSlideshowSettings({ slideshowSettingsPath: settingsPath });
  assert.equal(voice.getOrder(), 'recent');

  const updated = admin.update({ order: 'oldest', secondsPerPhoto: 12 });
  assert.equal(updated.ok, true);

  // Voice listener historically kept a stale in-memory copy — must re-read.
  assert.equal(voice.getOrder(), 'oldest');
  assert.equal(voice.getSecondsPerPhoto(), 12);
  assert.deepEqual(voice.get(), { order: 'oldest', secondsPerPhoto: 12 });
});
