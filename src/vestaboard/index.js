// Wires the Vestaboard feature together.
//
// Owns the board list, a queue and a transport per enabled board, and the
// view of those boards that the display registry merges in. Everything above
// this — the router, the formatters, the scheduler — talks to `pushEvent()`
// or `submit()` and never learns whether the board on the other end is
// hardware or the simulator.

const fs = require('fs');
const path = require('path');
const { resolveGuestPhotoboothSettings } = require('../guest-photobooth');
const { createVestaboardSettings, SIMULATOR_ID } = require('./settings');
const { createTransport } = require('./transport');
const { createQueue } = require('./queue');
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

  /** id -> { board, transport, queue, unsubscribe } */
  const boards = new Map();
  const listeners = new Set();
  let started = false;

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

  function build(board) {
    const transport = createTransport({
      baseUrl: baseUrlFor(board),
      key: settings.keyFor(board.id) || '',
    });

    const queue = createQueue({
      board, transport, log, now,
      timeZone: houseTimeZone(config),
    });
    seedQueueCooldown(queue, board.id);

    const unsubscribe = queue.onChange((event, detail) => {
      if (event === 'posted') {
        persistLastPostAt(board.id, queue.state().lastPostAt);
      }
      if (event === 'health') {
        // The picker shows board health, so a change has to reach the registry.
        emit('registry', { boardId: board.id });
      }
      emit(event, detail);
    });

    queue.start();
    return {
      board, transport, queue, unsubscribe,
    };
  }

  function teardown(entry) {
    entry.queue.stop();
    entry.unsubscribe();
  }

  /** Bring running queues in line with the saved board list. */
  function sync() {
    const wanted = settings.list().filter((board) => board.enabled);
    const wantedIds = new Set(wanted.map((board) => board.id));

    for (const [id, entry] of boards) {
      if (!wantedIds.has(id)) {
        teardown(entry);
        boards.delete(id);
      }
    }

    for (const board of wanted) {
      const existing = boards.get(board.id);
      if (!existing) {
        boards.set(board.id, build(board));
        continue;
      }
      // Settings changes apply live rather than waiting for a restart.
      existing.board = board;
      existing.queue.setConfig(board);
      const nextTransport = createTransport({
        baseUrl: baseUrlFor(board),
        key: settings.keyFor(board.id) || '',
      });
      existing.transport = nextTransport;
      existing.queue.setTransport(nextTransport);
    }

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
      const health = running ? running.queue.state().health : 'offline';
      return {
        id: board.id,
        name: board.name,
        kind: 'vestaboard',
        simulator: board.simulator,
        enabled: board.enabled,
        health,
        healthReason: running ? running.queue.state().healthReason : null,
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
        health: running ? running.queue.state().health : 'offline',
        healthReason: running ? running.queue.state().healthReason : null,
        hasKey: settings.hasKey(board.id),
      };
    });
  }

  function queueFor(id) {
    return boards.get(String(id))?.queue || null;
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
      ctx,
      now,
      submit,
      log,
    });
    // Kick the queue now rather than waiting up to a second for the timer.
    // `submit()` itself stays synchronous so unit tests can assert pending
    // items before an explicit tick.
    const kicked = new Set();
    for (const row of results) {
      if (!(row?.accepted > 0) || kicked.has(row.boardId)) {
        continue;
      }
      kicked.add(row.boardId);
      queueFor(row.boardId)?.tick()?.catch((error) => {
        log?.warn?.(`Vestaboard ${row.boardId} tick failed`, error?.message || error);
      });
    }
    return { boards: results };
  }

  /**
   * Hand frames to one board. Returns why nothing happened when nothing did,
   * so callers can say something useful rather than failing silently.
   */
  function submit(boardId, frames, options = {}) {
    const entry = boards.get(String(boardId));
    if (!entry) {
      return { ok: false, error: 'That board is not enabled' };
    }
    const outcome = entry.queue.submit(frames, options);
    return { ok: outcome.accepted > 0, ...outcome };
  }

  async function testFlip(boardId) {
    const entry = boards.get(String(boardId));
    if (!entry) {
      return { ok: false, error: 'That board is not enabled' };
    }
    if (!settings.hasKey(entry.board.id)) {
      return { ok: false, error: 'That board has no key yet' };
    }
    // An alert so it lands now rather than behind whatever is rotating.
    entry.queue.submit([identityFrame({ name: entry.board.name })], {
      priority: 'alert',
      quietHoursExempt: true,
    });
    const result = await entry.queue.tick();
    return result === 'posted'
      ? { ok: true }
      : { ok: true, queued: true, state: entry.queue.state() };
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
    queueFor,
    pushEvent,
    submit,
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
      if (simulator?.snapshot) {
        seedQueueCooldown(
          queueFor(SIMULATOR_ID),
          SIMULATOR_ID,
          simulator.snapshot().lastAcceptedAt,
        );
      }
    },
    stop() {
      started = false;
      quietHoursWatch.stop();
      unwatchSettings();
      for (const entry of boards.values()) {
        teardown(entry);
      }
      boards.clear();
    },
  };
}

module.exports = {
  createVestaboardHub,
  REAL_BOARD_PORT,
};
