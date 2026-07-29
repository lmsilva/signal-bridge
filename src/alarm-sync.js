const fs = require('fs');
const path = require('path');
const {
  toEpochMs,
  mergeTimerMaps,
  diffTimerSnapshots,
} = require('./timer-sync');
const {
  zonedLocalToUtcMs,
  resolveAlarmTimeZone,
} = require('./alarm-timezone');

const DEFAULTS = {
  enabled: true,
  pollIntervalMs: 60 * 1000,
  mirrorFile: 'data/alarm-mirror.json',
  localTimeZone: process.env.ALARM_LOCAL_TIMEZONE || 'America/Denver',
};

const ALARM_TYPES = new Set(['Alarm', 'MusicAlarm']);

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function loadMirror(filePath) {
  if (!fs.existsSync(filePath)) {
    return { alarms: {} };
  }

  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return {
      alarms: data.alarms && typeof data.alarms === 'object' ? data.alarms : {},
    };
  } catch {
    return { alarms: {} };
  }
}

function saveMirror(filePath, mirror) {
  ensureParentDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify({
    alarms: mirror.alarms,
    savedAt: new Date().toISOString(),
  }, null, 2)}\n`, 'utf8');
}

function parseAlarmRemainingSecondsFromField(notification) {
  const remaining = Number(notification?.remainingTime);
  if (Number.isNaN(remaining) || remaining <= 0) {
    return null;
  }

  // Amazon alarm remainingTime is usually milliseconds (e.g. 3_600_000 = 1 hour).
  if (remaining > 1000) {
    return Math.round(remaining / 1000);
  }

  return Math.round(remaining);
}

function parseOriginalDateTimeMs(notification, timeZone) {
  const date = notification?.originalDate;
  const time = notification?.originalTime;
  if (!date || !time) {
    return null;
  }

  const parsed = timeZone
    ? zonedLocalToUtcMs(String(date).trim(), time, timeZone)
    : Date.parse(`${String(date).trim()}T${String(time).trim().split('.')[0]}`);
  if (parsed == null || Number.isNaN(parsed)) {
    return null;
  }

  const recurrence = notification?.recurringPattern || notification?.recurrence;
  if (
    notification?.status === 'ON'
    && !recurrence
    && parsed < Date.now() - 60000
  ) {
    return parsed + 24 * 60 * 60 * 1000;
  }

  return parsed;
}

function parseAlarmTriggerMs(notification, timeZone) {
  const fromOriginal = parseOriginalDateTimeMs(notification, timeZone);
  if (fromOriginal != null) {
    return fromOriginal;
  }

  for (const field of [
    'triggerTime',
    'alarmTime',
    'scheduledTime',
    'lastTriggerTimeInUtc',
    'lastOccurrenceTimeInMilli',
  ]) {
    const ms = toEpochMs(notification?.[field]);
    if (ms != null) {
      return ms;
    }
  }

  const remaining = parseAlarmRemainingSecondsFromField(notification);
  if (remaining != null && remaining > 0) {
    return Date.now() + remaining * 1000;
  }

  return null;
}

function parseAlarmRemainingSeconds(notification, timeZone) {
  const trigger = parseAlarmTriggerMs(notification, timeZone);
  if (trigger != null) {
    return Math.max(0, Math.round((trigger - Date.now()) / 1000));
  }

  return parseAlarmRemainingSecondsFromField(notification);
}

function normalizeAlarmNotification(notification, deviceNameMap = {}, options = {}) {
  if (!notification || !ALARM_TYPES.has(notification.type)) {
    return null;
  }

  const amazonId = notification.notificationIndex || notification.id;
  if (!amazonId) {
    return null;
  }

  const timeZone = resolveAlarmTimeZone(notification, options);
  const triggerMs = parseAlarmTriggerMs(notification, timeZone);
  const remainingSec = parseAlarmRemainingSeconds(notification, timeZone);
  const serial = notification.deviceSerialNumber || null;

  return {
    amazonId,
    deviceSerialNumber: serial,
    device: deviceNameMap[serial] || notification.deviceName || serial || 'unknown-device',
    label: notification.alarmLabel || notification.reminderLabel || null,
    status: notification.status || 'ON',
    triggerTime: triggerMs != null ? new Date(triggerMs).toISOString() : null,
    remainingSec,
    recurrence: notification.recurringPattern || notification.recurrence || null,
    alarmType: notification.type === 'MusicAlarm' ? 'music' : 'standard',
    updatedAt: new Date().toISOString(),
  };
}

function isActiveAlarm(alarm) {
  if (!alarm || alarm.status === 'OFF') {
    return false;
  }
  if (alarm.recurrence) {
    return true;
  }
  if (alarm.remainingSec == null) {
    return alarm.status === 'ON';
  }
  return alarm.remainingSec > 0;
}

function isUserAlarmTrigger(trigger) {
  return trigger === 'show-alarms'
    || trigger === 'alarm-set-voice'
    || trigger === 'alarm-cancel-voice'
    || String(trigger || '').startsWith('show-alarms-')
    || String(trigger || '').startsWith('alarm-set-voice-')
    || String(trigger || '').startsWith('alarm-cancel-voice-');
}

function isCancelTrigger(trigger) {
  return trigger === 'alarm-cancel-voice'
    || String(trigger || '').startsWith('alarm-cancel-voice-');
}

function pickPrimaryAlarmEvent(events, trigger) {
  if (isUserAlarmTrigger(trigger)) {
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

  const priority = ['started', 'cancelled'];
  for (const kind of priority) {
    const match = events.find((entry) => entry.kind === kind);
    if (match) {
      return match;
    }
  }

  return { kind: 'list' };
}

function isImmediateUserAlarmTrigger(trigger) {
  // Same rule as timers: followup polls (`show-alarms-followup-…`) must not
  // re-emit an unchanged list and interrupt a later overlay (slideshow, etc.).
  return trigger === 'show-alarms'
    || trigger === 'alarm-set-voice'
    || trigger === 'alarm-cancel-voice';
}

function shouldEmitAlarmSnapshot(events, trigger) {
  const notifyEvents = (events || []).filter((entry) => ['started', 'cancelled'].includes(entry.kind));
  if (notifyEvents.length > 0) {
    return true;
  }
  return isImmediateUserAlarmTrigger(trigger);
}

function listActiveAlarms(alarmMap) {
  return Object.values(alarmMap || {})
    .filter(isActiveAlarm)
    .sort((a, b) => {
      const aTime = a.triggerTime ? Date.parse(a.triggerTime) : Number.MAX_SAFE_INTEGER;
      const bTime = b.triggerTime ? Date.parse(b.triggerTime) : Number.MAX_SAFE_INTEGER;
      if (aTime !== bTime) {
        return aTime - bTime;
      }
      return String(a.device || '').localeCompare(String(b.device || ''));
    });
}

function pickHighlightAmazonId(_activeAlarms, event, trigger) {
  if (event?.kind === 'started' && event.amazonId) {
    return event.amazonId;
  }
  if (trigger === 'alarm-set-voice' && event?.alarm?.amazonId) {
    return event.alarm.amazonId;
  }
  return null;
}

function createAlarmSync({
  alexa,
  config,
  log,
  onSnapshot,
  getDeviceNameMap = () => ({}),
}) {
  const settings = {
    ...DEFAULTS,
    ...(config.alarmSync || {}),
  };

  const mirrorPath = config.alarmMirrorPath || path.resolve(
    path.dirname(config.sessionPath),
    settings.mirrorFile || 'alarm-mirror.json',
  );

  let mirror = loadMirror(mirrorPath);
  let pollTimer = null;
  let pollInFlight = false;
  let immediatePollRequested = false;

  function persistMirror() {
    saveMirror(mirrorPath, mirror);
  }

  function emitSnapshot({ trigger, device, event, highlightAmazonId }) {
    const alarms = listActiveAlarms(mirror.alarms);
    onSnapshot?.({
      alarms,
      device: device || event?.alarm?.device || null,
      timestamp: Date.now(),
      trigger,
      event,
      highlightAmazonId: highlightAmazonId || pickHighlightAmazonId(alarms, event, trigger),
    });
  }

  function applySnapshot(currentMap, trigger, device) {
    const previousAlarms = mirror.alarms;
    const prevActiveCount = listActiveAlarms(previousAlarms).length;

    const events = diffTimerSnapshots(previousAlarms, currentMap, {
      fireVerifySlackMs: settings.fireVerifySlackMs || 30000,
    });

    const hasRemoval = events.some(
      (entry) => entry.kind === 'cancelled' || entry.kind === 'removed',
    );
    const mergedMap = hasRemoval || isCancelTrigger(trigger)
      ? { ...currentMap }
      : mergeTimerMaps(previousAlarms, currentMap);

    mirror.alarms = mergedMap;
    persistMirror();

    const notifyEvents = events.filter((entry) => ['started', 'cancelled', 'fired', 'paused', 'resumed'].includes(entry.kind));
    const activeAlarms = listActiveAlarms(mergedMap);
    const gainedAlarms = activeAlarms.length > prevActiveCount;
    const lostAlarms = activeAlarms.length < prevActiveCount;
    const shouldEmit = shouldEmitAlarmSnapshot(events, trigger) || gainedAlarms || lostAlarms;

    if (!shouldEmit) {
      return;
    }

    const hasCancel = notifyEvents.some((entry) => entry.kind === 'cancelled');
    const isExplicitShow = trigger === 'show-alarms';
    if (!activeAlarms.length && !hasCancel && !lostAlarms && !isExplicitShow) {
      return;
    }

    let event = pickPrimaryAlarmEvent(notifyEvents.length ? notifyEvents : events, trigger);
    if (gainedAlarms && !notifyEvents.some((entry) => entry.kind === 'started')) {
      const started = events.find((entry) => entry.kind === 'started');
      if (started) {
        event = started;
      }
    }

    const mappedEvent = event?.timer
      ? { ...event, alarm: event.timer }
      : event;

    emitSnapshot({
      trigger,
      device: mappedEvent?.alarm?.device || device,
      event: mappedEvent,
      highlightAmazonId: pickHighlightAmazonId(activeAlarms, mappedEvent, trigger),
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
        log.warn(`Alarm sync poll failed (${reason})`, err.message || err);
        if (immediatePollRequested) {
          setTimeout(() => pollNotifications('immediate-retry', device), 500);
        }
        return;
      }

      const notifications = result?.notifications || result || [];
      const deviceNameMap = getDeviceNameMap();
      const currentMap = {};

      for (const notification of notifications) {
        const normalized = normalizeAlarmNotification(notification, deviceNameMap, {
          localTimeZone: settings.localTimeZone,
        });
        if (!normalized || !isActiveAlarm(normalized)) {
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
      reason === 'alarm-set-voice'
      || reason === 'show-alarms'
      || reason === 'alarm-cancel-voice'
    ) {
      for (const delayMs of [1000, 2000, 4000, 8000, 15000]) {
        setTimeout(() => pollNotifications(`${reason}-followup-${delayMs}ms`, device), delayMs);
      }
    }
  }

  function start() {
    if (!settings.enabled) {
      log.info('Alarm sync disabled');
      return;
    }

    log.info('Alarm sync enabled', {
      pollIntervalMs: settings.pollIntervalMs,
      mirrorPath,
      activeAlarms: listActiveAlarms(mirror.alarms).length,
    });

    pollNotifications('startup');
    pollTimer = setInterval(() => pollNotifications('scheduled'), settings.pollIntervalMs);
  }

  function stop() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  return {
    start,
    stop,
    pollNotifications,
    requestImmediatePoll,
    listActiveAlarms: () => listActiveAlarms(mirror.alarms),
    normalizeAlarmNotification,
    getMirrorPath: () => mirrorPath,
  };
}

module.exports = {
  createAlarmSync,
  normalizeAlarmNotification,
  parseAlarmTriggerMs,
  parseOriginalDateTimeMs,
  isActiveAlarm,
  listActiveAlarms,
  shouldEmitAlarmSnapshot,
  DEFAULTS,
};
