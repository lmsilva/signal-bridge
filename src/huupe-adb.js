/**
 * Bridge-side ADB collector for the Huupe Mini.
 *
 * The hoop runs a stock-ish Android build we do not control and cannot install
 * a service on, so the bridge is the active party: it dials the device over
 * wireless ADB and tails logcat read-only. Nothing is ever installed, started or
 * written on the hoop.
 *
 * This is viable because of one property confirmed on the device: the hoop has
 * `persist.adb.tcp.port` set, so wireless ADB comes back by itself after a
 * reboot, and logcat works as the unprivileged shell user with no `adb root`.
 *
 * The device is off most of the day. That is the normal case, not an error, so
 * a failed dial backs off quietly and never logs at warn level twice for the
 * same outage.
 */

const os = require('os');
const { execFile, spawn } = require('child_process');

const { createHuupeParser, LOGCAT_TAGS } = require('./huupe-parser');

const DEFAULT_PORT = 5555;
const CONNECT_TIMEOUT_MS = 4000;
const PROBE_TIMEOUT_MS = 6000;

/** Backoff between dial attempts. The tail is long because the hoop is usually off. */
const BACKOFF_MS = [3_000, 5_000, 10_000, 20_000, 30_000, 60_000, 120_000];

/**
 * How often a live stream is asked to prove the hoop is still on the end of it.
 *
 * Silence cannot be the signal. With the tag allowlist in place the hoop logs
 * nothing at all while nobody is shooting, so a quiet stream and a dead one
 * look identical from here — liveness has to be asked for.
 */
const HEARTBEAT_MS = 30_000;

/** One missed beat is a busy device; two in a row is a stream that has died. */
const HEARTBEAT_STRIKES = 2;

const HEARTBEAT_TIMEOUT_MS = 5_000;

/** Echoed back, so a truncated or empty reply cannot pass for a pulse. */
const HEARTBEAT_TOKEN = 'huupe-alive';

/** Sweeping a /24 one address at a time would take minutes. */
const DISCOVERY_BATCH = 24;

const HUUPE_PACKAGE_HINTS = [
  'com.huupe.justhuupe',
  'com.game.huupecityroyale',
  'com.acdetorres.huuplauncher',
];

function backoffFor(attempt) {
  return BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
}

/** Candidate hosts on every private IPv4 /24 the bridge is attached to. */
function localCandidates(interfaces = os.networkInterfaces()) {
  const hosts = [];
  const seen = new Set();
  for (const entries of Object.values(interfaces || {})) {
    for (const entry of entries || []) {
      if (entry.internal || entry.family !== 'IPv4') continue;
      if (String(entry.netmask) !== '255.255.255.0') continue;
      const parts = String(entry.address).split('.');
      if (parts.length !== 4) continue;
      const prefix = parts.slice(0, 3).join('.');
      if (seen.has(prefix)) continue;
      seen.add(prefix);
      for (let host = 1; host <= 254; host += 1) {
        if (String(host) === parts[3]) continue;
        hosts.push(`${prefix}.${host}`);
      }
    }
  }
  return hosts;
}

function createHuupeCollector({
  config = {},
  settings,
  log = console,
  onEvent = null,
  onStreamState = null,
  execFileImpl = execFile,
  spawnImpl = spawn,
  now = () => Date.now(),
  setTimerImpl = setTimeout,
  clearTimerImpl = clearTimeout,
} = {}) {
  const adbPath = config.huupeAdbPath || process.env.HUUPE_ADB_PATH || 'adb';
  const parser = createHuupeParser({ year: new Date(now()).getFullYear() });

  let child = null;
  let retryTimer = null;
  let heartbeatTimer = null;
  let missedBeats = 0;
  let attempt = 0;
  let running = false;
  let discovering = false;
  let serial = null;
  let state = 'idle';
  let lastError = null;
  let lastConnectedAt = null;
  let lastLineAt = null;
  let lastBeatAt = null;
  let deviceInfo = null;
  let reportedOutage = false;

  function deviceSettings() {
    return settings?.get?.()?.device || {};
  }

  function setState(next, { reason = null } = {}) {
    if (state === next && reason === lastError) return;
    state = next;
    lastError = reason;
    onStreamState?.({ connected: next === 'streaming', reason, state: next, serial });
  }

  function adb(args, { timeout = PROBE_TIMEOUT_MS } = {}) {
    return new Promise((resolve) => {
      execFileImpl(adbPath, args, { timeout, windowsHide: true }, (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: error?.code ?? 0,
          stdout: String(stdout || ''),
          stderr: String(stderr || error?.message || ''),
        });
      });
    });
  }

  async function connect(host, port = DEFAULT_PORT) {
    const target = `${host}:${port}`;
    const result = await adb(['connect', target], { timeout: CONNECT_TIMEOUT_MS });
    const text = `${result.stdout} ${result.stderr}`.toLowerCase();
    if (text.includes('connected to')) {
      return { ok: true, serial: target, alreadyConnected: text.includes('already connected') };
    }
    if (text.includes('unauthorized')) {
      return { ok: false, serial: target, error: 'unauthorized — approve the ADB prompt on the hoop' };
    }
    return { ok: false, serial: target, error: (result.stderr || result.stdout || 'connect failed').trim() };
  }

  /** Confirm the thing that answered on 5555 is actually the hoop. */
  async function identify(target) {
    const props = await adb(['-s', target, 'shell', 'getprop']);
    if (!props.ok) {
      return { ok: false, error: (props.stderr || 'getprop failed').trim() };
    }
    const read = (key) => {
      const match = new RegExp(`\\[${key.replace(/\./g, '\\.')}\\]:\\s*\\[([^\\]]*)\\]`).exec(props.stdout);
      return match ? match[1] : '';
    };
    const model = read('ro.product.model');
    const manufacturer = read('ro.product.manufacturer');
    const release = read('ro.build.version.release');
    const tcpPort = read('persist.adb.tcp.port');

    const packages = await adb(['-s', target, 'shell', 'pm', 'list', 'packages']);
    const packageText = packages.stdout || '';
    const isHuupe = HUUPE_PACKAGE_HINTS.some((pkg) => packageText.includes(pkg))
      || /huupe/i.test(`${model} ${manufacturer}`);

    return {
      ok: isHuupe,
      error: isHuupe ? null : 'device is not a Huupe',
      info: {
        serial: target,
        model: model || 'unknown',
        manufacturer: manufacturer || 'unknown',
        androidRelease: release || 'unknown',
        // Blank here is the one real fragility: without it, wireless ADB does
        // not survive a reboot and the hoop needs a USB session to come back.
        persistentAdbPort: tcpPort || null,
        packages: HUUPE_PACKAGE_HINTS.filter((pkg) => packageText.includes(pkg)),
      },
    };
  }

  async function tryHost(host, port) {
    const connected = await connect(host, port);
    if (!connected.ok) return { ok: false, error: connected.error };
    const identified = await identify(connected.serial);
    if (!identified.ok) {
      await adb(['disconnect', connected.serial], { timeout: CONNECT_TIMEOUT_MS });
      return { ok: false, error: identified.error };
    }
    return { ok: true, serial: connected.serial, info: identified.info };
  }

  /**
   * Sweep the local /24s for a hoop.
   *
   * Only used when no host is configured or the saved one stopped answering —
   * a DHCP reservation is the right fix, this is the recovery path when the
   * lease moves anyway.
   */
  async function discover({ port = DEFAULT_PORT } = {}) {
    if (discovering) return { ok: false, error: 'discovery already running' };
    discovering = true;
    const started = now();
    try {
      const hosts = localCandidates();
      for (let index = 0; index < hosts.length; index += DISCOVERY_BATCH) {
        const batch = hosts.slice(index, index + DISCOVERY_BATCH);
        const results = await Promise.all(batch.map(async (host) => {
          const connected = await connect(host, port);
          return connected.ok ? connected.serial : null;
        }));
        for (const target of results.filter(Boolean)) {
          const identified = await identify(target);
          if (identified.ok) {
            return {
              ok: true,
              host: target.split(':')[0],
              serial: target,
              info: identified.info,
              scannedHosts: index + batch.length,
              elapsedMs: now() - started,
            };
          }
          await adb(['disconnect', target], { timeout: CONNECT_TIMEOUT_MS });
        }
      }
      return { ok: false, error: 'No Huupe found on the local network', elapsedMs: now() - started };
    } finally {
      discovering = false;
    }
  }

  function stopHeartbeat() {
    if (heartbeatTimer) clearTimerImpl(heartbeatTimer);
    heartbeatTimer = null;
    missedBeats = 0;
  }

  function scheduleHeartbeat() {
    if (heartbeatTimer || !running || !child) return;
    heartbeatTimer = setTimerImpl(() => {
      heartbeatTimer = null;
      heartbeat().catch((error) => {
        log?.warn?.(`Huupe heartbeat failed — ${error?.message || error}`);
      });
    }, HEARTBEAT_MS);
    heartbeatTimer?.unref?.();
  }

  /**
   * Tear down a stream that is still open but no longer carrying anything.
   *
   * A hoop that sleeps drops the ADB connection without closing it: logcat
   * keeps running, `child` stays set, and `dial()` returns early forever, so
   * the bridge reports Online while every shot of the next game goes unseen.
   * Nothing else in the collector can catch that, because a hoop nobody is
   * playing on is silent by design.
   */
  function loseStream(reason) {
    const lost = serial;
    stopStream();
    setState('disconnected', { reason });
    // A half-open entry answers the next `connect` with "already connected"
    // while every shell command on it fails, which would send the recovery
    // into a pointless LAN sweep.
    if (lost) adb(['disconnect', lost], { timeout: CONNECT_TIMEOUT_MS });
    // The hoop is most likely just asleep, so come back on the short end of
    // the backoff rather than wherever the last outage left it.
    attempt = 0;
    reportedOutage = false;
    scheduleRetry();
  }

  async function heartbeat() {
    const target = serial;
    const proc = child;
    if (!running || !proc || !target) return;

    const probe = await adb(['-s', target, 'shell', 'echo', HEARTBEAT_TOKEN], {
      timeout: HEARTBEAT_TIMEOUT_MS,
    });
    // The stream can be replaced or torn down while the probe is in flight.
    if (!running || child !== proc) return;

    if (probe.ok && probe.stdout.includes(HEARTBEAT_TOKEN)) {
      missedBeats = 0;
      lastBeatAt = now();
      scheduleHeartbeat();
      return;
    }

    missedBeats += 1;
    if (missedBeats < HEARTBEAT_STRIKES) {
      scheduleHeartbeat();
      return;
    }
    const detail = (probe.stderr || probe.stdout || 'no answer').trim();
    log?.info?.(`Huupe stream went quiet — ${target} stopped answering (${detail}). Reconnecting.`);
    loseStream(`the hoop stopped answering — ${detail}`);
  }

  function stopStream() {
    stopHeartbeat();
    if (!child) return;
    const doomed = child;
    child = null;
    try {
      doomed.kill();
    } catch {
      // Already gone.
    }
  }

  function handleLine(line) {
    lastLineAt = now();
    let event = null;
    try {
      event = parser.parse(line);
    } catch (error) {
      log?.warn?.(`Huupe parse failed — ${error?.message || error}`);
      return;
    }
    if (!event) return;
    // The state machine downstream owns the display; a throw in there must not
    // take the log pump — and with it every later game — down with it.
    try {
      onEvent?.(event);
    } catch (error) {
      log?.warn?.(`Huupe event handling failed — ${error?.message || error}`);
    }
  }

  function startStream(target) {
    stopStream();
    // `-T 1` starts one line back rather than replaying the whole ring buffer,
    // which would otherwise re-score an entire earlier session on reconnect.
    const args = ['-s', target, 'logcat', '-v', 'threadtime', '-T', '1', ...LOGCAT_TAGS.map((tag) => `${tag}:*`), '*:S'];
    const proc = spawnImpl(adbPath, args, { windowsHide: true });
    child = proc;
    serial = target;
    lastConnectedAt = now();
    attempt = 0;
    reportedOutage = false;
    lastBeatAt = now();
    setState('streaming');
    scheduleHeartbeat();
    log?.info?.(`Huupe collector streaming from ${target}`);

    let buffer = '';
    proc.stdout?.setEncoding?.('utf8');
    proc.stdout?.on?.('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) handleLine(line);
      }
    });
    proc.stderr?.setEncoding?.('utf8');
    proc.stderr?.on?.('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) log?.debug?.(`Huupe logcat: ${text}`);
    });
    const onDone = (reason) => {
      if (child !== proc) return;
      child = null;
      stopHeartbeat();
      setState('disconnected', { reason });
      scheduleRetry();
    };
    proc.on?.('error', (error) => onDone(error?.message || String(error)));
    proc.on?.('close', (code) => onDone(code === 0 ? 'stream ended' : `logcat exited (${code})`));
  }

  async function dial() {
    if (!running || child) return;
    const device = deviceSettings();
    const port = Number(device.port) || DEFAULT_PORT;

    // Nothing to dial yet. Sweeping the whole LAN uninvited on a cold install
    // is the wrong first move, so discovery stays an explicit action in
    // Settings; once a host is known, `autoDiscover` becomes the recovery path
    // for when the DHCP lease moves.
    if (!device.host) {
      setState('unconfigured', { reason: 'No hoop configured — run Discover in Settings' });
      return;
    }

    setState('connecting');
    const direct = await tryHost(device.host, port);
    if (direct.ok) {
      deviceInfo = direct.info;
      startStream(direct.serial);
      return;
    }

    if (device.autoDiscover === false) {
      failed(direct.error || 'could not reach the hoop');
      return;
    }

    const found = await discover({ port });
    if (found.ok) {
      deviceInfo = found.info;
      // Remember it so the next dial is one connect instead of a sweep.
      try {
        settings?.update?.({ device: { host: found.host } });
      } catch (error) {
        log?.warn?.(`Could not save discovered Huupe host — ${error?.message || error}`);
      }
      startStream(found.serial);
      return;
    }
    failed(found.error || 'no hoop found');
  }

  function failed(reason) {
    // The hoop being off is the normal overnight state; say it once, not hourly.
    if (!reportedOutage) {
      reportedOutage = true;
      log?.info?.(`Huupe unreachable — ${reason}. Retrying in the background.`);
    }
    setState('disconnected', { reason });
    scheduleRetry();
  }

  function scheduleRetry() {
    if (!running || retryTimer) return;
    const delay = backoffFor(attempt);
    attempt += 1;
    retryTimer = setTimerImpl(() => {
      retryTimer = null;
      dial().catch((error) => {
        failed(error?.message || String(error));
      });
    }, delay);
    retryTimer?.unref?.();
  }

  async function testConnection() {
    const device = deviceSettings();
    const port = Number(device.port) || DEFAULT_PORT;
    const version = await adb(['version'], { timeout: CONNECT_TIMEOUT_MS });
    if (!version.ok) {
      return {
        ok: false,
        message: `adb is not available on the bridge (${adbPath}). Add android-tools to the container image.`,
      };
    }
    if (state === 'streaming' && serial) {
      return {
        ok: true,
        message: `Streaming from ${serial} — ${parser.counters().lines} log lines seen`,
        device: deviceInfo,
      };
    }
    if (device.host) {
      const direct = await tryHost(device.host, port);
      if (direct.ok) {
        deviceInfo = direct.info;
        return { ok: true, message: `Reached the hoop at ${direct.serial}`, device: direct.info };
      }
      return { ok: false, message: `Could not reach ${device.host}:${port} — ${direct.error}` };
    }
    return { ok: false, message: 'No hoop configured. Run Discover to find it.' };
  }

  return {
    start() {
      if (running) return;
      running = true;
      dial().catch((error) => failed(error?.message || String(error)));
    },
    close() {
      running = false;
      if (retryTimer) clearTimerImpl(retryTimer);
      retryTimer = null;
      stopStream();
      setState('idle');
    },
    /** Drop the backoff and dial immediately — the admin "Reconnect" button. */
    reconnectNow() {
      if (retryTimer) clearTimerImpl(retryTimer);
      retryTimer = null;
      attempt = 0;
      reportedOutage = false;
      stopStream();
      if (!running) running = true;
      return dial().catch((error) => failed(error?.message || String(error)));
    },
    discover,
    testConnection,
    statusSnapshot() {
      const nowMs = now();
      return {
        adbPath,
        state,
        configured: Boolean(deviceSettings().host),
        serial,
        connected: state === 'streaming',
        lastError,
        lastConnectedAt: lastConnectedAt ? new Date(lastConnectedAt).toISOString() : null,
        lastLineAt: lastLineAt ? new Date(lastLineAt).toISOString() : null,
        secondsSinceLine: lastLineAt ? Math.round((nowMs - lastLineAt) / 1000) : null,
        // A hoop nobody is playing on logs nothing, so "last line" says little
        // about reachability. This is when the hoop last answered.
        lastBeatAt: lastBeatAt ? new Date(lastBeatAt).toISOString() : null,
        secondsSinceBeat: lastBeatAt ? Math.round((nowMs - lastBeatAt) / 1000) : null,
        missedBeats,
        retryInSeconds: retryTimer ? Math.round(backoffFor(Math.max(0, attempt - 1)) / 1000) : null,
        discovering,
        device: deviceInfo,
        counters: parser.counters(),
      };
    },
    /** Redacted tail of lines the parser did not understand — the admin log view. */
    unmatched: () => parser.unmatched(),
    resetCounters: () => parser.reset(),
  };
}

module.exports = {
  createHuupeCollector,
  localCandidates,
  backoffFor,
  DEFAULT_PORT,
  BACKOFF_MS,
  HEARTBEAT_MS,
  HEARTBEAT_STRIKES,
  HEARTBEAT_TOKEN,
  HUUPE_PACKAGE_HINTS,
};
