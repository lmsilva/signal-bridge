const SPOKEN_TIME_PATTERNS = [
  /\bit(?:'s|\s+is)\s+(?:(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(a\.?\s*m\.?|p\.?\s*m\.?)?|(\d{1,2})\s+(?:(\d{2})\s+)?(a\.?\s*m\.?|p\.?\s*m\.?))/i,
  /\bthe\s+time\s+is\s+(?:(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(a\.?\s*m\.?|p\.?\s*m\.?)?|(\d{1,2})\s+(?:(\d{2})\s+)?(a\.?\s*m\.?|p\.?\s*m\.?))/i,
];

const DATE_PATTERNS = [
  /\b(?:today\s+is|it's)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday),?\s+([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/i,
  /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday),?\s+([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/i,
];

const MONTHS = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

function parseAmPm(value) {
  const text = String(value || '').toLowerCase().replace(/\./g, '');
  if (text.startsWith('p')) {
    return 'pm';
  }
  if (text.startsWith('a')) {
    return 'am';
  }
  return null;
}

function to24Hour(hour, ampm) {
  let h = hour;
  if (ampm === 'pm' && h < 12) {
    h += 12;
  }
  if (ampm === 'am' && h === 12) {
    h = 0;
  }
  return h;
}

function buildZonedInstant(referenceDate, hour, minute, second, timeZone) {
  const dateParts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(referenceDate);
  const pick = (type) => Number(dateParts.find((part) => part.type === type).value);
  const year = pick('year');
  const month = pick('month');
  const day = pick('day');

  let utcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(new Date(utcMs));
    const ph = Number(parts.find((part) => part.type === 'hour').value);
    const pm = Number(parts.find((part) => part.type === 'minute').value);
    const ps = Number(parts.find((part) => part.type === 'second').value);
    const deltaSec = (hour - ph) * 3600 + (minute - pm) * 60 + (second - ps);
    if (deltaSec === 0) {
      break;
    }
    utcMs += deltaSec * 1000;
  }
  return new Date(utcMs);
}

function parseSpokenTime(text, referenceDate = new Date(), { timeZone } = {}) {
  const source = String(text || '');
  if (!source) {
    return null;
  }

  for (const pattern of SPOKEN_TIME_PATTERNS) {
    const match = source.match(pattern);
    if (!match) {
      continue;
    }

    let hour;
    let minute;
    let second = 0;
    let ampm = parseAmPm(match[4] || match[7]);

    if (match[1] != null) {
      hour = Number(match[1]);
      minute = Number(match[2] || 0);
      second = Number(match[3] || 0);
    } else {
      hour = Number(match[5]);
      minute = Number(match[6] || 0);
    }

    if (Number.isNaN(hour) || Number.isNaN(minute)) {
      continue;
    }

    if (ampm) {
      hour = to24Hour(hour, ampm);
    } else if (hour <= 12 && !source.includes(':') && hour < 13) {
      // Spoken without am/pm — keep as-is; caller may refine with reference clock.
    }

    const date = timeZone
      ? buildZonedInstant(referenceDate, hour, minute, second, timeZone)
      : (() => {
        const local = new Date(referenceDate);
        local.setHours(hour, minute, second, 0);
        return local;
      })();

    return {
      iso: date.toISOString(),
      hour,
      minute,
      second,
      ampm: ampm || (hour >= 12 ? 'pm' : 'am'),
      dateLabel: date.toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      }),
      timeLabel: date.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      }),
    };
  }

  for (const pattern of DATE_PATTERNS) {
    const match = source.match(pattern);
    if (!match) {
      continue;
    }

    const month = MONTHS[match[2].toLowerCase()];
    const day = Number(match[3]);
    const year = Number(match[4]);
    if (month == null || Number.isNaN(day) || Number.isNaN(year)) {
      continue;
    }

    const date = new Date(year, month, day);
    return {
      iso: date.toISOString(),
      hour: referenceDate.getHours(),
      minute: referenceDate.getMinutes(),
      second: referenceDate.getSeconds(),
      dateLabel: date.toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      }),
      timeLabel: null,
      weekday: match[1],
    };
  }

  return null;
}

module.exports = {
  parseSpokenTime,
};
