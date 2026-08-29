/**
 * Shared Flight Plan status vocabulary — one source for panel, board, and change detection.
 */

const STATUS_COLOURS = Object.freeze({
  GOOD: 'GOOD',
  WARN: 'WARN',
  ALERT: 'ALERT',
  ACCENT: 'ACCENT',
  INK_3: 'INK_3',
});

function parseIsoMs(value) {
  if (!value) return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

function minutesBetween(a, b) {
  const am = parseIsoMs(a);
  const bm = parseIsoMs(b);
  if (am == null || bm == null) return 0;
  return Math.round(Math.abs(bm - am) / 60_000);
}

function delayMinutes(scheduled, estimated) {
  return minutesBetween(scheduled, estimated);
}

function isMaterialDelay(scheduled, estimated, thresholdMinutes = 15) {
  return delayMinutes(scheduled, estimated) >= thresholdMinutes;
}

function normaliseStatusCode(raw = '') {
  const text = String(raw || '').trim().toLowerCase();
  if (!text) return 'unknown';
  if (text.includes('cancel')) return 'cancelled';
  if (text.includes('divert')) return 'diverted';
  if (text.includes('land')) return 'landed';
  if (text.includes('depart') || text.includes('active') || text.includes('en-route') || text.includes('enroute')) {
    return 'departed';
  }
  if (text.includes('board')) return 'boarding';
  if (text.includes('delay')) return 'delayed';
  if (text.includes('schedule') || text.includes('expected') || text.includes('on time')) return 'on_time';
  return text;
}

function gateOrTerminalLine({ gate, terminal, belt } = {}) {
  const parts = [];
  if (gate) parts.push(`GATE ${String(gate).toUpperCase()}`);
  if (terminal) parts.push(`TERM ${String(terminal).toUpperCase()}`);
  if (belt) parts.push(`BAG BELT ${String(belt).toUpperCase()}`);
  return parts.join(' · ');
}

/** Panel-facing colour names. The panel cannot read the `GOOD`/`WARN` tokens. */
const COLOUR_TOKENS = Object.freeze({
  GOOD: 'good',
  WARN: 'warn',
  ALERT: 'alert',
  ACCENT: 'accent',
  INK_3: 'muted',
});

/**
 * Resolve display status from a normalised flight snapshot.
 * @param {object} flight
 * @param {object} options materialDelayMinutes
 */
function resolveFlightStatus(flight = {}, options = {}) {
  const status = resolveStatusBase(flight, options);
  return {
    ...status,
    colorToken: COLOUR_TOKENS[status.colour] || 'muted',
    headline: trackerHeadline(status, flight),
    gateLine: shortGateLine(flight, status),
  };
}

/** One-line status for a Vestaboard tracker card — no gate, no middot. */
function trackerHeadline(status = {}, flight = {}) {
  switch (status.code) {
    case 'cancelled':
      return 'CANCELLED';
    case 'diverted':
      return String(status.displayLine || 'DIVERTED').replace(/\s*·.*$/, '');
    case 'landed':
      return 'LANDED';
    case 'departed':
      return flight.state === 'active' ? 'IN FLIGHT' : 'DEPARTED';
    case 'boarding':
      return 'BOARDING';
    case 'delayed': {
      const match = String(status.displayLine || '').match(/DELAYED \d+ MIN/);
      return match ? match[0] : 'DELAYED';
    }
    case 'unknown':
      return 'NO UPDATE';
    default:
      return 'ON TIME';
  }
}

/** Gate / belt only — status lives on its own row on the tracker card. */
function shortGateLine(flight = {}, status = {}) {
  const latest = flight.latest || {};
  const dep = latest.departure || {};
  const arr = latest.arrival || {};
  const gate = dep.gate || latest.departureGate;
  const terminal = dep.terminal;
  const belt = arr.baggageBelt || latest.baggageBelt;
  if (status.code === 'landed' && belt) return `BAG BELT ${String(belt).toUpperCase()}`;
  if (gate) return `GATE ${String(gate).toUpperCase()}`;
  if (terminal) return `TERM ${String(terminal).toUpperCase()}`;
  if (belt) return `BAG BELT ${String(belt).toUpperCase()}`;
  return '';
}

function resolveStatusBase(flight = {}, options = {}) {
  const threshold = Number(options.materialDelayMinutes) || 15;
  const latest = flight.latest || {};
  const statusRaw = latest.status || latest.flightStatus || flight.state || '';
  const code = normaliseStatusCode(statusRaw);
  const dep = latest.departure || {};
  const arr = latest.arrival || {};
  const scheduledDep = flight.scheduled?.departure || dep.scheduledTime?.local || dep.scheduledTime?.utc;
  const estimatedDep = dep.revisedTime?.local || dep.estimatedTime?.local || dep.actualTime?.local;
  const scheduledArr = flight.scheduled?.arrival || arr.scheduledTime?.local || arr.scheduledTime?.utc;
  const estimatedArr = arr.revisedTime?.local || arr.estimatedTime?.local || arr.actualTime?.local;
  const depDelay = isMaterialDelay(scheduledDep, estimatedDep, threshold);
  const arrDelay = isMaterialDelay(scheduledArr, estimatedArr, threshold);
  const gateLine = gateOrTerminalLine({
    gate: dep.gate || latest.departureGate,
    terminal: dep.terminal,
    belt: arr.baggageBelt || latest.baggageBelt,
  });

  if (code === 'cancelled') {
    return {
      code: 'cancelled',
      displayLine: 'CANCELLED',
      colour: STATUS_COLOURS.ALERT,
      boardCode: 'CNX',
      chip: 'red',
    };
  }
  if (code === 'diverted') {
    const dest = arr.diversionAirport?.iata || arr.diversionAirport?.icao || 'UNK';
    return {
      code: 'diverted',
      displayLine: `DIVERTED TO ${dest}`,
      colour: STATUS_COLOURS.ALERT,
      boardCode: 'DIV',
      chip: 'red',
    };
  }
  if (code === 'landed' || flight.state === 'landed') {
    const belt = arr.baggageBelt || latest.baggageBelt;
    const line = belt ? `LANDED · BAG BELT ${belt}` : 'LANDED';
    return {
      code: 'landed',
      displayLine: line,
      colour: STATUS_COLOURS.GOOD,
      boardCode: 'ARR',
      chip: 'white',
    };
  }
  if (code === 'departed' || flight.state === 'active') {
    const time = estimatedDep || scheduledDep;
    const hhmm = formatTimeShort(time);
    return {
      code: 'departed',
      displayLine: hhmm ? `DEPARTED ${hhmm}` : 'DEPARTED',
      colour: STATUS_COLOURS.ACCENT,
      boardCode: 'DEP',
      chip: 'blue',
    };
  }
  if (code === 'boarding') {
    return {
      code: 'boarding',
      displayLine: gateLine ? `BOARDING · ${gateLine}` : 'BOARDING',
      colour: STATUS_COLOURS.GOOD,
      boardCode: 'BRD',
      chip: 'green',
    };
  }
  if (code === 'delayed' || depDelay || arrDelay) {
    const mins = Math.max(delayMinutes(scheduledDep, estimatedDep), delayMinutes(scheduledArr, estimatedArr));
    const delayText = mins >= threshold ? `DELAYED ${mins} MIN` : 'ON TIME';
    if (mins < threshold) {
      return {
        code: 'on_time',
        displayLine: gateLine ? `ON TIME · ${gateLine}` : 'ON TIME',
        colour: STATUS_COLOURS.GOOD,
        boardCode: 'ON',
        chip: 'green',
      };
    }
    return {
      code: 'delayed',
      displayLine: gateLine ? `${delayText} · ${gateLine}` : delayText,
      colour: STATUS_COLOURS.WARN,
      boardCode: `+${Math.min(999, mins)}`.slice(0, 4),
      chip: 'orange',
    };
  }
  if (code === 'unknown') {
    const stale = options.asOf ? `NO UPDATE SINCE ${formatTimeShort(options.asOf)}` : 'NO UPDATE';
    return {
      code: 'unknown',
      displayLine: stale,
      colour: STATUS_COLOURS.INK_3,
      boardCode: '--',
      chip: 'white',
    };
  }
  return {
    code: 'on_time',
    displayLine: gateLine ? `ON TIME · ${gateLine}` : 'ON TIME',
    colour: STATUS_COLOURS.GOOD,
    boardCode: 'ON',
    chip: 'green',
  };
}

function formatTimeShort(value) {
  const ms = parseIsoMs(value);
  if (ms == null) {
    const text = String(value || '').trim();
    const match = text.match(/(\d{1,2}):(\d{2})/);
    if (match) return `${match[1].padStart(2, '0')}:${match[2]}`;
    return '';
  }
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function parseHourMinute(value) {
  // Prefer the wall-clock embedded in the stamp — that is the airport-local
  // time the passenger cares about. Converting the absolute Instant through a
  // UTC Docker host would rewrite 13:45-07:00 into 20:45.
  // AeroDataBox local stamps arrive as `2026-09-10 10:15-06:00` or ISO with `T`.
  const text = String(value || '').trim();
  const iso = text.match(/\d{4}-\d{2}-\d{2}[T ](\d{2}):(\d{2})/);
  if (iso) return { hour: Number(iso[1]), minute: Number(iso[2]) };
  const loose = text.match(/(?:^|\s)(\d{1,2}):(\d{2})/);
  if (loose) return { hour: Number(loose[1]), minute: Number(loose[2]) };
  const ms = parseIsoMs(value);
  if (ms == null) return null;
  const d = new Date(ms);
  return { hour: d.getHours(), minute: d.getMinutes() };
}

function formatBoardTime(value) {
  const parts = parseHourMinute(value);
  if (!parts) return '----';
  return `${String(parts.hour).padStart(2, '0')}${String(parts.minute).padStart(2, '0')}`;
}

/** 12-hour clock with A/P suffix for a tracker card: 13:45 → 1:45P. */
function formatTrackerClock(value) {
  const parts = parseHourMinute(value);
  if (!parts) return '';
  const ampm = parts.hour >= 12 ? 'P' : 'A';
  let hour = parts.hour % 12;
  if (hour === 0) hour = 12;
  return `${hour}:${String(parts.minute).padStart(2, '0')}${ampm}`;
}

function stampFromLeg(node = {}) {
  return node.actualTime?.local
    || node.revisedTime?.local
    || node.estimatedTime?.local
    || node.scheduledTime?.local
    || '';
}

function bestDepartureStamp(flight = {}) {
  return stampFromLeg(flight.latest?.departure) || flight.scheduled?.departure || '';
}

function bestArrivalStamp(flight = {}) {
  return stampFromLeg(flight.latest?.arrival) || flight.scheduled?.arrival || '';
}

function formatBoardFlightNumber(airline = '', number = '') {
  let code = String(airline || '').trim().toUpperCase();
  let num = String(number || '').trim().toUpperCase().replace(/\s+/g, '');
  if (code && num.startsWith(code)) {
    num = num.slice(code.length);
  }
  if (!code) {
    const match = /^([A-Z]{2,3})(\d+)$/.exec(num);
    if (match) {
      code = match[1];
      num = match[2];
    }
  }
  code = code.slice(0, 2);
  num = num.replace(/\D/g, '');
  return `${code}${num.padStart(4, '0')}`.slice(0, 6);
}

/** Readable flight number for a tracker card: DL 167, never DL0167. */
function formatTrackerFlightNumber(airline = '', number = '') {
  const packed = formatBoardFlightNumber(airline, number);
  const letters = packed.slice(0, 2).replace(/[^A-Z]/g, '');
  const digits = packed.slice(letters.length).replace(/^0+/, '');
  if (!letters || !digits) return '';
  return `${letters} ${digits}`;
}

module.exports = {
  STATUS_COLOURS,
  normaliseStatusCode,
  resolveFlightStatus,
  isMaterialDelay,
  delayMinutes,
  minutesBetween,
  parseIsoMs,
  formatTimeShort,
  formatBoardTime,
  formatTrackerClock,
  formatTrackerFlightNumber,
  formatBoardFlightNumber,
  bestDepartureStamp,
  bestArrivalStamp,
  trackerHeadline,
  shortGateLine,
  gateOrTerminalLine,
};
