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

  const fireAt = triggerMs != null ? new Date(triggerMs).toISOString() : null;

  return {
    amazonId,
    deviceSerialNumber: serial,
    device: deviceNameMap[serial] || notification.deviceName || serial || 'unknown-device',
    label: notification.alarmLabel || notification.reminderLabel || null,
    status: notification.status || 'ON',
    triggerTime: fireAt,
    // diffTimerSnapshots only treats a disappearance as a fire when `fireAt`
    // is set. Alarms used to store the instant on `triggerTime` alone, so a
    // wake alarm that went off was logged as an empty list.
    fireAt,
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

  const priority = ['fired', 'started', 'cancelled'];
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
  const notifyEvents = (events || []).filter((entry) => (
    ['started', 'cancelled', 'fired'].includes(entry.kind)
  ));
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

// A stop a few seconds before the bell is still the bell (clock skew). A
// row that drops any time in the next hour is the alarm ringing out, not a
// cancel — Echo alarms keep ringing, and the "still going off" announcement
// lands well after the scheduled minute. Cancelling earlier stays a cancel.
const FIRE_EARLY_MS = 45 * 1000;
const FIRE_LATE_MS = 60 * 60 * 1000;

function alarmFireAtMs(alarm) {
  const raw = alarm?.fireAt || alarm?.triggerTime;
  const ms = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

function withinAlarmFireWindow(fireAt, now) {
  return fireAt != null && now >= fireAt - FIRE_EARLY_MS && now <= fireAt + FIRE_LATE_MS;
}

function reclassifyAlarmEvents(events, now = Date.now()) {
  return (events || []).map((entry) => {
    if (!entry || !['removed', 'cancelled', 'fired'].includes(entry.kind)) {
      return entry;
    }
    const fireAt = alarmFireAtMs(entry.timer || entry.alarm);
    if (!withinAlarmFireWindow(fireAt, now) || entry.kind === 'fired') {
      return entry;
    }
    return { ...entry, kind: 'fired' };
  });
}

// A daily alarm keeps its id and jumps triggerTime to tomorrow. That is a
// fire of the occurrence that just passed, not a silent edit.
function recurringAlarmFires(previousAlarms, currentAlarms, now = Date.now()) {
  const events = [];
  for (const [amazonId, previous] of Object.entries(previousAlarms || {})) {
    const current = currentAlarms?.[amazonId];
    if (!current) {
      continue;
    }
    const prevAt = alarmFireAtMs(previous);
    const nextAt = alarmFireAtMs(current);
    if (prevAt == null || nextAt == null || nextAt <= prevAt + 60 * 1000) {
      continue;
    }
    if (!withinAlarmFireWindow(prevAt, now)) {
      continue;
    }
    events.push({ kind: 'fired', amazonId, timer: previous });
  }
  return events;
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
  let wakeTimers = new Map();
  let pollInFlight = false;
  let immediatePollRequested = false;

  function persistMirror() {
    saveMirror(mirrorPath, mirror);
  }

  function emitSnapshot({
    trigger, device, event, highlightAmazonId, actor = null, targetId = null,
  }) {
    const alarms = listActiveAlarms(mirror.alarms);
    onSnapshot?.({
      alarms,
      device: device || event?.alarm?.device || null,
      timestamp: Date.now(),
      trigger,
      event,
      highlightAmazonId: highlightAmazonId || pickHighlightAmazonId(alarms, event, trigger),
      ...(actor ? { actor } : {}),
      ...(targetId ? { targetId } : {}),
    });
  }

  function applySnapshot(currentMap, trigger, device, options = {}) {
    const previousAlarms = mirror.alarms;
    const prevActiveCount = listActiveAlarms(previousAlarms).length;

    const events = [
      ...reclassifyAlarmEvents(diffTimerSnapshots(previousAlarms, currentMap, {
        fireVerifySlackMs: settings.fireVerifySlackMs || 90000,
      })),
      ...recurringAlarmFires(previousAlarms, currentMap),
    ];

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
    const hasFired = notifyEvents.some((entry) => entry.kind === 'fired');

    if (!shouldEmit) {
      rescheduleWakeTimers();
      return;
    }

    const hasCancel = notifyEvents.some((entry) => entry.kind === 'cancelled');
    const isExplicitShow = trigger === 'show-alarms';
    if (!activeAlarms.length && !hasFired && !hasCancel && !lostAlarms && !isExplicitShow) {
      rescheduleWakeTimers();
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

    rescheduleWakeTimers();
    emitSnapshot({
      trigger,
      device: mappedEvent?.alarm?.device || device,
      event: mappedEvent,
      highlightAmazonId: pickHighlightAmazonId(activeAlarms, mappedEvent, trigger),
      actor: options.actor || null,
      // Only the display someone asked on. An alarm *firing* is unsolicited and
      // belongs to the whole house, so it carries no target.
      targetId: trigger === 'show-alarms' ? (options.targetId || null) : null,
    });
  }

  function clearWakeTimer(amazonId) {
    const handle = wakeTimers.get(amazonId);
    if (handle) {
      clearTimeout(handle);
      wakeTimers.delete(amazonId);
    }
  }

  function scheduleWakeTimer(alarm) {
    clearWakeTimer(alarm.amazonId);
    if (!isActiveAlarm(alarm) || alarm.remainingSec == null || alarm.remainingSec <= 0) {
      return;
    }
    const delayMs = Math.max(1000, alarm.remainingSec * 1000);
    const handle = setTimeout(() => {
      wakeTimers.delete(alarm.amazonId);
      pollNotifications('fire-verify');
    }, delayMs);
    wakeTimers.set(alarm.amazonId, handle);
  }

  function rescheduleWakeTimers() {
    for (const handle of wakeTimers.values()) {
      clearTimeout(handle);
    }
    wakeTimers.clear();
    for (const alarm of listActiveAlarms(mirror.alarms)) {
      scheduleWakeTimer(alarm);
    }
  }

  function pollNotifications(reason = 'scheduled', device = null, options = {}) {
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
          setTimeout(() => pollNotifications('immediate-retry', device, options), 500);
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

      applySnapshot(currentMap, reason, device, options);

      if (immediatePollRequested) {
        pollNotifications('immediate-followup', device, options);
      }
    });
  }

  function requestImmediatePoll(reason = 'voice-hint', device = null, options = {}) {
    pollNotifications(reason, device, options);
    if (
      reason === 'alarm-set-voice'
      || reason === 'show-alarms'
      || reason === 'alarm-cancel-voice'
    ) {
      for (const delayMs of [1000, 2000, 4000, 8000, 15000]) {
        setTimeout(
          () => pollNotifications(`${reason}-followup-${delayMs}ms`, device, options),
          delayMs,
        );
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

    rescheduleWakeTimers();
    pollNotifications('startup');
    pollTimer = setInterval(() => pollNotifications('scheduled'), settings.pollIntervalMs);
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
  reclassifyAlarmEvents,
  recurringAlarmFires,
  DEFAULTS,
};
