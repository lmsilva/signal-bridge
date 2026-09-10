/**
 * Session state machine for the Huupe Mini.
 *
 * The hoop never tells us a session started — it only ever reports shots. So a
 * session is inferred: it opens on sustained shooting, stays open while the ball
 * keeps moving, and closes on Family Mode's own final scoreboard, on an
 * inactivity timeout, or on the collector losing the device.
 *
 * That last case is the one that matters most on the wall. A hoop that is
 * switched off mid-game will never send an end event, so a live card left up
 * would block the scheduler indefinitely. Every path out of `live` therefore
 * ends in either a final card with a scheduled close, or an immediate close.
 */

const { ZONES } = require('./huupe-aggregates');

const IDLE = 'idle';
const LIVE = 'live';
const FINAL = 'final';

/** Live pushes are coalesced to this cadence so a fast break is not a flood. */
const MIN_PUSH_INTERVAL_MS = 900;

/**
 * Grace period after the log stream drops before a live session is torn down.
 *
 * Long enough to ride out an ADB reconnect (the collector retries within a few
 * seconds), short enough that a hoop switched off at the wall does not hold the
 * display much past the point anyone is still watching it.
 */
const STREAM_LOSS_GRACE_MS = 30_000;

/** Standings arrive per player; the final screen normally follows immediately. */
const STANDINGS_SETTLE_MS = 4_000;

/** How many shots the ticker on the session page can show at wall size. */
const RECENT_SHOT_LIMIT = 18;

/**
 * How long a session stays off the wall after another page interrupted it,
 * when nothing can tell us how long that page wanted the display for.
 *
 * Matches the Autodarts fallback: long enough that a timer or a reminder gets
 * its full moment, short enough that a game in progress comes back on its own.
 */
const SUPPRESS_FALLBACK_MS = 75_000;

function emptyZones() {
  return ZONES.reduce((out, zone) => {
    out[zone] = { made: 0, attempts: 0 };
    return out;
  }, {});
}

function pct(made, attempts) {
  const total = Number(attempts) || 0;
  if (total <= 0) return 0;
  return Math.round((100 * (Number(made) || 0)) / total);
}

function round1(value) {
  return Math.round((Number(value) || 0) * 10) / 10;
}

function emptyStats() {
  return {
    made: 0,
    attempts: 0,
    points: 0,
    threes: 0,
    streak: 0,
    bestStreak: 0,
    byZone: emptyZones(),
  };
}

function recordShot(stats, { made, zone, points }) {
  stats.attempts += 1;
  if (zone && stats.byZone[zone]) {
    stats.byZone[zone].attempts += 1;
    if (made) stats.byZone[zone].made += 1;
  }
  if (made) {
    stats.made += 1;
    stats.points = round1(stats.points + (Number(points) || 0));
    if (zone === 'three') stats.threes += 1;
    stats.streak += 1;
    stats.bestStreak = Math.max(stats.bestStreak, stats.streak);
  } else {
    stats.streak = 0;
  }
  return stats;
}

function statsView(stats) {
  return {
    made: stats.made,
    attempts: stats.attempts,
    points: round1(stats.points),
    fgPct: pct(stats.made, stats.attempts),
    threes: stats.threes,
    streak: stats.streak,
    bestStreak: stats.bestStreak,
    byZone: ZONES.reduce((out, zone) => {
      out[zone] = {
        ...stats.byZone[zone],
        pct: pct(stats.byZone[zone].made, stats.byZone[zone].attempts),
      };
      return out;
    }, {}),
  };
}

function newSessionId(nowMs) {
  return `huupe-${new Date(nowMs).toISOString().replace(/[-:.]/g, '').slice(0, 15)}-${
    Math.random().toString(36).slice(2, 8)
  }`;
}

function createHuupeLive({
  settings,
  archive,
  aggregates,
  payload,
  sendUdpPayload = null,
  displayBusy = null,
  log = console,
  now = () => Date.now(),
  setTimer = setInterval,
  clearTimer = clearInterval,
  tickMs = 1000,
} = {}) {
  let phase = IDLE;
  let session = null;
  let last = null;
  let timer = null;

  let deviceMode = null;
  let streamConnected = false;
  let streamLostAt = null;
  let lastEventAt = null;
  let suppressedBy = null;
  let suppressedAt = 0;
  let closeDisplayAt = null;
  let lastPushAt = 0;
  let lastPushFingerprint = null;
  let pendingPush = false;
  const counters = { opened: 0, finished: 0, aborted: 0, pushed: 0 };

  function liveSettings() {
    return settings?.get?.()?.live || {};
  }

  function send(payloadBody, options = {}) {
    if (typeof sendUdpPayload !== 'function') return null;
    try {
      return sendUdpPayload(payloadBody, { source: 'event', ...options });
    } catch (error) {
      log?.warn?.(`Huupe push failed — ${error?.message || error}`);
      return null;
    }
  }

  function newSession(nowMs, mode) {
    return {
      sessionId: newSessionId(nowMs),
      mode: mode || deviceMode || 'unknown',
      startedAtMs: nowMs,
      startedAt: new Date(nowMs).toISOString(),
      endedAt: null,
      durationSec: 0,
      revision: 0,
      opened: false,
      familyMode: false,
      countdownMode: false,
      countdownId: null,
      countdownStart: null,
      countdownDiff: null,
      countdownLayup: 1,
      currentSeat: null,
      // Held back until `minShotsToOpen` so one stray bounce is not a session.
      pendingShots: [],
      stats: emptyStats(),
      players: new Map(),
      playerOrder: [],
      lastShot: null,
      // Oldest first. Only make/miss and zone, so the panel can paint a shot
      // ticker without the bridge having to keep the whole shot log in memory.
      recentShots: [],
      standingsAt: null,
      uniqueScoreId: null,
      combination: null,
      truncated: false,
      sensorErrors: 0,
      turn: null,
    };
  }

  function playerFor(name) {
    const key = String(name || '').trim();
    if (!key) return null;
    if (!session.players.has(key)) {
      session.players.set(key, {
        name: key,
        score: 0,
        position: null,
        stats: emptyStats(),
      });
      session.playerOrder.push(key);
    }
    return session.players.get(key);
  }

  /** Keep the tail of the shot log the ticker draws, and nothing more. */
  function rememberShot(shot) {
    if (!session || !shot) return;
    session.recentShots.push({
      made: Boolean(shot.made),
      zone: shot.zone || null,
      player: shot.player || null,
    });
    if (session.recentShots.length > RECENT_SHOT_LIMIT) {
      session.recentShots.splice(0, session.recentShots.length - RECENT_SHOT_LIMIT);
    }
  }

  /**
   * Family Mode reports the same shots twice: once through the hardware tracker
   * and again through Unity, which is the only one that knows whose shot it was.
   * Switching to the Unity stream means dropping whatever the raw shots had
   * already accumulated, or every make would be counted twice.
   */
  function enterFamilyMode() {
    if (session.familyMode) return;
    session.familyMode = true;
    session.mode = 'family';
    session.stats = emptyStats();
    // Unity is about to replay the same shots with names attached, so the
    // ticker has to forget the hardware copies or every shot shows up twice.
    session.recentShots = [];
  }

  function ownsScoreboard() {
    return Boolean(session?.familyMode || session?.countdownMode);
  }

  function countdownSeat(seat, extras = {}) {
    const index = Number(seat);
    if (!Number.isInteger(index) || index < 0 || index > 3) return null;
    const key = `seat:${index}`;
    let player = session.players.get(key);
    const named = String(extras.name || '').trim();
    if (!player) {
      player = {
        name: named || `P${index + 1}`,
        id: extras.id || null,
        bot: extras.bot === true,
        seat: index,
        score: Number.isFinite(Number(extras.left))
          ? Number(extras.left)
          : (Number(session.countdownStart) || 0),
        scored: Number.isFinite(Number(extras.scored)) ? Number(extras.scored) : 0,
        position: null,
        isWinner: false,
        stats: emptyStats(),
      };
      session.players.set(key, player);
      session.playerOrder.push(key);
    } else {
      if (named) player.name = named;
      if (extras.id) player.id = extras.id;
      if (extras.bot != null) player.bot = extras.bot === true;
      if (Number.isFinite(Number(extras.left))) player.score = Number(extras.left);
      if (Number.isFinite(Number(extras.scored))) player.scored = Number(extras.scored);
    }
    return player;
  }

  function recordCountdownShot(stats, { made, zone, points, bust }) {
    if (bust) {
      stats.attempts += 1;
      if (zone && stats.byZone[zone]) stats.byZone[zone].attempts += 1;
      stats.streak = 0;
      return stats;
    }
    return recordShot(stats, { made, zone, points: made ? points : 0 });
  }

  function applyCountdownMeta(event) {
    if (!event) return;
    if (event.id) session.countdownId = event.id;
    if (Number.isFinite(Number(event.startScore))) {
      session.countdownStart = Number(event.startScore);
    }
    if (event.difficulty) session.countdownDiff = event.difficulty;
    if (event.layupValue === 0 || event.layupValue === 1) {
      session.countdownLayup = event.layupValue;
    }
    session.combination = {
      startScore: session.countdownStart,
      difficulty: session.countdownDiff,
      layupValue: session.countdownLayup,
    };
    for (const seat of event.seats || []) {
      countdownSeat(seat.seat, seat);
    }
  }

  /**
   * Countdown names its own seats. HAL still fires the same shot, so once this
   * stream is live the hardware totals have to be dropped or every make is
   * counted twice — same reason Family Mode switches to Unity.
   */
  function enterCountdown(event, nowMs) {
    const id = event?.id || null;
    if (session && session.countdownMode && id && session.countdownId === id) {
      applyCountdownMeta(event);
      return session;
    }
    if (session && session.opened && !session.countdownMode) {
      if (hasContent()) finishSession({ reason: 'left-app' });
      else abortSession({ reason: 'left-app' });
    } else if (session && session.countdownMode && id && session.countdownId !== id) {
      if (hasContent()) finishSession({ reason: 'countdown-end' });
      else abortSession({ reason: 'countdown-end' });
    }
    ensureSession(nowMs, 'countdown');
    if (!session.countdownMode) {
      session.countdownMode = true;
      session.mode = 'countdown';
      session.stats = emptyStats();
      session.recentShots = [];
      session.players = new Map();
      session.playerOrder = [];
    }
    applyCountdownMeta(event);
    return session;
  }

  function sessionView() {
    const countdown = Boolean(session.countdownMode);
    const players = session.playerOrder
      .map((key) => session.players.get(key))
      .filter(Boolean)
      .map((player) => ({
        name: player.name,
        score: round1(player.score),
        remaining: countdown ? round1(player.score) : undefined,
        scored: countdown
          ? round1(Number.isFinite(player.scored)
            ? player.scored
            : (Number(session.countdownStart) || 0) - Number(player.score || 0))
          : undefined,
        position: player.position,
        isWinner: Boolean(player.isWinner) || player.position === 0,
        ...statsView(player.stats),
      }));

    // Standings order once the game has called it; live score until then.
    // Countdown races to zero, so the lowest remaining score is winning.
    players.sort((a, b) => {
      if (a.position != null && b.position != null) return a.position - b.position;
      if (a.position != null) return -1;
      if (b.position != null) return 1;
      return countdown ? a.score - b.score : b.score - a.score;
    });

    const nowMs = now();
    return {
      sessionId: session.sessionId,
      mode: session.mode,
      status: phase === FINAL ? 'finished' : 'live',
      revision: session.revision,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      durationSec: session.endedAt
        ? session.durationSec
        : Math.max(0, Math.round((nowMs - session.startedAtMs) / 1000)),
      players,
      stats: statsView(session.stats),
      lastShot: session.lastShot,
      recentShots: session.recentShots.map((shot) => ({ ...shot })),
      winner: players.find((row) => row.isWinner)?.name || null,
      uniqueScoreId: session.uniqueScoreId,
      combination: session.combination,
      scoreKind: countdown ? 'remaining' : 'points',
      startScore: session.countdownStart,
      difficulty: session.countdownDiff,
      currentSeat: session.currentSeat,
      truncated: session.truncated,
      sensorErrors: session.sensorErrors,
      idleSeconds: lastEventAt ? Math.max(0, Math.round((nowMs - lastEventAt) / 1000)) : 0,
    };
  }

  function archiveRow(view, { aborted = false, reason = null } = {}) {
    const countdown = view.mode === 'countdown';
    const startScore = Number(view.startScore || view.combination?.startScore);
    const players = view.players.map((player, index) => {
      const remaining = countdown ? Number(player.remaining ?? player.score) : undefined;
      const scored = countdown
        ? round1(Number.isFinite(Number(player.scored))
          ? Number(player.scored)
          : (Number.isFinite(startScore) ? startScore - remaining : 0))
        : player.score;
      return {
        name: player.name,
        score: scored,
        remaining,
        position: player.position != null ? player.position : (player.isWinner ? 0 : index),
        isWinner: Boolean(player.isWinner),
        made: player.made,
        attempts: player.attempts,
        fgPct: player.fgPct,
        threes: player.threes,
        bestStreak: player.bestStreak,
        byZone: player.byZone,
      };
    });
    const points = countdown
      ? round1(players.reduce((sum, player) => sum + (Number(player.score) || 0), 0))
      : view.stats.points;
    return {
      sessionId: view.sessionId,
      mode: view.mode,
      startedAt: view.startedAt,
      endedAt: view.endedAt,
      durationSec: view.durationSec,
      aborted,
      endReason: reason,
      winner: view.winner,
      uniqueScoreId: view.uniqueScoreId,
      combination: view.combination,
      truncated: view.truncated,
      players,
      stats: {
        made: view.stats.made,
        attempts: view.stats.attempts,
        points,
        fgPct: view.stats.fgPct,
        threes: view.stats.threes,
        bestStreak: view.stats.bestStreak,
        byZone: view.stats.byZone,
      },
    };
  }

  function pushLive({ force = false } = {}) {
    if (!session || !session.opened) return;
    if (suppressedBy) return;
    if (!liveSettings().autoPush) return;

    const view = sessionView();
    const fingerprint = JSON.stringify({
      players: view.players,
      stats: view.stats,
      status: view.status,
    });
    if (!force && fingerprint === lastPushFingerprint) return;

    const nowMs = now();
    if (!force && nowMs - lastPushAt < MIN_PUSH_INTERVAL_MS) {
      pendingPush = true;
      return;
    }

    session.revision += 1;
    lastPushAt = nowMs;
    lastPushFingerprint = fingerprint;
    pendingPush = false;
    counters.pushed += 1;
    send(payload.buildSessionPayload({ ...view, revision: session.revision }, {
      persistent: true,
      displaySeconds: 0,
    }));
  }

  function openSession() {
    if (!session || session.opened) return;
    session.opened = true;
    // Cancel the previous game's pending close, or it lands mid-way through
    // this one and takes the live card down with it.
    closeDisplayAt = null;
    counters.opened += 1;
    log?.info?.(`Huupe session ${session.sessionId} open (${session.mode})`);
    pushLive({ force: true });
  }

  function closeDisplay(reason) {
    if (!session && !last) return;
    const sessionId = session?.sessionId || last?.sessionId || null;
    send(payload.buildClosePayload(sessionId, reason));
  }

  function settle(view, { aborted, reason }) {
    const row = archiveRow(view, { aborted, reason });
    try {
      const result = archive.append(row);
      if (result?.ok && !result.deduped) {
        aggregates.recompute(archive.listAll());
      }
    } catch (error) {
      log?.warn?.(`Could not archive Huupe session — ${error?.message || error}`);
    }
    last = view;
  }

  /** A session with nothing in it is noise; it is dropped without a trace. */
  function hasContent() {
    if (!session) return false;
    if (session.countdownMode) return session.stats.attempts >= 1;
    return session.stats.attempts >= 2;
  }

  /**
   * Swap the live card for the final one and let the display count itself
   * down, rather than pulling the page while the score is still on it.
   *
   * Returns false when there is nobody to show it to — a suppressed session,
   * auto-push off — so the caller can close the display instead.
   */
  function holdFinalCard(view, nowMs) {
    if (suppressedBy || !liveSettings().autoPush) return false;
    const holdSeconds = Number(liveSettings().finalHoldSeconds) || 60;
    session.revision += 1;
    counters.pushed += 1;
    send(payload.buildSessionPayload({ ...view, revision: session.revision }, {
      persistent: false,
      displaySeconds: holdSeconds,
    }));
    closeDisplayAt = nowMs + holdSeconds * 1000;
    return true;
  }

  function finishSession({ reason = 'ended' } = {}) {
    if (!session || phase !== LIVE) return null;
    const nowMs = now();
    phase = FINAL;
    session.endedAt = new Date(nowMs).toISOString();
    session.durationSec = Math.max(0, Math.round((nowMs - session.startedAtMs) / 1000));
    counters.finished += 1;

    const view = sessionView();
    const keep = hasContent();
    if (keep) settle(view, { aborted: false, reason });

    if (session.opened && !(keep && holdFinalCard(view, nowMs))) {
      closeDisplay(reason);
      closeDisplayAt = null;
    }

    log?.info?.(`Huupe session ${session.sessionId} finished (${reason})`);
    session = null;
    phase = IDLE;
    lastPushFingerprint = null;
    return view;
  }

  /**
   * Teardown for a session that will never report an end of its own — the hoop
   * went dark, or nobody came back.
   *
   * A game that got far enough to have a score still earns the same final card
   * a clean end gets: the hoop dropping off ADB says nothing about whether
   * anyone is still standing in front of the wall reading the result. Only a
   * session with nothing in it, or a bridge on its way down, clears the display
   * on the spot — and even the final card releases the wall to the scheduler
   * when its hold elapses, so nothing is left stranded up there.
   */
  function abortSession({ reason = 'lost', immediate = false } = {}) {
    if (!session) return null;
    const nowMs = now();
    session.endedAt = new Date(nowMs).toISOString();
    session.durationSec = Math.max(0, Math.round((nowMs - session.startedAtMs) / 1000));
    const view = sessionView();
    view.status = 'finished';
    counters.aborted += 1;
    const keep = hasContent();
    if (keep) settle(view, { aborted: true, reason });

    let held = false;
    if (session.opened) {
      held = !immediate && keep && holdFinalCard(view, nowMs);
      if (!held) closeDisplay(reason);
    }
    log?.warn?.(`Huupe session ${session.sessionId} aborted (${reason})`);
    session = null;
    phase = IDLE;
    if (!held) closeDisplayAt = null;
    lastPushFingerprint = null;
    return view;
  }

  function noteActivity(nowMs) {
    lastEventAt = nowMs;
  }

  /**
   * Decide whether an interrupted session can have the wall back.
   *
   * Shooting again is deliberately *not* enough on its own. A timer going off
   * mid-game would otherwise be wiped by the very next basket, which is the one
   * moment someone actually needs to read it.
   */
  function maybeResume(nowMs) {
    if (!suppressedBy || phase !== LIVE || !session?.opened) return;
    if (displayBusy?.isBusy?.()) {
      const snap = displayBusy.snapshot?.();
      if (snap?.type && snap.type !== 'huupe.session') return;
    } else if (!displayBusy && nowMs - suppressedAt < SUPPRESS_FALLBACK_MS) {
      return;
    }
    suppressedBy = null;
    suppressedAt = 0;
    lastPushFingerprint = null;
    pushLive({ force: true });
  }

  function ensureSession(nowMs, mode) {
    if (phase === IDLE) {
      session = newSession(nowMs, mode);
      phase = LIVE;
      closeDisplayAt = null;
    }
    return session;
  }

  function applyShot(event, nowMs) {
    // Family Mode and Countdown own the scoreboard. HAL still fires the same
    // shot; counting it here would double every make. While Countdown is in
    // front we also ignore HAL before the first tagged line arrives, so a
    // mid-game deploy does not open a nameless free-play session.
    if (deviceMode === 'countdown' && !session?.countdownMode) return;
    ensureSession(nowMs, event.mode);
    if (ownsScoreboard()) return;

    recordShot(session.stats, {
      made: event.made,
      zone: event.zone,
      points: event.points,
    });
    session.lastShot = {
      made: Boolean(event.made),
      zone: event.zone,
      points: event.made ? event.points : 0,
      range: event.range ?? null,
      at: event.at || null,
    };
    rememberShot(session.lastShot);

    if (!session.opened) {
      session.pendingShots.push(session.lastShot);
      const need = Number(liveSettings().minShotsToOpen) || 2;
      if (session.pendingShots.length >= need) openSession();
    } else {
      pushLive();
    }
  }

  function applyShotMade(event, nowMs) {
    ensureSession(nowMs, 'family');
    enterFamilyMode();
    const player = playerFor(event.player);
    if (!player) return;
    recordShot(player.stats, {
      made: event.made,
      zone: event.zone,
      points: event.points,
    });
    recordShot(session.stats, {
      made: event.made,
      zone: event.zone,
      points: event.points,
    });
    session.lastShot = {
      player: player.name,
      made: Boolean(event.made),
      zone: event.zone,
      points: event.made ? event.points : 0,
      at: event.at || null,
    };
    rememberShot(session.lastShot);
    if (!session.opened) openSession();
    else pushLive();
  }

  function applyCountdownShot(event, nowMs) {
    enterCountdown(event, nowMs);
    const player = countdownSeat(event.seat);
    if (!player) return;
    const points = Number(event.points) || 0;
    const made = event.made === true && event.bust !== true;
    recordCountdownShot(player.stats, {
      made: event.made === true,
      zone: event.zone,
      points,
      bust: event.bust === true,
    });
    recordCountdownShot(session.stats, {
      made: event.made === true,
      zone: event.zone,
      points,
      bust: event.bust === true,
    });
    if (Number.isFinite(Number(event.left))) {
      player.score = Number(event.left);
      if (Number.isFinite(Number(session.countdownStart))) {
        player.scored = Number(session.countdownStart) - player.score;
      }
    }
    session.currentSeat = event.seat;
    session.lastShot = {
      player: player.name,
      made: event.made === true,
      zone: event.zone,
      points: made ? points : 0,
      bust: event.bust === true,
      at: event.at || null,
    };
    rememberShot(session.lastShot);
    if (!session.opened) openSession();
    else pushLive();
  }

  function applyCountdownEnd(event, nowMs) {
    enterCountdown(event, nowMs);
    applyCountdownMeta(event);
    const startScore = Number(session.countdownStart);
    for (const seat of event.seats || []) {
      const player = countdownSeat(seat.seat, seat);
      if (!player) continue;
      if (Number.isFinite(Number(seat.left))) player.score = Number(seat.left);
      if (Number.isFinite(Number(seat.scored))) {
        player.scored = Number(seat.scored);
      } else if (Number.isFinite(startScore)) {
        player.scored = startScore - Number(player.score || 0);
      }
      if (Number.isFinite(Number(seat.made)) && player.stats.attempts === 0) {
        player.stats.made = Number(seat.made) || 0;
        player.stats.attempts = Number(seat.attempts) || player.stats.made;
        player.stats.threes = Number(seat.threes) || 0;
        player.stats.points = round1(player.scored);
      }
    }
    if (session.stats.attempts === 0) {
      for (const key of session.playerOrder) {
        const player = session.players.get(key);
        if (!player) continue;
        session.stats.made += player.stats.made;
        session.stats.attempts += player.stats.attempts;
        session.stats.threes += player.stats.threes;
        session.stats.points = round1(session.stats.points + (Number(player.scored) || 0));
      }
    }
    const winnerName = String(event.winner || '').trim();
    const winnerId = event.winnerId || null;
    for (const key of session.playerOrder) {
      const player = session.players.get(key);
      if (!player) continue;
      player.isWinner = Boolean(
        (winnerId && player.id === winnerId) || (winnerName && player.name === winnerName),
      );
    }
    const ordered = session.playerOrder
      .map((key) => session.players.get(key))
      .filter(Boolean)
      .sort((a, b) => {
        if (a.isWinner) return -1;
        if (b.isWinner) return 1;
        return Number(a.score) - Number(b.score);
      });
    ordered.forEach((player, index) => {
      player.position = player.isWinner ? 0 : index;
    });
    if (!session.opened) openSession();
    finishSession({ reason: event.reason === 'abort' ? 'countdown-abort' : 'countdown-end' });
  }

  function handleEvent(event) {
    if (!event || !event.kind) return;
    const nowMs = now();

    if (event.kind === 'focus') {
      deviceMode = event.mode === 'launcher' ? null : event.mode;
      // Leaving every game for the launcher ends a free-play session cleanly
      // instead of waiting out the inactivity timer.
      if (event.mode === 'launcher' && phase === LIVE && !ownsScoreboard()) {
        finishSession({ reason: 'left-app' });
      }
      return;
    }

    if (event.kind === 'sensor-error') {
      if (session) session.sensorErrors += 1;
      return;
    }

    noteActivity(nowMs);

    switch (event.kind) {
      case 'shot':
        applyShot(event, nowMs);
        break;
      case 'shot-made':
        applyShotMade(event, nowMs);
        break;
      case 'scored': {
        ensureSession(nowMs, 'family');
        enterFamilyMode();
        const player = playerFor(event.player);
        if (player) {
          // Unity reports the running total, not a delta.
          player.score = round1(event.points);
        }
        if (!session.opened) openSession();
        else pushLive();
        break;
      }
      case 'standings': {
        if (phase !== LIVE) break;
        enterFamilyMode();
        const player = playerFor(event.player);
        if (player) {
          player.score = round1(event.points);
          player.position = event.position;
        }
        session.standingsAt = nowMs;
        pushLive();
        break;
      }
      case 'processing':
        if (phase === LIVE) session.turn = event.state;
        break;
      case 'final-screen':
        if (phase === LIVE) finishSession({ reason: 'final-screen' });
        break;
      case 'game-end':
        if (phase === LIVE) {
          session.uniqueScoreId = event.uniqueScoreId || session.uniqueScoreId;
          session.combination = event.combination || session.combination;
          session.truncated = session.truncated || Boolean(event.truncated);
        } else if (last && !last.uniqueScoreId) {
          // The upload routinely lands after the final screen has already
          // closed the session; backfill the identity onto the archived row.
          last.uniqueScoreId = event.uniqueScoreId || null;
        }
        break;
      case 'countdown-start':
        enterCountdown(event, nowMs);
        if (!session.opened) openSession();
        else pushLive();
        break;
      case 'countdown-shot':
        applyCountdownShot(event, nowMs);
        break;
      case 'countdown-end':
        applyCountdownEnd(event, nowMs);
        break;
      default:
        break;
    }
  }

  function handleStreamState({ connected, reason = null } = {}) {
    const wasConnected = streamConnected;
    streamConnected = Boolean(connected);
    if (streamConnected) {
      streamLostAt = null;
      return;
    }
    if (wasConnected) {
      streamLostAt = now();
      log?.warn?.(`Huupe log stream lost${reason ? ` — ${reason}` : ''}`);
    }
  }

  function tick() {
    const nowMs = now();

    if (closeDisplayAt && nowMs >= closeDisplayAt) {
      closeDisplayAt = null;
      closeDisplay('final-hold-elapsed');
    }

    if (pendingPush && nowMs - lastPushAt >= MIN_PUSH_INTERVAL_MS) {
      pushLive();
    }

    if (phase !== LIVE || !session) return;

    maybeResume(nowMs);

    // The hoop cannot report an end it never reaches; this is the recovery path.
    if (!streamConnected && streamLostAt && nowMs - streamLostAt >= STREAM_LOSS_GRACE_MS) {
      abortSession({ reason: 'device-unreachable' });
      return;
    }

    if (session.standingsAt && nowMs - session.standingsAt >= STANDINGS_SETTLE_MS) {
      finishSession({ reason: 'standings' });
      return;
    }

    const idleMs = (Number(liveSettings().inactivityMinutes) || 5) * 60_000;
    if (lastEventAt && nowMs - lastEventAt >= idleMs) {
      if (hasContent()) finishSession({ reason: 'inactivity' });
      else abortSession({ reason: 'inactivity' });
    }
  }

  function statusSnapshot() {
    return {
      phase,
      streamConnected,
      streamLostAt: streamLostAt ? new Date(streamLostAt).toISOString() : null,
      mode: deviceMode,
      suppressedBy,
      counters: { ...counters },
      session: session && session.opened ? sessionView() : null,
      lastSession: last
        ? {
          sessionId: last.sessionId,
          mode: last.mode,
          endedAt: last.endedAt,
          winner: last.winner,
          points: last.stats?.points ?? 0,
        }
        : null,
      lastEventAt: lastEventAt ? new Date(lastEventAt).toISOString() : null,
    };
  }

  return {
    start() {
      if (timer) return;
      timer = setTimer(() => {
        try {
          tick();
        } catch (error) {
          log?.warn?.(`Huupe live tick failed — ${error?.message || error}`);
        }
      }, tickMs);
      timer?.unref?.();
    },
    close() {
      if (timer) clearTimer(timer);
      timer = null;
      // Nothing is left running to close the card later, so it goes now.
      if (phase === LIVE) abortSession({ reason: 'shutdown', immediate: true });
    },
    handleEvent,
    handleStreamState,
    tick,
    statusSnapshot,
    currentSession: () => (session && session.opened ? sessionView() : null),
    lastSession: () => last,
    setLastSession(view) {
      last = view;
    },
    /** Another page took the wall — stop re-pushing, keep scoring. */
    suppressActiveSession(reason = 'other-display') {
      if (phase !== LIVE || !session?.opened || suppressedBy) return;
      suppressedBy = reason;
      suppressedAt = now();
      closeDisplayAt = null;
    },
    isSuppressed: () => Boolean(suppressedBy),
    // Exposed for the service's manual push, which must not disturb the
    // auto-push fingerprint or the revision the panel is tracking.
    viewForPush: () => (session && session.opened ? sessionView() : null),
    displayBusy,
  };
}

module.exports = {
  createHuupeLive,
  recordShot,
  statsView,
  emptyStats,
  emptyZones,
  pct,
  round1,
  MIN_PUSH_INTERVAL_MS,
  STREAM_LOSS_GRACE_MS,
  STANDINGS_SETTLE_MS,
  SUPPRESS_FALLBACK_MS,
};
