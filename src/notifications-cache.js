'use strict';

const fs = require('fs');
const path = require('path');

const CACHE_FILE_NAME = 'notifications-cache.json';

function resolveCachePath(config) {
  if (config?.notificationsCachePath) {
    return config.notificationsCachePath;
  }
  return path.join(config?.ROOT || process.cwd(), 'data', CACHE_FILE_NAME);
}

function hasCachedNotification(cached) {
  return Boolean(cached?.payload?.notifications?.items?.length);
}

function loadNotificationsCache(config) {
  try {
    const raw = fs.readFileSync(resolveCachePath(config), 'utf8');
    const parsed = JSON.parse(raw);
    if (hasCachedNotification(parsed)) {
      return parsed;
    }
  } catch {
    // Missing or corrupt cache is fine.
  }
  return null;
}

function saveNotificationsCache(config, payload, log) {
  if (payload?.type !== 'alexa-notifications.query') {
    return false;
  }
  if (!payload?.notifications?.items?.length) {
    return false;
  }
  const cachePath = resolveCachePath(config);
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, `${JSON.stringify({
      savedAt: new Date().toISOString(),
      payload: {
        version: payload.version,
        type: payload.type,
        displaySeconds: payload.displaySeconds,
        notifications: payload.notifications,
        spokenResponse: payload.spokenResponse || null,
        query: payload.query || null,
        themeAccent: payload.themeAccent || '#FF9900',
      },
    }, null, 2)}\n`, 'utf8');
    return true;
  } catch (error) {
    log?.warn?.('Failed to save notifications cache', error?.message || error);
    return false;
  }
}

function buildReplayPayload(cached, { device, trigger, timestamp } = {}) {
  const template = cached?.payload;
  if (!hasCachedNotification(cached)) {
    return null;
  }
  return {
    ...template,
    device: device || template.device || 'Signal',
    timestamp: new Date(timestamp || Date.now()).toISOString(),
    trigger: trigger || 'notifications-push',
  };
}

module.exports = {
  CACHE_FILE_NAME,
  resolveCachePath,
  loadNotificationsCache,
  saveNotificationsCache,
  buildReplayPayload,
  hasCachedNotification,
};
