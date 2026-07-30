const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  loadBatteryCache,
  saveBatteryCache,
  buildRefreshingReading,
  applyBatteryFallback,
  resolveCachePath,
  readingFromDashboard,
} = require('../src/tesla-battery-cache');

function tempConfig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tesla-batt-cache-'));
  return { ROOT: root };
}

test('saveBatteryCache persists only ok readings and loadBatteryCache reads them back', () => {
  const config = tempConfig();
  assert.equal(saveBatteryCache(config, { status: 'error', error: 'nope' }), false);
  assert.equal(loadBatteryCache(config), null);

  const reading = {
    status: 'ok',
    percent: 72,
    model: 'Model Y',
    batteryRange: 162,
    rangeMiles: 162,
    fetchedAt: '2026-07-08T22:00:00.000Z',
  };
  assert.equal(saveBatteryCache(config, reading), true);
  const cached = loadBatteryCache(config);
  assert.equal(cached.percent, 72);
  assert.equal(cached.model, 'Model Y');
  assert.equal(cached.batteryRange, 162);
  assert.equal(cached.rangeMiles, 162);
  fs.rmSync(config.ROOT, { recursive: true, force: true });
});

test('loadBatteryCache tolerates corrupt cache files', () => {
  const config = tempConfig();
  const cachePath = resolveCachePath(config);
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, 'not json');
  assert.equal(loadBatteryCache(config), null);
  fs.rmSync(config.ROOT, { recursive: true, force: true });
});

test('loadBatteryCache falls back to dashboard cache', () => {
  const config = tempConfig();
  const dashboardPath = path.join(config.ROOT, 'data', 'tesla-dashboard-cache.json');
  fs.mkdirSync(path.dirname(dashboardPath), { recursive: true });
  fs.writeFileSync(
    dashboardPath,
    JSON.stringify({
      savedAt: '2026-07-08T22:00:00.000Z',
      dashboard: {
        status: 'ok',
        fetchedAt: '2026-07-08T22:00:00.000Z',
        vehicle: { model: 'Model Y' },
        battery: { percent: 64, chargingLabel: 'Not plugged in', rangeMiles: 171.4 },
      },
    }),
  );
  const cached = loadBatteryCache(config);
  assert.equal(cached.percent, 64);
  assert.equal(cached.chargingLabel, 'Not plugged in');
  assert.equal(cached.batteryRange, 171);
  assert.equal(cached.rangeMiles, 171);
  fs.rmSync(config.ROOT, { recursive: true, force: true });
});

test('readingFromDashboard returns null without percent', () => {
  assert.equal(readingFromDashboard({ battery: {} }), null);
});

test('applyBatteryFallback marks cached reading stale with age', () => {
  const cached = {
    status: 'ok',
    percent: 55,
    model: 'Model Y',
    fetchedAt: '2026-07-08T22:00:00.000Z',
  };
  const failed = { status: 'error', error: 'Request throttled', limitResetAt: '2026-07-08T22:01:00.000Z' };
  const now = Date.parse('2026-07-08T22:05:00.000Z');
  const result = applyBatteryFallback(failed, cached, now);

  assert.equal(result.stale, true);
  assert.equal(result.percent, 55);
  assert.equal(result.status, 'ok');
  assert.equal(result.staleReason, 'Request throttled');
  assert.equal(result.cachedAt, '2026-07-08T22:00:00.000Z');
  assert.equal(result.freshnessSec, 5 * 60);
  assert.equal(result.limitResetAt, '2026-07-08T22:01:00.000Z');
});

test('buildRefreshingReading marks cache as refreshing preview', () => {
  const cached = {
    status: 'ok',
    percent: 71,
    model: 'Model Y',
    fetchedAt: '2026-07-11T18:00:00.000Z',
  };
  const now = Date.parse('2026-07-11T18:08:00.000Z');
  const preview = buildRefreshingReading(cached, now);

  assert.equal(preview.percent, 71);
  assert.equal(preview.status, 'ok');
  assert.equal(preview.stale, true);
  assert.equal(preview.refreshing, true);
  assert.equal(preview.staleReason, 'Refreshing live data');
  assert.equal(preview.cachedAt, '2026-07-11T18:00:00.000Z');
  assert.equal(preview.freshnessSec, 8 * 60);
});

test('buildRefreshingReading returns null without usable cache', () => {
  assert.equal(buildRefreshingReading(null), null);
  assert.equal(buildRefreshingReading({ status: 'ok', percent: null }), null);
});

test('applyBatteryFallback keeps live reading and error without cache', () => {
  const live = { status: 'ok', percent: 80 };
  assert.equal(applyBatteryFallback(live, null), live);
  assert.equal(applyBatteryFallback(live, { status: 'ok', percent: 50 }), live);

  const failed = { status: 'error', error: 'vehicle unavailable' };
  assert.equal(applyBatteryFallback(failed, null), failed);
});
