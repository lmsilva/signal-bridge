/**
 * Word Clock — the time, spelled out the way a person would say it.
 *
 * No network. "IT'S A QUARTER PAST TWELVE IN THE AFTERNOON." wrapped into a
 * left-aligned block that is centred on all six rows, matching the Vestaboard+
 * channel of the same name.
 *
 * Two wording choices are settings because they change how the sentence reads
 * rather than how it is drawn:
 *   - `rounding` — a wall clock nobody reads to the minute rounds to the
 *     nearest five ("TEN PAST THREE"). `exact` spells the true minute
 *     ("SEVEN MINUTES PAST THREE"), which is longer but honest.
 *   - `dayPart` — the "IN THE AFTERNOON" tail. Off keeps the board terse.
 *
 * Midnight and noon are named rather than counted, so the board never says
 * "TWELVE O'CLOCK AT NIGHT".
 */

const fs = require('fs');
const path = require('path');
const {
  COLS,
  ROWS,
  fold,
  wrap,
  blankRow,
  placeText,
} = require('./vestaboard/encoder');
const { dateParts, houseTimeZone } = require('./vestaboard/clock');

const TYPE = 'word.clock';

const ONES = Object.freeze([
  '', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE',
  'TEN', 'ELEVEN', 'TWELVE', 'THIRTEEN', 'FOURTEEN', 'FIFTEEN', 'SIXTEEN',
  'SEVENTEEN', 'EIGHTEEN', 'NINETEEN',
]);

const DEFAULT_SETTINGS = Object.freeze({
  rounding: 'five',
  dayPart: true,
});

function roundingMode(value, fallback = 'five') {
  const raw = String(value == null ? '' : value).trim().toLowerCase();
  if (raw === 'exact' || raw === 'minute') return 'exact';
  if (raw === 'five' || raw === '5') return 'five';
  return fallback === 'exact' ? 'exact' : 'five';
}

function boolish(value, fallback) {
  if (value === undefined || value === null || value === '') return Boolean(fallback);
  if (typeof value === 'string') {
    const raw = value.trim().toLowerCase();
    if (['0', 'false', 'no', 'off'].includes(raw)) return false;
    if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
    return Boolean(fallback);
  }
  return Boolean(value);
}

function sanitiseSettings(raw = {}, base = DEFAULT_SETTINGS) {
  const incoming = raw && typeof raw === 'object' ? raw : {};
  return {
    rounding: roundingMode(incoming.rounding, base.rounding),
    dayPart: boolish(
      incoming.dayPart != null ? incoming.dayPart : base.dayPart,
      base.dayPart,
    ),
  };
}

/** 1-29 in words. Only ever the minutes either side of the half hour. */
function numberWord(value) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n < 1 || n > 59) {
    return '';
  }
  if (n < 20) {
    return ONES[n];
  }
  const tens = ['', '', 'TWENTY', 'THIRTY', 'FORTY', 'FIFTY'][Math.floor(n / 10)];
  const unit = n % 10;
  return unit ? `${tens}-${ONES[unit]}` : tens;
}

/** 0-23 to how the hour is named: 13 is ONE, 0 and 12 are TWELVE. */
function hourWord(hour) {
  const h = ((Math.trunc(Number(hour)) % 24) + 24) % 24;
  return ONES[h % 12 || 12];
}

/**
 * Which stretch of the day the announced hour belongs to.
 *
 * Six in the evening and five in the afternoon are both what people say, so
 * the afternoon runs to 18:00 and the evening hands over to night at 21:00.
 */
function dayPartPhrase(hour) {
  const h = ((Math.trunc(Number(hour)) % 24) + 24) % 24;
  if (h < 12) return 'IN THE MORNING';
  if (h < 18) return 'IN THE AFTERNOON';
  if (h < 21) return 'IN THE EVENING';
  return 'AT NIGHT';
}

/**
 * The announced time after rounding. Rolls the hour when the minutes round up
 * past the top, so 11:58 becomes noon rather than "SIXTY PAST ELEVEN".
 */
function announcedTime(hour, minute, rounding = 'five') {
  const h = ((Math.trunc(Number(hour)) % 24) + 24) % 24;
  const m = Math.min(59, Math.max(0, Math.trunc(Number(minute)) || 0));
  if (roundingMode(rounding) !== 'five') {
    return { hour: h, minute: m };
  }
  const rounded = Math.round(m / 5) * 5;
  return rounded >= 60
    ? { hour: (h + 1) % 24, minute: 0 }
    : { hour: h, minute: rounded };
}

/**
 * The sentence on the board, ending in a full stop like the channel does.
 *
 * Multiples of five drop the word MINUTES ("TEN PAST TWO"); anything else
 * keeps it, because "SEVEN PAST TWO" reads as a score rather than a time.
 */
function timePhrase(hour, minute, { dayPart = true } = {}) {
  const h = ((Math.trunc(Number(hour)) % 24) + 24) % 24;
  const m = Math.min(59, Math.max(0, Math.trunc(Number(minute)) || 0));

  if (m === 0 && h === 0) return "IT'S MIDNIGHT.";
  if (m === 0 && h === 12) return "IT'S NOON.";

  const tail = dayPart ? ` ${dayPartPhrase(h)}` : '';
  const next = hourWord(h + 1);
  const here = hourWord(h);

  let core;
  if (m === 0) core = `${here} O'CLOCK`;
  else if (m === 15) core = `A QUARTER PAST ${here}`;
  else if (m === 30) core = `HALF PAST ${here}`;
  else if (m === 45) core = `A QUARTER TO ${next}`;
  else {
    const past = m < 30;
    const count = past ? m : 60 - m;
    // MINUTE singular only ever applies to one minute either side of the hour.
    const unit = count % 5 === 0 ? '' : ` MINUTE${count === 1 ? '' : 'S'}`;
    core = `${numberWord(count)}${unit} ${past ? 'PAST' : 'TO'} ${past ? here : next}`;
  }

  return `IT'S ${core}${tail}.`;
}

/**
 * Wrap the sentence into the tightest block that still uses the fewest rows.
 *
 * Plain `wrap(text, COLS)` is greedy, so it fills the first line and leaves a
 * stub on the last ("IT'S A QUARTER PAST / TWELVE IN THE / AFTERNOON."). The
 * board has room to spare, so the narrowest width that costs no extra row wins
 * — the block ends up roughly rectangular, which is what the channel shows.
 */
function layoutLines(text, { cols = COLS, rows = ROWS } = {}) {
  const folded = fold(text);
  if (!folded) {
    return [];
  }
  const widest = wrap(folded, cols);
  if (widest.length >= rows) {
    return widest.slice(0, rows);
  }
  // Never search below the longest word or `wrap` starts hyphenating it.
  const longest = folded.split(' ').reduce((max, word) => Math.max(max, word.length), 0);
  for (let width = Math.max(longest, 2); width < cols; width += 1) {
    const candidate = wrap(folded, width);
    if (candidate.length && candidate.length <= widest.length) {
      return candidate;
    }
  }
  return widest;
}

/** The block centred on both axes: every line shares a left edge. */
function wordClockRows(payload = {}) {
  const lines = Array.isArray(payload.lines) && payload.lines.length
    ? payload.lines.map((line) => fold(line)).filter(Boolean).slice(0, ROWS)
    : layoutLines(payload.text);
  if (!lines.length) {
    return null;
  }
  const width = lines.reduce((max, line) => Math.max(max, line.length), 0);
  const from = Math.max(0, Math.floor((COLS - width) / 2));
  const top = Math.floor((ROWS - lines.length) / 2);
  const rows = [];
  for (let index = 0; index < ROWS; index += 1) {
    const row = blankRow(COLS);
    const line = lines[index - top];
    if (line) {
      placeText(row, line, from);
    }
    rows.push(row);
  }
  return rows;
}

function clockLabel(hour, minute) {
  const h = ((Math.trunc(Number(hour)) % 24) + 24) % 24;
  return `${h % 12 || 12}:${String(minute).padStart(2, '0')}${h >= 12 ? 'PM' : 'AM'}`;
}

function buildWordClockPayload(settings = {}, options = {}) {
  const cfg = sanitiseSettings(settings);
  const timeZone = options.timeZone || (options.config ? houseTimeZone(options.config) : null);
  const asOf = options.asOf || new Date();
  const parts = dateParts(asOf, timeZone || null);
  if (!parts) {
    return null;
  }
  const said = announcedTime(parts.hour, parts.minute, cfg.rounding);
  const text = timePhrase(said.hour, said.minute, { dayPart: cfg.dayPart });
  return {
    type: TYPE,
    asOf: asOf instanceof Date ? asOf.toISOString() : String(asOf),
    timeZone: timeZone || '',
    rounding: cfg.rounding,
    dayPart: cfg.dayPart,
    hour: said.hour,
    minute: said.minute,
    actualHour: parts.hour,
    actualMinute: parts.minute,
    timeLabel: clockLabel(said.hour, said.minute),
    text,
    lines: layoutLines(text),
  };
}

function createWordClockSettings(config = {}, log = console) {
  const settingsPath = config.wordClockSettingsPath
    || path.resolve(config.ROOT || path.resolve(__dirname, '..'), 'data', 'word-clock-settings.json');
  let current = sanitiseSettings({}, DEFAULT_SETTINGS);

  function load() {
    try {
      if (!fs.existsSync(settingsPath)) {
        current = sanitiseSettings({}, DEFAULT_SETTINGS);
        return current;
      }
      current = sanitiseSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), DEFAULT_SETTINGS);
    } catch (error) {
      log?.warn?.('Could not read Word Clock settings', error?.message || error);
      current = sanitiseSettings({}, DEFAULT_SETTINGS);
    }
    return current;
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
    } catch (error) {
      log?.warn?.('Could not save Word Clock settings', error?.message || error);
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

function createWordClock(config, log) {
  const settingsApi = createWordClockSettings(config, log);

  function nextPayload(options = {}) {
    return buildWordClockPayload(settingsApi.get(), {
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
      const payload = nextPayload(options);
      return {
        settings: settingsApi.get(),
        defaults: { ...DEFAULT_SETTINGS },
        payload,
        // The card paints the same rows the formatter will, so the bezel
        // cannot drift from the flaps.
        boardRows: payload ? wordClockRows(payload) : null,
      };
    },
    nextPayload,
  };
}

module.exports = {
  TYPE,
  ONES,
  DEFAULT_SETTINGS,
  sanitiseSettings,
  roundingMode,
  numberWord,
  hourWord,
  dayPartPhrase,
  announcedTime,
  timePhrase,
  layoutLines,
  wordClockRows,
  buildWordClockPayload,
  createWordClockSettings,
  createWordClock,
};
