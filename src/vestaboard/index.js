// Wires the Vestaboard feature together.
//
// Owns the board list, one house queue, and a transport per enabled board.
// Dwell and priorities are house-wide; each posted page fans out to every
// enabled board. Everything above this — the router, the formatters, the
// scheduler — talks to `pushEvent()` or `submit()` and never learns whether
// the board on the other end is hardware or the simulator.

const fs = require('fs');
const path = require('path');
const { resolveGuestPhotoboothSettings } = require('../guest-photobooth');
const { createVestaboardSettings, SIMULATOR_ID, DEFAULTS } = require('./settings');
const { createTransport } = require('./transport');
const { createQueue, inQuietHours, sameLayout } = require('./queue');
const { catalogForClient } = require('./priorities');
const { identityFrame } = require('./formatters/signal');
const { routeEvent } = require('./router');
const { houseTimeZone } = require('./clock');
const { createQuietHoursReminder, createQuietHoursWatch } = require('../quiet-hours-reminder');

const REAL_BOARD_PORT = 7000;

function createVestaboardHub({
  config = {},
  log = console,
  simulator = null,
  settings: injectedSettings = null,
  now = () => Date.now(),
  setTimer = setInterval,
  clearTimer = clearInterval,
} = {}) {
  const settings = injectedSettings || createVestaboardSettings({ config, log });
  const runtimePath = config.vestaboardRuntimePath
    || path.join(config.ROOT || path.resolve(__dirname, '..', '..'), 'data', 'vestaboard-runtime.json');

  /** id -> { board, transport, follower } */
  const boards = new Map();
  const listeners = new Set();
  let started = false;
  let houseQueue = null;
  let houseUnsubscribe = null;
  let catchUpTimer = null;
  let catchingUp = false;

  function emit(event, detail) {
    for (const listener of listeners) {
      try {
        listener(event, detail);
      } catch (error) {
        log?.warn?.('Vestaboard hub listener failed', error?.message || error);
      }
    }
  }

  function asTimestamp(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function readRuntime() {
    try {
      if (!fs.existsSync(runtimePath)) {
        return { lastPostAt: {} };
      }
      const parsed = JSON.parse(fs.readFileSync(runtimePath, 'utf8')) || {};
      const lastPostAt = parsed.lastPostAt && typeof parsed.lastPostAt === 'object'
        ? parsed.lastPostAt
        : {};
      return { lastPostAt };
    } catch (error) {
      log?.warn?.('Could not read Vestaboard runtime state', error?.message || error);
      return { lastPostAt: {} };
    }
  }

  function writeRuntime(runtime) {
    try {
      fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
      fs.writeFileSync(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`);
    } catch (error) {
      log?.warn?.('Could not persist Vestaboard runtime state', error?.message || error);
    }
  }

  function persistLastPostAt(boardId, at) {
    const ts = asTimestamp(at);
    if (!boardId || ts == null) {
      return;
    }
    const runtime = readRuntime();
    runtime.lastPostAt[String(boardId)] = ts;
    writeRuntime(runtime);
  }

  function seedQueueCooldown(queue, boardId, extraAt = null) {
    if (!queue?.noteLastPostAt) {
      return;
    }
    const persisted = asTimestamp(readRuntime().lastPostAt?.[String(boardId)]);
    if (persisted != null) {
      queue.noteLastPostAt(persisted);
    }
    const extra = asTimestamp(extraAt);
    if (extra != null) {
      queue.noteLastPostAt(extra);
    }
  }

  function baseUrlFor(board) {
    if (board.baseUrl) {
      return board.baseUrl;
    }
    // A board with only a hostname still needs the Local API port.
    return `http://${board.id}.local:${REAL_BOARD_PORT}`;
  }

  function houseConfig() {
    const house = settings.house();
    const donor = settings.get(SIMULATOR_ID) || settings.list()[0] || {};
    return {
      id: SIMULATOR_ID,
      dwellSeconds: house.dwellSeconds,
      priorities: house.priorities,
      rateWindowSeconds: donor.rateWindowSeconds ?? DEFAULTS.rateWindowSeconds,
      minRotationGapSeconds: donor.minRotationGapSeconds ?? DEFAULTS.minRotationGapSeconds,
      quietHours: { enabled: false },
    };
  }

  function followerState(boardId) {
    return {
      lastAccepted: null,
      lastPostAt: asTimestamp(readRuntime().lastPostAt?.[String(boardId)]),
      retryNotBefore: null,
      health: 'ok',
      healthReason: null,
      failures: 0,
    };
  }

  async function postToBoard(entry, rows, opts = {}) {
    if (!opts.quietHoursExempt
      && inQuietHours(new Date(now()), entry.board.quietHours, houseTimeZone(config))) {
      return { id: entry.board.id, skipped: 'quiet' };
    }
    let outcome;
    try {
      outcome = await entry.transport.post(rows, opts);
    } catch (error) {
      outcome = { ok: false, reason: 'network', retryable: true, message: error?.message };
    }
    if (outcome.ok) {
      entry.follower.lastAccepted = rows;
      entry.follower.lastPostAt = now();
      entry.follower.retryNotBefore = null;
      entry.follower.health = 'ok';
      entry.follower.healthReason = null;
      entry.follower.failures = 0;
      persistLastPostAt(entry.board.id, entry.follower.lastPostAt);
    } else if (outcome.reason === 'auth') {
      entry.follower.health = 'degraded';
      entry.follower.healthReason = 'auth';
      emit('health', { boardId: entry.board.id, health: 'degraded', reason: 'auth' });
      emit('registry', { boardId: entry.board.id });
    } else if (outcome.reason === 'busy') {
      entry.follower.retryNotBefore = (entry.follower.lastPostAt || now())
        + (DEFAULTS.rateWindowSeconds * 1000) + 1000;
    } else {
      entry.follower.failures += 1;
      if (entry.follower.failures >= 3) {
        entry.follower.health = 'unhealthy';
        entry.follower.healthReason = outcome.reason;
        emit('health', { boardId: entry.board.id, health: 'unhealthy', reason: outcome.reason });
        emit('registry', { boardId: entry.board.id });
      }
    }
    return { id: entry.board.id, outcome };
  }

  function createFanoutTransport() {
    return {
      async post(rows, opts = {}) {
        const entries = [...boards.values()];
        if (!entries.length) {
          return { ok: false, reason: 'offline', retryable: true };
        }
        const results = await Promise.all(
          entries.map((entry) => postToBoard(entry, rows, opts)),
        );
        if (results.some((row) => row.outcome?.ok)) {
          return { ok: true, reason: 'ok' };
        }
        const attempted = results.filter((row) => !row.skipped);
        if (!attempted.length) {
          return { ok: true, reason: 'ok' };
        }
        if (attempted.every((row) => row.outcome?.reason === 'busy')) {
          return { ok: false, reason: 'busy', retryable: true };
        }
        return attempted[0].outcome
          || { ok: false, reason: 'network', retryable: true };
      },
    };
  }

  async function catchUpFollowers() {
    if (!houseQueue || catchingUp) {
      return;
    }
    const current = houseQueue.state()?.current;
    if (!current) {
      return;
    }
    catchingUp = true;
    try {
      const at = now();
      for (const entry of boards.values()) {
        if (sameLayout(entry.follower.lastAccepted, current)) {
          continue;
        }
        if (entry.follower.retryNotBefore && at < entry.follower.retryNotBefore) {
          continue;
        }
        if (entry.follower.lastPostAt != null
          && at < entry.follower.lastPostAt + (DEFAULTS.rateWindowSeconds * 1000)) {
          continue;
        }
        await postToBoard(entry, current, {});
      }
    } finally {
      catchingUp = false;
    }
  }

  function build(board) {
    const transport = createTransport({
      baseUrl: baseUrlFor(board),
      key: settings.keyFor(board.id) || '',
    });
    return {
      board,
      transport,
      follower: followerState(board.id),
    };
  }

  function teardownHouse() {
    if (catchUpTimer) {
      clearTimer(catchUpTimer);
      catchUpTimer = null;
    }
    if (houseQueue) {
      houseQueue.stop();
      houseUnsubscribe?.();
      houseUnsubscribe = null;
      houseQueue = null;
    }
  }

  function ensureHouseQueue() {
    if (!boards.size) {
      teardownHouse();
      return;
    }
    const fanout = createFanoutTransport();
    if (!houseQueue) {
      houseQueue = createQueue({
        board: houseConfig(),
        transport: fanout,
        log,
        now,
        timeZone: houseTimeZone(config),
        setTimer,
        clearTimer,
      });
      const lastPosts = [...boards.values()]
        .map((entry) => entry.follower.lastPostAt)
        .filter((ts) => ts != null);
      if (lastPosts.length) {
        houseQueue.noteLastPostAt(Math.max(...lastPosts));
      }
      houseUnsubscribe = houseQueue.onChange((event, detail) => {
        if (event === 'posted') {
          persistLastPostAt(SIMULATOR_ID, houseQueue.state().lastPostAt);
        }
        emit(event, { boardId: SIMULATOR_ID, ...detail });
      });
      houseQueue.start();
      catchUpTimer = setTimer(() => {
        catchUpFollowers().catch((error) => {
          log?.warn?.('Vestaboard catch-up failed', error?.message || error);
        });
      }, 1000);
      if (typeof catchUpTimer?.unref === 'function') {
        catchUpTimer.unref();
      }
    } else {
      houseQueue.setConfig(houseConfig());
      houseQueue.setTransport(fanout);
    }
  }

  /** Bring running boards in line with the saved list. One house queue. */
  function sync() {
    const wanted = settings.list().filter((board) => board.enabled);
    const wantedIds = new Set(wanted.map((board) => board.id));

    for (const [id] of boards) {
      if (!wantedIds.has(id)) {
        boards.delete(id);
      }
    }

    for (const board of wanted) {
      const existing = boards.get(board.id);
      if (!existing) {
        boards.set(board.id, build(board));
        continue;
      }
      existing.board = board;
      existing.transport = createTransport({
        baseUrl: baseUrlFor(board),
        key: settings.keyFor(board.id) || '',
      });
    }

    ensureHouseQueue();
    emit('registry', { boardId: null });
  }

  /**
   * Walk the simulator's own enablement handshake at boot.
   *
   * This is the same exchange a board owner does by hand with a real board,
   * done over HTTP rather than in-process on purpose: it keeps the path
   * rehearsed, so the day hardware arrives nothing here is untested.
   */
  async function adoptSimulator() {
    if (!simulator) {
      return;
    }
    const port = simulator.address()?.port || simulator.port;
    settings.seedSimulator({ port, apiKey: null });

    // Always walk the handshake. Enabling twice returns the same live key,
    // and a stored key that no longer matches (simulator state was reset)
    // would otherwise 401 forever and the queue would stop.
    const transport = createTransport({ baseUrl: `http://127.0.0.1:${port}` });
    const outcome = await transport.enable(simulator.enablementToken());
    if (outcome.ok && outcome.apiKey) {
      settings.setKey(SIMULATOR_ID, outcome.apiKey);
      log?.info?.('Vestaboard simulator enabled');
    } else {
      log?.warn?.(`Could not enable the Vestaboard simulator (${outcome.reason})`);
    }
  }

  /** What the display picker shows for boards. */
  function registryEntries() {
    return settings.list().map((board) => {
      const running = boards.get(board.id);
      const health = running ? running.follower.health : 'offline';
      return {
        id: board.id,
        name: board.name,
        kind: 'vestaboard',
        simulator: board.simulator,
        enabled: board.enabled,
        health,
        healthReason: running ? running.follower.healthReason : null,
        hasKey: settings.hasKey(board.id),
      };
    });
  }

  /**
   * The Settings tab needs the whole board, health included, so the edit form
   * can be filled in. Keys are never part of it — only whether one is set.
   */
  function settingsView() {
    return settings.list().map((board) => {
      const running = boards.get(board.id);
      return {
        ...board,
        health: running ? running.follower.health : 'offline',
        healthReason: running ? running.follower.healthReason : null,
        hasKey: settings.hasKey(board.id),
      };
    });
  }

  function houseSettings() {
    return settings.house();
  }

  function queueFor(_id) {
    return houseQueue;
  }

  /**
   * Format one payload and offer it to the boards that should show it.
   *
   * Voice, admin push, and (later) the scheduler all come through here.
   * The UDP path is unchanged: this only talks to boards. A payload a board
   * cannot show is skipped with one debug line, never a blank flip.
   */
  function pushEvent(payload, options = {}) {
    if (!payload) {
      return { boards: [] };
    }

    const ctx = { ...(options.ctx || {}) };
    if (!ctx.timeZone) {
      ctx.timeZone = houseTimeZone(config);
    }
    if (payload.type === 'guest.photobooth') {
      // The UDP payload ships a Wi-Fi QR string, not the typed password a
      // board has to print. Pull the house settings once so every path —
      // voice, Push, request-PIN — shows the same SSID and password.
      const guest = resolveGuestPhotoboothSettings(config);
      ctx.ssid = ctx.ssid || guest.ssid;
      ctx.password = ctx.password || guest.password;
      ctx.boothUrl = ctx.boothUrl || guest.boothUrl;
    }

    const results = routeEvent({
      payload,
      boards: [...boards.values()].map((entry) => ({ board: entry.board })),
      targetId: options.targetId,
      commandId: options.commandId || null,
      explicit: options.explicit != null
        ? Boolean(options.explicit)
        : !options.scheduler,
      scheduler: Boolean(options.scheduler),
      breakHold: options.breakHold,
      quietHoursExempt: options.quietHoursExempt,
      replaceSource: options.replaceSource,
      replaceCard: options.replaceCard,
      gameSource: options.gameSource,
      actor: options.actor,
      ctx: {
        ...ctx,
        priorities: settings.house().priorities,
        board: {
          dwellSeconds: settings.house().dwellSeconds,
          priorities: settings.house().priorities,
        },
      },
      now,
      submit,
      log,
    });
    // Kick the house queue now rather than waiting up to a second for the timer.
    if (results.some((row) => row?.accepted > 0)) {
      houseQueue?.tick()?.catch((error) => {
        log?.warn?.('Vestaboard house tick failed', error?.message || error);
      });
    }
    return { boards: results };
  }

  /**
   * Hand frames to one board. Returns why nothing happened when nothing did,
   * so callers can say something useful rather than failing silently.
   */
  function submit(_boardId, frames, options = {}) {
    if (!houseQueue) {
      return { ok: false, error: 'That board is not enabled' };
    }
    const outcome = houseQueue.submit(frames, {
      ...options,
      priorities: options.priorities != null
        ? options.priorities
        : settings.house().priorities,
    });
    return { ok: outcome.accepted > 0, ...outcome };
  }

  /**
   * A live Vestaboard game owns every board until its session ends. Called on
   * each phase card (which also refreshes the safety deadline) and once more
   * on close. See `src/games/registry.js` — every vestaboard game must do
   * this. Huupe / Autodarts take the same lock from the queue when the
   * board's Priorities list marks them as holds.
   */
  function setGameLock(source, active) {
    if (!houseQueue) {
      return;
    }
    if (active) {
      houseQueue.acquireGameLock?.(source);
    } else {
      houseQueue.releaseGameLock?.(source);
    }
  }

  /**
   * Drop the house hold. Every enabled board follows that line, so one
   * release unpins them all.
   */
  function releaseHolds() {
    if (!houseQueue?.releaseGameLock?.('')) {
      return { released: 0, boards: [] };
    }
    const ids = [...boards.keys()];
    return { released: ids.length, boards: ids };
  }

  /** Drop matching pending pages on the house line. */
  function dropPending(predicate) {
    return houseQueue?.dropPending?.(predicate) || 0;
  }

  async function testFlip(boardId) {
    const entry = boards.get(String(boardId));
    if (!entry) {
      return { ok: false, error: 'That board is not enabled' };
    }
    if (!settings.hasKey(entry.board.id)) {
      return { ok: false, error: 'That board has no key yet' };
    }
    const rows = identityFrame({ name: entry.board.name }).rows;
    const outcome = await postToBoard(entry, rows, { quietHoursExempt: true });
    if (outcome.outcome?.ok) {
      return { ok: true };
    }
    if (outcome.outcome?.reason === 'busy') {
      return { ok: true, queued: true };
    }
    return {
      ok: false,
      error: outcome.outcome?.message || outcome.outcome?.reason || 'Test flip failed',
    };
  }

  const quietHoursReminder = createQuietHoursReminder({
    persistPath: config.quietHoursReminderPath
      || path.join(config.ROOT || path.resolve(__dirname, '..', '..'), 'data', 'quiet-hours-reminder.json'),
  });

  const quietHoursWatch = createQuietHoursWatch({
    reminder: quietHoursReminder,
    getBoards: () => [...boards.values()].map((entry) => entry.board),
    pushEvent,
    timeZone: () => houseTimeZone(config),
    now,
    setTimer,
    clearTimer,
    log,
  });

  const unwatchSettings = settings.onChange(() => {
    if (started) {
      sync();
    }
  });

  return {
    settings,
    registryEntries,
    settingsView,
    houseSettings,
    priorityCatalog: catalogForClient,
    queueFor,
    pushEvent,
    submit,
    dropPending,
    setGameLock,
    releaseHolds,
    testFlip,
    boards: () => [...boards.values()].map((entry) => ({ ...entry.board })),
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    nextQuietHoursPayload(options = {}) {
      return quietHoursReminder.nextPayload(options);
    },
    tickQuietHoursReminder(at) {
      return quietHoursWatch.tick(at);
    },
    async start() {
      await adoptSimulator();
      started = true;
      sync();
      quietHoursWatch.start();
      // Recreate / restart forgets the in-memory queue clock. The simulator
      // still knows when it last flipped, so honour that before the first tick.
      if (simulator?.snapshot && houseQueue) {
        seedQueueCooldown(
          houseQueue,
          SIMULATOR_ID,
          simulator.snapshot().lastAcceptedAt,
        );
      }
    },
    stop() {
      started = false;
      quietHoursWatch.stop();
      unwatchSettings();
      teardownHouse();
      boards.clear();
    },
  };
}

module.exports = {
  createVestaboardHub,
  REAL_BOARD_PORT,
};
