function pickIntlPart(parts, type) {
  const entry = parts.find((part) => part.type === type);
  return entry ? Number(entry.value) : 0;
}

function zonedLocalToUtcMs(date, time, timeZone) {
  if (!date || !time || !timeZone) {
    return null;
  }

  const timePart = String(time).trim().split('.')[0];
  const match = `${String(date).trim()}T${timePart}`.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/,
  );
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] || 0);

  const asUtcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(asUtcGuess));

  const shownAsUtc = Date.UTC(
    pickIntlPart(parts, 'year'),
    pickIntlPart(parts, 'month') - 1,
    pickIntlPart(parts, 'day'),
    pickIntlPart(parts, 'hour'),
    pickIntlPart(parts, 'minute'),
    pickIntlPart(parts, 'second'),
  );
  const offset = shownAsUtc - asUtcGuess;
  return asUtcGuess - offset;
}

function resolveAlarmTimeZone(notification, settings = {}) {
  const fromNotification = notification?.timeZoneId;
  if (typeof fromNotification === 'string' && fromNotification.includes('/')) {
    return fromNotification;
  }

  if (settings.localTimeZone) {
    return settings.localTimeZone;
  }

  if (process.env.ALARM_LOCAL_TIMEZONE) {
    return process.env.ALARM_LOCAL_TIMEZONE;
  }

  return 'America/Denver';
}

module.exports = {
  zonedLocalToUtcMs,
  resolveAlarmTimeZone,
};
