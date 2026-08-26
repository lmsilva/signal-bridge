// The Alexa family of board frames (03 §A).
//
// Every entry takes a UDP payload the bridge already builds and returns an
// array of frames. An empty array means "nothing worth flipping the board
// for" — silence is a valid answer, and it is the answer far more often than
// not. Formatters that have an all-quiet frame only return it when someone
// actually asked (`ctx.explicit`), never in the ambient rotation.
//
// Pure functions: no clock beyond what a caller passes, no I/O, no state.

const {
  COLS,
  BLANK,
  blankRow,
  encodeText,
  placeText,
  placeCodes,
  truncate,
  wrap,
  fold,
  toNumber,
  formatWhole,
} = require('../encoder');

const {
  BADGE_TEXT_WIDTH,
  BODY_FROM,
  BODY_TO,
  BORDER_TEXT_WIDTH,
  MAX_BODY_ROWS,
  ALERT_DWELL_SECONDS,
  chipCode,
  lr,
  pageCounter,
  badgeFrame,
  borderFrame,
  blockTime,
  dwellFor,
} = require('../frames');

const {
  toDate,
  clockLabel,
  weekday,
  dateLabel,
  dayPhrase,
  countdown,
  durationLabel,
  partOfDay,
} = require('../clock');

const BODY_WIDTH = BODY_TO - BODY_FROM + 1;

function tz(ctx) {
  return { timeZone: ctx?.timeZone };
}

// Timers get three rows so the footer count stays readable at a glance; list
// items are shorter and take all four.
const TIMERS_PER_PAGE = 3;
const ITEMS_PER_PAGE = MAX_BODY_ROWS;

// Long room names are abbreviated before they are cut, because "MASTER BATH"
// still names a room and "MASTER BATHRO" names nothing.
const DEVICE_ABBREVIATIONS = new Map([
  ['BATHROOM', 'BATH'],
  ['BEDROOM', 'BED'],
  ['BASEMENT', 'BSMT'],
  ['DOWNSTAIRS', 'DOWN'],
  ['UPSTAIRS', 'UP'],
]);

const BAND_CHIPS = {
  good: 'green',
  fair: 'yellow',
  moderate: 'orange',
  poor: 'red',
  unknown: 'white',
};

const CONDITION_WORDS = {
  sunny: 'SUNNY',
  'clear-night': 'CLEAR',
  cloudy: 'CLOUDY',
  rainy: 'RAIN',
  snowy: 'SNOW',
  stormy: 'STORMS',
  unknown: '',
};

// A monitor this warm is the story on the frame, whatever its air score says.
const HOT_MONITOR_F = 85;
const NOTABLE_WIND_MPH = 20;
const NOTABLE_RAIN_PERCENT = 30;

function snapshotFrame(rows, label, source, { base = 15 } = {}) {
  return {
    rows,
    dwellSeconds: dwellFor(rows, { base }),
    label,
    source,
    priority: 'snapshot',
  };
}

function alertFrame(rows, label, source, { more = false } = {}) {
  return {
    rows,
    dwellSeconds: ALERT_DWELL_SECONDS,
    label,
    source,
    priority: 'alert',
    more,
  };
}

/** Split a list into pages, always yielding at least one (possibly empty) page. */
function paginate(list, perPage) {
  const pages = [];
  for (let index = 0; index < list.length; index += perPage) {
    pages.push(list.slice(index, index + perPage));
  }
  return pages.length ? pages : [[]];
}

/** Pad a body-row list out to the four rows a badge frame expects. */
function padRows(rows) {
  const padded = rows.slice(0, MAX_BODY_ROWS);
  while (padded.length < MAX_BODY_ROWS) {
    padded.push('');
  }
  return padded;
}

/**
 * Fit a device name into `width`: abbreviate the words that have a shorter
 * form, drop a bare trailing "ROOM", and only then cut.
 */
function fitDevice(name, width = BORDER_TEXT_WIDTH) {
  const folded = fold(name);
  if (!folded) {
    return '';
  }
  if (folded.length <= width) {
    return folded;
  }

  const abbreviated = folded
    .split(' ')
    .map((word) => DEVICE_ABBREVIATIONS.get(word) || word)
    .join(' ');
  if (abbreviated.length <= width) {
    return abbreviated;
  }

  const withoutRoom = abbreviated.replace(/\bROOM\b/g, '').replace(/\s+/g, ' ').trim();
  if (withoutRoom.length <= width) {
    return withoutRoom;
  }

  return truncate(withoutRoom, width);
}

/** A body row of text with a colour chip one column after it. */
function chipAfterRow(text, color) {
  const row = blankRow(COLS);
  const codes = encodeText(text).slice(0, BODY_WIDTH);
  placeCodes(row, codes, BODY_FROM);
  if (color) {
    const at = BODY_FROM + codes.length + 1;
    if (at <= BODY_TO) {
      row[at] = chipCode(color);
    }
  }
  return row;
}

/** A body row of text with a colour chip parked at the right edge. */
function chipRightRow(text, color) {
  const row = blankRow(COLS);
  placeText(row, truncate(text, BODY_WIDTH - 2), BODY_FROM);
  if (color) {
    row[BODY_TO] = chipCode(color);
  }
  return row;
}

/** A label row whose value is right-aligned, with the label cut to what is left. */
function labelValueRow(label, value, options = {}) {
  const right = fold(value);
  const room = BODY_WIDTH - right.length - (right.length ? 1 : 0);
  return lr(truncate(label, Math.max(0, room)), right, options);
}

/** `YYYY-MM-DD` as a local date, so a weekday name does not slip a day. */
function parseYmd(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) {
    return toDate(value);
  }
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function conditionWord(condition) {
  return CONDITION_WORDS[String(condition || '').toLowerCase()] ?? '';
}

function degrees(value) {
  const whole = formatWhole(value);
  return whole ? `${whole}\u00b0` : '';
}

// ---------------------------------------------------------------------------
// A1. Broadcast
// ---------------------------------------------------------------------------

/**
 * The priority feature: someone spoke to the house and the board says so.
 *
 * Three tiers by wrapped line count. A one-line message becomes a poster —
 * centred, with the room underneath — because a single word floating on the
 * left of a border frame reads like a mistake.
 */
function broadcastFrames(payload = {}, ctx = {}) {
  const lines = wrap(payload.message, BORDER_TEXT_WIDTH);
  if (!lines.length) {
    return [];
  }

  const device = fitDevice(payload.sender || payload.device, BORDER_TEXT_WIDTH);
  const label = ctx.label || 'Broadcast';
  const source = 'broadcast';

  if (lines.length === 1) {
    const rows = borderFrame({
      color: 'violet',
      align: 'center',
      lines: ['', lines[0], '', device],
    });
    return [alertFrame(rows, label, source)];
  }

  if (lines.length <= 3) {
    const content = padRows([...lines]);
    content[MAX_BODY_ROWS - 1] = device;
    return [alertFrame(borderFrame({ color: 'violet', lines: content }), label, source)];
  }

  // Four lines exactly fill the frame, so the room name yields to the words.
  const pages = paginate(lines, MAX_BODY_ROWS);
  return pages.map((page, index) => {
    const more = index < pages.length - 1;
    const rows = borderFrame({ color: 'violet', lines: padRows(page), more });
    return alertFrame(rows, label, source, { more });
  });
}

// ---------------------------------------------------------------------------
// A2. Time
// ---------------------------------------------------------------------------

function timeFrames(payload = {}, ctx = {}) {
  const when = toDate(payload.parsedTime?.iso)
    || toDate(payload.timestamp)
    || toDate(ctx.now)
    || new Date();

  if (ctx.timeStyle === 'text') {
    const rows = badgeFrame({
      color: 'white',
      title: 'TIME',
      rows: ['', { center: clockLabel(when, tz(ctx)) }, '', ''],
      footerLeft: dateLabel(when, tz(ctx)),
    });
    return [snapshotFrame(rows, 'Time', 'time.query')];
  }

  const rows = blockTime(when, { footer: dateLabel(when, tz(ctx)), timeZone: ctx.timeZone });
  return [{
    rows,
    dwellSeconds: 15,
    label: 'Time',
    source: 'time.query',
    priority: 'snapshot',
  }];
}

// ---------------------------------------------------------------------------
// A3. Smart home
// ---------------------------------------------------------------------------

/**
 * A device changed state. The target and the state share a phrase so it reads
 * as a sentence; when that fits on one row the room that heard the command
 * gets the second row, and when it does not, the phrase wins.
 */
function smartHomeFrames(payload = {}, ctx = {}) {
  const command = payload.command || {};
  const action = fold(command.action);
  if (!action) {
    return [];
  }

  const target = fold(command.matchedName || command.target || command.spokenTarget);
  if (!target) {
    return [];
  }

  const lines = wrap(`${target}: ${action}`, BODY_WIDTH);
  const chip = action === 'ON' ? 'green' : null;
  const device = fitDevice(payload.device, BODY_WIDTH - 'VIA '.length);

  const content = lines.length > 1
    ? ['', lines[0], chipAfterRow(lines[1], chip), '']
    : ['', chipAfterRow(lines[0], chip), device ? `VIA ${device}` : '', ''];

  const rows = badgeFrame({
    color: 'white',
    title: 'SMART HOME',
    rows: content,
    footerLeft: clockLabel(payload.timestamp, tz(ctx)),
  });
  return [snapshotFrame(rows, 'Smart home', 'smart-home.command')];
}

// ---------------------------------------------------------------------------
// A4. Timers
// ---------------------------------------------------------------------------

function timerFiredFrame(timer = {}) {
  const name = fold(timer.label);
  const headline = name ? `${name} TIMER DONE` : 'TIMER DONE';
  const rows = borderFrame({
    color: 'orange',
    indent: 1,
    lines: ['', truncate(headline, BORDER_TEXT_WIDTH - 1), "TIME'S UP!", ''],
  });
  return alertFrame(rows, 'Timer fired', 'timer.fired');
}

function timerFrames(payload = {}, ctx = {}) {
  const event = payload.event || {};
  if (event.kind === 'fired') {
    return [timerFiredFrame(event.timer || (payload.timers || [])[0] || {})];
  }

  const running = (payload.timers || [])
    .filter((timer) => timer && timer.status === 'ON')
    .map((timer) => ({ ...timer, remaining: toNumber(timer.remainingSec) }))
    .sort((a, b) => (a.remaining ?? Infinity) - (b.remaining ?? Infinity));

  if (!running.length) {
    if (!ctx.explicit) {
      return [];
    }
    const rows = badgeFrame({
      color: 'orange',
      title: 'TIMERS',
      rows: ['', { left: 'NO TIMERS RUNNING', indent: 2 }, '', ''],
      footerLeft: 'ALL QUIET',
    });
    return [snapshotFrame(rows, 'Timers', 'timer.snapshot')];
  }

  const pages = paginate(running, TIMERS_PER_PAGE);
  const footerLeft = `${running.length} RUNNING`;

  return pages.map((page, index) => {
    const rows = badgeFrame({
      color: 'orange',
      title: 'TIMERS',
      rows: padRows(page.map((timer) => labelValueRow(
        timer.label || timer.device || 'TIMER',
        countdown(timer.remaining),
      ))),
      footerLeft,
      footerRight: pageCounter(index + 1, pages.length),
    });
    return snapshotFrame(rows, 'Timers', 'timer.snapshot');
  });
}

// ---------------------------------------------------------------------------
// A5. Alarms
// ---------------------------------------------------------------------------

function alarmFiredFrame(alarm = {}, ctx = {}) {
  const name = fold(alarm.label) || 'ALARM';
  const time = clockLabel(alarm.triggerTime, tz(ctx));
  const headline = time ? `${name} - ${time}` : name;
  const rows = borderFrame({
    color: 'red',
    indent: 1,
    lines: ['', truncate(headline, BORDER_TEXT_WIDTH - 1), 'RISE AND SHINE!', ''],
  });
  return alertFrame(rows, 'Alarm fired', 'alarm.fired');
}

function alarmFrames(payload = {}, ctx = {}) {
  const event = payload.event || {};
  if (event.kind === 'fired') {
    return [alarmFiredFrame(event.alarm || {}, ctx)];
  }

  const alarms = (payload.alarms || [])
    .filter((alarm) => alarm && alarm.status !== 'OFF')
    .map((alarm) => ({ ...alarm, at: toDate(alarm.triggerTime) }))
    .sort((a, b) => (a.at?.getTime() ?? Infinity) - (b.at?.getTime() ?? Infinity));

  if (!alarms.length) {
    if (!ctx.explicit) {
      return [];
    }
    const rows = badgeFrame({
      color: 'yellow',
      title: 'ALARMS',
      rows: ['', { left: 'NO ALARMS SET', indent: 2 }, '', ''],
      footerLeft: 'ALL QUIET',
    });
    return [snapshotFrame(rows, 'Alarms', 'alarm.snapshot')];
  }

  const next = alarms[0];
  const remaining = toNumber(next.remainingSec);
  const zone = tz(ctx);
  const footerLeft = remaining === null ? clockLabel(next.at, zone) : `NEXT IN ${durationLabel(remaining)}`;
  const now = toDate(ctx.now) || toDate(payload.timestamp) || new Date();

  // One alarm has room to say which day it lands on; a list does not, and the
  // times alone carry it.
  const content = alarms.length === 1
    ? [
      labelValueRow(clockLabel(next.at, zone), fitDevice(next.label || next.device, BODY_WIDTH)),
      dayPhrase(next.at, now, zone),
    ]
    : alarms.slice(0, MAX_BODY_ROWS).map((alarm) => labelValueRow(
      clockLabel(alarm.at, zone),
      fitDevice(alarm.label || alarm.device, BODY_WIDTH),
    ));

  const rows = badgeFrame({
    color: 'yellow',
    title: 'ALARMS',
    rows: padRows(content),
    footerLeft,
  });
  return [snapshotFrame(rows, 'Alarms', 'alarm.snapshot')];
}

// ---------------------------------------------------------------------------
// A6. Reminder fired
// ---------------------------------------------------------------------------

function reminderFrames(payload = {}) {
  const reminder = payload.event?.reminder || payload.reminder || {};
  const label = fold(reminder.label || payload.label);
  if (!label) {
    return [];
  }

  const device = fitDevice(reminder.device || payload.device, BORDER_TEXT_WIDTH - 1);
  const width = BORDER_TEXT_WIDTH - 1;
  const room = device ? MAX_BODY_ROWS - 2 : MAX_BODY_ROWS - 1;
  const lines = wrap(label, width).slice(0, room);

  const rows = borderFrame({
    color: 'white',
    indent: 1,
    lines: padRows(['REMINDER:', ...lines, device].filter(Boolean)),
  });
  return [alertFrame(rows, 'Reminder', 'reminder.fired')];
}

// ---------------------------------------------------------------------------
// A7. Shopping list
// ---------------------------------------------------------------------------

function shoppingListFrames(payload = {}, ctx = {}) {
  const items = (payload.items || [])
    .map((item) => truncate(item?.value ?? item, BODY_WIDTH))
    .filter(Boolean);

  const title = truncate(payload.listName || 'SHOPPING LIST', BADGE_TEXT_WIDTH);

  if (!items.length) {
    if (!ctx.explicit) {
      return [];
    }
    const rows = badgeFrame({
      color: 'green',
      title,
      rows: ['', { left: 'LIST IS EMPTY', indent: 2 }, '', ''],
      footerLeft: 'NOTHING TO GET',
    });
    return [snapshotFrame(rows, 'Shopping list', 'shopping-list.snapshot')];
  }

  const pages = paginate(items, ITEMS_PER_PAGE);
  const footerLeft = `${items.length} ${items.length === 1 ? 'ITEM' : 'ITEMS'}`;

  return pages.map((page, index) => {
    const rows = badgeFrame({
      color: 'green',
      title,
      rows: padRows(page),
      footerLeft,
      footerRight: pageCounter(index + 1, pages.length),
    });
    return snapshotFrame(rows, 'Shopping list', 'shopping-list.snapshot');
  });
}

// ---------------------------------------------------------------------------
// A8. Weather
// ---------------------------------------------------------------------------

/**
 * The one hourly worth mentioning: strong wind first, then a real chance of
 * rain. Neither means the row stays blank rather than inventing a headline.
 */
function notableHourly(hourlies = [], ctx = {}) {
  let windiest = null;
  let wettest = null;

  for (const hour of hourlies) {
    const wind = toNumber(hour?.windSpeedMph);
    if (wind !== null && (!windiest || wind > toNumber(windiest.windSpeedMph))) {
      windiest = hour;
    }
    const rain = toNumber(hour?.precipitationProbability);
    if (rain !== null && (!wettest || rain > toNumber(wettest.precipitationProbability))) {
      wettest = hour;
    }
  }

  const wind = toNumber(windiest?.windSpeedMph);
  if (wind !== null && wind >= NOTABLE_WIND_MPH) {
    return `WINDY ${partOfDay(windiest.time, tz(ctx))} - ${formatWhole(wind)} MPH`;
  }

  const rain = toNumber(wettest?.precipitationProbability);
  if (rain !== null && rain >= NOTABLE_RAIN_PERCENT) {
    return `RAIN ${partOfDay(wettest.time, tz(ctx))} - ${formatWhole(rain)}%`;
  }

  return '';
}

function tomorrowLine(day) {
  if (!day) {
    return '';
  }
  const parts = [
    weekday(parseYmd(day.date), { short: true }),
    degrees(day.highF),
    conditionWord(day.condition),
  ].filter(Boolean);

  const rain = toNumber(day.precipitationProbability);
  if (rain) {
    parts.push(`${formatWhole(rain)}%`);
  }
  return parts.join(' ');
}

function weatherFrames(payload = {}, ctx = {}) {
  const weather = payload.weather;
  const current = weather?.current;
  if (!current) {
    return [];
  }

  const today = weather.next7Days?.[0];
  const nowLine = ['NOW', degrees(current.temperatureF), conditionWord(current.condition)]
    .filter(Boolean)
    .join(' ');
  const highLow = today
    ? ['HIGH', degrees(today.highF), 'LOW', degrees(today.lowF)].filter(Boolean).join(' ')
    : '';

  const rows = badgeFrame({
    color: 'blue',
    title: 'WEATHER',
    rows: padRows([nowLine, highLow, notableHourly(weather.next24Hours, ctx)].filter(Boolean)),
    footerLeft: tomorrowLine(weather.next7Days?.[1]),
  });
  return [snapshotFrame(rows, 'Weather', 'weather.query')];
}

// ---------------------------------------------------------------------------
// A9. Indoor temperature
// ---------------------------------------------------------------------------

/**
 * One row per named sensor when the house has several, otherwise the single
 * reading the voice query resolved.
 */
function indoorTemperatureFrames(payload = {}, ctx = {}) {
  const monitors = (ctx.monitors || payload.monitors || [])
    .map((monitor) => ({
      label: fold(monitor?.label || monitor?.id),
      temperatureF: toNumber(monitor?.reading?.temperatureF ?? monitor?.temperatureF),
      humidity: toNumber(monitor?.reading?.humidity ?? monitor?.humidity),
    }))
    .filter((monitor) => monitor.label && monitor.temperatureF !== null);

  const reading = payload.reading || {};
  const rows = [];
  let humidity = null;

  if (monitors.length) {
    for (const monitor of monitors.slice(0, MAX_BODY_ROWS)) {
      rows.push(labelValueRow(monitor.label, degrees(monitor.temperatureF)));
    }
    humidity = monitors.find((monitor) => monitor.humidity !== null)?.humidity ?? null;
  } else {
    const temperature = toNumber(reading.temperatureF);
    if (temperature === null) {
      return [];
    }
    const label = fold(payload.location?.label || reading.locationPhrase) || 'INDOOR';
    rows.push('', labelValueRow(label, degrees(temperature)));
    humidity = toNumber(reading.humidity);
  }

  const frame = badgeFrame({
    color: 'blue',
    title: 'INDOOR TEMP',
    rows: padRows(rows),
    footerLeft: humidity === null ? clockLabel(payload.timestamp, tz(ctx)) : `HUMIDITY ${formatWhole(humidity)}%`,
  });
  return [snapshotFrame(frame, 'Indoor temp', 'indoor-temperature.query')];
}

// ---------------------------------------------------------------------------
// A10. Air quality
// ---------------------------------------------------------------------------

/** `MAIN FLOOR   99g 76°` — label left, then score, band chip and temperature. */
function airQualityRow(monitor) {
  const row = blankRow(COLS);
  const right = [...encodeText(formatWhole(monitor.iaqScore))];
  right.push(chipCode(BAND_CHIPS[monitor.band] || BAND_CHIPS.unknown));
  const temperature = degrees(monitor.temperatureF);
  if (temperature) {
    // Folding trims a leading space, so the gap is a blank code, not text.
    right.push(BLANK, ...encodeText(temperature));
  }

  placeCodes(row, right, BODY_TO - right.length + 1);
  placeText(row, truncate(monitor.label, BODY_WIDTH - right.length - 1), BODY_FROM);
  return row;
}

const BAND_SEVERITY = {
  good: 0, unknown: 1, fair: 2, moderate: 3, poor: 4,
};

/**
 * Fit `LABEL PHRASE` into the footer, dropping to a shorter phrase before
 * cutting the label. "MAIN FLOOR HOT" says the thing; "MAIN FLOOR RUNNI"
 * says nothing.
 */
function insightLine(label, phrase, shortPhrase = phrase) {
  const full = `${label} ${phrase}`;
  if (full.length <= BADGE_TEXT_WIDTH) {
    return full;
  }
  const short = `${label} ${shortPhrase}`;
  if (short.length <= BADGE_TEXT_WIDTH) {
    return short;
  }
  const room = BADGE_TEXT_WIDTH - shortPhrase.length - 1;
  return `${truncate(label, Math.max(1, room))} ${shortPhrase}`;
}

/**
 * The footer says the one thing worth knowing. Heat beats air score, because
 * a 114° room is a problem you can act on and a fair reading usually is not.
 */
function airQualityInsight(monitors) {
  const hottest = monitors
    .filter((monitor) => (monitor.temperatureF ?? 0) >= HOT_MONITOR_F)
    .sort((a, b) => b.temperatureF - a.temperatureF)[0];
  if (hottest) {
    return insightLine(hottest.label, 'RUNNING HOT', 'HOT');
  }

  const worst = [...monitors].sort(
    (a, b) => (BAND_SEVERITY[b.band] ?? 1) - (BAND_SEVERITY[a.band] ?? 1),
  )[0];
  if (worst && (BAND_SEVERITY[worst.band] ?? 1) >= BAND_SEVERITY.fair) {
    return insightLine(worst.label, worst.band.toUpperCase());
  }
  return 'ALL CLEAR';
}

function airQualityFrames(payload = {}) {
  const monitors = (payload.monitors || [])
    .map((monitor) => ({
      label: fold(monitor?.label || monitor?.id),
      iaqScore: toNumber(monitor?.iaqScore),
      band: String(monitor?.band || 'unknown').toLowerCase(),
      temperatureF: toNumber(monitor?.reading?.temperatureF),
    }))
    .filter((monitor) => monitor.label && monitor.iaqScore !== null);

  if (!monitors.length) {
    return [];
  }

  const pages = paginate(monitors, MAX_BODY_ROWS);
  const footerLeft = airQualityInsight(monitors);

  return pages.map((page, index) => {
    const rows = badgeFrame({
      color: 'green',
      title: 'AIR QUALITY',
      rows: padRows(page.map(airQualityRow)),
      footerLeft,
      footerRight: pageCounter(index + 1, pages.length),
    });
    return snapshotFrame(rows, 'Air quality', 'air-quality.query');
  });
}

// ---------------------------------------------------------------------------
// A11. Music
// ---------------------------------------------------------------------------

function musicFrames(payload = {}) {
  const music = payload.music;
  if (!music || music.empty || music.state === 'IDLE') {
    return [];
  }

  const song = fold(music.song);
  const artist = fold(music.artist);
  if (!song && !artist) {
    return [];
  }

  const content = [];
  if (artist) {
    content.push(...wrap(artist, BODY_WIDTH));
  }
  const album = fold(music.album);
  if (album) {
    content.push(truncate(album, BODY_WIDTH));
  }
  if (song) {
    content.push(...wrap(`'${song}'`, BODY_WIDTH));
  }

  const rows = badgeFrame({
    color: 'violet',
    title: 'NOW PLAYING',
    rows: padRows(content),
    footerLeft: fitDevice(music.device || payload.device, BADGE_TEXT_WIDTH),
  });
  return [snapshotFrame(rows, 'Now playing', 'music.playing')];
}

// ---------------------------------------------------------------------------
// A12. Notifications
// ---------------------------------------------------------------------------

function notificationFrames(payload = {}) {
  const notifications = payload.notifications;
  const items = (notifications?.items || []).map((item) => fold(item)).filter(Boolean);
  if (!items.length) {
    return [];
  }

  const isDelivery = notifications?.category === 'delivery'
    || notifications?.source === 'amazon-shopping';
  const title = isDelivery ? 'AMAZON DELIVERY' : 'NOTIFICATIONS';
  const content = [`${items.length} NEW`, ...wrap(items[0], BODY_WIDTH)];
  const rows = badgeFrame({
    color: 'yellow',
    title,
    rows: padRows(content),
  });
  return [snapshotFrame(rows, isDelivery ? 'Amazon delivery' : 'Notifications', 'alexa-notifications.query')];
}

// ---------------------------------------------------------------------------
// A13. Vivint
// ---------------------------------------------------------------------------

function vivintFrames(payload = {}, ctx = {}) {
  const alarm = payload.alarm;
  const status = fold(alarm?.status);
  if (!status || status === 'UNKNOWN') {
    return [];
  }

  const mode = fold(alarm?.mode);
  const armed = status === 'ARMED';
  const text = `SYSTEM: ${status}${armed && mode ? ` ${mode}` : ''}`;

  const rows = badgeFrame({
    color: 'white',
    title: fold(alarm?.provider) || 'VIVINT',
    rows: ['', chipRightRow(text, armed ? 'green' : 'orange'), '', ''],
    footerLeft: clockLabel(payload.timestamp, tz(ctx)),
  });
  return [snapshotFrame(rows, 'Security', 'vivint-alarm.query')];
}

// ---------------------------------------------------------------------------

// Keyed by the UDP payload type so the router can dispatch without a switch.
const FORMATTERS = {
  broadcast: broadcastFrames,
  'time.query': timeFrames,
  'smart-home.command': smartHomeFrames,
  'timer.snapshot': timerFrames,
  'alarm.snapshot': alarmFrames,
  'reminder.fired': reminderFrames,
  'shopping-list.snapshot': shoppingListFrames,
  'weather.query': weatherFrames,
  'indoor-temperature.query': indoorTemperatureFrames,
  'air-quality.query': airQualityFrames,
  'music.playing': musicFrames,
  'alexa-notifications.query': notificationFrames,
  'vivint-alarm.query': vivintFrames,
};

/** Frames for any Alexa-family payload, or `[]` when the type is not ours. */
function framesFor(payload, ctx = {}) {
  const formatter = FORMATTERS[payload?.type];
  return formatter ? formatter(payload, ctx) : [];
}

module.exports = {
  FORMATTERS,
  BAND_CHIPS,
  CONDITION_WORDS,
  framesFor,
  fitDevice,
  notableHourly,
  airQualityInsight,
  broadcastFrames,
  timeFrames,
  smartHomeFrames,
  timerFrames,
  alarmFrames,
  reminderFrames,
  shoppingListFrames,
  weatherFrames,
  indoorTemperatureFrames,
  airQualityFrames,
  musicFrames,
  notificationFrames,
  vivintFrames,
};
