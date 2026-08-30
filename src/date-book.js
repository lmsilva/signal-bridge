/**
 * Date Book — the house list of dates worth counting down to.
 *
 * An event is either a one-off (`2026-11-27`, gone once it passes) or a
 * yearly recurrence (an anniversary, which rolls to next year the moment it
 * is behind us). Everything here is civil-date arithmetic in the house
 * timezone: a countdown that slips a day because the container runs UTC is
 * the whole bug class this module exists to avoid.
 *
 * No network, no board formatting — `red-letter.js` turns a picked event
 * into flaps.
 */

const fs = require('fs');
const path = require('path');
const { dateParts, houseTimeZone } = require('./vestaboard/clock');

const MAX_EVENTS = 200;
const MAX_NAME = 60;
const MAX_MESSAGE = 240;

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parseYmdParts(value) {
  const match = YMD.exec(String(value || '').trim());
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return null;
  }
  return { year, month, day };
}

function toYmd({ year, month, day }) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * The UTC instant of local midnight on a civil date.
 *
 * `Date.UTC` gives the wall time as if it were UTC; one correction pass
 * subtracts the zone offset and a second settles the DST edge cases where
 * that offset differs either side of midnight.
 */
function zonedMidnightMs(year, month, day, timeZone) {
  const target = Date.UTC(year, month - 1, day, 0, 0, 0);
  if (!timeZone) {
    return new Date(year, month - 1, day, 0, 0, 0).getTime();
  }
  let ts = target;
  for (let pass = 0; pass < 2; pass += 1) {
    const parts = dateParts(ts, timeZone);
    if (!parts) {
      return target;
    }
    const seen = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    const drift = seen - target;
    if (drift === 0) {
      break;
    }
    ts -= drift;
  }
  return ts;
}

function todayParts(asOf, timeZone) {
  return dateParts(asOf instanceof Date ? asOf : new Date(asOf || Date.now()), timeZone || null)
    || dateParts(new Date(), null);
}

// ------------------------------------------------------------------ events

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function makeId(name, date, taken = new Set()) {
  const stem = `${slugify(name) || 'event'}-${String(date || '').replace(/-/g, '').slice(4) || '0000'}`;
  if (!taken.has(stem)) {
    return stem;
  }
  for (let n = 2; n < 500; n += 1) {
    const candidate = `${stem}-${n}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
  return `${stem}-${Date.now()}`;
}

function clean(text, max) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Coerce one row. Returns null when there is no usable date or name, so a
 * half-filled admin form can never persist an event the board cannot draw.
 */
function sanitiseEvent(raw = {}, { taken = new Set(), existing = null } = {}) {
  const name = clean(raw.name ?? existing?.name, MAX_NAME);
  const parts = parseYmdParts(raw.date ?? existing?.date);
  if (!name || !parts) {
    return null;
  }
  const date = toYmd(parts);
  const id = clean(raw.id ?? existing?.id, 80) || makeId(name, date, taken);
  return {
    id,
    name,
    message: clean(raw.message ?? existing?.message, MAX_MESSAGE),
    date,
    recurring: (raw.recurring ?? existing?.recurring) === true,
    enabled: (raw.enabled ?? existing?.enabled) !== false,
    layout: sanitiseLayoutRef(raw.layout !== undefined ? raw.layout : existing?.layout),
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Layouts are validated in `red-letter.js`; here we only keep the shape so a
 * malformed blob cannot crash the store on load.
 */
function sanitiseLayoutRef(layout) {
  if (!layout || !Array.isArray(layout.cells)) {
    return null;
  }
  return { cells: layout.cells.map((row) => (Array.isArray(row) ? row.map(Number) : [])) };
}

function sanitiseEvents(list) {
  const taken = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const event = sanitiseEvent(raw, { taken });
    if (!event || out.length >= MAX_EVENTS) {
      continue;
    }
    if (taken.has(event.id)) {
      event.id = makeId(event.name, event.date, taken);
    }
    taken.add(event.id);
    out.push(event);
  }
  return out;
}

// -------------------------------------------------------------- occurrence

/**
 * When this event next lands, and how far off that is.
 *
 * A recurring Feb 29 falls back to Feb 28 in a common year rather than
 * skipping three years out of four. A one-off whose date has passed reports
 * `expired` and drops out of every selection.
 */
function nextOccurrence(event = {}, { asOf = new Date(), timeZone = null } = {}) {
  const parts = parseYmdParts(event.date);
  const today = todayParts(asOf, timeZone);
  if (!parts || !today) {
    return null;
  }
  const nowMs = (asOf instanceof Date ? asOf : new Date(asOf)).getTime();
  const todayMs = zonedMidnightMs(today.year, today.month, today.day, timeZone);

  let occurrence = parts;
  if (event.recurring) {
    const dayIn = (year) => Math.min(parts.day, daysInMonth(year, parts.month));
    const thisYear = { year: today.year, month: parts.month, day: dayIn(today.year) };
    const passed = zonedMidnightMs(thisYear.year, thisYear.month, thisYear.day, timeZone) < todayMs;
    occurrence = passed
      ? { year: today.year + 1, month: parts.month, day: dayIn(today.year + 1) }
      : thisYear;
  }

  const at = zonedMidnightMs(occurrence.year, occurrence.month, occurrence.day, timeZone);
  const daysAway = Math.round((at - todayMs) / DAY_MS);
  const remainingMs = Math.max(0, at - nowMs);
  return {
    date: toYmd(occurrence),
    year: occurrence.year,
    month: occurrence.month,
    day: occurrence.day,
    at,
    daysAway,
    isToday: daysAway === 0,
    expired: !event.recurring && daysAway < 0,
    remainingMs,
    days: Math.floor(remainingMs / DAY_MS),
    hours: Math.floor((remainingMs % DAY_MS) / HOUR_MS),
    minutes: Math.floor((remainingMs % HOUR_MS) / MINUTE_MS),
    // A leap-day anniversary observed on the 28th is worth saying out loud.
    observed: event.recurring && occurrence.day !== parts.day,
  };
}

/** Enabled, not expired, soonest first. Same-day ties keep list order. */
function upcomingEvents(events = [], options = {}) {
  return events
    .filter((event) => event?.enabled !== false)
    .map((event, index) => ({ event, index, next: nextOccurrence(event, options) }))
    .filter((row) => row.next && !row.next.expired)
    .sort((a, b) => (a.next.at - b.next.at) || (a.index - b.index))
    .map((row) => ({ ...row.event, next: row.next }));
}

/**
 * Which event to put on the board. `random` never repeats what is already
 * happening today — a day-of card outranks a countdown, always.
 */
function pickEvent(events = [], {
  mode = 'next',
  random = Math.random,
  ...options
} = {}) {
  const upcoming = upcomingEvents(events, options);
  if (!upcoming.length) {
    return null;
  }
  const today = upcoming.filter((event) => event.next.isToday);
  if (today.length) {
    return mode === 'random'
      ? today[Math.min(today.length - 1, Math.floor(random() * today.length))]
      : today[0];
  }
  if (mode !== 'random') {
    return upcoming[0];
  }
  return upcoming[Math.min(upcoming.length - 1, Math.floor(random() * upcoming.length))];
}

// ------------------------------------------------------------------- store

function createDateBook(config = {}, log = console) {
  const filePath = config.dateBookPath
    || path.resolve(config.ROOT || path.resolve(__dirname, '..'), 'data', 'date-book.json');
  let events = [];

  function load() {
    try {
      if (!fs.existsSync(filePath)) {
        events = [];
        return events;
      }
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      events = sanitiseEvents(Array.isArray(raw) ? raw : raw?.events);
    } catch (error) {
      log?.warn?.('Could not read the Date Book', error?.message || error);
      events = [];
    }
    return events;
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, `${JSON.stringify({ events }, null, 2)}\n`, 'utf8');
    } catch (error) {
      log?.warn?.('Could not save the Date Book', error?.message || error);
    }
  }

  function ids() {
    return new Set(events.map((event) => event.id));
  }

  load();

  return {
    path: filePath,
    reload: load,
    list: () => events.map((event) => ({ ...event })),
    get: (id) => {
      const found = events.find((event) => event.id === id);
      return found ? { ...found } : null;
    },
    add(raw = {}) {
      if (events.length >= MAX_EVENTS) {
        throw new Error(`The Date Book holds at most ${MAX_EVENTS} events`);
      }
      const taken = ids();
      const event = sanitiseEvent({ ...raw, id: '' }, { taken });
      if (!event) {
        throw new Error('An event needs a name and a YYYY-MM-DD date');
      }
      events.push(event);
      save();
      return { ...event };
    },
    update(id, patch = {}) {
      const index = events.findIndex((event) => event.id === id);
      if (index < 0) {
        throw new Error('Unknown event');
      }
      const next = sanitiseEvent({ ...patch, id }, { existing: events[index] });
      if (!next) {
        throw new Error('An event needs a name and a YYYY-MM-DD date');
      }
      events[index] = next;
      save();
      return { ...next };
    },
    remove(id) {
      const before = events.length;
      events = events.filter((event) => event.id !== id);
      if (events.length === before) {
        return false;
      }
      save();
      return true;
    },
    replaceAll(list) {
      events = sanitiseEvents(list);
      save();
      return this.list();
    },
    /** Every event in list order, each with its next occurrence attached. */
    withNext(options = {}) {
      const timeZone = houseTimeZone(config || {});
      return events.map((event) => ({
        ...event,
        next: nextOccurrence(event, { timeZone, ...options }),
      }));
    },
    upcoming(options = {}) {
      return upcomingEvents(events, {
        timeZone: houseTimeZone(config || {}),
        ...options,
      });
    },
    pick(options = {}) {
      return pickEvent(events, {
        timeZone: houseTimeZone(config || {}),
        ...options,
      });
    },
  };
}

module.exports = {
  MAX_EVENTS,
  MAX_NAME,
  MAX_MESSAGE,
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  isLeapYear,
  daysInMonth,
  parseYmdParts,
  toYmd,
  zonedMidnightMs,
  slugify,
  makeId,
  sanitiseEvent,
  sanitiseEvents,
  nextOccurrence,
  upcomingEvents,
  pickEvent,
  createDateBook,
};
