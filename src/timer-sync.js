const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  enabled: true,
  pollIntervalMs: 30 * 1000,
  nearFirePollIntervalMs: 10 * 1000,
  nearFireWindowMs: 2 * 60 * 1000,
  fireVerifySlackMs: 30 * 1000,
  mirrorFile: 'data/timer-mirror.json',
};

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function loadMirror(filePath) {
  if (!fs.existsSync(filePath)) {
    return { timers: {} };
  }

  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return {
      timers: data.timers && typeof data.timers === 'object' ? data.timers : {},
    };
  } catch {
    return { timers: {} };
  }
}

function saveMirror(filePath, mirror) {
  ensureParentDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify({
    timers: mirror.timers,
    savedAt: new Date().toISOString(),
  }, null, 2)}\n`, 'utf8');
}

function toEpochMs(value) {
  if (value == null || value === '') {
    return null;
  }

  const numeric = Number(value);
  if (!Number.isNaN(numeric) && numeric > 0) {
    if (numeric > 1e12) {
      return numeric;
    }
    if (numeric > 1e9) {
      return numeric * 1000;
    }
    return null;
  }

  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }

  return null;
}

function parseDurationSeconds(notification) {
  const originalMs = Number(notification?.originalDurationInMillis);
  if (!Number.isNaN(originalMs) && originalMs > 0) {
    return Math.round(originalMs / 1000);
  }

  const created = toEpochMs(notification?.createdDate);
  const trigger = toEpochMs(notification?.triggerTime);
  if (created != null && trigger != null && trigger > created) {
    return Math.round((trigger - created) / 1000);
  }

  return null;
}

function normalizeRemainingTime(notification, durationSec = null) {
  const remaining = Number(notification?.remainingTime);
  if (Number.isNaN(remaining) || remaining < 0) {
    return null;
  }

  const originalMs = Number(notification?.originalDurationInMillis);
  if (!Number.isNaN(originalMs) && originalMs > 0) {
    if (remaining >= originalMs * 0.75 && remaining <= originalMs * 1.25) {
      return Math.round(remaining / 1000);
    }
    if (remaining > originalMs && remaining > 86400) {
      return Math.round(remaining / 1000);
    }
  }

  if (durationSec != null && durationSec > 0 && remaining > durationSec * 4) {
    return Math.round(remaining / 1000);
  }

  if (remaining > 86400000) {
    return Math.round(remaining / 1000);
  }

  return Math.round(remaining);
}

function parseRemainingSeconds(notification) {
  const trigger = toEpochMs(notification?.triggerTime);
  if (trigger != null) {
    return Math.max(0, Math.round((trigger - Date.now()) / 1000));
  }

  return normalizeRemainingTime(notification, parseDurationSeconds(notification));
}

function decayRemaining(timer) {
  if (timer.remainingSec == null || !timer.updatedAt) {
    return timer.remainingSec;
  }

  const elapsed = Math.max(0, Math.round((Date.now() - Date.parse(timer.updatedAt)) / 1000));
  return Math.max(0, timer.remainingSec - elapsed);
}

function mergeTimerMaps(previousTimers, currentTimers, { preserveMissingMs = 60000 } = {}) {
  const merged = { ...currentTimers };
  const now = Date.now();

  for (const [amazonId, previous] of Object.entries(previousTimers || {})) {
    if (merged[amazonId]) {
      continue;
    }

    if (!isActiveTimer(previous)) {
      continue;
    }

    const expectedFireAt = previous.fireAt ? Date.parse(previous.fireAt) : null;
    if (expectedFireAt != null && now >= expectedFireAt) {
      continue;
    }

    const updatedAt = previous.updatedAt ? Date.parse(previous.updatedAt) : 0;
    if (now - updatedAt > preserveMissingMs) {
      continue;
    }

    const remainingSec = decayRemaining(previous);
    if (remainingSec == null || remainingSec <= 0) {
      continue;
    }

    merged[amazonId] = {
      ...previous,
      remainingSec,
      fireAt: new Date(now + remainingSec * 1000).toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  return merged;
}

const NOTIFY_EVENT_KINDS = new Set([
  'started',
  'cancelled',
  'fired',
  'paused',
  'resumed',
]);

function filterNotifyEvents(events) {
  return (events || []).filter((entry) => NOTIFY_EVENT_KINDS.has(entry.kind));
}

function isUserTimerTrigger(trigger) {
  return trigger === 'show-timers'
    || trigger === 'timer-set-voice'
    || trigger === 'timer-cancel-voice'
    || String(trigger || '').startsWith('show-timers-')
    || String(trigger || '').startsWith('timer-set-voice-')
    || String(trigger || '').startsWith('timer-cancel-voice-');
}

function isCancelTrigger(trigger) {
  return trigger === 'timer-cancel-voice'
    || String(trigger || '').startsWith('timer-cancel-voice-');
}

function shouldEmitSnapshot(events, trigger) {
  if (filterNotifyEvents(events).length > 0) {
    return true;
  }
  return isUserTimerTrigger(trigger);
}

function pickPrimaryTimerEvent(events, trigger) {
  if (isUserTimerTrigger(trigger)) {
    if (isCancelTrigger(trigger)) {
      const cancelled = events.find((entry) => entry.kind === 'cancelled');
      if (cancelled) {
        return cancelled;
      }
    }
    const started = events.find((entry) => entry.kind === 'started');
    if (started) {
      return started;
    }
    return { kind: 'list' };
  }

  const priority = ['fired', 'started', 'cancelled', 'paused', 'resumed'];
  for (const kind of priority) {
    const match = events.find((entry) => entry.kind === kind);
    if (match) {
      return match;
    }
  }

  return { kind: 'list' };
}

function normalizeTimerNotification(notification, deviceNameMap = {}) {
  if (!notification || notification.type !== 'Timer') {
    return null;
  }

  const amazonId = notification.notificationIndex || notification.id;
  if (!amazonId) {
    return null;
  }

  const remainingSec = parseRemainingSeconds(notification);
  const durationSec = parseDurationSeconds(notification);
  const serial = notification.deviceSerialNumber || null;
  const fireAt = remainingSec != null
    ? new Date(Date.now() + remainingSec * 1000).toISOString()
    : null;

  return {
    amazonId,
    deviceSerialNumber: serial,
    device: deviceNameMap[serial] || serial || 'unknown-device',
    label: notification.timerLabel || null,
    status: notification.status || 'ON',
    durationSec,
    remainingSec,
    fireAt,
    updatedAt: new Date().toISOString(),
  };
}

function isActiveTimer(timer) {
  if (!timer || timer.status === 'OFF') {
    return false;
  }
  if (timer.remainingSec == null) {
    return true;
  }
  if (timer.remainingSec > 0) {
    return true;
  }
  return timer.status === 'ON' && Number(timer.durationSec) > 0;
}

function diffTimerSnapshots(previousTimers, currentTimers, { fireVerifySlackMs = 30000 } = {}) {
  const events = [];
  const previousIds = new Set(Object.keys(previousTimers || {}));
  const currentIds = new Set(Object.keys(currentTimers || {}));
  const now = Date.now();

  for (const amazonId of currentIds) {
    const current = currentTimers[amazonId];
    const previous = previousTimers[amazonId];

    if (!previous) {
      events.push({ kind: 'started', amazonId, timer: current });
      continue;
    }

    if (
      previous.remainingSec != null
      && current.remainingSec != null
      && Math.abs(previous.remainingSec - current.remainingSec) > 5
    ) {
      events.push({ kind: 'updated', amazonId, timer: current, previous });
    }

    if (previous.status !== current.status && current.status === 'PAUSED') {
      events.push({ kind: 'paused', amazonId, timer: current });
    }

    if (previous.status === 'PAUSED' && current.status === 'ON') {
      events.push({ kind: 'resumed', amazonId, timer: current });
    }
  }

  for (const amazonId of previousIds) {
    if (currentIds.has(amazonId)) {
      continue;
    }

    const previous = previousTimers[amazonId];
    const expectedFireAt = previous?.fireAt ? Date.parse(previous.fireAt) : null;
    const nearFire = expectedFireAt != null && Math.abs(now - expectedFireAt) <= fireVerifySlackMs;
    const earlyCancel = expectedFireAt != null && now < expectedFireAt - fireVerifySlackMs;

    if (nearFire) {
      events.push({ kind: 'fired', amazonId, timer: previous });
    } else if (earlyCancel) {
      events.push({ kind: 'cancelled', amazonId, timer: previous });
    } else {
      events.push({ kind: 'removed', amazonId, timer: previous });
    }
  }

  return events;
}

function createTimerSync({
  alexa,
  config,
  log,
  onSnapshot,
  getDeviceNameMap = () => ({}),
}) {
  const settings = {
    ...DEFAULTS,
    ...(config.timerSync || {}),
  };

  const mirrorPath = config.timerMirrorPath || path.resolve(
    path.dirname(config.sessionPath),
    settings.mirrorFile || 'timer-mirror.json',
  );

  let mirror = loadMirror(mirrorPath);
  let pollTimer = null;
  let wakeTimers = new Map();
  let pollInFlight = false;
  let immediatePollRequested = false;

  function persistMirror() {
    saveMirror(mirrorPath, mirror);
  }

  function listActiveTimers() {
    return Object.values(mirror.timers)
      .filter(isActiveTimer)
      .sort((a, b) => (a.remainingSec ?? Infinity) - (b.remainingSec ?? Infinity));
  }

  function clearWakeTimer(amazonId) {
    const handle = wakeTimers.get(amazonId);
    if (handle) {
      clearTimeout(handle);
      wakeTimers.delete(amazonId);
    }
  }

  function scheduleWakeTimer(timer) {
    clearWakeTimer(timer.amazonId);
    if (!isActiveTimer(timer) || timer.remainingSec == null) {
      return;
    }

    const delayMs = Math.max(1000, timer.remainingSec * 1000);
    const handle = setTimeout(() => {
      wakeTimers.delete(timer.amazonId);
      pollNotifications('fire-verify');
    }, delayMs);
    wakeTimers.set(timer.amazonId, handle);
  }

  function rescheduleWakeTimers() {
    for (const handle of wakeTimers.values()) {
      clearTimeout(handle);
    }
    wakeTimers.clear();
    for (const timer of listActiveTimers()) {
      scheduleWakeTimer(timer);
    }
  }

  function emitSnapshot({ trigger, device, event }) {
    let timers = listActiveTimers();
    if (event?.kind === 'fired' && event.timer) {
      timers = [{
        ...event.timer,
        remainingSec: 0,
        status: 'OFF',
      }];
    }
    onSnapshot?.({
      timers,
      device: device || event?.timer?.device || device || null,
      timestamp: Date.now(),
      trigger,
      event,
    });
  }

  function applySnapshot(currentMap, trigger, device) {
    const previousTimers = mirror.timers;
    const prevActiveCount = Object.values(previousTimers).filter(isActiveTimer).length;

    const events = diffTimerSnapshots(previousTimers, currentMap, {
      fireVerifySlackMs: settings.fireVerifySlackMs,
    });

    const hasRemoval = events.some(
      (entry) => entry.kind === 'cancelled' || entry.kind === 'removed',
    );
    const mergedMap = hasRemoval || isCancelTrigger(trigger)
      ? { ...currentMap }
      : mergeTimerMaps(previousTimers, currentMap);

    mirror.timers = mergedMap;
    persistMirror();
    rescheduleWakeTimers();

    const notifyEvents = filterNotifyEvents(events);
    const activeTimers = listActiveTimers();
    const gainedTimers = activeTimers.length > prevActiveCount;
    const lostTimers = activeTimers.length < prevActiveCount;
    const shouldEmit = shouldEmitSnapshot(events, trigger) || gainedTimers || lostTimers;

    if (!shouldEmit) {
      return;
    }

    const hasFired = notifyEvents.some((entry) => entry.kind === 'fired');
    const hasCancel = notifyEvents.some((entry) => entry.kind === 'cancelled');

    // "Show my timers" should always answer, even with an empty list (the
    // display renders "No active timers"). Followup polls stay silent when
    // empty to avoid repeated flashes.
    const isExplicitShow = trigger === 'show-timers';
    if (!activeTimers.length && !hasFired && !hasCancel && !lostTimers && !isExplicitShow) {
      return;
    }

    let event = pickPrimaryTimerEvent(notifyEvents.length ? notifyEvents : events, trigger);
    if (gainedTimers && !notifyEvents.some((entry) => entry.kind === 'started')) {
      event = { kind: 'started', timer: activeTimers[activeTimers.length - 1] };
    }

    emitSnapshot({
      trigger,
      device: event.timer?.device || device,
      event,
    });
  }

  function pollNotifications(reason = 'scheduled', device = null) {
    if (!settings.enabled) {
      return;
    }

    if (pollInFlight) {
      immediatePollRequested = true;
      return;
    }

    pollInFlight = true;
    immediatePollRequested = false;

    alexa.getNotifications(false, (err, result) => {
      pollInFlight = false;

      if (err) {
        log.warn(`Timer sync poll failed (${reason})`, err.message || err);
        if (immediatePollRequested) {
          setTimeout(() => pollNotifications('immediate-retry', device), 500);
        }
        return;
      }

      const notifications = result?.notifications || result || [];
      const deviceNameMap = getDeviceNameMap();
      const currentMap = {};

      for (const notification of notifications) {
        const normalized = normalizeTimerNotification(notification, deviceNameMap);
        if (!normalized || !isActiveTimer(normalized)) {
          continue;
        }
        currentMap[normalized.amazonId] = normalized;
      }

      applySnapshot(currentMap, reason, device);

      if (immediatePollRequested) {
        pollNotifications('immediate-followup', device);
      }
    });
  }

  function requestImmediatePoll(reason = 'voice-hint', device = null) {
    pollNotifications(reason, device);
    if (
      reason === 'timer-set-voice'
      || reason === 'show-timers'
      || reason === 'timer-cancel-voice'
    ) {
      for (const delayMs of [1000, 2000, 4000, 8000, 15000]) {
        setTimeout(() => pollNotifications(`${reason}-followup-${delayMs}ms`, device), delayMs);
      }
    }
  }

  function getPollIntervalMs() {
    const active = listActiveTimers();
    const nearFire = active.some((timer) => {
      if (timer.remainingSec == null) {
        return false;
      }
      return timer.remainingSec * 1000 <= settings.nearFireWindowMs;
    });

    return nearFire ? settings.nearFirePollIntervalMs : settings.pollIntervalMs;
  }

  function schedulePollLoop() {
    if (pollTimer) {
      clearInterval(pollTimer);
    }

    if (!settings.enabled) {
      return;
    }

    pollTimer = setInterval(() => {
      pollNotifications('scheduled');
    }, getPollIntervalMs());
  }

  function start() {
    if (!settings.enabled) {
      log.info('Timer sync disabled');
      return;
    }

    log.info('Timer sync enabled', {
      pollIntervalMs: settings.pollIntervalMs,
      mirrorPath,
      activeTimers: listActiveTimers().length,
    });

    rescheduleWakeTimers();
    pollNotifications('startup');
    schedulePollLoop();
  }

  function stop() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    for (const handle of wakeTimers.values()) {
      clearTimeout(handle);
    }
    wakeTimers.clear();
  }

  return {
    start,
    stop,
    pollNotifications,
    requestImmediatePoll,
    listActiveTimers,
    normalizeTimerNotification,
    diffTimerSnapshots,
    getMirrorPath: () => mirrorPath,
  };
}

module.exports = {
  createTimerSync,
  normalizeTimerNotification,
  diffTimerSnapshots,
  parseRemainingSeconds,
  parseDurationSeconds,
  mergeTimerMaps,
  shouldEmitSnapshot,
  pickPrimaryTimerEvent,
  toEpochMs,
  isActiveTimer,
  DEFAULTS,
};
