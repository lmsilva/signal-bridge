/**
 * Feature Presentation — Plex session watcher.
 *
 * Polls /status/sessions, keeps one movie for the configured theater player,
 * and emits vestaboard-only plex.now-playing snapshots. A pause is not a
 * stop. A dead Plex server is not a stop either.
 */

const fs = require('fs');
const path = require('path');
const { fetchSessions } = require('./plex-api');
const { createPlexSettings } = require('./plex-settings');
const {
  defaultCredentialsPath,
  resolvePlexToken,
  credentialsStatus,
} = require('./plex-credentials');

const AUTH_POLL_MS = 5 * 60 * 1000;
const SEEK_SLACK_MS = 5000;
const FAILURES_BEFORE_UNHEALTHY = 3;

function resolveStatePath(config, settings) {
  return path.resolve(
    config.ROOT || path.resolve(__dirname, '..'),
    settings.stateFile || 'data/plex-now-playing.json',
  );
}

function credentialsPathOf(config) {
  return config.plexCredentialsPath
    || defaultCredentialsPath(config.ROOT || path.resolve(__dirname, '..'));
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function iso(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function qualifies(session, settings) {
  if (!session) {
    return false;
  }
  const types = settings.mediaTypes || ['movie'];
  if (!types.includes(session.type)) {
    return false;
  }
  const players = settings.monitoredPlayers || [];
  if (!players.length) {
    return false;
  }
  return players.includes(session.player?.address);
}

function pickSession(sessions, settings) {
  const hits = (sessions || []).filter((entry) => qualifies(entry, settings));
  if (!hits.length) {
    return null;
  }
  hits.sort((a, b) => Number(b.sessionKey || 0) - Number(a.sessionKey || 0));
  const playing = hits.find((entry) => entry.player?.state === 'playing');
  return playing || hits[0];
}

function endsAtMs(session, nowMs) {
  if (session?.durationMs == null) {
    return null;
  }
  const remaining = Math.max(0, session.durationMs - (session.viewOffsetMs || 0));
  return nowMs + remaining;
}

function sameMovie(current, next) {
  if (!current || !next) {
    return false;
  }
  if (current.sessionKey && next.sessionKey) {
    return current.sessionKey === next.sessionKey;
  }
  return current.title === next.title;
}

function isSeek(session, previous, pollIntervalMs) {
  if (!previous || previous.viewOffsetMs == null || session.viewOffsetMs == null) {
    return false;
  }
  const delta = Math.abs(session.viewOffsetMs - previous.viewOffsetMs);
  return delta > (pollIntervalMs + SEEK_SLACK_MS);
}

function playerView(session) {
  const player = session?.player || {};
  return {
    address: player.address || '',
    name: player.name || '',
    product: player.product || '',
  };
}

function buildPayload(mode, record) {
  if (!record?.title) {
    return {
      type: 'plex.now-playing',
      plex: {
        mode,
        title: '',
        contentRating: null,
        criticScore: null,
        startedAt: null,
        endsAt: null,
        endedAt: null,
        player: { address: '', name: '', product: '' },
      },
    };
  }
  return {
    type: 'plex.now-playing',
    plex: {
      mode,
      title: record.title,
      contentRating: record.contentRating || null,
      criticScore: record.criticScore == null ? null : record.criticScore,
      startedAt: record.startedAt || null,
      endsAt: mode === 'now-playing' ? (record.endsAt || null) : null,
      endedAt: mode === 'last-played' ? (record.endedAt || null) : null,
      player: record.player || { address: '', name: '', product: '' },
    },
  };
}

function createPlexNowPlaying({
  config = {},
  log = console,
  sendUdpPayload,
  settings: injectedSettings = null,
  fetchSessions: fetchImpl = fetchSessions,
  now = () => Date.now(),
} = {}) {
  const settingsStore = injectedSettings || createPlexSettings(config, log);
  const credPath = credentialsPathOf(config);

  let timer = null;
  let started = false;
  let consecutiveFailures = 0;
  let health = 'idle';
  let healthReason = '';
  let missingSince = null;
  let lastPollPlayers = [];
  let session = null;
  let lastPlayed = null;
  let resumeEmit = false;

  function statePath() {
    return resolveStatePath(config, settingsStore.get());
  }

  function loadState() {
    const raw = readJson(statePath());
    session = raw?.session || null;
    lastPlayed = raw?.lastPlayed || null;
    resumeEmit = Boolean(session);
  }

  function persist() {
    try {
      writeJson(statePath(), {
        session,
        lastPlayed,
        updatedAt: iso(now()),
      });
    } catch (error) {
      log?.warn?.('Could not save Plex now-playing state', error?.message || error);
    }
  }

  function tokenOf() {
    return resolvePlexToken({ credentialsPath: credPath }).token;
  }

  function emitOptions(settings, { explicit = false } = {}) {
    const zone = settings.localTimeZone
      || config.voiceEvents?.localTimeZone
      || '';
    return {
      targetId: 'vestaboard',
      explicit,
      quietHoursExempt: explicit ? true : Boolean(settings.quietHoursExempt),
      ctx: {
        showCriticScore: settings.showCriticScore !== false,
        timeZone: zone || undefined,
      },
    };
  }

  function emit(mode, record, { explicit = false, settings = settingsStore.get() } = {}) {
    if (typeof sendUdpPayload !== 'function') {
      return { ok: false, error: 'No send function' };
    }
    const payload = buildPayload(mode, record);
    sendUdpPayload(payload, emitOptions(settings, { explicit }));
    return { ok: true, mode, title: record?.title || '', payload };
  }

  function markOk() {
    consecutiveFailures = 0;
    health = 'ok';
    healthReason = '';
  }

  function markFailure(error) {
    const kind = error?.kind || 'network';
    consecutiveFailures += 1;
    if (kind === 'auth') {
      health = 'auth';
      healthReason = 'Plex token was rejected';
      return;
    }
    if (consecutiveFailures >= FAILURES_BEFORE_UNHEALTHY) {
      health = 'unhealthy';
      healthReason = 'Plex unreachable';
    }
  }

  function recordLastPlayed(current, endedAt) {
    lastPlayed = {
      title: current.title,
      contentRating: current.contentRating || null,
      criticScore: current.criticScore == null ? null : current.criticScore,
      startedAt: current.startedAt,
      endedAt,
      player: current.player,
    };
  }

  function beginSession(next, nowMs, settings) {
    const startedAt = iso(nowMs);
    const ends = endsAtMs(next, nowMs);
    session = {
      sessionKey: next.sessionKey,
      title: next.title,
      contentRating: next.contentRating,
      criticScore: next.criticScore,
      durationMs: next.durationMs,
      viewOffsetMs: next.viewOffsetMs,
      startedAt,
      endsAt: ends != null ? iso(ends) : null,
      shownEndsAt: ends,
      paused: next.player?.state === 'paused',
      player: playerView(next),
      lastPollAt: nowMs,
    };
    persist();
    if (next.player?.state === 'playing') {
      emit('now-playing', session, { settings });
    }
  }

  function stopSession(settings, { emitLast = true } = {}) {
    if (!session) {
      missingSince = null;
      return;
    }
    const endedAt = iso(now());
    recordLastPlayed(session, endedAt);
    session = null;
    missingSince = null;
    persist();
    if (emitLast && settings.pushOnStop !== false) {
      emit('last-played', lastPlayed, { settings });
    }
  }

  function applyPlaying(next, nowMs, settings) {
    const paused = next.player?.state === 'paused';
    const wasPaused = Boolean(session.paused);
    const seek = isSeek(next, session, settings.pollIntervalMs);
    session.viewOffsetMs = next.viewOffsetMs;
    session.durationMs = next.durationMs;
    session.player = playerView(next);
    session.lastPollAt = nowMs;
    session.paused = paused;
    session.title = next.title;
    session.contentRating = next.contentRating;
    session.criticScore = next.criticScore;
    missingSince = null;

    if (paused) {
      persist();
      return;
    }

    const ends = endsAtMs(next, nowMs);
    session.endsAt = ends != null ? iso(ends) : session.endsAt;
    const driftMin = ends != null && session.shownEndsAt != null
      ? Math.abs(ends - session.shownEndsAt) / 60000
      : 0;
    const shouldRepush = resumeEmit
      || ((wasPaused || seek) && driftMin >= settings.repushEndDriftMinutes);

    if (shouldRepush || session.shownEndsAt == null) {
      session.shownEndsAt = ends;
      resumeEmit = false;
      persist();
      emit('now-playing', session, { settings });
      return;
    }
    persist();
  }

  async function tick() {
    const settings = settingsStore.get();
    if (!settings.enabled) {
      health = 'idle';
      healthReason = 'Feature Presentation is off';
      return;
    }
    if (!settings.serverUrl || !tokenOf()) {
      health = 'idle';
      healthReason = settings.serverUrl ? 'Plex token is missing' : 'Plex server URL is missing';
      return;
    }
    if (!settings.monitoredPlayers.length) {
      health = 'idle';
      healthReason = 'No theater player is monitored';
      return;
    }

    let sessions;
    try {
      sessions = await fetchImpl({
        serverUrl: settings.serverUrl,
        token: tokenOf(),
      });
      markOk();
    } catch (error) {
      markFailure(error);
      log?.warn?.(`Plex poll failed (${error?.kind || 'network'})`, error?.message || error);
      return;
    }

    lastPollPlayers = (sessions || []).map((entry) => ({
      name: entry.player?.name || '',
      product: entry.player?.product || '',
      address: entry.player?.address || '',
      title: entry.title || '',
      state: entry.player?.state || '',
    }));

    const next = pickSession(sessions, settings);
    const nowMs = now();
    const stopped = !next || next.player?.state === 'stopped';

    if (!session && next && next.player?.state === 'playing') {
      missingSince = nowMs;
      beginSession(next, nowMs, settings);
      return;
    }

    if (session && next && sameMovie(session, next)) {
      missingSince = nowMs;
      applyPlaying(next, nowMs, settings);
      return;
    }

    if (session && next && !sameMovie(session, next) && next.player?.state === 'playing') {
      stopSession(settings, { emitLast: false });
      beginSession(next, nowMs, settings);
      return;
    }

    if (session && stopped) {
      if (missingSince == null) {
        missingSince = nowMs;
      }
      if (nowMs - missingSince >= settings.stopGraceMs) {
        stopSession(settings);
      }
      return;
    }

    missingSince = null;
  }

  function pollDelay() {
    if (health === 'auth') {
      return AUTH_POLL_MS;
    }
    return settingsStore.get().pollIntervalMs;
  }

  function armTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!started) {
      return;
    }
    timer = setTimeout(() => {
      tick().catch((error) => {
        log?.warn?.('Plex tick failed', error?.message || error);
      }).finally(() => {
        armTimer();
      });
    }, pollDelay());
  }

  function start() {
    if (started) {
      return;
    }
    loadState();
    started = true;
    tick().catch((error) => {
      log?.warn?.('Plex first poll failed', error?.message || error);
    }).finally(() => {
      armTimer();
    });
  }

  function stop() {
    started = false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function statusSnapshot() {
    const settings = settingsStore.get();
    return {
      enabled: settings.enabled,
      health,
      healthReason,
      session: session ? { ...session, suppressed: false } : null,
      lastPlayed,
      players: lastPollPlayers,
      hasContent: Boolean(session || lastPlayed),
      playing: Boolean(session && !session.paused),
      settings,
      credentials: credentialsStatus(credPath),
    };
  }

  async function testConnection(options = {}) {
    const settings = settingsStore.get();
    const token = tokenOf();
    const serverUrl = String(options.serverUrl || settings.serverUrl || '').trim();
    if (!serverUrl) {
      return { ok: false, error: 'Set the Plex server URL first' };
    }
    if (!token) {
      return { ok: false, error: 'Save a Plex token first' };
    }
    try {
      const sessions = await fetchImpl({
        serverUrl,
        token,
      });
      lastPollPlayers = (sessions || []).map((entry) => ({
        name: entry.player?.name || '',
        product: entry.player?.product || '',
        address: entry.player?.address || '',
        title: entry.title || '',
        state: entry.player?.state || '',
      }));
      markOk();
      return {
        ok: true,
        health: 'ok',
        players: lastPollPlayers,
      };
    } catch (error) {
      markFailure(error);
      return {
        ok: false,
        error: error?.message || 'Plex test failed',
        health,
        healthReason,
      };
    }
  }

  async function liveSession() {
    const settings = settingsStore.get();
    if (!settings.serverUrl || !tokenOf() || !settings.monitoredPlayers.length) {
      return session;
    }
    try {
      const sessions = await fetchImpl({
        serverUrl: settings.serverUrl,
        token: tokenOf(),
      });
      markOk();
      const next = pickSession(sessions, settings);
      if (next && next.player?.state === 'playing') {
        return {
          ...next,
          startedAt: session && sameMovie(session, next) ? session.startedAt : iso(now()),
          endsAt: iso(endsAtMs(next, now())),
          player: playerView(next),
        };
      }
    } catch {
      // Preview falls back to cached state.
    }
    return session;
  }

  async function pushManualPreview({
    requestedMode = 'auto',
    send,
    explicit = true,
  } = {}) {
    const settings = settingsStore.get();
    const emitWith = (mode, record) => {
      const payload = buildPayload(mode, record);
      const options = emitOptions(settings, { explicit });
      if (typeof send === 'function') {
        send(payload, options);
      } else if (typeof sendUdpPayload === 'function') {
        sendUdpPayload(payload, options);
      } else {
        return { ok: false, error: 'No send function' };
      }
      return { ok: true, mode, title: record?.title || '', payload };
    };

    const mode = String(requestedMode || 'auto').trim();
    const live = await liveSession();

    if (mode === 'last-played') {
      if (lastPlayed?.title) {
        return emitWith('last-played', lastPlayed);
      }
      return emitWith('last-played', null);
    }

    if (mode === 'now-playing') {
      if (live?.title) {
        return emitWith('now-playing', live);
      }
      return emitWith('now-playing', null);
    }

    if (live?.title) {
      return emitWith('now-playing', live);
    }
    if (lastPlayed?.title) {
      return emitWith('last-played', lastPlayed);
    }
    return emitWith('now-playing', null);
  }

  loadState();

  return {
    start,
    stop,
    tick,
    settings: settingsStore,
    statusSnapshot,
    testConnection,
    pushManualPreview,
    applySettings(patch) {
      const next = settingsStore.update(patch);
      if (started) {
        armTimer();
      }
      return next;
    },
    // Test seam: inspect the in-memory session without going through persist.
    _debug: () => ({ session, lastPlayed, health, missingSince, consecutiveFailures }),
  };
}

module.exports = {
  createPlexNowPlaying,
  buildPayload,
  pickSession,
  qualifies,
  endsAtMs,
  isSeek,
  sameMovie,
};
