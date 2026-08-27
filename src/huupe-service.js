/**
 * Huupe integration facade.
 *
 * Owns the wiring between the ADB collector (raw logcat), the parser (events),
 * the live state machine (sessions) and the stores (archive + career table).
 * Everything the web server and the listener touch goes through here.
 */

const { createHuupeSettings } = require('./huupe-settings');
const { createHuupeArchive } = require('./huupe-archive');
const { createHuupeAggregates } = require('./huupe-aggregates');
const { createHuupeLive } = require('./huupe-live');
const { createHuupeCollector } = require('./huupe-adb');
const payload = require('./huupe-payload');

function createHuupeService({
  config = {},
  log = console,
  sendUdpPayload = null,
  displayBusy = null,
  dependencies = {},
} = {}) {
  const settings = dependencies.settings || createHuupeSettings(config, log);
  const archive = dependencies.archive || createHuupeArchive(config, log);
  const aggregates = dependencies.aggregates || createHuupeAggregates(config, log);

  const live = dependencies.live || createHuupeLive({
    settings,
    archive,
    aggregates,
    payload,
    sendUdpPayload,
    displayBusy,
    log,
  });

  const collector = dependencies.collector || createHuupeCollector({
    config,
    settings,
    log,
    onEvent: (event) => live.handleEvent(event),
    onStreamState: (state) => live.handleStreamState(state),
  });

  let started = false;

  function currentAggregate() {
    const cached = aggregates.get();
    if (cached) return cached;
    return aggregates.recompute(archive.listAll());
  }

  function deviceCard() {
    const status = collector.statusSnapshot();
    return {
      name: status.device?.model || 'Huupe Mini',
      serial: status.serial,
      online: status.connected,
      statusLabel: status.connected
        ? 'Online'
        : (status.lastError ? 'Unreachable' : 'Offline'),
      androidRelease: status.device?.androidRelease || null,
      lastConnectedAt: status.lastConnectedAt,
      linesSeen: status.counters?.lines || 0,
      sensorInterference: status.counters?.interference || 0,
    };
  }

  function statusSnapshot() {
    const liveStatus = live.statusSnapshot();
    const collectorStatus = collector.statusSnapshot();
    const aggregate = aggregates.get();
    const configured = Boolean(settings.get().device.host);
    return {
      configured,
      connected: collectorStatus.connected,
      collector: collectorStatus,
      live: liveStatus,
      settings: settings.get(),
      device: deviceCard(),
      archive: {
        count: archive.count(),
        root: archive.archiveRoot,
      },
      players: aggregate?.players?.length || 0,
      hasArchive: archive.count() > 0,
      hasLiveSession: Boolean(liveStatus.session),
      unavailableReason: collectorStatus.connected
        ? null
        : (collectorStatus.lastError || (configured ? 'Hoop is offline' : 'No hoop configured')),
    };
  }

  function pushSession({ send, view, persistent, displaySeconds }) {
    const body = payload.buildSessionPayload(view, { persistent, displaySeconds });
    const dispatch = typeof send === 'function' ? send : sendUdpPayload;
    dispatch?.(body, { source: 'push' });
    return {
      ok: true,
      pushed: 'huupe.session',
      sessionId: view.sessionId,
      status: view.status,
      displaySeconds: body.displaySeconds,
    };
  }

  function lastGameView() {
    const remembered = live.lastSession();
    if (remembered) return remembered;
    const [row] = archive.latest(1);
    return row ? payload.viewFromArchivedSession(row) : null;
  }

  /** Live session if there is one, otherwise the last game — the auto tile. */
  function pushNow({ send, mode = 'auto' } = {}) {
    if (mode !== 'last-game') {
      const view = live.viewForPush();
      if (view) {
        return pushSession({ send, view, persistent: true, displaySeconds: 0 });
      }
      if (mode === 'live') {
        return { ok: false, error: 'No live Huupe session' };
      }
    }
    return pushLastGame({ send });
  }

  function pushLastGame({ send } = {}) {
    const view = lastGameView();
    if (!view) {
      return { ok: false, error: 'No Huupe games recorded yet' };
    }
    return pushSession({
      send,
      view,
      persistent: false,
      displaySeconds: Number(settings.get().lastGame.displaySeconds) || 90,
    });
  }

  function pushDashboard({ send } = {}) {
    const aggregate = currentAggregate();
    if (!aggregate || !aggregate.totals?.sessions) {
      return { ok: false, error: 'No Huupe games recorded yet' };
    }
    const view = settings.get();
    const body = payload.buildDashboardPayload(aggregate, {
      displaySeconds: Number(view.dashboard.displaySeconds) || 120,
      leaderboardSize: Number(view.dashboard.leaderboardSize) || 10,
      device: deviceCard(),
      lastSession: live.lastSession(),
    });
    const dispatch = typeof send === 'function' ? send : sendUdpPayload;
    dispatch?.(body, { source: 'push' });
    return {
      ok: true,
      pushed: 'huupe.dashboard',
      players: body.leaderboard.length,
      displaySeconds: body.displaySeconds,
    };
  }

  function updateSettings(patch = {}) {
    const before = settings.get().device || {};
    const next = settings.update(patch);
    const after = next.device || {};
    // A new address has to take effect now rather than after the current
    // backoff. Anything else must not: the Settings card saves the whole form
    // on every slider drag, so "the patch mentioned the device" would drop a
    // healthy logcat tail — and the game on it — while someone nudged a slider.
    const moved = before.host !== after.host
      || (Number(before.port) || 0) !== (Number(after.port) || 0);
    if (moved && started) {
      collector.reconnectNow();
    }
    return { ok: true, settings: next };
  }

  async function discover() {
    const found = await collector.discover();
    if (found.ok) {
      settings.update({ device: { host: found.host } });
      collector.reconnectNow();
    }
    return found;
  }

  function rebuildAggregates() {
    const rebuilt = aggregates.recompute(archive.listAll());
    return {
      ok: true,
      sessions: rebuilt.totals.sessions,
      players: rebuilt.players.length,
    };
  }

  return {
    settings,
    archive,
    aggregates,
    live,
    collector,
    start() {
      if (started) return;
      started = true;
      if (!aggregates.get() && archive.count()) {
        rebuildAggregates();
      }
      live.start();
      collector.start();
    },
    close() {
      started = false;
      collector.close();
      live.close();
    },
    statusSnapshot,
    pushNow,
    pushLastGame,
    pushDashboard,
    pushCurrent: pushNow,
    updateSettings,
    discover,
    rebuildAggregates,
    testConnection: () => collector.testConnection(),
    reconnect: () => {
      collector.reconnectNow();
      return { ok: true, message: 'Reconnecting to the hoop…' };
    },
    logTail: () => collector.unmatched(),
    dashboardPreview: () => payload.buildDashboardPayload(currentAggregate() || {}, {
      device: deviceCard(),
      leaderboardSize: Number(settings.get().dashboard.leaderboardSize) || 10,
    }),
    suppressActiveSession: (...args) => live.suppressActiveSession(...args),
  };
}

module.exports = { createHuupeService };
