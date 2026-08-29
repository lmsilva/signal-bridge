/**
 * On This Day in History — pick a shipped (or house-edited) event for today.
 *
 * Corpus is local JSON from the Wikimedia On this day feed. No network and no
 * API keys at runtime. “Today” uses the house timezone from locale settings.
 */

const crypto = require('crypto');
const SHIPPED = require('./on-this-day-events.json');
const {
  cleanText,
  cleanYear,
  cleanMonth,
  cleanDay,
  createOnThisDaySettings,
} = require('./on-this-day-settings');
const { fold, wrap } = require('./vestaboard/encoder');

const TYPE = 'history.day';
const BODY_ROWS = 4;
const BODY_WIDTH = 22;
const MONTH_ABBR = [
  '', 'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
  'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC',
];

function loadShipped() {
  return Array.isArray(SHIPPED?.events) ? SHIPPED.events : [];
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function eventRows(text) {
  const folded = fold(cleanText(text));
  if (!folded) {
    return [];
  }
  return wrap(folded, BODY_WIDTH);
}

function fitsBoard(text) {
  const lines = eventRows(text);
  return lines.length > 0 && lines.length <= BODY_ROWS;
}

function formatYear(year) {
  const n = Number(year);
  if (!Number.isFinite(n) || n === 0) {
    return '';
  }
  if (n < 0) {
    return `${Math.abs(Math.round(n))} BC`;
  }
  return String(Math.round(n));
}

function formatDateLine(month, day, year) {
  const mon = MONTH_ABBR[month] || '';
  const y = formatYear(year);
  if (!mon || !day || !y) {
    return '';
  }
  const line = `${mon} ${Number(day)}, ${y}`;
  return fold(line).slice(0, BODY_WIDTH);
}

function newCustomId(month, day) {
  return `custom-${pad2(month)}-${pad2(day)}-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`;
}

function withinYearRange(year, settings = {}) {
  const min = settings.minYear != null ? Number(settings.minYear) : null;
  const max = settings.maxYear != null ? Number(settings.maxYear) : null;
  if (Number.isFinite(min) && year < min) {
    return false;
  }
  if (Number.isFinite(max) && year > max) {
    return false;
  }
  return true;
}

function resolveEvents(settings = {}) {
  const hidden = new Set(settings.hiddenIds || []);
  const overrides = settings.overrides || {};
  const rows = [];

  for (const event of loadShipped()) {
    const id = String(event.id || '').trim();
    const month = cleanMonth(event.month);
    const day = cleanDay(event.day, month || 1);
    if (!id || !month || !day) {
      continue;
    }
    const patch = overrides[id] || {};
    const text = cleanText(patch.text != null ? patch.text : event.text);
    const year = cleanYear(patch.year != null ? patch.year : event.year);
    if (year == null) {
      continue;
    }
    rows.push({
      id,
      month,
      day,
      year,
      text,
      custom: false,
      hidden: hidden.has(id),
      rows: eventRows(text).length,
      source: event.source || 'shipped',
    });
  }

  for (const event of settings.custom || []) {
    const id = String(event.id || '').trim();
    const month = cleanMonth(event.month);
    const day = cleanDay(event.day, month || 1);
    const year = cleanYear(event.year);
    const text = cleanText(event.text);
    if (!id || !month || !day || year == null || !text) {
      continue;
    }
    rows.push({
      id,
      month,
      day,
      year,
      text,
      custom: true,
      hidden: false,
      rows: eventRows(text).length,
      source: 'custom',
    });
  }

  return rows;
}

function matchingEvents(settings = {}, { month, day } = {}) {
  const m = cleanMonth(month);
  const d = cleanDay(day, m || 1);
  return resolveEvents(settings).filter((event) => (
    !event.hidden
    && event.text
    && event.rows > 0
    && event.rows <= BODY_ROWS
    && withinYearRange(event.year, settings)
    && (m == null || event.month === m)
    && (d == null || event.day === d)
  ));
}

function pickEvent(settings = {}, { month, day, random = Math.random } = {}) {
  const pool = matchingEvents(settings, { month, day });
  if (!pool.length) {
    return null;
  }
  const recent = new Set(settings.recentIds || []);
  const fresh = pool.filter((event) => !recent.has(event.id));
  const choices = fresh.length ? fresh : pool;
  const index = Math.min(choices.length - 1, Math.floor(Number(random()) * choices.length));
  return choices[Math.max(0, index)] || null;
}

function buildOnThisDayPayload(event, { asOf } = {}) {
  const text = cleanText(event?.text);
  const month = cleanMonth(event?.month);
  const day = cleanDay(event?.day, month || 1);
  const year = cleanYear(event?.year);
  if (!text || !month || !day || year == null) {
    return null;
  }
  return {
    type: TYPE,
    asOf: asOf || new Date().toISOString(),
    event: {
      id: event.id || '',
      month,
      day,
      year,
      text,
      dateLine: formatDateLine(month, day, year),
      yearLabel: formatYear(year),
    },
  };
}

function listEvents(settings = {}, {
  query = '',
  hidden = false,
  page = 1,
  pageSize = 20,
  month,
  day,
} = {}) {
  const needle = String(query || '').trim().toLowerCase();
  const m = cleanMonth(month);
  const d = cleanDay(day, m || 1);
  let rows = resolveEvents(settings);
  if (!hidden) {
    rows = rows.filter((event) => !event.hidden);
  }
  if (m != null) {
    rows = rows.filter((event) => event.month === m);
  }
  if (d != null) {
    rows = rows.filter((event) => event.day === d);
  }
  if (needle) {
    rows = rows.filter((event) => event.text.toLowerCase().includes(needle)
      || String(event.year).includes(needle)
      || formatYear(event.year).toLowerCase().includes(needle)
      || event.id.toLowerCase().includes(needle)
      || `${MONTH_ABBR[event.month]} ${event.day}`.toLowerCase().includes(needle));
  }
  const size = Math.min(50, Math.max(5, Number(pageSize) || 20));
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(pages, Math.max(1, Number(page) || 1));
  const start = (current - 1) * size;
  return {
    query: needle,
    page: current,
    pageSize: size,
    pages,
    total,
    month: m,
    day: d,
    events: rows.slice(start, start + size),
  };
}

function partsInTimeZone(date, timeZone) {
  const tz = String(timeZone || 'America/Denver').trim() || 'America/Denver';
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      month: 'numeric',
      day: 'numeric',
    }).formatToParts(date);
    const month = Number(parts.find((p) => p.type === 'month')?.value);
    const day = Number(parts.find((p) => p.type === 'day')?.value);
    if (cleanMonth(month) && cleanDay(day, month)) {
      return { month, day, timeZone: tz };
    }
  } catch {
    // fall through
  }
  return {
    month: date.getMonth() + 1,
    day: date.getDate(),
    timeZone: tz,
  };
}

function createOnThisDay(config, log, { getLocaleSettings } = {}) {
  const settingsApi = createOnThisDaySettings(config, log);

  function todayParts(asOf = new Date()) {
    const locale = typeof getLocaleSettings === 'function' ? getLocaleSettings() : null;
    return partsInTimeZone(asOf instanceof Date ? asOf : new Date(asOf), locale?.timeZone);
  }

  function snapshot(extra = {}) {
    const settings = settingsApi.get();
    const today = todayParts();
    const all = resolveEvents(settings);
    const boardReady = all.filter((event) => (
      !event.hidden
      && event.text
      && event.rows > 0
      && event.rows <= BODY_ROWS
      && withinYearRange(event.year, settings)
    ));
    const todayReady = boardReady.filter((event) => (
      event.month === today.month && event.day === today.day
    ));
    return {
      available: todayReady.length,
      todayAvailable: todayReady.length,
      totalAvailable: boardReady.length,
      total: loadShipped().length + settings.custom.length,
      customCount: settings.custom.length,
      hiddenCount: settings.hiddenIds.length,
      minYear: settings.minYear,
      maxYear: settings.maxYear,
      today: {
        month: today.month,
        day: today.day,
        label: `${MONTH_ABBR[today.month]} ${today.day}`,
        timeZone: today.timeZone,
      },
      attribution: SHIPPED?.attribution || 'Text adapted from English Wikipedia.',
      license: SHIPPED?.license || 'CC BY-SA 4.0',
      ...extra,
    };
  }

  return {
    getSettings: () => settingsApi.get(),
    statusSnapshot(query) {
      const settings = settingsApi.get();
      return snapshot(listEvents(settings, query));
    },
    updateFilters({ minYear, maxYear } = {}) {
      settingsApi.update({
        minYear: minYear === '' || minYear === undefined ? null : minYear,
        maxYear: maxYear === '' || maxYear === undefined ? null : maxYear,
      });
      return { ok: true, ...this.statusSnapshot() };
    },
    addEvent({ month, day, year, text } = {}) {
      const m = cleanMonth(month);
      const d = cleanDay(day, m || 1);
      const y = cleanYear(year);
      const next = cleanText(text);
      if (!m || !d) {
        return { ok: false, error: 'Pick a month and day' };
      }
      if (y == null) {
        return { ok: false, error: 'Enter a year (use negative for BC)' };
      }
      if (!next) {
        return { ok: false, error: 'Type an On This Day fact' };
      }
      if (!fitsBoard(next)) {
        return { ok: false, error: 'That fact is too long for one Vestaboard frame' };
      }
      const settings = settingsApi.get();
      const custom = [...settings.custom, {
        id: newCustomId(m, d),
        month: m,
        day: d,
        year: y,
        text: next,
      }];
      settingsApi.update({ custom });
      return { ok: true, ...this.statusSnapshot() };
    },
    updateEvent(id, { text, year, month, day, hidden } = {}) {
      const key = String(id || '').trim();
      if (!key) {
        return { ok: false, error: 'Missing event id' };
      }
      const settings = settingsApi.get();
      const customIndex = settings.custom.findIndex((row) => row.id === key);
      const shipped = loadShipped().some((row) => row.id === key);

      if (customIndex >= 0) {
        const custom = [...settings.custom];
        if (hidden) {
          custom.splice(customIndex, 1);
        } else {
          const current = custom[customIndex];
          const nextText = text != null ? cleanText(text) : current.text;
          const nextYear = year != null ? cleanYear(year) : current.year;
          const nextMonth = month != null ? cleanMonth(month) : current.month;
          const nextDay = day != null ? cleanDay(day, nextMonth || current.month) : current.day;
          if (!nextText) {
            return { ok: false, error: 'Type an On This Day fact' };
          }
          if (nextYear == null || !nextMonth || !nextDay) {
            return { ok: false, error: 'Need a valid date and year' };
          }
          if (!fitsBoard(nextText)) {
            return { ok: false, error: 'That fact is too long for one Vestaboard frame' };
          }
          custom[customIndex] = {
            ...current,
            text: nextText,
            year: nextYear,
            month: nextMonth,
            day: nextDay,
          };
        }
        settingsApi.update({ custom });
        return { ok: true, ...this.statusSnapshot() };
      }

      if (!shipped) {
        return { ok: false, error: 'Unknown event' };
      }

      const hiddenIds = new Set(settings.hiddenIds);
      const overrides = { ...settings.overrides };
      if (hidden === true) {
        hiddenIds.add(key);
      } else if (hidden === false) {
        hiddenIds.delete(key);
      }
      if (text != null || year != null) {
        const original = loadShipped().find((row) => row.id === key);
        const nextText = text != null ? cleanText(text) : cleanText(original?.text);
        const nextYear = year != null ? cleanYear(year) : cleanYear(original?.year);
        if (!nextText) {
          return { ok: false, error: 'Type an On This Day fact' };
        }
        if (nextYear == null) {
          return { ok: false, error: 'Enter a year' };
        }
        if (!fitsBoard(nextText)) {
          return { ok: false, error: 'That fact is too long for one Vestaboard frame' };
        }
        if (original
          && cleanText(original.text) === nextText
          && cleanYear(original.year) === nextYear) {
          delete overrides[key];
        } else {
          overrides[key] = { text: nextText, year: nextYear };
        }
      }
      settingsApi.update({
        hiddenIds: [...hiddenIds],
        overrides,
      });
      return { ok: true, ...this.statusSnapshot() };
    },
    nextPayload({ month, day, asOf } = {}) {
      const settings = settingsApi.get();
      const today = todayParts(asOf ? new Date(asOf) : new Date());
      const m = cleanMonth(month) || today.month;
      const d = cleanDay(day, m) || today.day;
      const event = pickEvent(settings, { month: m, day: d });
      if (!event) {
        return null;
      }
      settingsApi.remember(event.id);
      return buildOnThisDayPayload(event, { asOf: asOf || new Date().toISOString() });
    },
  };
}

module.exports = {
  TYPE,
  BODY_ROWS,
  BODY_WIDTH,
  MONTH_ABBR,
  loadShipped,
  eventRows,
  fitsBoard,
  formatYear,
  formatDateLine,
  matchingEvents,
  pickEvent,
  buildOnThisDayPayload,
  listEvents,
  partsInTimeZone,
  createOnThisDay,
};
