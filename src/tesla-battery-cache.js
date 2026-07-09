'use strict';

const fs = require('fs');
const path = require('path');
const { loadDashboardCache } = require('./tesla-dashboard-cache');

const CACHE_FILE_NAME = 'tesla-battery-cache.json';

function resolveCachePath(config) {
  if (config?.teslaBatteryCachePath) {
    return config.teslaBatteryCachePath;
  }
  return path.join(config?.ROOT || process.cwd(), 'data', CACHE_FILE_NAME);
}

function readingFromDashboard(dashboard) {
  const percent = dashboard?.battery?.percent;
  if (percent == null) {
    return null;
  }
  return {
    percent,
    model: dashboard?.vehicle?.model || 'Model Y',
    chargingLabel: dashboard?.battery?.chargingLabel || null,
    label: 'Battery',
    source: 'fleet-api',
    status: 'ok',
    fetchedAt: dashboard.fetchedAt || null,
  };
}

function loadBatteryCacheFile(config) {
  try {
    const raw = fs.readFileSync(resolveCachePath(config), 'utf8');
    const parsed = JSON.parse(raw);
    const reading = parsed?.reading;
    if (reading && reading.status === 'ok' && reading.percent != null) {
      return reading;
    }
  } catch (error) {
    // Missing or corrupt cache is fine — caller falls back to the error state.
  }
  return null;
}

function loadBatteryCache(config) {
  const fromFile = loadBatteryCacheFile(config);
  if (fromFile) {
    return fromFile;
  }
  const dashboard = loadDashboardCache(config);
  return readingFromDashboard(dashboard);
}

function saveBatteryCache(config, reading, log) {
  if (!reading || reading.status !== 'ok' || reading.percent == null) {
    return false;
  }
  const cachePath = resolveCachePath(config);
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(
      cachePath,
      JSON.stringify({ savedAt: new Date().toISOString(), reading }, null, 2),
    );
    return true;
  } catch (error) {
    if (log?.warn) {
      log.warn('Failed to save Tesla battery cache', error.message || error);
    }
    return false;
  }
}

/**
 * When a live fetch failed, fall back to the last good reading (if any),
 * marking it stale so the client can show a "cached" legend.
 */
function applyBatteryFallback(reading, cached, now = Date.now()) {
  if (reading?.status === 'ok' || !cached || cached.percent == null) {
    return reading;
  }
  const cachedAtMs = Date.parse(cached.fetchedAt || '');
  const freshnessSec = Number.isFinite(cachedAtMs)
    ? Math.max(0, Math.round((now - cachedAtMs) / 1000))
    : null;
  return {
    ...cached,
    status: 'ok',
    stale: true,
    staleReason: reading?.error || reading?.status || 'Tesla unreachable',
    cachedAt: cached.fetchedAt || null,
    freshnessSec,
    limitResetAt: reading?.limitResetAt || null,
  };
}

module.exports = {
  CACHE_FILE_NAME,
  resolveCachePath,
  loadBatteryCache,
  saveBatteryCache,
  applyBatteryFallback,
  readingFromDashboard,
};
