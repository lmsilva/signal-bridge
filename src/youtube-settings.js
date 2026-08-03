const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Settings, linked devices and watch history for the YouTube feature.
 *
 * Every read re-checks the file's mtime because the web server and the
 * listener hold separate instances — the same reason `slideshow-settings.js`
 * reloads on read.
 */

const DEFAULT_SETTINGS = {
  showDislikes: true,
  showSubscribers: true,
  showDescription: true,
  descriptionLines: 3,
  showShorts: false,
  confirmSeconds: 5,
  dismissSeconds: 60,
  // §7: when two rooms are playing at once, "most recently started" is the
  // only rule that needs no configuration to be right most of the time.
  multiDevice: 'most-recent',
  preferredDeviceId: null,
  historyLimit: 100,
};

const MULTI_DEVICE_MODES = new Set(['most-recent', 'preferred']);

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, n));
}

function sanitiseSettings(raw = {}, base = DEFAULT_SETTINGS) {
  const merged = { ...base, ...(raw || {}) };
  return {
    showDislikes: merged.showDislikes !== false,
    showSubscribers: merged.showSubscribers !== false,
    showDescription: merged.showDescription !== false,
    descriptionLines: clampInt(merged.descriptionLines, 1, 6, 3),
    showShorts: merged.showShorts === true,
    confirmSeconds: clampInt(merged.confirmSeconds, 0, 60, 5),
    dismissSeconds: clampInt(merged.dismissSeconds, 10, 600, 60),
    multiDevice: MULTI_DEVICE_MODES.has(merged.multiDevice) ? merged.multiDevice : 'most-recent',
    preferredDeviceId: merged.preferredDeviceId ? String(merged.preferredDeviceId) : null,
    historyLimit: clampInt(merged.historyLimit, 10, 1000, 100),
  };
}

const DEVICE_STATUSES = new Set(['linked', 'refreshing', 'needs-relink', 'unreachable']);

function sanitiseDevice(raw = {}, existing = null) {
  return {
    id: String(raw.id || existing?.id || crypto.randomUUID()),
    label: String(raw.label ?? existing?.label ?? 'YouTube device').slice(0, 60).trim() || 'YouTube device',
    screenId: raw.screenId ?? existing?.screenId ?? null,
    screenName: raw.screenName ?? existing?.screenName ?? null,
    screenDeviceName: raw.screenDeviceName ?? existing?.screenDeviceName ?? null,
    // Encrypted before it reaches this function; never logged, never returned.
    authState: raw.authState !== undefined ? raw.authState : (existing?.authState ?? null),
    tokenExpiry: raw.tokenExpiry ?? existing?.tokenExpiry ?? null,
    enabled: raw.enabled !== undefined ? raw.enabled !== false : (existing?.enabled !== false),
    lastSeenAt: raw.lastSeenAt ?? existing?.lastSeenAt ?? null,
    status: DEVICE_STATUSES.has(raw.status) ? raw.status : (existing?.status || 'linked'),
    statusDetail: raw.statusDetail ?? existing?.statusDetail ?? null,
    linkedAt: existing?.linkedAt || raw.linkedAt || new Date().toISOString(),
  };
}

function createJsonFile(filePath, fallback) {
  let cached = null;
  let cachedMtime = 0;

  function read() {
    let mtime = 0;
    try {
      mtime = fs.statSync(filePath).mtimeMs;
    } catch {
      mtime = 0;
    }
    if (cached && mtime === cachedMtime) {
      return cached;
    }
    try {
      cached = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      cached = typeof fallback === 'function' ? fallback() : fallback;
    }
    cachedMtime = mtime;
    return cached;
  }

  function write(value) {
    cached = value;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
      cachedMtime = fs.statSync(filePath).mtimeMs;
    } catch {
      cachedMtime = 0;
    }
    return value;
  }

  return { read, write };
}

function createYoutubeStore({ config, secretBox = null, log = null } = {}) {
  const youtubeConfig = config?.youtube || {};
  const settingsFile = createJsonFile(youtubeConfig.settingsPath, () => ({ ...DEFAULT_SETTINGS }));
  const devicesFile = createJsonFile(youtubeConfig.devicesPath, () => ({ devices: [] }));
  const historyFile = createJsonFile(youtubeConfig.historyPath, () => ({ sessions: [] }));

  function getSettings() {
    return sanitiseSettings(settingsFile.read());
  }

  function updateSettings(patch) {
    const next = sanitiseSettings({ ...getSettings(), ...(patch || {}) });
    settingsFile.write(next);
    return next;
  }

  // ------------------------------------------------------------- devices

  function rawDevices() {
    const data = devicesFile.read();
    return Array.isArray(data?.devices) ? data.devices : [];
  }

  /** Internal view, with the auth state decrypted for the sidecar. */
  function listDevices() {
    return rawDevices().map((device) => ({
      ...device,
      authState: device.authState && secretBox
        ? secretBox.decrypt(device.authState)
        : device.authState,
    }));
  }

  /** What the admin page is allowed to see. Tokens never leave the bridge. */
  function publicDevices() {
    return rawDevices().map(({ authState, ...device }) => ({
      ...device,
      hasToken: Boolean(authState),
    }));
  }

  function getDevice(id) {
    return listDevices().find((device) => device.id === String(id)) || null;
  }

  function saveDevice(patch) {
    const devices = rawDevices();
    const index = devices.findIndex((device) => device.id === String(patch.id));
    const existing = index >= 0 ? devices[index] : null;
    const next = sanitiseDevice(patch, existing);
    if (next.authState && secretBox && !secretBox.isEncrypted(next.authState)) {
      next.authState = secretBox.encrypt(
        typeof next.authState === 'string' ? next.authState : JSON.stringify(next.authState),
      );
    }
    if (index >= 0) {
      devices[index] = next;
    } else {
      devices.push(next);
    }
    devicesFile.write({ devices });
    log?.info?.(`YouTube device ${index >= 0 ? 'updated' : 'linked'}: ${next.label}`);
    return { ...next, authState: undefined };
  }

  function removeDevice(id) {
    const devices = rawDevices();
    const next = devices.filter((device) => device.id !== String(id));
    if (next.length === devices.length) {
      return false;
    }
    devicesFile.write({ devices: next });
    return true;
  }

  function markDeviceStatus(id, status, detail = null) {
    const device = rawDevices().find((entry) => entry.id === String(id));
    if (!device) {
      return null;
    }
    return saveDevice({
      ...device,
      status,
      statusDetail: detail,
      lastSeenAt: status === 'linked' ? new Date().toISOString() : device.lastSeenAt,
    });
  }

  // ------------------------------------------------------------- history

  function history({ limit = 20, deviceId = null } = {}) {
    const sessions = historyFile.read()?.sessions || [];
    return sessions
      .filter((entry) => !deviceId || entry.deviceId === deviceId)
      .slice(0, Math.max(1, limit));
  }

  function recordSession(session) {
    const settings = getSettings();
    const sessions = historyFile.read()?.sessions || [];
    const watchedSeconds = Math.max(0, Math.round(Number(session.watchedSeconds) || 0));
    const positionSeconds = Math.max(0, Math.round(Number(session.positionSeconds) || 0));
    const entry = {
      id: session.id || crypto.randomUUID(),
      videoId: session.videoId,
      deviceId: session.deviceId,
      startedAt: session.startedAt,
      endedAt: session.endedAt || new Date().toISOString(),
      // Keep the pause-aware attention total; fall back to scrubber when Lounge
      // never delivered intermediate ticks (common on Apple TV).
      watchedSeconds: watchedSeconds || positionSeconds,
      // How far into the video the scrubber was — drives "Watched X of Y".
      positionSeconds: positionSeconds || watchedSeconds,
      durationSeconds: Math.max(0, Math.round(Number(session.durationSeconds) || 0)),
      completed: session.completed === true,
    };
    // Newest first: `last-played` is the only reader and always wants the head.
    historyFile.write({ sessions: [entry, ...sessions].slice(0, settings.historyLimit) });
    return entry;
  }

  function lastPlayed(deviceId = null) {
    return history({ limit: 1, deviceId })[0] || null;
  }

  return {
    getSettings,
    updateSettings,
    listDevices,
    publicDevices,
    getDevice,
    saveDevice,
    removeDevice,
    markDeviceStatus,
    history,
    recordSession,
    lastPlayed,
  };
}

module.exports = {
  DEFAULT_SETTINGS,
  MULTI_DEVICE_MODES,
  sanitiseSettings,
  sanitiseDevice,
  createYoutubeStore,
};
