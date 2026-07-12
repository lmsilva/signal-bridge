'use strict';

const { fetchWeatherForecast } = require('./weather-fetch');
const { extractWeatherLocation } = require('./weather-location');
const { loadWeatherCache, saveWeatherCache } = require('./weather-cache');
const { fetchShoppingList, saveShoppingListCache } = require('./shopping-list');
const { enrichAllMonitors } = require('./air-quality-fetch');
const { summarizeMonitorReadings } = require('./air-quality-parse');
const { resolveAirQualityLocation } = require('./air-quality-locations');
const { loadAirQualityCache, saveAirQualityCache } = require('./air-quality-cache');
const {
  isFleetConfigured,
  fetchTeslaDashboardIfOnline,
} = require('./tesla-fleet-client');
const { saveDashboardCache } = require('./tesla-dashboard-cache');
const {
  saveBatteryCache,
  readingFromDashboard,
} = require('./tesla-battery-cache');

const DEFAULTS = {
  enabled: true,
  intervalMs: 60 * 60 * 1000,
  startupDelayMs: 90 * 1000,
  weather: true,
  shoppingList: true,
  airQuality: true,
  tesla: true,
};

function createBackgroundCacheRefresh({ alexa, config, log, settings: userSettings = {} } = {}) {
  const settings = { ...DEFAULTS, ...(config?.backgroundCache || {}), ...userSettings };
  let timer = null;
  let startupTimer = null;
  let inFlight = false;
  let lastRunAt = null;
  let lastResults = null;

  async function refreshWeather() {
    const defaultLocation = config.voiceEvents?.defaultLocation;
    const location = extractWeatherLocation(
      'what is the weather outside',
      defaultLocation,
    );
    if (!location) {
      return { ok: false, reason: 'no_default_location' };
    }

    const weather = await fetchWeatherForecast(location);
    if (!weather) {
      return { ok: false, reason: 'fetch_empty' };
    }

    const resolvedLocation = weather.location || location;
    saveWeatherCache(config, { location: resolvedLocation, weather }, log);
    return {
      ok: true,
      location: resolvedLocation.resolvedName || resolvedLocation.query || null,
    };
  }

  async function refreshShoppingList() {
    if (!alexa) {
      return { ok: false, reason: 'no_alexa' };
    }
    const list = await fetchShoppingList(alexa);
    const items = list?.items || [];
    saveShoppingListCache(config.shoppingListCachePath, items);
    return { ok: true, itemCount: items.length };
  }

  async function refreshAirQuality() {
    if (!alexa) {
      return { ok: false, reason: 'no_alexa' };
    }
    const airQualityConfig = config.airQuality || {};
    const monitors = await enrichAllMonitors(alexa, airQualityConfig);
    if (!monitors.length) {
      return { ok: false, reason: 'no_monitors' };
    }
    const reading = summarizeMonitorReadings(monitors, airQualityConfig);
    const location = resolveAirQualityLocation(
      airQualityConfig.defaultMonitor || 'main floor',
      airQualityConfig,
    );
    saveAirQualityCache(config, { location, reading, monitors }, log);
    return { ok: true, monitorCount: monitors.length };
  }

  async function refreshTesla() {
    if (!isFleetConfigured(config.teslaFleet)) {
      return { ok: false, reason: 'not_configured' };
    }

    const dashboard = await fetchTeslaDashboardIfOnline(config, log);
    if (!dashboard) {
      return { ok: false, reason: 'skipped_or_offline' };
    }
    if (dashboard.status !== 'ok') {
      return { ok: false, reason: dashboard.status || 'error' };
    }

    saveDashboardCache(config, dashboard, log);
    const battery = readingFromDashboard(dashboard);
    if (battery) {
      saveBatteryCache(config, battery, log);
    }
    return {
      ok: true,
      percent: battery?.percent ?? null,
      vehicle: dashboard.vehicle?.name || null,
    };
  }

  async function runOnce(reason = 'scheduled') {
    if (inFlight) {
      log?.debug?.('Background cache refresh already in flight', { reason });
      return lastResults;
    }
    if (!settings.enabled) {
      return null;
    }

    inFlight = true;
    const startedAt = Date.now();
    const results = {};

    try {
      log?.info?.('Background cache refresh starting', { reason });

      if (settings.weather) {
        try {
          results.weather = await refreshWeather();
        } catch (error) {
          results.weather = { ok: false, reason: error.message || String(error) };
          log?.warn?.('Background weather cache failed', error.message || error);
        }
      }

      if (settings.shoppingList) {
        try {
          results.shoppingList = await refreshShoppingList();
        } catch (error) {
          results.shoppingList = { ok: false, reason: error.message || String(error) };
          log?.warn?.('Background shopping list cache failed', error.message || error);
        }
      }

      if (settings.airQuality) {
        try {
          results.airQuality = await refreshAirQuality();
        } catch (error) {
          results.airQuality = { ok: false, reason: error.message || String(error) };
          log?.warn?.('Background air quality cache failed', error.message || error);
        }
      }

      if (settings.tesla) {
        try {
          results.tesla = await refreshTesla();
        } catch (error) {
          results.tesla = { ok: false, reason: error.message || String(error) };
          log?.warn?.('Background Tesla cache failed', error.message || error);
        }
      }

      lastRunAt = Date.now();
      lastResults = results;
      log?.info?.('Background cache refresh finished', {
        reason,
        durationMs: lastRunAt - startedAt,
        results,
      });
      return results;
    } finally {
      inFlight = false;
    }
  }

  function start() {
    stop();
    if (!settings.enabled) {
      log?.info?.('Background cache refresh disabled');
      return;
    }

    log?.info?.('Background cache refresh enabled', {
      intervalMinutes: Math.round(settings.intervalMs / 60000),
      startupDelaySec: Math.round(settings.startupDelayMs / 1000),
      weather: settings.weather,
      shoppingList: settings.shoppingList,
      airQuality: settings.airQuality,
      tesla: settings.tesla,
      teslaNote: 'online-only (never wakes vehicle)',
    });

    startupTimer = setTimeout(() => {
      runOnce('startup').catch(() => {});
    }, Math.max(0, settings.startupDelayMs));

    timer = setInterval(() => {
      runOnce('scheduled').catch(() => {});
    }, Math.max(60_000, settings.intervalMs));
  }

  function stop() {
    if (startupTimer) {
      clearTimeout(startupTimer);
      startupTimer = null;
    }
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function getStatus() {
    return {
      enabled: settings.enabled,
      intervalMs: settings.intervalMs,
      lastRunAt: lastRunAt ? new Date(lastRunAt).toISOString() : null,
      lastResults,
      inFlight,
      weatherCache: Boolean(loadWeatherCache(config)),
      airQualityCache: Boolean(loadAirQualityCache(config)),
    };
  }

  return {
    start,
    stop,
    runOnce,
    getStatus,
    DEFAULTS,
  };
}

module.exports = {
  createBackgroundCacheRefresh,
  DEFAULTS,
};
