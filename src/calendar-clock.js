/**
 * Calendar Clock — marketplace monthly calendar + house clock on the flaps.
 *
 * No network. The left seven columns are a month grid (one chip per day);
 * the right side is weekday, month+day, and a 12-hour clock. A 5-week month
 * keeps `SMTWTFS` on row 1 so the chips line up under the letters. A 6-week
 * month (31 days starting Friday/Saturday on a Sunday week, and similar
 * Monday-week cases) spends that row on days instead.
 *
 * Each month has its own chip colour; today is a contrasting highlight —
 * March blue/white, August red/orange, December violet/yellow, matching
 * the Vestaboard+ Calendar Clock samples.
 */

const fs = require('fs');
const path = require('path');
const {
  COLS,
  ROWS,
  blankRow,
  placeText,
  fold,
} = require('./vestaboard/encoder');
const { chipCode } = require('./vestaboard/frames');
const { dateParts, houseTimeZone, WEEKDAYS } = require('./vestaboard/clock');

const TYPE = 'calendar.clock';

const MONTH_NAMES = Object.freeze([
  'JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE',
  'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER',
]);

/** Sunday-first letters, one flap each so they sit on the seven day columns. */
const HEADER_SUNDAY = 'SMTWTFS';
const HEADER_MONDAY = 'MTWTFSS';

/**
 * Per-month {days, today} chip names. Samples: March blue/white, August
 * red/orange, December violet/yellow.
 */
const MONTH_THEMES = Object.freeze([
  { month: 'white', today: 'red' },
  { month: 'red', today: 'white' },
  { month: 'blue', today: 'white' },
  { month: 'green', today: 'white' },
  { month: 'yellow', today: 'violet' },
  { month: 'violet', today: 'yellow' },
  { month: 'orange', today: 'white' },
  { month: 'red', today: 'orange' },
  { month: 'orange', today: 'white' },
  { month: 'violet', today: 'orange' },
  { month: 'green', today: 'yellow' },
  { month: 'violet', today: 'yellow' },
]);

const DEFAULT_SETTINGS = Object.freeze({
  weekStartsOn: 'sunday',
});

const CAL_COLS = 7;
const TEXT_COL = 8;

function weekStartIndex(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'monday' || raw === 'mon' || raw === '1') {
    return 1;
  }
  return 0;
}

function sanitiseSettings(raw = {}, base = DEFAULT_SETTINGS) {
  const incoming = raw && typeof raw === 'object' ? raw : {};
  const weekStartsOn = weekStartIndex(
    incoming.weekStartsOn != null ? incoming.weekStartsOn : base.weekStartsOn,
  ) === 1
    ? 'monday'
    : 'sunday';
  return { weekStartsOn };
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
}

/**
 * Civil Y-M-D in `timeZone`. Noon UTC on that date is the same calendar day
 * from UTC-12 through UTC+11 (covers the house zones this bridge uses).
 */
function civilParts(year, month, day, timeZone) {
  if (!timeZone) {
    const date = new Date(year, month - 1, day, 12, 0, 0);
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      weekday: date.getDay(),
    };
  }
  return dateParts(Date.UTC(year, month - 1, day, 12, 0, 0), timeZone);
}

function themeForMonth(month) {
  const index = Math.min(11, Math.max(0, Number(month) - 1));
  return { ...MONTH_THEMES[index] };
}

function formatClockTime(hour, minute) {
  const hr = Number(hour);
  const min = Number(minute);
  if (!Number.isFinite(hr) || !Number.isFinite(min)) {
    return '';
  }
  const meridiem = hr >= 12 ? 'PM' : 'AM';
  const twelve = hr % 12 || 12;
  return `${twelve}:${String(min).padStart(2, '0')}  ${meridiem}`;
}

/**
 * Grid math for one civil month. `weekStartsOn` is 0 (Sunday) or 1 (Monday).
 */
function monthGrid({ year, month, day, weekStartsOn = 0, timeZone = null } = {}) {
  const y = Number(year);
  const m = Number(month);
  const today = Number(day);
  const start = weekStartIndex(weekStartsOn === 1 || weekStartsOn === 'monday' ? 'monday' : weekStartsOn);
  const days = daysInMonth(y, m);
  const first = civilParts(y, m, 1, timeZone);
  const firstWeekday = Number.isFinite(first?.weekday) ? first.weekday : 0;
  const offset = (firstWeekday - start + 7) % 7;
  const weekRows = Math.ceil((offset + days) / 7);
  const showHeader = weekRows <= 5;
  const cells = [];
  for (let date = 1; date <= days; date += 1) {
    const slot = offset + date - 1;
    cells.push({
      day: date,
      row: Math.floor(slot / 7),
      col: slot % 7,
      today: date === today,
    });
  }
  return {
    year: y,
    month: m,
    day: today,
    days,
    offset,
    weekRows,
    showHeader,
    weekStartsOn: start,
    firstWeekday,
    cells,
    theme: themeForMonth(m),
    header: start === 1 ? HEADER_MONDAY : HEADER_SUNDAY,
  };
}

function buildCalendarClockModel(options = {}) {
  const timeZone = options.timeZone || null;
  const asOf = options.asOf || new Date();
  const parts = dateParts(asOf, timeZone);
  if (!parts) {
    return null;
  }
  const weekStartsOn = weekStartIndex(options.weekStartsOn);
  const grid = monthGrid({
    year: parts.year,
    month: parts.month,
    day: parts.day,
    weekStartsOn,
    timeZone,
  });
  return {
    ...grid,
    weekday: parts.weekday,
    weekdayName: WEEKDAYS[parts.weekday] || '',
    monthName: MONTH_NAMES[parts.month - 1] || '',
    hour: parts.hour,
    minute: parts.minute,
    timeLabel: formatClockTime(parts.hour, parts.minute),
    timeZone,
    asOf: asOf instanceof Date ? asOf.toISOString() : String(asOf),
  };
}

function calendarClockRows(model) {
  if (!model?.cells?.length) {
    return null;
  }
  const rows = [0, 1, 2, 3, 4, 5].map(() => blankRow(COLS));
  const dayRow0 = model.showHeader ? 1 : 0;
  if (model.showHeader && model.header) {
    placeText(rows[0], fold(model.header), 0);
  }
  const monthChip = chipCode(model.theme.month);
  const todayChip = chipCode(model.theme.today);
  for (const cell of model.cells) {
    const row = dayRow0 + cell.row;
    if (row < 0 || row >= ROWS || cell.col < 0 || cell.col >= CAL_COLS) {
      continue;
    }
    rows[row][cell.col] = cell.today ? todayChip : monthChip;
  }

  // Weekday / date / time sit on the same rows whether or not the header
  // is showing, so a 6-week month does not shove the clock down.
  // `fold()` collapses spaces, so month/day and clock/meridiem are placed
  // as two pieces with a two-flap gap — the marketplace samples use that
  // extra air (`DECEMBER  31`, `11:59  PM`).
  const weekday = fold(model.weekdayName || '');
  const month = fold(model.monthName || '');
  const day = fold(String(model.day ?? ''));
  const timeBits = String(model.timeLabel || '').trim().split(/\s+/);
  const clock = fold(timeBits[0] || '');
  const meridiem = fold(timeBits[1] || '');
  if (weekday) placeText(rows[1], weekday, TEXT_COL);
  if (month) placeText(rows[2], month, TEXT_COL);
  if (day) placeText(rows[2], day, TEXT_COL + month.length + 2);
  if (clock) placeText(rows[4], clock, TEXT_COL);
  if (meridiem) placeText(rows[4], meridiem, TEXT_COL + clock.length + 2);
  return rows;
}

function buildCalendarClockPayload(settings = {}, options = {}) {
  const cfg = sanitiseSettings(settings);
  const timeZone = options.timeZone || (options.config ? houseTimeZone(options.config) : null);
  const model = buildCalendarClockModel({
    asOf: options.asOf,
    timeZone: timeZone || null,
    weekStartsOn: cfg.weekStartsOn,
  });
  if (!model) {
    return null;
  }
  return {
    type: TYPE,
    asOf: model.asOf,
    timeZone: model.timeZone || '',
    weekStartsOn: cfg.weekStartsOn,
    year: model.year,
    month: model.month,
    day: model.day,
    weekday: model.weekday,
    weekdayName: model.weekdayName,
    monthName: model.monthName,
    hour: model.hour,
    minute: model.minute,
    timeLabel: model.timeLabel,
    showHeader: model.showHeader,
    weekRows: model.weekRows,
    theme: model.theme,
    header: model.header,
    cells: model.cells,
  };
}

function createCalendarClockSettings(config = {}, log = console) {
  const settingsPath = config.calendarClockSettingsPath
    || path.resolve(config.ROOT || path.resolve(__dirname, '..'), 'data', 'calendar-clock-settings.json');
  let current = sanitiseSettings({}, DEFAULT_SETTINGS);

  function load() {
    try {
      if (!fs.existsSync(settingsPath)) {
        current = sanitiseSettings({}, DEFAULT_SETTINGS);
        return current;
      }
      current = sanitiseSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), DEFAULT_SETTINGS);
    } catch (error) {
      log?.warn?.('Could not read Calendar Clock settings', error?.message || error);
      current = sanitiseSettings({}, DEFAULT_SETTINGS);
    }
    return current;
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
    } catch (error) {
      log?.warn?.('Could not save Calendar Clock settings', error?.message || error);
    }
  }

  load();

  return {
    get: () => ({ ...current }),
    update(patch = {}) {
      current = sanitiseSettings({ ...current, ...patch }, DEFAULT_SETTINGS);
      save();
      return this.get();
    },
    reset() {
      current = sanitiseSettings({}, DEFAULT_SETTINGS);
      save();
      return this.get();
    },
    reload: load,
    path: settingsPath,
  };
}

function createCalendarClock(config, log) {
  const settingsApi = createCalendarClockSettings(config, log);

  function nextPayload(options = {}) {
    return buildCalendarClockPayload(settingsApi.get(), {
      ...options,
      timeZone: options.timeZone || houseTimeZone(config || {}),
      config,
    });
  }

  return {
    getSettings: () => settingsApi.get(),
    updateSettings: (patch) => settingsApi.update(patch),
    resetSettings: () => settingsApi.reset(),
    statusSnapshot(options = {}) {
      const settings = settingsApi.get();
      const payload = nextPayload(options);
      return {
        settings,
        defaults: { ...DEFAULT_SETTINGS },
        payload,
      };
    },
    nextPayload,
  };
}

module.exports = {
  TYPE,
  MONTH_NAMES,
  MONTH_THEMES,
  HEADER_SUNDAY,
  HEADER_MONDAY,
  DEFAULT_SETTINGS,
  sanitiseSettings,
  weekStartIndex,
  daysInMonth,
  themeForMonth,
  formatClockTime,
  monthGrid,
  buildCalendarClockModel,
  calendarClockRows,
  buildCalendarClockPayload,
  createCalendarClockSettings,
  createCalendarClock,
};
