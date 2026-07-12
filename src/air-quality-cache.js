'use strict';

const fs = require('fs');
const path = require('path');

const CACHE_FILE_NAME = 'air-quality-cache.json';

function resolveCachePath(config) {
  if (config?.airQualityCachePath) {
    return config.airQualityCachePath;
  }
  return path.join(config?.ROOT || process.cwd(), 'data', CACHE_FILE_NAME);
}

function loadAirQualityCache(config) {
  try {
    const raw = fs.readFileSync(resolveCachePath(config), 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.monitors) && parsed.monitors.length) {
      return parsed;
    }
  } catch {
    // Missing or corrupt cache is fine.
  }
  return null;
}

function saveAirQualityCache(config, { location, reading, monitors }, log) {
  if (!Array.isArray(monitors) || monitors.length === 0) {
    return false;
  }
  const cachePath = resolveCachePath(config);
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(
      cachePath,
      JSON.stringify({
        savedAt: new Date().toISOString(),
        location: location || null,
        reading: reading || null,
        monitors,
      }, null, 2),
    );
    return true;
  } catch (error) {
    if (log?.warn) {
      log.warn('Failed to save air quality cache', error.message || error);
    }
    return false;
  }
}

module.exports = {
  CACHE_FILE_NAME,
  resolveCachePath,
  loadAirQualityCache,
  saveAirQualityCache,
};
