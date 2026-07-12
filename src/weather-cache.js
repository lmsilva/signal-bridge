'use strict';

const fs = require('fs');
const path = require('path');

const CACHE_FILE_NAME = 'weather-cache.json';

function resolveCachePath(config) {
  if (config?.weatherCachePath) {
    return config.weatherCachePath;
  }
  return path.join(config?.ROOT || process.cwd(), 'data', CACHE_FILE_NAME);
}

function loadWeatherCache(config) {
  try {
    const raw = fs.readFileSync(resolveCachePath(config), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed?.weather && parsed?.location) {
      return parsed;
    }
  } catch {
    // Missing or corrupt cache is fine.
  }
  return null;
}

function saveWeatherCache(config, { location, weather }, log) {
  if (!weather || !location) {
    return false;
  }
  const cachePath = resolveCachePath(config);
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(
      cachePath,
      JSON.stringify({
        savedAt: new Date().toISOString(),
        location,
        weather,
      }, null, 2),
    );
    return true;
  } catch (error) {
    if (log?.warn) {
      log.warn('Failed to save weather cache', error.message || error);
    }
    return false;
  }
}

module.exports = {
  CACHE_FILE_NAME,
  resolveCachePath,
  loadWeatherCache,
  saveWeatherCache,
};
