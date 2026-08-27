/**
 * Flight Plan background poller — budget-aware poll ladder + change detection.
 */

const { diffMaterial, isMaterialChange, snapshotComparable } = require('./flightplan-changes');
const { mapLeg } = require('./flightplan-api');
const { parseDepartureMs } = require('./flightplan-store');

const POLL_24H_MS = 60 * 60 * 1000;
const POLL_3H_MS = 15 * 60 * 1000;

function pollIntervalMs(flight, nowMs = Date.now()) {
  const depMs = parseDepartureMs(flight);
  if (depMs == null) return null;
  const hoursOut = (depMs - nowMs) / 3_600_000;
  if (hoursOut > 24) return null;
  if (hoursOut > 3) return POLL_24H_MS;
  if (hoursOut > 0) return POLL_3H_MS;
  if (flight.state === 'active') return null;
  return POLL_3H_MS;
}

function createFlightplanPoller({
  store,
  api,
  settings,
  ledger,
  live,
  payload,
  sendUdpPayload,
  log = console,
  now = () => Date.now(),
} = {}) {
  let timer = null;
  let running = false;
  const lastPollAt = new Map();
  const lastAutoPushAt = new Map();
  const lastPushFingerprint = new Map();
  let currentFlightId = null;

  function shouldBackgroundPoll() {
    const state = ledger?.state?.() || 'ok';
    return state === 'ok';
  }

  async function refreshFlight(flightId, { manual = false } = {}) {
    const flight = store.getFlight(flightId);
    if (!flight) return { ok: false, error: 'Flight not found' };
    const before = snapshotComparable(flight);
    const result = await api.fetchFlightStatus({
      airline: flight.airline,
      number: flight.number,
      date: flight.date,
      manual,
    });
    if (!result.ok || !result.leg) {
      return { ok: false, error: 'Status fetch failed' };
    }
    const leg = result.leg;
    const latest = leg.raw || leg;
    const patch = {
      origin: leg.origin,
      destination: leg.destination,
      scheduled: leg.scheduled,
      latest,
      registration: leg.registration || flight.registration,
      callsign: leg.callsign || flight.callsign,
    };
    const status = String(latest.status || latest.flightStatus || '').toLowerCase();
    if (status.includes('land')) patch.state = 'landed';
    else if (status.includes('depart') || status.includes('active') || status.includes('en-route')) {
      patch.state = 'active';
    }
    const updated = store.updateFlight(flightId, patch);
    const after = snapshotComparable(updated.flight);
    const changes = diffMaterial(before, after, {
      materialDelayMinutes: settings.get().materialDelayMinutes,
    });
    if (changes.length) {
      store.appendFlightHistory(flightId, { changes, manual });
    }
    return { ok: true, flight: updated.flight, changes, material: isMaterialChange(changes) };
  }

  function pushFingerprint(body) {
    return JSON.stringify({
      flightId: body?.flight?.id,
      status: body?.status?.displayLine,
      dep: body?.flight?.scheduled?.departure,
      arr: body?.flight?.scheduled?.arrival,
    });
  }

  async function maybeAutoPush(flightId, changes = []) {
    const cfg = settings.get();
    if (!cfg.autoPushEnabled || cfg.pollerLogOnly) return { pushed: false, reason: 'log-only' };
    if (!isMaterialChange(changes)) return { pushed: false, reason: 'not-material' };
    const cooldownMs = (cfg.autoPushCooldownMinutes || 10) * 60_000;
    const lastPush = lastAutoPushAt.get(flightId) || 0;
    if (now() - lastPush < cooldownMs) return { pushed: false, reason: 'cooldown' };
    if (!payload?.buildFlight || !sendUdpPayload) return { pushed: false, reason: 'no-sender' };
    const body = await payload.buildFlight({ mode: 'auto', flightId });
    if (!body) return { pushed: false, reason: 'no-payload' };
    const fp = pushFingerprint(body);
    if (lastPushFingerprint.get(flightId) === fp) return { pushed: false, reason: 'duplicate' };
    sendUdpPayload(body, { source: 'event' });
    lastAutoPushAt.set(flightId, now());
    lastPushFingerprint.set(flightId, fp);
    return { pushed: true };
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      if (!settings.get().enabled) return;
      const flights = store.listFlightsNeedingPoll({ nowMs: now() });
      if (!flights.length) return;
      if (!shouldBackgroundPoll() && !currentFlightId) return;
      const sorted = flights.sort((a, b) => (parseDepartureMs(a) || 0) - (parseDepartureMs(b) || 0));
      const target = sorted.find((row) => {
        const interval = pollIntervalMs(row, now());
        if (interval == null) return false;
        const last = lastPollAt.get(row.id) || 0;
        return (now() - last) >= interval;
      });
      if (!target) return;
      currentFlightId = target.id;
      try {
        const result = await refreshFlight(target.id, { manual: false });
        lastPollAt.set(target.id, now());
        if (result.material) {
          await maybeAutoPush(target.id, result.changes);
        }
      } finally {
        currentFlightId = null;
      }
    } catch (error) {
      log?.warn?.('Flight Plan poller tick failed', error?.message || error);
    } finally {
      running = false;
    }
  }

  function start() {
    stop();
    timer = setInterval(() => { tick().catch(() => {}); }, 30_000);
    if (typeof timer.unref === 'function') timer.unref();
    tick().catch(() => {});
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    start,
    stop,
    tick,
    refreshFlight,
    pollIntervalMs,
    maybeAutoPush,
  };
}

module.exports = {
  createFlightplanPoller,
  pollIntervalMs,
  POLL_24H_MS,
  POLL_3H_MS,
};
