const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  loadDashboardCache,
  saveDashboardCache,
  applyDashboardFallback,
  resolveCachePath,
} = require('../src/tesla-dashboard-cache');

function tempConfig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tesla-dash-cache-'));
  return { ROOT: root };
}

test('saveDashboardCache persists only ok dashboards and loadDashboardCache reads them back', () => {
  const config = tempConfig();
  assert.equal(saveDashboardCache(config, { status: 'error', error: 'nope' }), false);
  assert.equal(loadDashboardCache(config), null);

  const dashboard = {
    status: 'ok',
    fetchedAt: '2026-07-08T22:00:00.000Z',
    vehicle: { name: 'Model Y' },
    battery: { percent: 68 },
  };
  assert.equal(saveDashboardCache(config, dashboard), true);
  const cached = loadDashboardCache(config);
  assert.equal(cached.vehicle.name, 'Model Y');
  assert.equal(cached.battery.percent, 68);
  fs.rmSync(config.ROOT, { recursive: true, force: true });
});

test('loadDashboardCache tolerates corrupt cache files', () => {
  const config = tempConfig();
  const cachePath = resolveCachePath(config);
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, 'not json');
  assert.equal(loadDashboardCache(config), null);
  fs.rmSync(config.ROOT, { recursive: true, force: true });
});

test('applyDashboardFallback marks cached dashboard stale with age', () => {
  const cached = {
    status: 'ok',
    fetchedAt: '2026-07-08T22:00:00.000Z',
    vehicle: { name: 'Model Y' },
  };
  const failed = { status: 'error', error: 'vehicle unavailable' };
  const now = Date.parse('2026-07-08T22:25:00.000Z');
  const result = applyDashboardFallback(failed, cached, now);

  assert.equal(result.stale, true);
  assert.equal(result.staleReason, 'vehicle unavailable');
  assert.equal(result.cachedAt, '2026-07-08T22:00:00.000Z');
  assert.equal(result.freshnessSec, 25 * 60);
  assert.equal(result.vehicle.name, 'Model Y');
});

test('applyDashboardFallback keeps live dashboard and error without cache', () => {
  const live = { status: 'ok', vehicle: { name: 'Model Y' } };
  assert.equal(applyDashboardFallback(live, null), live);
  assert.equal(applyDashboardFallback(live, { status: 'ok' }), live);

  const failed = { status: 'error', error: 'vehicle unavailable' };
  assert.equal(applyDashboardFallback(failed, null), failed);
});
