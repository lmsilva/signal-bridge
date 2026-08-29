// Quiet Hours Reminder — marketplace-style night cards for the Vestaboard.
//
// The official channel posts a card when the house goes quiet. Three of the
// layouts follow that look (crescent moon, SHHH, star field); the rest are
// house extras. Every push picks a random variant and skips the last one
// when it can. The watcher fires on the false→true quiet-hours edge for each
// board, and is exempt so the queue does not drop the card at 22:00.

const fs = require('fs');
const path = require('path');

const { parseHhMm, inQuietHours } = require('./vestaboard/queue');
const { dateParts } = require('./vestaboard/clock');
const { parseLayout } = require('./vestaboard/notation');
const { centered } = require('./vestaboard/frames');
const { COLS, fold, blankRow, assertValidLayout } = require('./vestaboard/encoder');

const TYPE = 'quiet-hours.reminder';
const CATCH_WINDOW_MINUTES = 10;
const WATCH_TICK_MS = 15_000;

/** Marketplace-style night cards, plus a few extras. */
const DRAWINGS = {
  moon: [
    '    yyy               ',
    '   y   y     QUIET    ',
    '  y                   ',
    '  y                   ',
    '   y   y     HOURS    ',
    '    yyy            w  ',
  ],
  shhh: [
    'vv                  vv',
    '                      ',
    '       S H H H        ',
    '                      ',
    '     QUIET HOURS      ',
    'vv                  vv',
  ],
  stars: [
    'y   w        y    w   ',
    '                      ',
    '      GOOD NIGHT      ',
    '                      ',
    'w   y        w    y   ',
    '                      ',
  ],
  zzz: [
    '                 Z    ',
    '              Z       ',
    '           ZZZ        ',
    '                      ',
    '     TIME TO REST     ',
    '                      ',
  ],
  dreams: [
    'y  w              w  y',
    '     SWEET DREAMS     ',
    '                      ',
    '  THE BOARD IS QUIET  ',
    'y  w              w  y',
    '                      ',
  ],
  late: [
    '   w              y   ',
    '                      ',
    '     IT\'S GETTING     ',
    '         LATE         ',
    '   y              w   ',
    '                      ',
  ],
};

const VARIANT_IDS = Object.freeze(['moon', 'shhh', 'stars', 'zzz', 'dreams', 'late', 'until']);

function pad2(value) {
  return String(value).padStart(2, '0');
}

function ymd(year, month, day) {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function previousYmd(year, month, day) {
  const prev = new Date(Date.UTC(year, month - 1, day) - 24 * 60 * 60 * 1000);
  return ymd(prev.getUTCFullYear(), prev.getUTCMonth() + 1, prev.getUTCDate());
}

/** `UNTIL 7AM` / `UNTIL 10:30PM` — short enough for a centered 22-col line. */
function formatQuietEnd(hhmm) {
  const minutes = parseHhMm(hhmm);
  if (minutes == null) {
    return '';
  }
  const hour24 = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const meridiem = hour24 >= 12 ? 'PM' : 'AM';
  const hour = hour24 % 12 || 12;
  if (minute === 0) {
    return `UNTIL ${hour}${meridiem}`;
  }
  return `UNTIL ${hour}:${pad2(minute)}${meridiem}`;
}

function chipEdgeRow() {
  return parseLayout('vv                  vv\n'.repeat(6), { label: 'edge' })[0];
}

function untilRows(payload = {}) {
  const until = fold(formatQuietEnd(payload.window?.end) || 'GOOD NIGHT');
  return assertValidLayout([
    chipEdgeRow(),
    blankRow(COLS),
    centered(fold('QUIET HOURS'), { from: 0, width: COLS }),
    centered(until, { from: 0, width: COLS }),
    blankRow(COLS),
    chipEdgeRow(),
  ], 'quiet hours until');
}

function layoutFor(payload = {}) {
  const id = String(payload.variant || '');
  if (id === 'until') {
    return untilRows(payload);
  }
  const drawing = DRAWINGS[id] || DRAWINGS.moon;
  return parseLayout(drawing.join('\n'), { label: `quiet-hours-${id || 'moon'}` });
}

function pickVariant(lastId, { random = Math.random } = {}) {
  const pool = VARIANT_IDS.filter((id) => id !== lastId);
  const list = pool.length ? pool : VARIANT_IDS;
  const index = Math.min(list.length - 1, Math.max(0, Math.floor(random() * list.length)));
  return list[index];
}

function buildQuietHoursReminderPayload({
  variant = null,
  lastVariant = null,
  quietHours = null,
  now = new Date(),
  random,
} = {}) {
  const chosen = VARIANT_IDS.includes(variant) ? variant : pickVariant(lastVariant, { random });
  const at = now instanceof Date ? now : new Date(now);
  return {
    type: TYPE,
    variant: chosen,
    asOf: Number.isNaN(at.getTime()) ? new Date().toISOString() : at.toISOString(),
    window: quietHours && (quietHours.start || quietHours.end)
      ? { start: quietHours.start || '', end: quietHours.end || '' }
      : null,
  };
}

/**
 * Civil day the current quiet-hours window started on, or null when outside.
 * Overnight 22:00–07:00 at 02:00 on the 29th is still the 28th's period.
 */
function quietHoursPeriodId(date, quietHours, timeZone) {
  if (!inQuietHours(date, quietHours, timeZone)) {
    return null;
  }
  const parts = dateParts(date, timeZone);
  const start = parseHhMm(quietHours?.start);
  const end = parseHhMm(quietHours?.end);
  if (!parts || start == null || end == null) {
    return null;
  }
  const minutes = parts.hour * 60 + parts.minute;
  if (start > end && minutes < end) {
    return previousYmd(parts.year, parts.month, parts.day);
  }
  return ymd(parts.year, parts.month, parts.day);
}

function minutesSinceQuietStart(date, quietHours, timeZone) {
  if (!inQuietHours(date, quietHours, timeZone)) {
    return Infinity;
  }
  const parts = dateParts(date, timeZone);
  const start = parseHhMm(quietHours?.start);
  if (!parts || start == null) {
    return Infinity;
  }
  const minutes = parts.hour * 60 + parts.minute;
  const end = parseHhMm(quietHours?.end);
  if (end != null && start > end && minutes < end) {
    return (24 * 60 - start) + minutes;
  }
  return minutes - start;
}

/**
 * Fire on the rising edge, or catch a start we missed after a short restart.
 *
 * A first sample never fires unless we already have a persisted period from a
 * previous run — otherwise a 3am recreate would flip the board, and hub tests
 * that start overnight would too.
 */
function shouldFireQuietHoursReminder({
  nowIn,
  wasIn,
  periodId,
  lastPeriodId,
  minutesSinceStart,
  catchWindowMinutes = CATCH_WINDOW_MINUTES,
} = {}) {
  if (!nowIn || !periodId) {
    return false;
  }
  if (lastPeriodId === periodId) {
    return false;
  }
  if (wasIn === undefined) {
    return lastPeriodId != null
      && minutesSinceStart <= catchWindowMinutes;
  }
  return !wasIn;
}

function emptyState() {
  return { lastVariant: null, lastPeriodByBoard: {} };
}

function createQuietHoursReminder({ persistPath = null } = {}) {
  let state = emptyState();

  function load() {
    if (!persistPath) {
      return;
    }
    try {
      if (!fs.existsSync(persistPath)) {
        return;
      }
      const parsed = JSON.parse(fs.readFileSync(persistPath, 'utf8')) || {};
      state = {
        lastVariant: typeof parsed.lastVariant === 'string' ? parsed.lastVariant : null,
        lastPeriodByBoard: parsed.lastPeriodByBoard && typeof parsed.lastPeriodByBoard === 'object'
          ? { ...parsed.lastPeriodByBoard }
          : {},
      };
    } catch {
      state = emptyState();
    }
  }

  function save() {
    if (!persistPath) {
      return;
    }
    try {
      fs.mkdirSync(path.dirname(persistPath), { recursive: true });
      fs.writeFileSync(persistPath, `${JSON.stringify(state, null, 2)}\n`);
    } catch {
      // The next push still randomizes in memory.
    }
  }

  load();

  return {
    nextPayload(options = {}) {
      load();
      const payload = buildQuietHoursReminderPayload({
        ...options,
        lastVariant: options.lastVariant != null ? options.lastVariant : state.lastVariant,
      });
      state.lastVariant = payload.variant;
      save();
      return payload;
    },
    lastVariant() {
      return state.lastVariant;
    },
    lastPeriodFor(boardId) {
      return state.lastPeriodByBoard[String(boardId)] || null;
    },
    markPeriod(boardId, periodId) {
      if (!boardId || !periodId) {
        return;
      }
      state.lastPeriodByBoard[String(boardId)] = periodId;
      save();
    },
  };
}

function createQuietHoursWatch({
  reminder,
  getBoards,
  pushEvent,
  timeZone,
  now = () => Date.now(),
  setTimer = setInterval,
  clearTimer = clearInterval,
  tickMs = WATCH_TICK_MS,
  log = null,
} = {}) {
  const lastIn = new Map();
  let timer = null;

  function zone() {
    return typeof timeZone === 'function' ? timeZone() : timeZone;
  }

  function atNow() {
    const value = now();
    return value instanceof Date ? value : new Date(value);
  }

  function tick(at = atNow()) {
    const tz = zone();
    const fired = [];
    const boards = typeof getBoards === 'function' ? getBoards() : [];
    for (const board of boards) {
      if (!board || board.enabled === false) {
        continue;
      }
      const quietHours = board.quietHours;
      if (!quietHours || quietHours.enabled === false || quietHours.remindOnStart === false) {
        lastIn.set(board.id, false);
        continue;
      }
      const inside = inQuietHours(at, quietHours, tz);
      const period = quietHoursPeriodId(at, quietHours, tz);
      const since = minutesSinceQuietStart(at, quietHours, tz);
      const was = lastIn.get(board.id);
      lastIn.set(board.id, inside);
      if (!shouldFireQuietHoursReminder({
        nowIn: inside,
        wasIn: was,
        periodId: period,
        lastPeriodId: reminder.lastPeriodFor(board.id),
        minutesSinceStart: since,
      })) {
        continue;
      }
      const payload = reminder.nextPayload({ quietHours, now: at });
      reminder.markPeriod(board.id, period);
      if (typeof pushEvent === 'function') {
        pushEvent(payload, {
          targetId: board.id,
          explicit: true,
          quietHoursExempt: true,
        });
      }
      fired.push({ boardId: board.id, variant: payload.variant, period });
      log?.info?.('Quiet hours reminder', {
        boardId: board.id,
        variant: payload.variant,
      });
    }
    return fired;
  }

  return {
    tick,
    start() {
      if (timer) {
        return;
      }
      tick();
      timer = setTimer(() => {
        try {
          tick();
        } catch (error) {
          log?.warn?.('Quiet hours reminder tick failed', error?.message || error);
        }
      }, tickMs);
      if (typeof timer?.unref === 'function') {
        timer.unref();
      }
    },
    stop() {
      if (!timer) {
        return;
      }
      clearTimer(timer);
      timer = null;
    },
  };
}

module.exports = {
  TYPE,
  VARIANT_IDS,
  DRAWINGS,
  CATCH_WINDOW_MINUTES,
  WATCH_TICK_MS,
  pickVariant,
  buildQuietHoursReminderPayload,
  layoutFor,
  formatQuietEnd,
  quietHoursPeriodId,
  minutesSinceQuietStart,
  shouldFireQuietHoursReminder,
  createQuietHoursReminder,
  createQuietHoursWatch,
};
