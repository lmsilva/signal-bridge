// Tesla family of board frames (03 §B).
//
// The UDP payload key is `dashboard` for the full card and `battery` for the
// gauge — never `reading`. That last name is only the on-disk cache key, and
// reading it here would blank every battery flip.

const {
  COLS,
  blankRow,
  placeCodes,
  placeText,
  fold,
  toNumber,
  formatWhole,
} = require('../encoder');

const {
  BODY_FROM,
  chipCode,
  lr,
  badgeFrame,
  gauge,
} = require('../frames');

const { toDate, clockLabel } = require('../clock');
const { snapshotFrame, padRows } = require('./common');

function degrees(value) {
  const whole = formatWhole(value);
  return whole ? `${whole}\u00b0` : '';
}

function teslaTitle(model) {
  const folded = fold(model);
  if (!folded || folded === 'TESLA') {
    return 'TESLA';
  }
  return folded.startsWith('TESLA ') ? folded : `TESLA ${folded}`;
}

/**
 * Amber on the overlay is `stale && !refreshing`. A live refresh reuses the
 * last snapshot with `refreshing: true` so the board must not look stale for
 * that brief window. `freshnessSec` is recomputed on every cache read and
 * is not a staleness signal.
 */
function isStale(record) {
  return Boolean(record?.stale) && !record?.refreshing;
}

/** Footer time, with an orange chip in front when the snapshot is cached. */
function stampFooter(layout, when, stale, timeZone) {
  const time = clockLabel(when, { timeZone });
  if (!stale || !time) {
    return layout;
  }
  const row = layout[layout.length - 1];
  for (let column = 2; column < COLS - 2; column += 1) {
    row[column] = 0;
  }
  row[3] = chipCode('orange');
  placeText(row, time, 5);
  return layout;
}

function snapshotAt(record, payload) {
  return toDate(record?.fetchedAt) || toDate(payload?.timestamp) || new Date();
}

function drivingSpeed(chip) {
  const match = String(chip || '').match(/(\d+)\s*mph/i);
  return match ? Number(match[1]) : null;
}

function isDriving(chip) {
  const text = String(chip || '');
  if (/\bPark\b/i.test(text)) {
    return false;
  }
  return /\b(Drive|R)\b/i.test(text) || drivingSpeed(text) > 0;
}

function parkLabel(chargingLabel) {
  const folded = fold(chargingLabel);
  if (!folded || folded === 'NOT PLUGGED IN') {
    return 'NOT PLUGGED';
  }
  return folded;
}

/**
 * One line for what the car is doing. Charging wins over parked; driving
 * wins over both, because a moving car is the thing you notice from the room.
 */
function stateLine(dashboard = {}) {
  const battery = dashboard.battery || {};
  const chip = dashboard.map?.drivingChip;
  const speed = drivingSpeed(chip);

  if (isDriving(chip) && speed !== null) {
    return `DRIVING ${formatWhole(speed)} MPH`;
  }

  if (battery.charging) {
    const kw = toNumber(battery.chargerPowerKw);
    return kw === null ? 'CHARGING' : `CHARGING +${formatWhole(kw)}KW`;
  }

  return `PARKED - ${parkLabel(battery.chargingLabel)}`;
}

function securityLine(security = {}) {
  if (security.locked == null && security.sentryOn == null) {
    return '';
  }
  const parts = [security.locked ? 'LOCKED' : 'UNLOCKED'];
  if (security.sentryOn) {
    parts.push('SENTRY ON');
  }
  return parts.join(' - ');
}

function climateRow(climate = {}) {
  const inside = degrees(climate.insideTempF);
  const outside = degrees(climate.outsideTempF);
  if (!inside && !outside) {
    return '';
  }
  if (inside && outside) {
    return lr(`IN ${inside}`, `OUT ${outside}`, { from: 0, to: 14 });
  }
  return { left: inside ? `IN ${inside}` : `OUT ${outside}`, indent: 0 };
}

function dashboardFrames(payload = {}, ctx = {}) {
  const dashboard = payload.dashboard;
  const battery = dashboard?.battery;
  const percent = toNumber(battery?.percent);
  if (!dashboard || percent === null) {
    return [];
  }

  const range = toNumber(battery.rangeMiles);
  const battLeft = `BATT ${formatWhole(percent)}%`;
  const battRight = range === null ? '' : `RANGE ${formatWhole(range)}MI`;
  const zone = { timeZone: ctx.timeZone };

  const rows = badgeFrame({
    color: 'red',
    title: teslaTitle(dashboard.vehicle?.model),
    rows: padRows([
      battRight
        ? { left: battLeft, right: battRight, indent: 0, to: COLS - 2 }
        : { left: battLeft, indent: 0 },
      { left: stateLine(dashboard), indent: 0 },
      climateRow(dashboard.climate),
      { left: securityLine(dashboard.security), indent: 0 },
    ]),
    footerLeft: clockLabel(snapshotAt(dashboard, payload), zone),
  });

  stampFooter(rows, snapshotAt(dashboard, payload), isStale(dashboard), ctx.timeZone);
  return [snapshotFrame(rows, 'Tesla', 'tesla-dashboard.query')];
}

function gaugeRow(percent) {
  const filled = Math.round((toNumber(percent) || 0) / 100 * 18);
  const row = blankRow(COLS);
  placeCodes(row, gauge(filled, 18), BODY_FROM);
  return row;
}

function fullAtLabel(minutes, now, timeZone) {
  const span = toNumber(minutes);
  if (span === null) {
    return '';
  }
  const origin = toDate(now) || new Date();
  return `FULL AT ${clockLabel(new Date(origin.getTime() + span * 60000), { timeZone })}`;
}

function batteryFrames(payload = {}, ctx = {}) {
  const battery = payload.battery || payload.reading;
  const percent = toNumber(battery?.percent);
  if (percent === null) {
    return [];
  }

  const range = toNumber(battery.rangeMiles ?? battery.batteryRange);
  const headline = range === null
    ? `${formatWhole(percent)}%`
    : `${formatWhole(percent)}% - ${formatWhole(range)} MI RANGE`;

  const minutes = toNumber(battery.timeToFullChargeMin ?? ctx.timeToFullChargeMin);
  const when = snapshotAt(battery, payload);
  const zone = { timeZone: ctx.timeZone };
  const footerLeft = minutes === null
    ? `AS OF ${clockLabel(when, zone)}`
    : fullAtLabel(minutes, when, ctx.timeZone);

  const rows = badgeFrame({
    color: 'green',
    title: 'TESLA BATTERY',
    rows: padRows([
      '',
      headline,
      gaugeRow(percent),
      fold(battery.chargingLabel),
    ]),
    footerLeft,
  });

  return [snapshotFrame(rows, 'Tesla battery', 'tesla-battery.query')];
}

const FORMATTERS = {
  'tesla-dashboard.query': dashboardFrames,
  'tesla-battery.query': batteryFrames,
};

function framesFor(payload, ctx = {}) {
  const formatter = FORMATTERS[payload?.type];
  return formatter ? formatter(payload, ctx) : [];
}

module.exports = {
  FORMATTERS,
  framesFor,
  dashboardFrames,
  batteryFrames,
  stateLine,
  isStale,
  teslaTitle,
};
