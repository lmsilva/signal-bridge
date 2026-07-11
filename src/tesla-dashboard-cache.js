'use strict';

const fs = require('fs');
const path = require('path');

const CACHE_FILE_NAME = 'tesla-dashboard-cache.json';

function resolveCachePath(config) {
  if (config?.teslaDashboardCachePath) {
    return config.teslaDashboardCachePath;
  }
  return path.join(config?.ROOT || process.cwd(), 'data', CACHE_FILE_NAME);
}

function loadDashboardCache(config) {
  try {
    const raw = fs.readFileSync(resolveCachePath(config), 'utf8');
    const parsed = JSON.parse(raw);
    const dashboard = parsed?.dashboard;
    if (dashboard && dashboard.status === 'ok') {
      return dashboard;
    }
  } catch (error) {
    // Missing or corrupt cache is fine — caller falls back to the error state.
  }
  return null;
}

function saveDashboardCache(config, dashboard, log) {
  if (!dashboard || dashboard.status !== 'ok') {
    return false;
  }
  const cachePath = resolveCachePath(config);
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(
      cachePath,
      JSON.stringify({ savedAt: new Date().toISOString(), dashboard }, null, 2),
    );
    return true;
  } catch (error) {
    if (log?.warn) {
      log.warn('Failed to save Tesla dashboard cache', error.message || error);
    }
    return false;
  }
}

/**
 * Cached dashboard served instantly while the live Fleet fetch runs. The
 * `refreshing` flag tells the client to show a calm "updating…" legend
 * instead of the amber "Tesla unreachable" fallback styling.
 */
function buildRefreshingDashboard(cached, now = Date.now()) {
  if (!cached) {
    return null;
  }
  const cachedAtMs = Date.parse(cached.fetchedAt || '');
  const freshnessSec = Number.isFinite(cachedAtMs)
    ? Math.max(0, Math.round((now - cachedAtMs) / 1000))
    : null;
  return {
    ...cached,
    stale: true,
    refreshing: true,
    staleReason: 'Refreshing live data',
    cachedAt: cached.fetchedAt || null,
    freshnessSec,
  };
}

/**
 * When a live fetch failed, fall back to the last good dashboard (if any),
 * marking it stale so the client can show a "cached" legend.
 */
function applyDashboardFallback(dashboard, cached, now = Date.now()) {
  if (dashboard?.status === 'ok' || !cached) {
    return dashboard;
  }
  const cachedAtMs = Date.parse(cached.fetchedAt || '');
  const freshnessSec = Number.isFinite(cachedAtMs)
    ? Math.max(0, Math.round((now - cachedAtMs) / 1000))
    : null;
  return {
    ...cached,
    stale: true,
    staleReason: dashboard?.error || 'Tesla unreachable',
    cachedAt: cached.fetchedAt || null,
    freshnessSec,
  };
}

module.exports = {
  CACHE_FILE_NAME,
  resolveCachePath,
  loadDashboardCache,
  saveDashboardCache,
  buildRefreshingDashboard,
  applyDashboardFallback,
};
