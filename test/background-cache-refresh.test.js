const test = require('node:test');
const assert = require('node:assert/strict');
const { createBackgroundCacheRefresh, DEFAULTS } = require('../src/background-cache-refresh');

test('background cache defaults are hourly and enabled', () => {
  assert.equal(DEFAULTS.enabled, true);
  assert.equal(DEFAULTS.intervalMs, 60 * 60 * 1000);
  assert.equal(DEFAULTS.weather, true);
  assert.equal(DEFAULTS.shoppingList, true);
  assert.equal(DEFAULTS.airQuality, true);
  assert.equal(DEFAULTS.tesla, true);
});

test('createBackgroundCacheRefresh exposes start/stop/runOnce/getStatus', () => {
  const refresh = createBackgroundCacheRefresh({
    config: { backgroundCache: { enabled: false } },
    log: { info() {}, warn() {}, debug() {} },
  });
  assert.equal(typeof refresh.start, 'function');
  assert.equal(typeof refresh.stop, 'function');
  assert.equal(typeof refresh.runOnce, 'function');
  assert.equal(typeof refresh.getStatus, 'function');
  refresh.start();
  const status = refresh.getStatus();
  assert.equal(status.enabled, false);
  refresh.stop();
});
