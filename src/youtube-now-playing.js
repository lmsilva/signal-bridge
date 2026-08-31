const path = require('path');

const { createYoutubeLounge } = require('./youtube-lounge');
const { createYoutubeApi } = require('./youtube-api');
const { createYoutubeStore } = require('./youtube-settings');
const { createSecretBox } = require('./secret-box');
const {
  buildYoutubeNowPlayingPayload,
  buildYoutubeNowPlayingClosePayload,
} = require('./udp-payload');

/**
 * The YouTube feature, assembled.
 *
 * Detection (`youtube-lounge`), metadata (`youtube-api`) and persistence
 * (`youtube-settings`) are deliberately separate and none of them know about
 * the display. This module is the only place they meet: it turns a confirmed
 * playback session into a card, keeps history, and answers the content check
 * the command registry and Display Scheduler ask.
 */

const SHORT_MAX_SECONDS = 60;
const TOKEN_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Ask Lounge for a fresh now-playing — Apple TV is often silent until polled. */
const KEEP_ALIVE_POLL_MS = 45 * 1000;
/** Backoff when a device task dies and Node has to re-connect it. */
const RECONNECT_BACKOFF_MS = [2000, 5000, 15000, 30000, 60000];
/**
 * A thumbnail that failed to download while the card was being built used to
 * stay missing for the whole video — the payload carries no URL when there is
 * no cached file, so the display had nothing to even retry. These are the
 * background attempts that fill it in, after which the card is pushed once more.
 */
const IMAGE_BACKFILL_DELAYS_MS = [5000, 20000, 60000, 180000];

function createYoutubeNowPlaying({
  config,
  log = null,
  sendUdpPayload = () => {},
  now = () => Date.now(),
  lounge: injectedLounge = null,
  api: injectedApi = null,
  store: injectedStore = null,
  imageBackfillDelays = IMAGE_BACKFILL_DELAYS_MS,
} = {}) {
  const youtubeConfig = config?.youtube || {};
  const secretBox = createSecretBox({
    keyPath: path.resolve(path.dirname(youtubeConfig.devicesPath || '.'), 'secret.key'),
  });

  const store = injectedStore || createYoutubeStore({ config, secretBox, log });
  const api = injectedApi || createYoutubeApi({ config, log, now });
  const lounge = injectedLounge || createYoutubeLounge({
    config,
    log,
    now,
    // Admin confirm-seconds slider lives in youtube-settings.json — not config.js.
    getConfirmSeconds: () => store.getSettings().confirmSeconds,
  });

  let refreshTimer = null;
  let pruneTimer = null;
  let keepAliveTimer = null;
  let lastError = null;
  let started = false;
  // videoId → resolved metadata for the currently airing card, so a progress
  // tick or a manual push does not re-resolve what we just fetched.
  let airing = null;
  /** Chases artwork for a card that had to go out without it. */
  let imageBackfill = null;
  /** @type {Map<string, { timer: NodeJS.Timeout|null, attempt: number }>} */
  const reconnectState = new Map();

  function imageBaseUrl() {
    if (youtubeConfig.imageBaseUrl) {
      return String(youtubeConfig.imageBaseUrl).replace(/\/+$/, '');
    }
    const host = config.proxyOwnIp || config.webServer?.publicHost || null;
    if (!host) {
      return '';
    }
    const scheme = config.webServer?.https === false ? 'http' : 'https';
    const port = config.webServer?.port || 47810;
    return `${scheme}://${host}:${port}`;
  }

  function deviceLabelFor(deviceId) {
    return store.getDevice(deviceId)?.label || null;
  }

  function isSuppressedShort(video) {
    if (store.getSettings().showShorts) {
      return false;
    }
    // A Short is usually over before the card renders (§12.10). Live streams
    // report a zero duration, so they must not be caught by this.
    return video.durationSeconds > 0
      && video.durationSeconds < SHORT_MAX_SECONDS
      && video.liveBroadcastContent === 'none';
  }

  // ------------------------------------------------------ session handling

  function cancelImageBackfill() {
    if (imageBackfill?.timer) {
      clearTimeout(imageBackfill.timer);
    }
    imageBackfill = null;
  }

  /** Live scrubber position, so a re-push does not rewind the progress bar. */
  function livePositionSeconds(deviceId, fallback = 0) {
    try {
      const device = lounge._devices?.()?.get?.(deviceId);
      const position = Math.max(Number(device?.position) || 0, Number(device?.maxPosition) || 0);
      return position > 0 ? Math.round(position) : fallback;
    } catch {
      return fallback;
    }
  }

  /**
   * Keep chasing the artwork for a card that is already on the wall.
   *
   * The payload can only carry a thumbnail URL once the file exists locally, so
   * a download that failed while the card was being built left the hero empty
   * with nothing for the display to retry — for the entire video. When a later
   * attempt lands we push the card once more, which is the same "redraw only
   * when the retry actually filled a band" rule the PSN poller follows.
   */
  function scheduleImageBackfill({ videoId, deviceId, startedAt, settings }) {
    cancelImageBackfill();
    const candidateUrls = airing?.video?.thumbnailCandidateUrls || [];
    if (!candidateUrls.length || !imageBackfillDelays.length) {
      return;
    }
    const state = { attempt: 0, timer: null };
    imageBackfill = state;

    const stale = () => imageBackfill !== state || airing?.videoId !== videoId;

    const run = async () => {
      state.timer = null;
      if (stale()) {
        return;
      }
      let file = null;
      try {
        ({ file } = await api.cacheFirstImage(candidateUrls.map((url) => ({ url }))));
      } catch (error) {
        log?.warn?.('Could not backfill a YouTube thumbnail', error?.message || error);
      }
      if (stale()) {
        return;
      }
      if (file) {
        imageBackfill = null;
        airing.video.thumbnailFile = file;
        const payload = buildYoutubeNowPlayingPayload(airing.video, config, {
          trigger: 'youtube-thumbnail-backfill',
          mode: 'playing',
          deviceLabel: deviceLabelFor(deviceId),
          imageBaseUrl: imageBaseUrl(),
          settings,
          session: {
            startedAt,
            positionSeconds: livePositionSeconds(deviceId),
          },
        });
        if (payload) {
          sendUdpPayload(payload);
          log?.info?.(`Thumbnail arrived late for ${videoId} — refreshed the card`);
        }
        return;
      }
      state.attempt += 1;
      if (state.attempt >= imageBackfillDelays.length) {
        imageBackfill = null;
        log?.warn?.(`Gave up fetching the thumbnail for ${videoId}`);
        return;
      }
      state.timer = setTimeout(run, imageBackfillDelays[state.attempt]);
      state.timer.unref?.();
    };

    state.timer = setTimeout(run, imageBackfillDelays[0]);
    state.timer.unref?.();
  }

  async function onStarted(event) {
    const settings = store.getSettings();
    let video;
    try {
      video = await api.resolveVideo(event.videoId, {
        includeDislikes: settings.showDislikes,
      });
    } catch (error) {
      lastError = error?.message || String(error);
      log?.warn?.('Could not resolve a YouTube video', lastError);
      return;
    }
    if (isSuppressedShort(video)) {
      log?.info?.(`Suppressing a YouTube Short (${event.videoId})`);
      return;
    }
    // Seed history as soon as a session confirms. Waiting for `stopped` alone
    // meant `./recreate.sh` (or any container kill) erased every in-flight
    // watch — metadata cache survived on disk, last-played did not.
    store.recordSession({
      videoId: event.videoId,
      deviceId: event.deviceId,
      startedAt: event.startedAt,
      endedAt: event.startedAt,
      watchedSeconds: 0,
      positionSeconds: 0,
      durationSeconds: event.durationSeconds || video.durationSeconds || 0,
      completed: false,
    });
    // Resolve can outlive a flicker Stopped. Only abandon the push when Lounge
    // has clearly moved on to a *different* video — a cleared active/provisional
    // (or stop-grace) still means this video is what just confirmed, and history
    // already proves we used to drop the card entirely in that window.
    const deviceMap = lounge._devices?.();
    if (deviceMap && typeof deviceMap.get === 'function') {
      const device = deviceMap.get(event.deviceId);
      if (device) {
        const currentId = device.active?.videoId || device.provisional || null;
        if (currentId && currentId !== event.videoId) {
          log?.info?.(`Skipping YouTube push — ${event.videoId} already replaced by ${currentId}`);
          return;
        }
      }
    }
    airing = { videoId: event.videoId, deviceId: event.deviceId, video };
    const payload = buildYoutubeNowPlayingPayload(video, config, {
      trigger: 'youtube-lounge',
      mode: 'playing',
      deviceLabel: deviceLabelFor(event.deviceId),
      imageBaseUrl: imageBaseUrl(),
      settings,
      session: { startedAt: event.startedAt, positionSeconds: 0 },
    });
    if (payload) {
      sendUdpPayload(payload);
    }
    if (!video.thumbnailFile) {
      scheduleImageBackfill({
        videoId: event.videoId,
        deviceId: event.deviceId,
        startedAt: event.startedAt,
        settings,
      });
    }
  }

  function onStopped(event) {
    const wall = Number(event.wallSeconds);
    const meaningful = (Number.isFinite(wall) ? wall : 0) >= 2
      || Number(event.watchedSeconds) > 0
      || Number(event.positionSeconds) > 0
      // A confirmed session that already seeded history still deserves a final
      // row even when Lounge never delivered a scrubber sample.
      || Boolean(event.startedAt && event.videoId);
    if (meaningful) {
      store.recordSession(event);
    }
    if (airing?.videoId === event.videoId) {
      airing = null;
      cancelImageBackfill();
      sendUdpPayload(buildYoutubeNowPlayingClosePayload({ trigger: 'youtube-lounge-stop' }, config));
    }
  }

  function onObserved(event) {
    if (!event?.videoId) {
      return;
    }
    const settings = store.getSettings();
    const durationSeconds = Number(event.durationSeconds) || 0;
    if (
      durationSeconds > 0
      && durationSeconds < SHORT_MAX_SECONDS
      && settings.showShorts !== true
    ) {
      return;
    }
    store.recordSession(event);
    if (event.deviceId && event.endedAt && typeof store.touchLastSeen === 'function') {
      store.touchLastSeen(event.deviceId, event.endedAt);
    }
  }

  function seedHistoryFromPlayback(live) {
    if (!live?.videoId) {
      return;
    }
    store.recordSession({
      videoId: live.videoId,
      deviceId: live.deviceId,
      startedAt: live.startedAt || new Date().toISOString(),
      endedAt: new Date().toISOString(),
      watchedSeconds: live.watchedSeconds || 0,
      positionSeconds: live.positionSeconds || 0,
      durationSeconds: live.durationSeconds || 0,
      completed: false,
    });
  }

  /**
   * Rebuild last-played from the metadata cache when history is empty.
   *
   * `./recreate.sh` never touches `./data`, but history used to live only in
   * memory until a session stopped — so a rebuild mid-watch left an empty
   * history file next to a full `youtube-cache.json`. Prefer the real watch
   * log when it exists; otherwise recover the most recently resolved videos.
   */
  function recoverHistoryFromCache() {
    if (store.hasHistory?.() || store.lastPlayed()) {
      return 0;
    }
    const recent = typeof api.recentVideos === 'function' ? api.recentVideos({ limit: 20 }) : [];
    if (!recent.length) {
      return 0;
    }
    const fallbackDeviceId = store.listDevices()[0]?.id || 'unknown';
    // Oldest first so each prepend leaves the newest video at the head.
    const chronological = [...recent].reverse();
    for (const video of chronological) {
      const at = video.fetchedAt || new Date().toISOString();
      store.recordSession({
        videoId: video.videoId,
        deviceId: fallbackDeviceId,
        startedAt: at,
        endedAt: at,
        watchedSeconds: 0,
        positionSeconds: 0,
        durationSeconds: video.durationSeconds || 0,
        completed: false,
      });
    }
    log?.info?.(`Recovered ${chronological.length} YouTube history entr${chronological.length === 1 ? 'y' : 'ies'} from the metadata cache`);
    return chronological.length;
  }

  function onPrefetch(event) {
    api.prefetchVideo(event.videoId).catch(() => {});
  }

  // ------------------------------------------------------- device linking

  async function connectDevice(device) {
    if (!device?.enabled) {
      return { ok: false, error: 'Device is disabled' };
    }
    const result = await lounge.connectDevice({
      id: device.id,
      screenId: device.screenId,
      authState: device.authState,
    });
    // A revoked link is a real, recurring event and must surface as a status
    // the user can act on, never a silent failure (§8.3).
    store.markDeviceStatus(
      device.id,
      result.ok ? 'linked' : (result.error === 'needs-relink' ? 'needs-relink' : 'unreachable'),
      result.ok ? null : result.error,
    );
    if (result.ok && (result.screenName || result.screenDeviceName)) {
      store.saveDevice({
        ...store.getDevice(device.id),
        screenName: result.screenName,
        screenDeviceName: result.screenDeviceName,
      });
    }
    return result;
  }

  async function connectAll() {
    for (const device of store.listDevices()) {
      if (!device.enabled) {
        continue;
      }
      try {
        // One dead link must not stop the others from connecting (§12.13).
        await connectDevice(device);
      } catch (error) {
        log?.warn?.(`YouTube device ${device.label} failed to connect`, error?.message || error);
      }
    }
  }

  function clearReconnect(deviceId) {
    const entry = reconnectState.get(deviceId);
    if (entry?.timer) {
      clearTimeout(entry.timer);
    }
    reconnectState.delete(deviceId);
  }

  function clearAllReconnects() {
    for (const deviceId of [...reconnectState.keys()]) {
      clearReconnect(deviceId);
    }
  }

  /**
   * Lounge subscribe tasks can still die hard (agent crash, needs-relink).
   * The Python sidecar reconnects across normal long-poll ends; this is the
   * safety net when the whole device task exits and Node hears `disconnected`.
   */
  function scheduleReconnect(deviceId, reason = null) {
    const device = store.getDevice(deviceId);
    if (!device?.enabled || !started) {
      return;
    }
    if (reason === 'needs-relink' || device.status === 'needs-relink') {
      store.markDeviceStatus(deviceId, 'needs-relink', reason || device.statusDetail);
      clearReconnect(deviceId);
      return;
    }
    const existing = reconnectState.get(deviceId) || { timer: null, attempt: 0 };
    if (existing.timer) {
      return;
    }
    const delay = RECONNECT_BACKOFF_MS[
      Math.min(existing.attempt, RECONNECT_BACKOFF_MS.length - 1)
    ];
    existing.attempt += 1;
    existing.timer = setTimeout(() => {
      existing.timer = null;
      const current = store.getDevice(deviceId);
      if (!started || !current?.enabled) {
        clearReconnect(deviceId);
        return;
      }
      connectDevice(current)
        .then((result) => {
          if (result?.ok) {
            clearReconnect(deviceId);
            return;
          }
          if (result?.error === 'needs-relink') {
            clearReconnect(deviceId);
            return;
          }
          scheduleReconnect(deviceId, result?.error);
        })
        .catch((error) => {
          log?.warn?.(`YouTube reconnect failed for ${current.label}`, error?.message || error);
          scheduleReconnect(deviceId);
        });
    }, delay);
    existing.timer?.unref?.();
    reconnectState.set(deviceId, existing);
    log?.info?.(
      `YouTube device ${device.label} disconnected`
      + (reason ? ` (${reason})` : '')
      + ` — reconnecting in ${Math.round(delay / 1000)}s`,
    );
  }

  async function keepAlivePoll() {
    if (!started || typeof lounge.pollNowPlaying !== 'function') {
      return;
    }
    // Before asking for fresh state, retire anything the device has gone quiet
    // on — otherwise a TV that vanished mid-video stays "playing" forever.
    if (typeof lounge.sweepIdleSessions === 'function') {
      lounge.sweepIdleSessions();
    }
    let result;
    try {
      result = await lounge.pollNowPlaying();
    } catch (error) {
      log?.warn?.('YouTube keep-alive poll failed', error?.message || error);
      return;
    }
    // A dead agent session reports not-connected per device — re-bind those.
    const rows = Array.isArray(result?.devices) ? result.devices : null;
    if (rows) {
      const reported = new Set();
      for (const row of rows) {
        if (row?.deviceId) {
          reported.add(String(row.deviceId));
        }
        // Any failed row means the bind is not delivering. Matching only
        // `not-connected` left the worst case invisible: the sidecar task is
        // still alive — so the device is listed and looks healthy — while its
        // bind is dead and `get_now_playing()` raises. That device was never
        // re-bound, and the TV stayed `linked` and silent until a restart.
        if (row?.ok === false) {
          scheduleReconnect(row.deviceId, row.error || 'not-connected');
        }
      }
      const known = new Set(store.listDevices().map((device) => String(device.id)));
      // The agent drops a device from its session table as soon as that task
      // dies, so a dead link is *absent* here rather than reported unhealthy.
      // Without this an empty list read as "everything is fine" and the TV sat
      // linked and silent forever — the exact failure this poll exists to catch.
      for (const device of store.listDevices()) {
        if (device.enabled && !reported.has(String(device.id))) {
          scheduleReconnect(device.id, 'not-connected');
        }
      }
      // The mirror of that: a session the store has never heard of is a ghost
      // left by a delete or a re-register, and it is still holding the Lounge
      // bind for a screen a live device now wants. Polling it here would only
      // help it steal the bind back, so hang it up instead.
      for (const deviceId of reported) {
        if (!known.has(deviceId)) {
          log?.info?.(`YouTube dropping orphaned lounge session ${deviceId}`);
          await disconnectSession(deviceId);
        }
      }
    } else if (result?.ok === false && result.error === 'not-connected') {
      for (const device of store.listDevices()) {
        if (device.enabled) {
          scheduleReconnect(device.id, 'not-connected');
        }
      }
    }
    syncDeviceLastSeen();
  }

  function syncDeviceLastSeen() {
    if (typeof store.touchLastSeen !== 'function' || typeof lounge.snapshot !== 'function') {
      return;
    }
    const snap = lounge.snapshot();
    for (const row of snap?.devices || []) {
      if (row?.deviceId && row.lastSeenAt) {
        store.touchLastSeen(row.deviceId, row.lastSeenAt);
      }
    }
  }

  async function linkDevice({ label, pairingCode = null, screenId = null } = {}) {
    const draft = store.saveDevice({ label: label || 'YouTube device', status: 'refreshing' });
    const result = pairingCode
      ? await lounge.pairWithCode(draft.id, pairingCode)
      : await lounge.pairWithScreenId(draft.id, screenId);

    if (!result.ok) {
      store.removeDevice(draft.id);
      return {
        ok: false,
        error: result.error === 'code-expired'
          ? 'That code has expired — get a fresh one from the TV'
          // The agent knows why it cannot run; repeating a generic sentence
          // here would throw that away and leave nothing to act on.
          : (result.error === 'pyytlounge-missing'
            ? (lounge.unavailableReason?.() || result.detail || 'The YouTube agent could not start')
            : result.error || 'Could not link that device'),
      };
    }

    const linkedScreenId = result.screenId || screenId;
    const saved = store.saveDevice({
      id: draft.id,
      label: label || result.screenName || 'YouTube device',
      screenId: linkedScreenId,
      screenName: result.screenName,
      screenDeviceName: result.screenDeviceName,
      authState: result.authState ? JSON.stringify(result.authState) : null,
      status: 'linked',
    });
    // Re-registering a TV that is already linked is the common way out of a
    // stuck session, and leaving the old row behind would have the two rows
    // fight over one screen's Lounge bind — the very thing being fixed.
    if (linkedScreenId) {
      for (const other of store.listDevices()) {
        if (other.id !== saved.id && other.screenId === linkedScreenId) {
          log?.info?.(`YouTube replacing earlier link for ${other.label}`);
          await forgetDevice(other.id);
        }
      }
    }
    await connectDevice(store.getDevice(saved.id));
    return { ok: true, device: store.publicDevices().find((entry) => entry.id === saved.id) };
  }

  async function relinkDevice(id) {
    const device = store.getDevice(id);
    if (!device) {
      return { ok: false, error: 'Unknown device' };
    }
    if (!device.screenId) {
      return { ok: false, error: 'No screen ID stored — link the device again with a TV code' };
    }
    // §8.3 layer 2: a known screen ID re-pairs with no code and no human.
    const result = await lounge.pairWithScreenId(device.id, device.screenId);
    if (!result.ok) {
      store.markDeviceStatus(device.id, 'needs-relink', result.error);
      return { ok: false, error: 'YouTube refused the re-link — pair again with a TV code' };
    }
    store.saveDevice({
      ...device,
      authState: result.authState ? JSON.stringify(result.authState) : device.authState,
      status: 'linked',
      statusDetail: null,
    });
    await connectDevice(store.getDevice(device.id));
    return { ok: true };
  }

  /**
   * Drop a device for good — agent session included.
   *
   * Removing the store row alone left the sidecar's `_run_device` task running
   * forever: it keeps re-binding through `_reestablish`, so a re-registered TV
   * (a new device id for the same screen) fights its own ghost for the Lounge
   * bind and the events land under an id the store no longer knows. That reads
   * as "linked, but nothing is ever detected".
   */
  async function forgetDevice(id) {
    const deviceId = String(id);
    clearReconnect(deviceId);
    await disconnectSession(deviceId);
    return store.removeDevice(deviceId);
  }

  async function disconnectSession(deviceId) {
    if (typeof lounge.disconnectDevice !== 'function') {
      return;
    }
    try {
      await lounge.disconnectDevice(String(deviceId));
    } catch (error) {
      log?.warn?.(`YouTube device ${deviceId} would not disconnect`, error?.message || error);
    }
  }

  /** Pausing a device has to release the screen too, or the ghost keeps the bind. */
  async function setDeviceEnabled(id, enabled) {
    const device = store.getDevice(id);
    if (!device) {
      return null;
    }
    const next = store.saveDevice({ ...device, enabled: enabled !== false });
    if (enabled === false) {
      clearReconnect(String(id));
      await disconnectSession(id);
    } else if (!device.enabled) {
      await connectDevice(store.getDevice(id));
    }
    return next;
  }

  async function discover() {
    const result = await lounge.discover(5);
    if (!result.ok) {
      return result;
    }
    const linked = new Set(store.listDevices().map((device) => device.screenId).filter(Boolean));
    return {
      ok: true,
      devices: (result.devices || []).map((entry) => ({
        ...entry,
        // "Apple TV 4K · 192.168.1.42" comes from the SSDP SERVER header.
        name: entry.server?.split(' ')[0] || entry.address,
        alreadyLinked: Boolean(entry.screenId && linked.has(entry.screenId)),
      })),
    };
  }

  /** Refresh at 80% of remaining token lifetime; entirely invisible (§8.3). */
  async function refreshTokens() {
    for (const device of store.listDevices()) {
      if (!device.enabled || !device.authState) {
        continue;
      }
      const expiry = Number(device.tokenExpiry) || 0;
      if (expiry && now() < expiry * 1000 - (expiry * 1000 - now()) * 0.2) {
        continue;
      }
      const result = await lounge.refreshDevice({
        id: device.id,
        screenId: device.screenId,
        authState: device.authState,
      });
      if (!result.ok) {
        store.markDeviceStatus(device.id, 'needs-relink', result.error);
      }
    }
  }

  // ------------------------------------------------------------- pushing

  /** Which device wins when two rooms are playing at once (§7). */
  /**
   * Is this row something someone is watching right now?
   *
   * `currentPlayback()` deliberately reports whatever is on the TV, including
   * Paused, Stopped and unconfirmed videos, so that the manual push does not
   * air days-old history while a video sits on screen. That makes it the right
   * thing to *show* and the wrong thing to call "now playing": a card in that
   * mode draws a NOW PLAYING badge and an elapsed clock that counts up from
   * `startedAt` forever. Only a live Playing tick earns that.
   */
  function isLivePlayback(session) {
    return Boolean(session) && String(session.state || '') === 'Playing';
  }

  function pickSession(sessions, requestedDeviceId = null) {
    if (!sessions.length) {
      return null;
    }
    if (requestedDeviceId) {
      return sessions.find((entry) => entry.deviceId === requestedDeviceId) || null;
    }
    const settings = store.getSettings();
    if (settings.multiDevice === 'preferred' && settings.preferredDeviceId) {
      const preferred = sessions.find((entry) => entry.deviceId === settings.preferredDeviceId);
      if (preferred) {
        return preferred;
      }
    }
    // Most recent wins. Sorted here rather than trusting the detector's order,
    // so the rule holds whatever produced the list.
    return [...sessions].sort(
      (a, b) => Date.parse(b.startedAt || 0) - Date.parse(a.startedAt || 0),
    )[0];
  }

  /**
   * @param {Object} [options]
   * @param {'auto'|'now-playing'|'last-played'} [options.requestedMode] `auto`
   *   (the admin test button) falls back to the last video watched. The
   *   scheduler asks for one mode so a `youtube.now-playing` rule cannot
   *   quietly air a last-played card instead.
   */
  async function pushManualPreview({
    device = 'Signal',
    send,
    requestedMode = 'auto',
    deviceId = null,
    videoId = null,
  } = {}) {
    const settings = store.getSettings();
    const emit = typeof send === 'function' ? send : sendUdpPayload;

    let mode = 'playing';
    let session = null;
    let targetVideoId = videoId;
    let targetDeviceId = deviceId;

    // Apple TV often goes quiet between ticks — ask Lounge for a fresh
    // now-playing before deciding the TV is idle and falling back to history.
    // Last-played used to skip this poll, so a video still on the TV (Stopped
    // or paused) was ignored in favour of a days-old history row.
    if (!targetVideoId && typeof lounge.pollNowPlaying === 'function') {
      try {
        await lounge.pollNowPlaying(deviceId);
        const settleMs = Number(youtubeConfig.pollSettleMs);
        await new Promise((resolve) => setTimeout(
          resolve,
          Number.isFinite(settleMs) ? Math.max(0, settleMs) : 500,
        ));
      } catch (error) {
        log?.warn?.('YouTube now-playing poll failed', error?.message || error);
      }
    }

    if (!targetVideoId && requestedMode !== 'last-played') {
      // Prefer confirmed Playing, then any current/provisional Lounge video —
      // otherwise the admin button silently airs stale history while the TV
      // is already on something else.
      const live = typeof lounge.currentPlayback === 'function'
        ? lounge.currentPlayback()
        : lounge.activeSessions();
      session = pickSession(live, deviceId)
        || pickSession(lounge.activeSessions(), deviceId);
      targetVideoId = session?.videoId || null;
      targetDeviceId = session?.deviceId || deviceId;
      if (requestedMode === 'now-playing' && !isLivePlayback(session)) {
        return { ok: false, error: 'Nothing is playing on YouTube right now' };
      }
    }

    if (!targetVideoId && requestedMode === 'last-played') {
      const live = typeof lounge.currentPlayback === 'function'
        ? lounge.currentPlayback()
        : lounge.activeSessions();
      session = pickSession(live, deviceId)
        || pickSession(lounge.activeSessions(), deviceId);
      if (session?.videoId) {
        seedHistoryFromPlayback(session);
        targetVideoId = session.videoId;
        targetDeviceId = session.deviceId || deviceId;
        mode = 'last-played';
      }
    }

    if (!targetVideoId) {
      const previous = store.lastPlayed(deviceId);
      if (!previous) {
        return { ok: false, error: 'Nothing playing right now, and no watch history yet' };
      }
      mode = 'last-played';
      targetVideoId = previous.videoId;
      targetDeviceId = previous.deviceId;
      session = previous;
    } else if (requestedMode !== 'last-played' && !isLivePlayback(session)) {
      // The video is still on the TV but nothing is running — a paused, stopped
      // or merely announced video. Record what was watched and label the card
      // honestly rather than starting a clock against a session that is over.
      seedHistoryFromPlayback(session);
      mode = 'last-played';
      session = store.lastPlayed(targetDeviceId) || session;
    }

    let video;
    try {
      video = await api.resolveVideo(targetVideoId, { includeDislikes: settings.showDislikes });
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }

    const payload = buildYoutubeNowPlayingPayload(video, config, {
      device,
      trigger: 'youtube-manual-preview',
      mode,
      dismissible: true,
      deviceLabel: deviceLabelFor(targetDeviceId),
      imageBaseUrl: imageBaseUrl(),
      settings,
      session,
    });
    if (!payload) {
      return { ok: false, error: 'Failed to build the YouTube display payload' };
    }
    emit(payload);
    log?.info?.('YouTube manual preview pushed', { mode, videoId: targetVideoId, title: video.title });
    return {
      ok: true,
      mode,
      videoId: targetVideoId,
      title: video.title,
      displaySeconds: payload.displaySeconds,
    };
  }

  // -------------------------------------------------------------- status

  function statusSnapshot() {
    const sessions = lounge.activeSessions();
    const devices = store.publicDevices();
    const chosen = pickSession(sessions);
    const loungeSnap = typeof lounge.snapshot === 'function' ? lounge.snapshot() : null;
    const seenById = new Map(
      (loungeSnap?.devices || []).map((row) => [row.deviceId, row.lastSeenAt]),
    );
    const last = store.lastPlayed();
    const lastTitle = last && typeof api.cachedVideo === 'function'
      ? api.cachedVideo(last.videoId)?.title
      : null;
    return {
      enabled: youtubeConfig.enabled !== false,
      configured: devices.length > 0,
      hasApiKey: Boolean(String(config?.youtube?.apiKey || '').trim()),
      apiKeySource: config?.youtube?.apiKeySource || null,
      // The command registry's content check keys off this one boolean.
      playing: Boolean(chosen),
      hasHistory: Boolean(last),
      videoId: chosen?.videoId || null,
      deviceId: chosen?.deviceId || null,
      deviceLabel: chosen ? deviceLabelFor(chosen.deviceId) : null,
      sessions,
      devices: devices.map((device) => ({
        ...device,
        lastSeenAt: seenById.get(device.id) || device.lastSeenAt,
      })),
      needsRelink: devices.filter((entry) => entry.status === 'needs-relink').map((e) => e.label),
      lounge: loungeSnap || lounge.snapshot(),
      cache: api.stats(),
      settings: store.getSettings(),
      lastPlayed: last ? { ...last, title: lastTitle || null } : null,
      message: lastError,
    };
  }

  // --------------------------------------------------------------- control

  function start() {
    if (started || youtubeConfig.enabled === false) {
      return;
    }
    started = true;
    recoverHistoryFromCache();
    lounge.on('started', (event) => {
      onStarted(event).catch((error) => log?.warn?.('YouTube start failed', error?.message || error));
    });
    lounge.on('stopped', onStopped);
    lounge.on('observed', onObserved);
    lounge.on('prefetch', onPrefetch);
    lounge.on('ready', () => {
      clearAllReconnects();
      connectAll().catch((error) => log?.warn?.('YouTube connect failed', error?.message || error));
    });
    lounge.on('device-disconnected', (event) => {
      scheduleReconnect(event?.deviceId, event?.reason || null);
    });
    lounge.on('auth', (event) => {
      const device = store.getDevice(event.deviceId);
      if (device && event.authState) {
        store.saveDevice({
          ...device,
          authState: JSON.stringify(event.authState),
          // Without this every pass of `refreshTokens` re-refreshes a token
          // that is still good for weeks.
          tokenExpiry: Number(event.expiry) || device.tokenExpiry || null,
        });
      }
    });
    lounge.start();

    refreshTimer = setInterval(() => {
      refreshTokens().catch((error) => log?.warn?.('YouTube token refresh failed', error?.message || error));
    }, TOKEN_REFRESH_INTERVAL_MS);
    refreshTimer.unref?.();

    keepAliveTimer = setInterval(() => {
      keepAlivePoll().catch((error) => log?.warn?.('YouTube keep-alive failed', error?.message || error));
    }, KEEP_ALIVE_POLL_MS);
    keepAliveTimer.unref?.();

    pruneTimer = setInterval(() => {
      const removed = api.pruneThumbnails();
      if (removed) {
        log?.info?.(`Pruned ${removed} stale YouTube thumbnail(s)`);
      }
    }, PRUNE_INTERVAL_MS);
    pruneTimer.unref?.();
  }

  function stop() {
    started = false;
    clearAllReconnects();
    cancelImageBackfill();
    clearInterval(refreshTimer);
    clearInterval(pruneTimer);
    clearInterval(keepAliveTimer);
    refreshTimer = null;
    pruneTimer = null;
    keepAliveTimer = null;
    lounge.stop();
    api.flush();
  }

  return {
    start,
    stop,
    store,
    api,
    lounge,
    linkDevice,
    relinkDevice,
    forgetDevice,
    setDeviceEnabled,
    discover,
    connectDevice,
    refreshTokens,
    pushManualPreview,
    statusSnapshot,
    hasContent: () => lounge.activeSessions().length > 0 || Boolean(store.lastPlayed()),
    imageBaseUrl,

    // Test seams
    _onStarted: onStarted,
    _onStopped: onStopped,
    _onObserved: onObserved,
    _recoverHistoryFromCache: recoverHistoryFromCache,
    _scheduleReconnect: scheduleReconnect,
    _keepAlivePoll: keepAlivePoll,
    _reconnectState: reconnectState,
  };
}

module.exports = {
  SHORT_MAX_SECONDS,
  KEEP_ALIVE_POLL_MS,
  RECONNECT_BACKOFF_MS,
  createYoutubeNowPlaying,
};
