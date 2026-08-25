// Time and duration wording for the board.
//
// Twenty-two columns and no lowercase means every time value here is the
// shortest form that is still unambiguous: 9:05PM rather than 9:05 PM,
// 23H 57M rather than 23 hours 57 minutes. Nothing here pads with a leading
// zero on the leading unit, because a zero costs a flap and buys nothing.
//
// Instants (ISO timestamps, unix ms, "launched at") print in the household
// IANA zone so a UTC Docker host does not show 10:09PM for a 4:09PM Utah
// afternoon. Omit `timeZone` and the process clock is used, which is what
// the golden fixtures construct with `new Date(y, m, d, h, min)`.
// Calendar dates (`YYYY-MM-DD` via parseYmd) must not pass a timeZone —
// those are already local civil days and converting them slips a day west.

const WEEKDAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Voice/alarm config already names the house; Vestaboard should use the same. */
function houseTimeZone(config = {}) {
  const zone = config.voiceEvents?.localTimeZone
    || config.alarmSync?.localTimeZone
    || 'America/Denver';
  return String(zone || '').trim() || 'America/Denver';
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * A span in seconds, or null when there is no span.
 *
 * `Number(null)` is 0, which would print a confident `0:00` for a timer whose
 * remaining time simply was not reported. Absent and zero are different.
 */
function spanSeconds(value) {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

/** Anything date-shaped to a Date, or null. Never throws, never returns Invalid Date. */
function toDate(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * A calendar date with no time zone slip.
 *
 * `new Date('2026-08-22')` is UTC midnight, which is still the 21st on this
 * side of the country. Beat dates and forecast days are stored as `YYYY-MM-DD`,
 * so they have to be read as local calendar dates or the board names the
 * wrong day.
 */
function parseYmd(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) {
    return toDate(value);
  }
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/**
 * Civil clock parts for an instant.
 *
 * No zone → `Date#getHours` (process local). A named zone goes through
 * `Intl` so DST is correct and a UTC container still prints Utah time.
 */
function dateParts(value, timeZone) {
  const date = toDate(value);
  if (!date) {
    return null;
  }
  if (!timeZone) {
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
      weekday: date.getDay(),
    };
  }
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    }).formatToParts(date);
    const pick = (type) => parts.find((part) => part.type === type)?.value;
    return {
      year: Number(pick('year')),
      month: Number(pick('month')),
      day: Number(pick('day')),
      hour: Number(pick('hour')),
      minute: Number(pick('minute')),
      weekday: WEEKDAY_INDEX[pick('weekday')] ?? date.getDay(),
    };
  } catch {
    return dateParts(date, null);
  }
}

/** `9:05PM`. */
function clockLabel(value, { timeZone } = {}) {
  const parts = dateParts(value, timeZone);
  if (!parts) {
    return '';
  }
  const meridiem = parts.hour >= 12 ? 'PM' : 'AM';
  const hour = parts.hour % 12 || 12;
  const minute = String(parts.minute).padStart(2, '0');
  return `${hour}:${minute}${meridiem}`;
}

/** `SUNDAY`, or `SUN` when short. */
function weekday(value, { short = false, timeZone } = {}) {
  const parts = dateParts(value, timeZone);
  if (!parts) {
    return '';
  }
  const name = WEEKDAYS[parts.weekday];
  return short ? name.slice(0, 3) : name;
}

/** `AUG 23`. */
function shortDate(value, { timeZone } = {}) {
  const parts = dateParts(value, timeZone);
  if (!parts) {
    return '';
  }
  return `${MONTHS[parts.month - 1]} ${parts.day}`;
}

/** `SUNDAY AUG 23` — the clock-face footer. */
function dateLabel(value, { timeZone } = {}) {
  const parts = dateParts(value, timeZone);
  if (!parts) {
    return '';
  }
  return `${weekday(value, { timeZone })} ${shortDate(value, { timeZone })}`;
}

/** Whole days between two instants, by calendar date rather than by elapsed hours. */
function daysBetween(from, to, timeZone) {
  const start = dateParts(from, timeZone);
  const end = dateParts(to, timeZone);
  if (!start || !end) {
    return 0;
  }
  const startUtc = Date.UTC(start.year, start.month - 1, start.day);
  const endUtc = Date.UTC(end.year, end.month - 1, end.day);
  return Math.round((endUtc - startUtc) / (DAY * 1000));
}

/**
 * How to name the day something falls on, relative to now.
 *
 * Inside a week people think in weekday names, not dates, so `THURSDAY` beats
 * `AUG 27`. Past a week the weekday stops being useful and the date takes over.
 */
function dayPhrase(value, now = new Date(), { timeZone } = {}) {
  const date = toDate(value);
  const reference = toDate(now) || new Date();
  if (!date) {
    return '';
  }

  const offset = daysBetween(reference, date, timeZone);
  if (offset === 0) return 'TODAY';
  if (offset === 1) return 'TOMORROW';
  if (offset === -1) return 'YESTERDAY';
  if (offset > 1 && offset < 7) return weekday(date, { timeZone });
  return shortDate(date, { timeZone });
}

/**
 * A running countdown: `12:34`, or `1:22:05` once it passes an hour.
 *
 * Seconds always show, because a timer that stops ticking looks broken.
 */
function countdown(seconds) {
  const total = spanSeconds(seconds);
  if (total === null) {
    return '';
  }
  const whole = Math.round(total);
  const hours = Math.floor(whole / HOUR);
  const minutes = Math.floor((whole % HOUR) / MINUTE);
  const secs = whole % MINUTE;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

/**
 * A span at a glance: `23H 57M`, `57M`, `45S`, `2D 3H`.
 *
 * Two units at most. Anything more is precision nobody reads from across a
 * room, and the third unit is the one that pushes a footer past its 16 columns.
 */
function durationLabel(seconds) {
  const total = spanSeconds(seconds);
  if (total === null) {
    return '';
  }
  const whole = Math.round(total);

  if (whole >= DAY) {
    const days = Math.floor(whole / DAY);
    const hours = Math.floor((whole % DAY) / HOUR);
    return hours ? `${days}D ${hours}H` : `${days}D`;
  }
  if (whole >= HOUR) {
    const hours = Math.floor(whole / HOUR);
    const minutes = Math.floor((whole % HOUR) / MINUTE);
    return minutes ? `${hours}H ${minutes}M` : `${hours}H`;
  }
  if (whole >= MINUTE) {
    return `${Math.floor(whole / MINUTE)}M`;
  }
  return `${whole}S`;
}

/**
 * Which part of the day an hour belongs to, for phrasing a forecast.
 *
 * `TONIGHT` rather than `EVE` because the board has room and the word is
 * what a person would say.
 */
function partOfDay(value, { timeZone } = {}) {
  const parts = dateParts(value, timeZone);
  if (!parts) {
    return '';
  }
  if (parts.hour < 12) return 'AM';
  if (parts.hour < 18) return 'PM';
  return 'TONIGHT';
}

module.exports = {
  WEEKDAYS,
  MONTHS,
  spanSeconds,
  toDate,
  parseYmd,
  dateParts,
  houseTimeZone,
  clockLabel,
  weekday,
  shortDate,
  dateLabel,
  dayPhrase,
  daysBetween,
  countdown,
  durationLabel,
  partOfDay,
};
