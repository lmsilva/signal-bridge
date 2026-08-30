/**
 * Red Letter — Date Book events on the flaps.
 *
 * Two cards. Before the day: an hourglass and a countdown, the way the
 * marketplace New Year card reads (`COUNTDOWN / TO NEW YEAR / 19 DAYS / 11
 * HOURS / 55 MINUTES`). On the day itself: the event's own message, either
 * on a confetti card this module draws or on a layout the user painted in
 * the Date Book designer.
 *
 * A painted layout is a 6x22 grid of flap codes where `-1` marks a cell the
 * message should flow into. That is the whole trick behind the designer:
 * paint a heart, mark the space beside it, and the message rewraps itself
 * into that space every year without anyone touching the artwork.
 */

const fs = require('fs');
const path = require('path');
const {
  ROWS,
  COLS,
  BLANK,
  fold,
  wrap,
  blankRow,
  placeText,
  isLegalCode,
} = require('./vestaboard/encoder');
const { chipCode } = require('./vestaboard/frames');
const { houseTimeZone } = require('./vestaboard/clock');
const { nextOccurrence } = require('./date-book');

const TYPE = 'red-letter.card';
const TITLE = 'Red Letter';

/** A painted cell holding this instead of a code is where the message goes. */
const MESSAGE_CELL = -1;

const SELECTIONS = Object.freeze(['next', 'random']);

const DEFAULT_SETTINGS = Object.freeze({
  pushSelection: 'next',
  scheduleSelection: 'next',
  showTime: true,
});

// --------------------------------------------------------------- countdown

/**
 * Sand draining left of the text. Eight columns wide, `.` is a blank flap.
 * Red on top, white below, so the card reads as a timer at room distance.
 */
const HOURGLASS = Object.freeze([
  'rrrrrrrr',
  '.rrrrrr.',
  '..rrrr..',
  '..wwww..',
  '.wwwwww.',
  'wwwwwwww',
]);

const HOURGLASS_COLS = 8;
const COUNTDOWN_TEXT_COL = 10;
const COUNTDOWN_TEXT_WIDTH = COLS - COUNTDOWN_TEXT_COL;

const CHIP_BY_LETTER = Object.freeze({
  r: 'red', o: 'orange', y: 'yellow', g: 'green', b: 'blue', v: 'violet', w: 'white', k: 'black', f: 'filled',
});

/** Confetti colours, matching the marketplace anniversary card. */
const CONFETTI = Object.freeze(['red', 'violet', 'white']);

function plural(value, unit) {
  return `${value} ${unit}${Number(value) === 1 ? '' : 'S'}`;
}

function hourglassRows() {
  return HOURGLASS.map((line) => {
    const row = blankRow(COLS);
    for (let col = 0; col < HOURGLASS_COLS; col += 1) {
      const letter = line[col];
      if (letter && letter !== '.') {
        row[col] = chipCode(CHIP_BY_LETTER[letter] || 'white');
      }
    }
    return row;
  });
}

function placeCentered(row, text, from, width) {
  const value = fold(text || '').slice(0, width);
  if (!value) {
    return row;
  }
  return placeText(row, value, from + Math.floor((width - value.length) / 2));
}

/**
 * `COUNTDOWN / TO NEW YEAR` beside the hourglass. Only names short enough to
 * sit on one 12-column line get the artwork; anything longer takes the wide
 * card so the name is never cut mid-word to protect a decoration.
 */
function countdownCompactRows({ name, days, hours, minutes, showTime = true }) {
  const rows = hourglassRows();
  placeText(rows[0], 'COUNTDOWN', COUNTDOWN_TEXT_COL);
  placeText(rows[1], `TO ${fold(name)}`, COUNTDOWN_TEXT_COL);
  if (showTime) {
    placeText(rows[3], plural(days, 'DAY'), COUNTDOWN_TEXT_COL);
    placeText(rows[4], plural(hours, 'HOUR'), COUNTDOWN_TEXT_COL);
    placeText(rows[5], plural(minutes, 'MINUTE'), COUNTDOWN_TEXT_COL);
  } else {
    placeText(rows[4], plural(days, 'DAY'), COUNTDOWN_TEXT_COL);
  }
  return rows;
}

/** Full-width fallback: chip-capped heading, wrapped name, then the counts. */
function countdownWideRows({ name, days, hours, minutes, showTime = true }) {
  const rows = [0, 1, 2, 3, 4, 5].map(() => blankRow(COLS));
  const chip = chipCode('red');
  rows[0][0] = chip;
  rows[0][1] = chip;
  rows[0][COLS - 2] = chip;
  rows[0][COLS - 1] = chip;
  placeCentered(rows[0], 'COUNTDOWN TO', 3, COLS - 6);

  const nameLines = wrap(name, COLS).slice(0, 2);
  nameLines.forEach((line, index) => placeCentered(rows[1 + index], line, 0, COLS));

  if (showTime) {
    placeCentered(rows[3], plural(days, 'DAY'), 0, COLS);
    placeCentered(rows[4], plural(hours, 'HOUR'), 0, COLS);
    placeCentered(rows[5], plural(minutes, 'MINUTE'), 0, COLS);
  } else {
    placeCentered(rows[4], plural(days, 'DAY'), 0, COLS);
  }
  return rows;
}

function countdownFitsCompact(name) {
  return `TO ${fold(name || '')}`.length <= COUNTDOWN_TEXT_WIDTH;
}

function countdownRows(model = {}) {
  return countdownFitsCompact(model.name)
    ? countdownCompactRows(model)
    : countdownWideRows(model);
}

// ------------------------------------------------------------------ day of

/** Stable per-event confetti: the same date always shakes out the same card. */
function seedFrom(text) {
  let hash = 2166136261;
  const value = String(text || 'red letter');
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function confettiRows(seed, count = 2) {
  let state = seed || 1;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    const row = blankRow(COLS);
    for (let col = 0; col < COLS; col += 1) {
      row[col] = chipCode(CONFETTI[Math.floor(next() * CONFETTI.length)]);
    }
    rows.push(row);
  }
  return rows;
}

const DAY_OF_WRAP = 20;

/**
 * The house day-of card. A message short enough to sit in four lines gets
 * confetti above and below; a long one takes the whole board, because losing
 * two lines of what someone wrote to protect a decoration is the wrong trade.
 */
function dayOfDefaultRows({ message, name, seed } = {}) {
  const text = fold(message || '') || fold(name || '');
  const short = wrap(text, DAY_OF_WRAP);

  if (short.length && short.length <= 4) {
    const [top, bottom] = confettiRows(seedFrom(seed), 2);
    const rows = [top, ...[1, 2, 3, 4].map(() => blankRow(COLS)), bottom];
    const offset = 1 + Math.floor((4 - short.length) / 2);
    short.forEach((line, index) => placeCentered(rows[offset + index], line, 0, COLS));
    return rows;
  }

  const lines = short.slice(0, ROWS);
  const rows = [0, 1, 2, 3, 4, 5].map(() => blankRow(COLS));
  const offset = Math.floor((ROWS - lines.length) / 2);
  lines.forEach((line, index) => placeCentered(rows[offset + index], line, 0, COLS));
  return rows;
}

// ----------------------------------------------------------- painted grids

/**
 * Keep only what the board can draw. Illegal codes become blanks rather than
 * throwing, so a layout saved by an older build never bricks the card.
 */
function sanitiseLayout(layout) {
  if (!layout) {
    return null;
  }
  const raw = Array.isArray(layout) ? layout : layout.cells;
  if (!Array.isArray(raw)) {
    return null;
  }
  const cells = [];
  for (let row = 0; row < ROWS; row += 1) {
    const source = Array.isArray(raw[row]) ? raw[row] : [];
    const out = [];
    for (let col = 0; col < COLS; col += 1) {
      const value = Number(source[col]);
      if (value === MESSAGE_CELL) {
        out.push(MESSAGE_CELL);
      } else {
        out.push(isLegalCode(value) ? value : BLANK);
      }
    }
    cells.push(out);
  }
  const painted = cells.some((row) => row.some((code) => code !== BLANK));
  return painted ? { cells } : null;
}

/** Contiguous horizontal runs of message cells, top-left to bottom-right. */
function messageRuns(cells = []) {
  const runs = [];
  cells.forEach((row, rowIndex) => {
    let start = -1;
    for (let col = 0; col <= COLS; col += 1) {
      const isSlot = col < COLS && row[col] === MESSAGE_CELL;
      if (isSlot && start < 0) {
        start = col;
      } else if (!isSlot && start >= 0) {
        runs.push({ row: rowIndex, from: start, width: col - start });
        start = -1;
      }
    }
  });
  return runs;
}

/**
 * Greedily pour words through the runs in reading order. A word too long for
 * its run is broken rather than dropped; anything left over after the last
 * run is reported so the designer can warn instead of silently truncating.
 */
function flowMessage(runs = [], message = '') {
  const words = fold(message).split(/\s+/).filter(Boolean);
  const lines = [];
  let index = 0;

  for (const run of runs) {
    let line = '';
    while (index < words.length) {
      const word = words[index];
      const candidate = line ? `${line} ${word}` : word;
      if (candidate.length <= run.width) {
        line = candidate;
        index += 1;
        continue;
      }
      if (!line && word.length > run.width) {
        line = word.slice(0, run.width);
        words[index] = word.slice(run.width);
      }
      break;
    }
    lines.push(line);
  }

  return { lines, overflow: index < words.length };
}

/**
 * Short text in a tall region sits in the middle of it, not jammed against
 * the top — marking four rows and getting two of message with two of dead
 * air below is not what anyone drew. Only runs of one width can shift, since
 * a line wrapped for a wide run would be cut by a narrow one.
 */
function centreRuns(runs, lines) {
  const used = lines.filter(Boolean).length;
  const uniform = runs.every((run) => run.width === runs[0]?.width);
  if (!used || !uniform || used >= runs.length) {
    return lines;
  }
  const offset = Math.floor((runs.length - used) / 2);
  const shifted = new Array(runs.length).fill('');
  lines.filter(Boolean).forEach((line, index) => {
    shifted[index + offset] = line;
  });
  return shifted;
}

function paintedRows(layout, message = '') {
  const cells = layout?.cells;
  if (!Array.isArray(cells)) {
    return null;
  }
  const runs = messageRuns(cells);
  const { lines, overflow } = flowMessage(runs, message);
  const placed = centreRuns(runs, lines);
  const rows = cells.map((row) => row.map((code) => (code === MESSAGE_CELL ? BLANK : code)));
  runs.forEach((run, index) => {
    placeCentered(rows[run.row], placed[index] || '', run.from, run.width);
  });
  return { rows, runs, overflow };
}

// ----------------------------------------------------------------- payload

function sanitiseSettings(raw = {}, base = DEFAULT_SETTINGS) {
  const incoming = raw && typeof raw === 'object' ? raw : {};
  const pick = (key) => {
    const value = String(incoming[key] != null ? incoming[key] : base[key]).trim().toLowerCase();
    return SELECTIONS.includes(value) ? value : DEFAULT_SETTINGS[key];
  };
  const showTime = incoming.showTime != null ? incoming.showTime : base.showTime;
  return {
    pushSelection: pick('pushSelection'),
    scheduleSelection: pick('scheduleSelection'),
    showTime: showTime !== false,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * One event to one card.
 *
 * `mode` is normally `auto` — day-of when the date is today, countdown
 * otherwise. The admin previews force a mode; a forced countdown on a
 * recurring event that lands today looks ahead a year rather than showing a
 * row of zeroes nobody would recognise as a preview.
 */
function buildRedLetterPayload(event, {
  asOf = new Date(),
  timeZone = null,
  mode = 'auto',
  showTime = true,
  selection = 'next',
  trigger = 'push',
} = {}) {
  if (!event?.name) {
    return null;
  }
  const at = asOf instanceof Date ? asOf : new Date(asOf);
  let occurrence = nextOccurrence(event, { asOf: at, timeZone });
  if (!occurrence) {
    return null;
  }

  let card = mode === 'auto' ? (occurrence.isToday ? 'day-of' : 'countdown') : mode;
  if (card === 'countdown' && occurrence.isToday && event.recurring) {
    occurrence = nextOccurrence(event, { asOf: new Date(at.getTime() + DAY_MS), timeZone })
      || occurrence;
  }
  if (card === 'countdown' && occurrence.isToday) {
    card = 'day-of';
  }

  const layout = card === 'day-of' ? sanitiseLayout(event.layout) : null;
  const painted = layout ? paintedRows(layout, event.message || event.name) : null;
  const rows = card === 'day-of'
    ? (painted?.rows || dayOfDefaultRows({
      message: event.message,
      name: event.name,
      seed: `${event.id || event.name}-${occurrence.date}`,
    }))
    : countdownRows({
      name: event.name,
      days: showTime ? occurrence.days : occurrence.daysAway,
      hours: occurrence.hours,
      minutes: occurrence.minutes,
      showTime,
    });

  return {
    type: TYPE,
    title: TITLE,
    card,
    trigger,
    selection,
    showTime: showTime !== false,
    custom: Boolean(painted),
    overflow: Boolean(painted?.overflow),
    event: {
      id: event.id || '',
      name: event.name,
      message: event.message || '',
      date: event.date || '',
      recurring: event.recurring === true,
    },
    occurrence: {
      date: occurrence.date,
      daysAway: occurrence.daysAway,
      days: occurrence.days,
      hours: occurrence.hours,
      minutes: occurrence.minutes,
      isToday: occurrence.isToday,
      observed: occurrence.observed,
    },
    rows,
    asOf: at.toISOString(),
    timeZone: timeZone || '',
  };
}

/** The formatter wants rows; a payload that already carries them just hands them over. */
function redLetterRows(payload = {}) {
  return Array.isArray(payload.rows) && payload.rows.length === ROWS ? payload.rows : null;
}

// ---------------------------------------------------------------- settings

function createRedLetterSettings(config = {}, log = console) {
  const settingsPath = config.redLetterSettingsPath
    || path.resolve(config.ROOT || path.resolve(__dirname, '..'), 'data', 'red-letter-settings.json');
  let current = sanitiseSettings({}, DEFAULT_SETTINGS);

  function load() {
    try {
      if (!fs.existsSync(settingsPath)) {
        current = sanitiseSettings({}, DEFAULT_SETTINGS);
        return current;
      }
      current = sanitiseSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), DEFAULT_SETTINGS);
    } catch (error) {
      log?.warn?.('Could not read Red Letter settings', error?.message || error);
      current = sanitiseSettings({}, DEFAULT_SETTINGS);
    }
    return current;
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
    } catch (error) {
      log?.warn?.('Could not save Red Letter settings', error?.message || error);
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

/**
 * The service the web server talks to. `dateBook` is injected so the store
 * stays a single instance shared with the Date Book CRUD routes.
 */
function createRedLetter(config = {}, log = console, { dateBook } = {}) {
  const settingsApi = createRedLetterSettings(config, log);
  const zone = () => houseTimeZone(config || {});

  function selectionFor(trigger) {
    const settings = settingsApi.get();
    return trigger === 'schedule' ? settings.scheduleSelection : settings.pushSelection;
  }

  function nextPayload({ trigger = 'push', asOf = new Date(), random, eventId = '' } = {}) {
    const settings = settingsApi.get();
    const timeZone = zone();
    const selection = selectionFor(trigger);
    const event = eventId
      ? dateBook?.get?.(eventId)
      : dateBook?.pick?.({ mode: selection, asOf, timeZone, random });
    if (!event) {
      return null;
    }
    return buildRedLetterPayload(event, {
      asOf,
      timeZone,
      showTime: settings.showTime,
      selection,
      trigger,
    });
  }

  function preview({ eventId = '', event = null, asOf = new Date() } = {}) {
    const source = event || (eventId ? dateBook?.get?.(eventId) : null);
    if (!source?.name) {
      return null;
    }
    const settings = settingsApi.get();
    const timeZone = zone();
    const common = { asOf, timeZone, showTime: settings.showTime, trigger: 'preview' };
    return {
      countdown: buildRedLetterPayload(source, { ...common, mode: 'countdown' }),
      dayOf: buildRedLetterPayload(source, { ...common, mode: 'day-of' }),
    };
  }

  return {
    getSettings: () => settingsApi.get(),
    updateSettings: (patch) => settingsApi.update(patch),
    resetSettings: () => settingsApi.reset(),
    selectionFor,
    nextPayload,
    preview,
    statusSnapshot(options = {}) {
      const timeZone = zone();
      const upcoming = dateBook?.upcoming?.({ asOf: options.asOf, timeZone }) || [];
      return {
        settings: settingsApi.get(),
        defaults: { ...DEFAULT_SETTINGS },
        timeZone,
        total: dateBook?.list?.().length || 0,
        upcoming: upcoming.length,
        today: upcoming.filter((event) => event.next?.isToday).length,
        nextUp: upcoming[0]
          ? {
            id: upcoming[0].id,
            name: upcoming[0].name,
            date: upcoming[0].next.date,
            daysAway: upcoming[0].next.daysAway,
          }
          : null,
      };
    },
  };
}

module.exports = {
  TYPE,
  TITLE,
  MESSAGE_CELL,
  SELECTIONS,
  DEFAULT_SETTINGS,
  HOURGLASS,
  CONFETTI,
  COUNTDOWN_TEXT_COL,
  COUNTDOWN_TEXT_WIDTH,
  DAY_OF_WRAP,
  plural,
  hourglassRows,
  countdownFitsCompact,
  countdownCompactRows,
  countdownWideRows,
  countdownRows,
  seedFrom,
  confettiRows,
  dayOfDefaultRows,
  sanitiseLayout,
  messageRuns,
  flowMessage,
  centreRuns,
  paintedRows,
  sanitiseSettings,
  buildRedLetterPayload,
  redLetterRows,
  createRedLetterSettings,
  createRedLetter,
};
