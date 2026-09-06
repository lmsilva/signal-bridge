// Per-board quiet hours: week grid of active/quiet hours, plus legacy
// {start,end} migration. Painted `1` = ACTIVE; `0` = QUIET. Days are
// Monday-first (0=Mon ... 6=Sun), matching fixedTimes and week-grid.js.

const { dateParts } = require('./clock');

/** Hours 0-6 and 22-23 quiet; 7-21 active (= overnight 22:00-07:00). */
const DEFAULT_QUIET_WEEK_ROW = '000000011111111111111100';

function defaultQuietWeek() {
  return Array.from({ length: 7 }, () => DEFAULT_QUIET_WEEK_ROW);
}

/** "22:00" -> minutes since midnight, or null if unusable. */
function parseHhMm(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function formatHhMm(totalMinutes) {
  const minutes = ((Number(totalMinutes) % (24 * 60)) + (24 * 60)) % (24 * 60);
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** JS / Intl Sunday=0 -> Monday-first index. */
function mondayFirstDay(weekdaySun0) {
  const day = Number(weekdaySun0);
  if (!Number.isFinite(day)) return 0;
  return (day + 6) % 7;
}

function isQuietAtMinutes(minutes, start, end) {
  if (start === null || end === null || start === end) return false;
  return start < end
    ? minutes >= start && minutes < end
    : minutes >= start || minutes < end;
}

/** Build seven identical day strings from a legacy overnight window. */
function weekFromStartEnd(startHhMm, endHhMm) {
  const start = parseHhMm(startHhMm);
  const end = parseHhMm(endHhMm);
  if (start === null || end === null || start === end) {
    return defaultQuietWeek();
  }
  const chars = [];
  for (let hour = 0; hour < 24; hour += 1) {
    chars.push(isQuietAtMinutes(hour * 60, start, end) ? '0' : '1');
  }
  const row = chars.join('');
  return Array.from({ length: 7 }, () => row);
}

function normaliseWeekRow(value, fallback = DEFAULT_QUIET_WEEK_ROW) {
  const raw = String(value || '');
  let out = '';
  for (let i = 0; i < 24; i += 1) {
    const ch = raw[i];
    out += ch === '0' || ch === '1' ? ch : (fallback[i] || '1');
  }
  return out;
}

function normaliseQuietWeek(week, fallbackStart = '22:00', fallbackEnd = '07:00') {
  if (Array.isArray(week) && week.length) {
    const fallback = weekFromStartEnd(fallbackStart, fallbackEnd)[0];
    const rows = [];
    for (let day = 0; day < 7; day += 1) {
      rows.push(normaliseWeekRow(week[day], fallback));
    }
    return rows;
  }
  return weekFromStartEnd(fallbackStart, fallbackEnd);
}

function quietHourChar(quietHours, dayMon0, hour) {
  const week = quietHours?.week;
  if (!Array.isArray(week) || !week.length) return null;
  const row = week[dayMon0];
  if (typeof row !== 'string' || row.length < 24) return null;
  const ch = row[hour];
  return ch === '0' || ch === '1' ? ch : null;
}

function inQuietHoursLegacy(date, quietHours, timeZone) {
  const start = parseHhMm(quietHours.start);
  const end = parseHhMm(quietHours.end);
  if (start === null || end === null || start === end) return false;
  const parts = dateParts(date, timeZone);
  if (!parts) return false;
  const minutes = parts.hour * 60 + parts.minute;
  return isQuietAtMinutes(minutes, start, end);
}

/**
 * Quiet hours are local wall-clock. Prefer `week` strings when present;
 * otherwise fall back to legacy `{start,end}` so old saves still work mid-migration.
 */
function inQuietHours(date, quietHours, timeZone) {
  if (!quietHours || quietHours.enabled === false) return false;
  if (Array.isArray(quietHours.week) && quietHours.week.length) {
    const parts = dateParts(date, timeZone);
    if (!parts) return false;
    const ch = quietHourChar(quietHours, mondayFirstDay(parts.weekday), parts.hour);
    if (ch == null) return inQuietHoursLegacy(date, quietHours, timeZone);
    return ch === '0';
  }
  return inQuietHoursLegacy(date, quietHours, timeZone);
}

function shiftCivilDay(year, month, day, deltaDays) {
  const next = new Date(Date.UTC(year, month - 1, day) + deltaDays * 24 * 60 * 60 * 1000);
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  };
}

/**
 * Walk back to the hour the current quiet run began. Returns null outside quiet.
 * `{ year, month, day, hour, dayMon0, minutesSinceStart }`
 */
function quietRunStart(date, quietHours, timeZone) {
  if (!inQuietHours(date, quietHours, timeZone)) return null;
  const parts = dateParts(date, timeZone);
  if (!parts) return null;

  if (Array.isArray(quietHours.week) && quietHours.week.length) {
    let dayMon0 = mondayFirstDay(parts.weekday);
    let hour = parts.hour;
    let { year, month, day } = parts;
    let hoursBack = 0;
    for (let step = 0; step < 24 * 7; step += 1) {
      let prevHour = hour - 1;
      let prevDayMon0 = dayMon0;
      let prevCal = { year, month, day };
      if (prevHour < 0) {
        prevHour = 23;
        prevDayMon0 = (dayMon0 + 6) % 7;
        prevCal = shiftCivilDay(year, month, day, -1);
      }
      if (quietHourChar(quietHours, prevDayMon0, prevHour) !== '0') {
        return {
          year,
          month,
          day,
          hour,
          dayMon0,
          minutesSinceStart: hoursBack * 60 + parts.minute,
        };
      }
      hour = prevHour;
      dayMon0 = prevDayMon0;
      year = prevCal.year;
      month = prevCal.month;
      day = prevCal.day;
      hoursBack += 1;
    }
    return {
      year: parts.year,
      month: parts.month,
      day: parts.day,
      hour: parts.hour,
      dayMon0: mondayFirstDay(parts.weekday),
      minutesSinceStart: parts.minute,
    };
  }

  const start = parseHhMm(quietHours.start);
  const end = parseHhMm(quietHours.end);
  if (start == null || end == null) return null;
  const minutes = parts.hour * 60 + parts.minute;
  if (start > end && minutes < end) {
    const prev = shiftCivilDay(parts.year, parts.month, parts.day, -1);
    return {
      year: prev.year,
      month: prev.month,
      day: prev.day,
      hour: Math.floor(start / 60),
      dayMon0: (mondayFirstDay(parts.weekday) + 6) % 7,
      minutesSinceStart: (24 * 60 - start) + minutes,
    };
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: Math.floor(start / 60),
    dayMon0: mondayFirstDay(parts.weekday),
    minutesSinceStart: minutes - start,
  };
}

/**
 * Approximate {start,end} HH:mm for the current quiet run (reminder "until" card).
 * Outside quiet, or when unknown, returns null.
 */
function quietWindowEdges(date, quietHours, timeZone) {
  const startInfo = quietRunStart(date, quietHours, timeZone);
  if (!startInfo) {
    if (quietHours?.start || quietHours?.end) {
      return {
        start: quietHours.start || '',
        end: quietHours.end || '',
      };
    }
    return null;
  }

  if (Array.isArray(quietHours.week) && quietHours.week.length) {
    let dayMon0 = startInfo.dayMon0;
    let hour = startInfo.hour;
    for (let step = 0; step < 24 * 7; step += 1) {
      hour += 1;
      if (hour > 23) {
        hour = 0;
        dayMon0 = (dayMon0 + 1) % 7;
      }
      const ch = quietHourChar(quietHours, dayMon0, hour);
      if (ch !== '0') {
        return {
          start: formatHhMm(startInfo.hour * 60),
          end: formatHhMm(hour * 60),
        };
      }
    }
    return {
      start: formatHhMm(startInfo.hour * 60),
      end: formatHhMm(startInfo.hour * 60),
    };
  }

  return {
    start: quietHours.start || formatHhMm(startInfo.hour * 60),
    end: quietHours.end || '',
  };
}

module.exports = {
  DEFAULT_QUIET_WEEK_ROW,
  defaultQuietWeek,
  parseHhMm,
  formatHhMm,
  mondayFirstDay,
  weekFromStartEnd,
  normaliseWeekRow,
  normaliseQuietWeek,
  inQuietHours,
  quietRunStart,
  quietWindowEdges,
};
