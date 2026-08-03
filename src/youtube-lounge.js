const { spawn } = require('child_process');
const { EventEmitter } = require('events');

/**
 * Node side of the YouTube Lounge integration.
 *
 * Owns the sidecar process (spawn, restart with backoff, NDJSON framing) and
 * the session lifecycle on top of the raw events: the confirm debounce, ad
 * suppression, and `watchedSeconds` from position deltas.
 *
 * The protocol details live in `youtube_lounge_agent.py`; this module only
 * knows the event names, so a Lounge protocol break is a one-file fix there.
 */

const DEFAULT_CONFIRM_SECONDS = 5;
const RESTART_BACKOFF_MS = [1000, 2000, 5000, 15000, 30000, 60000];
const REQUEST_TIMEOUT_MS = 30000;
/**
 * Apple TV often flickers Stopped between sparse Playing ticks (60–90s apart).
 * A short grace cleared provisional/active before confirm could fire, so auto
 * push never started and the Settings button fell back to stale history.
 * Keep the session alive across a full slow-tick gap.
 */
const STOP_GRACE_MS = 120000;
/** When confirm is due but the device is still Stopped/ad, retry this often. */
const CONFIRM_RETRY_MS = 2000;
/** Content scrubber past this point means a pre-roll ad has ended. */
const AD_CLEAR_POSITION_SECONDS = 3;

/** States that mean "a human is actually watching this right now". */
const PLAYING_STATES = new Set(['Playing']);
/** Still the current video for manual preview / status (not auto-push). */
const CURRENT_STATES = new Set(['Playing', 'Starting', 'Buffering', 'Advertisement', 'Paused']);
/**
 * Lounge position ticks are often 30–90s apart on Apple TV. Cap below a scrub
 * (minutes jumped in one event) but above a slow tick — the old 60s ceiling
 * discarded every real tick and left `watchedSeconds` at 0 forever.
 */
const MAX_PLAY_DELTA_SECONDS = 180;

function createYoutubeLounge({
  config,
  log = null,
  now = () => Date.now(),
  spawnImpl = spawn,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  getConfirmSeconds = null,
} = {}) {
  const emitter = new EventEmitter();
  const youtubeConfig = config?.youtube || {};

  let child = null;
  let stdoutBuffer = '';
  let restartAttempt = 0;
  let restartTimer = null;
  let ready = false;
  let loungeAvailable = null;
  let stopped = true;
  // Why detection is down, in the user's terms. Without this the admin card can
  // only say "not running", which reads as a scan failure rather than the
  // install step it usually is.
  let lastSpawnError = null;
  // What the sidecar said went wrong on import, if anything. "pyytlounge is
  // absent" and "pyytlounge is present but its API moved" need different fixes.
  let loungeImportError = null;
  let nextRequestId = 1;
  const pending = new Map();

  /**
   * Per-device playback state.
   *
   * `provisional` is the video we have seen but not yet paid for: nothing
   * downstream hears about it until it has been playing for `confirmSeconds`
   * (§6.7), which takes the cost of playlist-surfing to zero.
   */
  const devices = new Map();

  function deviceState(deviceId) {
    if (!devices.has(deviceId)) {
      devices.set(deviceId, {
        deviceId,
        provisional: null,
        provisionalSince: null,
        confirmTimer: null,
        stopTimer: null,
        active: null,
        state: 'Stopped',
        position: 0,
        maxPosition: 0,
        lastPosition: null,
        durationSeconds: 0,
        watchedSeconds: 0,
        adPlaying: false,
        // Whether the ad was reported outright or only inferred from the
        // player state; only the former may clear itself.
        adFromEvent: false,
        upNextVideoId: null,
        connected: false,
        lastSeenAt: null,
      });
    }
    return devices.get(deviceId);
  }

  function confirmSeconds() {
    if (typeof getConfirmSeconds === 'function') {
      const fromStore = Number(getConfirmSeconds());
      if (Number.isFinite(fromStore) && fromStore >= 0) {
        return fromStore;
      }
    }
    const value = Number(config?.youtube?.confirmSeconds);
    return Number.isFinite(value) && value >= 0 ? value : DEFAULT_CONFIRM_SECONDS;
  }

  function clearConfirmTimer(device) {
    if (device.confirmTimer) {
      clearTimer(device.confirmTimer);
      device.confirmTimer = null;
    }
  }

  function clearStopTimer(device) {
    if (device.stopTimer) {
      clearTimer(device.stopTimer);
      device.stopTimer = null;
    }
  }

  /**
   * Apple TV position ticks are often 60–90s apart. Without a wall-clock timer,
   * confirm only runs on the next Lounge event — auto-push can wait a minute
   * or never fire if the agent goes quiet after the first now-playing.
   */
  function scheduleConfirm(device, waitMs = null) {
    clearConfirmTimer(device);
    if (!device.provisional) {
      return;
    }
    const delay = waitMs != null
      ? Math.max(0, Math.round(waitMs))
      : Math.max(0, Math.round(confirmSeconds() * 1000));
    device.confirmTimer = setTimer(() => {
      device.confirmTimer = null;
      confirmIfDue(device);
    }, delay);
    device.confirmTimer?.unref?.();
  }

  function maybeClearStuckAd(device) {
    // Agent sometimes reports ad start and never ad end. Once the content
    // scrubber has clearly advanced, the pre-roll/mid-roll is over.
    if (
      device.adPlaying
      && PLAYING_STATES.has(device.state)
      && Number(device.position) >= AD_CLEAR_POSITION_SECONDS
    ) {
      device.adPlaying = false;
      device.adFromEvent = false;
    }
  }

  // ------------------------------------------------------------- process

  function send(message) {
    if (!child?.stdin?.writable) {
      return false;
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
    return true;
  }

  function request(message) {
    const id = nextRequestId;
    nextRequestId += 1;
    return new Promise((resolve) => {
      if (!send({ ...message, id })) {
        resolve({
          ok: false,
          error: unavailableReason() || 'The YouTube agent is not running',
          unavailable: true,
        });
        return;
      }
      const timer = setTimer(() => {
        pending.delete(id);
        resolve({ ok: false, error: 'The YouTube agent did not respond' });
      }, REQUEST_TIMEOUT_MS);
      timer?.unref?.();
      pending.set(id, (result) => {
        clearTimer(timer);
        resolve(result);
      });
    });
  }

  function handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      log?.warn?.('YouTube agent emitted a non-JSON line');
      return;
    }
    switch (message.event) {
      case 'ready':
        ready = true;
        loungeAvailable = message.loungeAvailable === true;
        loungeImportError = message.error || null;
        restartAttempt = 0;
        if (!loungeAvailable) {
          log?.warn?.(
            'YouTube agent started without a usable pyytlounge — detection is unavailable'
            + (loungeImportError ? ` (${loungeImportError})` : ''),
          );
        }
        emitter.emit('ready', { loungeAvailable });
        break;
      case 'result': {
        const resolver = pending.get(message.id);
        if (resolver) {
          pending.delete(message.id);
          const { event, id, ...rest } = message;
          resolver(rest);
        }
        break;
      }
      case 'log':
        log?.[message.level === 'warn' ? 'warn' : 'info']?.(`youtube-agent: ${message.message}`);
        break;
      case 'auth':
        emitter.emit('auth', message);
        break;
      case 'now-playing':
        onNowPlaying(message);
        break;
      case 'state':
        onState(message);
        break;
      case 'ad':
        onAd(message);
        break;
      case 'up-next':
        onUpNext(message);
        break;
      case 'disconnected':
        onDisconnected(message);
        break;
      default:
        break;
    }
  }

  function start() {
    if (child || !youtubeConfig.loungeEnabled) {
      return;
    }
    stopped = false;
    try {
      child = spawnImpl(
        youtubeConfig.pythonBin || 'python3',
        [youtubeConfig.agentScript],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
    } catch (error) {
      lastSpawnError = error?.message || String(error);
      log?.warn?.('Could not start the YouTube agent', lastSpawnError);
      child = null;
      scheduleRestart();
      return;
    }

    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on?.('data', (chunk) => {
      stdoutBuffer += chunk;
      let index = stdoutBuffer.indexOf('\n');
      while (index >= 0) {
        const line = stdoutBuffer.slice(0, index).trim();
        stdoutBuffer = stdoutBuffer.slice(index + 1);
        if (line) {
          handleLine(line);
        }
        index = stdoutBuffer.indexOf('\n');
      }
    });
    child.stderr?.setEncoding?.('utf8');
    child.stderr?.on?.('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) {
        log?.warn?.(`youtube-agent stderr: ${text.slice(0, 400)}`);
      }
    });
    child.on?.('exit', (code) => {
      ready = false;
      child = null;
      for (const resolver of pending.values()) {
        resolver({ ok: false, error: 'The YouTube agent exited' });
      }
      pending.clear();
      for (const device of devices.values()) {
        if (device.active) {
          finishSession(device, 'agent-exit');
        }
        device.connected = false;
      }
      if (!stopped) {
        log?.warn?.(`YouTube agent exited (${code}) — restarting`);
        scheduleRestart();
      }
    });
    child.on?.('error', (error) => {
      lastSpawnError = error?.message || String(error);
      log?.warn?.('YouTube agent process error', lastSpawnError);
    });
    child.unref?.();
  }

  function scheduleRestart() {
    if (restartTimer || stopped) {
      return;
    }
    const delay = RESTART_BACKOFF_MS[Math.min(restartAttempt, RESTART_BACKOFF_MS.length - 1)];
    restartAttempt += 1;
    restartTimer = setTimer(() => {
      restartTimer = null;
      start();
    }, delay);
    restartTimer?.unref?.();
  }

  function stop() {
    stopped = true;
    if (restartTimer) {
      clearTimer(restartTimer);
      restartTimer = null;
    }
    send({ cmd: 'shutdown' });
    child?.kill?.();
    child = null;
    ready = false;
  }

  // ----------------------------------------------------- session lifecycle

  /**
   * Advance watched time from a Lounge position sample.
   *
   * Position deltas while Playing (§12.15): pauses do not inflate the total,
   * seeks backwards are ignored, and jumps above MAX_PLAY_DELTA_SECONDS are
   * treated as scrubs rather than viewing.
   */
  function applyPosition(device, rawPosition, previousState) {
    const position = Number(rawPosition);
    if (!Number.isFinite(position) || position < 0) {
      return;
    }
    if (device.active && device.lastPosition != null && PLAYING_STATES.has(previousState)) {
      const delta = position - device.lastPosition;
      if (delta > 0 && delta <= MAX_PLAY_DELTA_SECONDS) {
        device.watchedSeconds += delta;
      }
    }
    device.lastPosition = position;
    device.position = position;
    device.maxPosition = Math.max(device.maxPosition || 0, position);
  }

  function finishSession(device, reason) {
    clearStopTimer(device);
    clearConfirmTimer(device);
    const session = device.active;
    if (!session) {
      return;
    }
    device.active = null;
    const durationSeconds = Math.round(device.durationSeconds);
    const positionSeconds = Math.round(Math.max(device.position || 0, device.maxPosition || 0));
    let watched = Math.max(0, Math.round(device.watchedSeconds));
    // Sparse ticks often leave the delta total at 0 even though Lounge reported
    // a real scrubber position — prefer that over claiming nobody watched.
    if (watched <= 0 && positionSeconds > 0) {
      watched = positionSeconds;
    }
    if (watched <= 0 && session.startedAt) {
      const wall = Math.round((now() - session.startedAt) / 1000);
      if (wall > 0) {
        watched = durationSeconds > 0 ? Math.min(wall, durationSeconds) : wall;
      }
    }
    device.watchedSeconds = 0;
    device.lastPosition = null;
    device.maxPosition = 0;
    const completed = durationSeconds > 0
      && (watched >= durationSeconds * 0.9 || positionSeconds >= durationSeconds * 0.9);
    const endedAt = now();
    const wallSeconds = session.startedAt
      ? Math.max(0, (endedAt - session.startedAt) / 1000)
      : 0;
    emitter.emit('stopped', {
      deviceId: device.deviceId,
      videoId: session.videoId,
      startedAt: new Date(session.startedAt).toISOString(),
      endedAt: new Date(endedAt).toISOString(),
      watchedSeconds: watched,
      positionSeconds,
      durationSeconds,
      completed,
      reason,
      // Downstream skips recording flicker sessions that never really played.
      wallSeconds,
    });
  }

  function scheduleStop(device, reason) {
    clearStopTimer(device);
    device.stopTimer = setTimer(() => {
      device.stopTimer = null;
      if (device.state === 'Stopped' || !CURRENT_STATES.has(device.state)) {
        clearConfirmTimer(device);
        device.provisional = null;
        device.provisionalSince = null;
        device.adPlaying = false;
        device.adFromEvent = false;
        finishSession(device, reason);
      }
    }, STOP_GRACE_MS);
    device.stopTimer?.unref?.();
  }

  function confirmIfDue(device) {
    if (!device.provisional || device.active?.videoId === device.provisional) {
      return;
    }
    maybeClearStuckAd(device);
    const elapsed = (now() - (device.provisionalSince || now())) / 1000;
    if (elapsed < confirmSeconds()) {
      // Timer may have been cleared by a Stopped flicker — keep the deadline.
      if (!device.confirmTimer) {
        scheduleConfirm(device, Math.max(0, (confirmSeconds() - elapsed) * 1000));
      }
      return;
    }
    // Never start a session on an ad: ads are not the video (§12.9).
    // Apple TV also parks in Stopped between sparse Playing ticks — retry soon.
    if (device.adPlaying || !PLAYING_STATES.has(device.state)) {
      if (!device.confirmTimer) {
        scheduleConfirm(device, CONFIRM_RETRY_MS);
      }
      return;
    }
    clearConfirmTimer(device);
    clearStopTimer(device);
    const videoId = device.provisional;
    device.provisional = null;
    device.provisionalSince = null;
    device.watchedSeconds = 0;
    device.maxPosition = Math.max(0, device.position || 0);
    // Null baseline so the first post-confirm tick establishes position without
    // counting 0→firstSample as watched (timer confirm often fires at position 0).
    device.lastPosition = null;
    device.active = { videoId, startedAt: now() };
    emitter.emit('started', {
      deviceId: device.deviceId,
      videoId,
      startedAt: new Date(device.active.startedAt).toISOString(),
      durationSeconds: Math.round(device.durationSeconds),
    });
  }

  function onNowPlaying(message) {
    const device = deviceState(message.deviceId);
    device.connected = true;
    device.lastSeenAt = now();
    clearStopTimer(device);
    if (Number.isFinite(Number(message.durationSeconds)) && Number(message.durationSeconds) > 0) {
      device.durationSeconds = Number(message.durationSeconds);
    }

    if (device.active && device.active.videoId !== message.videoId) {
      finishSession(device, 'changed');
    }
    if (device.active?.videoId === message.videoId) {
      // Same video: still refresh position — some devices only re-emit now-playing.
      const previousState = message.state || device.state;
      if (message.state) {
        device.state = message.state;
      }
      applyPosition(device, message.position, previousState);
      maybeClearStuckAd(device);
      if (device.active) {
        emitter.emit('progress', progressFor(device));
      }
      return;
    }
    if (device.provisional !== message.videoId) {
      device.provisional = message.videoId;
      device.provisionalSince = now();
      device.lastPosition = null;
      device.maxPosition = 0;
      // A new video means whatever ad preceded it has finished.
      device.adPlaying = false;
      device.adFromEvent = false;
      scheduleConfirm(device);
    }
    if (message.state) {
      device.state = message.state;
    }
    const position = Number(message.position);
    if (Number.isFinite(position) && position >= 0) {
      device.position = position;
      device.maxPosition = Math.max(device.maxPosition || 0, position);
    }
    maybeClearStuckAd(device);
    confirmIfDue(device);
  }

  function onState(message) {
    const device = deviceState(message.deviceId);
    device.connected = true;
    device.lastSeenAt = now();
    const previousState = device.state;
    device.state = message.state || device.state;
    if (Number.isFinite(Number(message.durationSeconds)) && Number(message.durationSeconds) > 0) {
      device.durationSeconds = Number(message.durationSeconds);
    }

    applyPosition(device, message.position, previousState);

    if (device.state === 'Stopped') {
      // Debounce — Apple TV often flickers Stopped between sparse Playing ticks.
      scheduleStop(device, 'stopped');
      return;
    }
    clearStopTimer(device);
    if (device.state === 'Advertisement') {
      // Hold the current card rather than swapping in ad metadata (§12.9).
      device.adPlaying = true;
      return;
    }
    // Inferred ads clear on Playing; event-sourced ads clear once the scrubber
    // has clearly advanced (agent often never sends ad:false on Apple TV).
    if (device.adPlaying && !device.adFromEvent && PLAYING_STATES.has(device.state)) {
      device.adPlaying = false;
    }
    maybeClearStuckAd(device);
    confirmIfDue(device);
    if (device.provisional && !device.active && PLAYING_STATES.has(device.state)) {
      scheduleConfirm(device);
    }
    if (device.active) {
      emitter.emit('progress', progressFor(device));
    }
  }

  function onAd(message) {
    const device = deviceState(message.deviceId);
    device.connected = true;
    device.lastSeenAt = now();
    device.adPlaying = message.playing === true;
    device.adFromEvent = device.adPlaying;
    const contentVideoId = String(message.contentVideoId || '').trim();
    // Pre-roll ads often arrive before now-playing — seed provisional from the
    // content id so manual preview / confirm have something to work with.
    if (contentVideoId && !device.active && device.provisional !== contentVideoId) {
      device.provisional = contentVideoId;
      device.provisionalSince = now();
      scheduleConfirm(device);
    }
    if (device.adPlaying && device.provisional) {
      // An ad before the video starts must not tick down the confirm window.
      device.provisionalSince = now();
      scheduleConfirm(device);
    }
    if (!device.adPlaying) {
      confirmIfDue(device);
    }
  }

  function onUpNext(message) {
    const device = deviceState(message.deviceId);
    device.upNextVideoId = message.videoId || null;
    // Only prefetch during real playback, one video ahead (§6.4).
    if (device.upNextVideoId && device.active && PLAYING_STATES.has(device.state)) {
      emitter.emit('prefetch', { deviceId: device.deviceId, videoId: device.upNextVideoId });
    }
  }

  function onDisconnected(message) {
    const device = deviceState(message.deviceId);
    clearConfirmTimer(device);
    clearStopTimer(device);
    device.connected = false;
    device.provisional = null;
    device.provisionalSince = null;
    finishSession(device, 'disconnected');
    emitter.emit('device-disconnected', { deviceId: device.deviceId });
  }

  function progressFor(device) {
    return {
      deviceId: device.deviceId,
      videoId: device.active?.videoId || null,
      state: device.state,
      positionSeconds: Math.round(device.position),
      durationSeconds: Math.round(device.durationSeconds),
      watchedSeconds: Math.round(device.watchedSeconds),
      adPlaying: device.adPlaying,
    };
  }

  // ----------------------------------------------------------- public API

  /**
   * The card is only allowed to claim "now playing" for a confirmed session
   * that is actually playing — a paused video is not what someone is watching.
   */
  function activeSessions() {
    return [...devices.values()]
      .filter((device) => device.active && PLAYING_STATES.has(device.state))
      .map((device) => ({
        ...progressFor(device),
        startedAt: new Date(device.active.startedAt).toISOString(),
      }))
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  }

  /**
   * Best-effort "what is on this TV right now" for manual preview / admin.
   * Includes confirmed and provisional videoIds even while Apple TV flickers
   * Stopped — clearing those made the Settings button air stale history.
   */
  function currentPlayback() {
    const rows = [];
    for (const device of devices.values()) {
      if (device.active) {
        rows.push({
          ...progressFor(device),
          videoId: device.active.videoId,
          startedAt: new Date(device.active.startedAt).toISOString(),
          provisional: false,
        });
        continue;
      }
      if (device.provisional) {
        rows.push({
          deviceId: device.deviceId,
          videoId: device.provisional,
          state: device.state,
          positionSeconds: Math.round(device.position),
          durationSeconds: Math.round(device.durationSeconds),
          watchedSeconds: 0,
          adPlaying: device.adPlaying,
          startedAt: device.provisionalSince
            ? new Date(device.provisionalSince).toISOString()
            : new Date(now()).toISOString(),
          provisional: true,
        });
      }
    }
    return rows.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  }

  /**
   * Ask linked screens to re-emit now-playing (Apple TV is often silent until
   * polled). Manual preview uses this so the button is not stuck on history.
   */
  async function pollNowPlaying(deviceId = null) {
    if (deviceId) {
      return request({ cmd: 'poll', deviceId: String(deviceId) });
    }
    return request({ cmd: 'poll-all' });
  }

  /**
   * One sentence a person can act on, or null when detection is healthy.
   *
   * The three ways this goes wrong all look identical from the admin page —
   * "no TVs found" — so they have to be told apart here.
   */
  function unavailableReason() {
    if (youtubeConfig.loungeEnabled === false) {
      return 'YouTube playback detection is turned off in the bridge config.';
    }
    if (loungeAvailable === false) {
      // An ImportError names the module that could not be resolved, which is
      // the difference between "not installed" and "installed, wrong version".
      const detail = loungeImportError ? ` (${loungeImportError})` : '';
      return 'The bridge could not load the pyytlounge library.'
        + `${detail} Rebuild the image (./recreate.sh --build) to install it.`;
    }
    // A child whose stdin has closed is present but cannot take commands, which
    // is the same thing as far as anyone asking is concerned.
    if (!child || !child.stdin?.writable) {
      const detail = /ENOENT/i.test(lastSpawnError || '')
        ? ' Python is not in this image — rebuild it (./recreate.sh --build).'
        : (lastSpawnError ? ` Last error: ${lastSpawnError}` : '');
      return `The YouTube detection agent is not running.${detail}`;
    }
    if (!ready) {
      return 'The YouTube detection agent is still starting.';
    }
    return null;
  }

  function snapshot() {
    return {
      running: Boolean(child),
      ready,
      loungeAvailable,
      unavailableReason: unavailableReason(),
      enabled: youtubeConfig.loungeEnabled !== false,
      confirmSeconds: confirmSeconds(),
      devices: [...devices.values()].map((device) => ({
        deviceId: device.deviceId,
        connected: device.connected,
        state: device.state,
        videoId: device.active?.videoId || device.provisional || null,
        provisional: Boolean(device.provisional && !device.active),
        adPlaying: device.adPlaying,
        lastSeenAt: device.lastSeenAt ? new Date(device.lastSeenAt).toISOString() : null,
      })),
    };
  }

  return {
    on: (event, handler) => emitter.on(event, handler),
    off: (event, handler) => emitter.off(event, handler),
    start,
    stop,
    connectDevice: (device) => request({ cmd: 'connect', device }),
    disconnectDevice: (deviceId) => request({ cmd: 'disconnect', deviceId }),
    pairWithCode: (deviceId, code) => request({ cmd: 'pair-code', deviceId, code }),
    pairWithScreenId: (deviceId, screenId) => request({ cmd: 'pair-screen', deviceId, screenId }),
    discover: (timeout = 5) => request({ cmd: 'discover', timeout }),
    refreshDevice: (device) => request({ cmd: 'refresh', device }),
    pollNowPlaying,
    activeSessions,
    currentPlayback,
    snapshot,
    unavailableReason,

    // Test seams
    _handleLine: handleLine,
    _devices: () => devices,
  };
}

module.exports = {
  DEFAULT_CONFIRM_SECONDS,
  STOP_GRACE_MS,
  CONFIRM_RETRY_MS,
  AD_CLEAR_POSITION_SECONDS,
  MAX_PLAY_DELTA_SECONDS,
  PLAYING_STATES,
  createYoutubeLounge,
};
