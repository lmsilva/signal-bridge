const fs = require('fs');
const path = require('path');
const {
  mergeTimerMaps,
  diffTimerSnapshots,
} = require('./timer-sync');
const {
  parseAlarmTriggerMs,
  isActiveAlarm,
} = require('./alarm-sync');
const { resolveAlarmTimeZone } = require('./alarm-timezone');

const DEFAULTS = {
  enabled: true,
  pollIntervalMs: 30 * 1000,
  nearFirePollIntervalMs: 10 * 1000,
  nearFireWindowMs: 2 * 60 * 1000,
  fireVerifySlackMs: 30 * 1000,
  mirrorFile: 'data/reminder-mirror.json',
  localTimeZone: process.env.ALARM_LOCAL_TIMEZONE || 'America/Denver',
};

const VOICE_HINT_FOLLOWUP_DELAYS_MS = [1000, 2000, 4000, 8000, 12000, 18000, 25000];

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function loadMirror(filePath) {
  if (!fs.existsSync(filePath)) {
    return { reminders: {} };
  }

  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return {
      reminders: data.reminders && typeof data.reminders === 'object' ? data.reminders : {},
    };
  } catch {
    return { reminders: {} };
  }
}

function saveMirror(filePath, mirror) {
  ensureParentDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify({
    reminders: mirror.reminders,
    savedAt: new Date().toISOString(),
  }, null, 2)}\n`, 'utf8');
}

function isActiveReminder(reminder) {
  return isActiveAlarm(reminder);
}

function normalizeReminderNotification(notification, deviceNameMap = {}, options = {}) {
  if (!notification || notification.type !== 'Reminder') {
    return null;
  }

  const amazonId = notification.notificationIndex || notification.id;
  if (!amazonId) {
    return null;
  }

  const timeZone = resolveAlarmTimeZone(notification, options);
  const triggerMs = parseAlarmTriggerMs(notification, timeZone);
  const remainingSec = triggerMs != null
    ? Math.max(0, Math.round((triggerMs - Date.now()) / 1000))
    : null;
  const serial = notification.deviceSerialNumber || null;
  const fireAt = triggerMs != null
    ? new Date(triggerMs).toISOString()
    : (remainingSec != null ? new Date(Date.now() + remainingSec * 1000).toISOString() : null);

  return {
    amazonId,
    deviceSerialNumber: serial,
    device: deviceNameMap[serial] || notification.deviceName || serial || 'unknown-device',
    label: notification.reminderLabel || notification.alarmLabel || null,
    status: notification.status || 'ON',
    triggerTime: fireAt,
    fireAt,
    remainingSec,
    recurrence: notification.recurringPattern || notification.recurrence || null,
    updatedAt: new Date().toISOString(),
  };
}

function listActiveReminders(reminderMap) {
  return Object.values(reminderMap || {})
    .filter(isActiveReminder)
    .sort((a, b) => (a.remainingSec ?? Infinity) - (b.remainingSec ?? Infinity));
}

function createReminderSync({
  alexa,
  config,
  log,
  onFired,
  getDeviceNameMap = () => ({}),
}) {
  const settings = {
    ...DEFAULTS,
    ...(config.reminderSync || {}),
    ...(config.alarmSync?.localTimeZone ? { localTimeZone: config.alarmSync.localTimeZone } : {}),
  };

  const mirrorPath = config.reminderMirrorPath || path.resolve(
    path.dirname(config.sessionPath),
    settings.mirrorFile || 'reminder-mirror.json',
  );

  let mirror = loadMirror(mirrorPath);
  let pollTimer = null;
  let wakeTimers = new Map();
  let pollInFlight = false;
  let immediatePollRequested = false;

  function persistMirror() {
    saveMirror(mirrorPath, mirror);
  }

  function listActive() {
    return listActiveReminders(mirror.reminders);
  }

  function scheduleWake(reminder) {
    if (!isActiveReminder(reminder) || reminder.remainingSec == null) {
      return;
    }

    const delayMs = Math.max(1000, reminder.remainingSec * 1000);
    const handle = setTimeout(() => {
      wakeTimers.delete(reminder.amazonId);
      pollNotifications('fire-verify');
    }, delayMs);
    wakeTimers.set(reminder.amazonId, handle);
  }

  function rescheduleWakeTimers() {
    for (const handle of wakeTimers.values()) {
      clearTimeout(handle);
    }
    wakeTimers.clear();
    for (const reminder of listActive()) {
      scheduleWake(reminder);
    }
  }

  function emitFired({ trigger, device, event }) {
    const reminder = event?.reminder || event?.timer || null;
    onFired?.({
      reminder,
      device: device || reminder?.device || null,
      timestamp: Date.now(),
      trigger,
      event: reminder ? { kind: 'fired', reminder } : { kind: 'fired' },
    });
  }

  function applySnapshot(currentMap, trigger, device) {
    const previousReminders = mirror.reminders;

    const events = diffTimerSnapshots(previousReminders, currentMap, {
      fireVerifySlackMs: settings.fireVerifySlackMs,
    });

    const hasRemoval = events.some(
      (entry) => entry.kind === 'cancelled' || entry.kind === 'removed',
    );
    const mergedMap = hasRemoval
      ? { ...currentMap }
      : mergeTimerMaps(previousReminders, currentMap);

    mirror.reminders = mergedMap;
    persistMirror();
    rescheduleWakeTimers();

    const fired = events.find((entry) => entry.kind === 'fired');
    if (!fired) {
      return;
    }

    emitFired({
      trigger,
      device: fired.timer?.device || device,
      event: { kind: 'fired', reminder: fired.timer, amazonId: fired.amazonId },
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
        log.warn(`Reminder sync poll failed (${reason})`, err.message || err);
        if (immediatePollRequested) {
          setTimeout(() => pollNotifications('immediate-retry', device), 500);
        }
        return;
      }

      const notifications = result?.notifications || result || [];
      const deviceNameMap = getDeviceNameMap();
      const currentMap = {};
      const tzOptions = { localTimeZone: settings.localTimeZone };

      for (const notification of notifications) {
        const normalized = normalizeReminderNotification(notification, deviceNameMap, tzOptions);
        if (!normalized || !isActiveReminder(normalized)) {
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
      reason === 'reminder-set-voice'
      || reason === 'reminder-cancel-voice'
      || reason === 'reminder-fire-voice'
      || reason === 'notification-change'
    ) {
      for (const delayMs of VOICE_HINT_FOLLOWUP_DELAYS_MS) {
        setTimeout(() => pollNotifications(`${reason}-followup-${delayMs}ms`, device), delayMs);
      }
    }
  }

  function getPollIntervalMs() {
    const nearFire = listActive().some((reminder) => {
      if (reminder.remainingSec == null) {
        return false;
      }
      return reminder.remainingSec * 1000 <= settings.nearFireWindowMs;
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
      log.info('Reminder sync disabled');
      return;
    }

    log.info('Reminder sync enabled', {
      pollIntervalMs: settings.pollIntervalMs,
      mirrorPath,
      activeReminders: listActive().length,
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
    listActiveReminders: listActive,
    normalizeReminderNotification,
    getMirrorPath: () => mirrorPath,
  };
}

module.exports = {
  createReminderSync,
  normalizeReminderNotification,
  isActiveReminder,
  listActiveReminders,
  DEFAULTS,
};
