/**
 * Flight Plan change detection for material updates.
 */

const { isMaterialDelay, normaliseStatusCode } = require('./flightplan-status');

function pickTime(block = {}) {
  return block?.revisedTime?.local
    || block?.estimatedTime?.local
    || block?.actualTime?.local
    || block?.scheduledTime?.local
    || block?.scheduledTime?.utc
    || null;
}

function snapshotComparable(flight = {}) {
  const latest = flight.latest || {};
  const dep = latest.departure || {};
  const arr = latest.arrival || {};
  return {
    date: flight.date || null,
    status: normaliseStatusCode(latest.status || latest.flightStatus || flight.state),
    depTime: pickTime(dep) || flight.scheduled?.departure || null,
    arrTime: pickTime(arr) || flight.scheduled?.arrival || null,
    depGate: dep.gate || latest.departureGate || null,
    arrGate: arr.gate || latest.arrivalGate || null,
    depTerminal: dep.terminal || null,
    arrTerminal: arr.terminal || null,
    baggageBelt: arr.baggageBelt || latest.baggageBelt || null,
  };
}

function diffMaterial(before = {}, after = {}, { materialDelayMinutes = 15 } = {}) {
  const changes = [];
  if (before.date !== after.date && after.date) {
    changes.push({ field: 'date', from: before.date, to: after.date });
  }
  if (before.status !== after.status && after.status) {
    changes.push({ field: 'status', from: before.status, to: after.status });
  }
  if (isMaterialDelay(before.depTime, after.depTime, materialDelayMinutes)
    || isMaterialDelay(before.arrTime, after.arrTime, materialDelayMinutes)) {
    changes.push({ field: 'time', from: before.depTime, to: after.depTime });
  }
  if (before.depGate !== after.depGate && after.depGate) {
    changes.push({ field: 'depGate', from: before.depGate, to: after.depGate });
  }
  if (before.arrGate !== after.arrGate && after.arrGate) {
    changes.push({ field: 'arrGate', from: before.arrGate, to: after.arrGate });
  }
  if (before.depTerminal !== after.depTerminal && after.depTerminal) {
    changes.push({ field: 'depTerminal', from: before.depTerminal, to: after.depTerminal });
  }
  if (before.arrTerminal !== after.arrTerminal && after.arrTerminal) {
    changes.push({ field: 'arrTerminal', from: before.arrTerminal, to: after.arrTerminal });
  }
  if (before.baggageBelt !== after.baggageBelt && after.baggageBelt) {
    changes.push({ field: 'baggageBelt', from: before.baggageBelt, to: after.baggageBelt });
  }
  return changes;
}

function isMaterialChange(changes = []) {
  if (!changes.length) return false;
  const materialFields = new Set([
    'date', 'status', 'time', 'depGate', 'arrGate', 'depTerminal', 'arrTerminal', 'baggageBelt',
  ]);
  return changes.some((row) => materialFields.has(row.field));
}

module.exports = {
  snapshotComparable,
  diffMaterial,
  isMaterialChange,
  pickTime,
};
