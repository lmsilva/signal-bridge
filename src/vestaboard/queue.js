// One send queue per board.
//
// A Vestaboard is a slow, physical thing: roughly fifteen seconds between
// flips, and every flip is audible in the room. So this queue's job is less
// about throughput than about restraint — deciding what is worth the noise.
//
// The rules, in the order they bite:
//   - never post faster than the board can move (rateWindowSeconds)
//   - a rotation page stays for Settings → Dwell (dwellSeconds), even when
//     the flaps could already take another flip; alerts and live hold cards
//     still wait only the rate window
//   - alerts (alarms, timers, reminders, doorbell) jump the line and do not
//     discard the pages they interrupted — those wait and resume after
//   - a live hold (game or now-playing) owns the board until it ends or
//     something of equal or higher rank arrives; score/metadata updates of
//     the same source replace the live card instead of stacking
//   - hold ranks: alert > game (scramble / Huupe / Autodarts) > watch
//     (YouTube / Plex / Steam / PSN) > rotation
//   - every other snapshot (manual Push, Air now, scheduler) joins the back
//     of the line — they do not jump ahead of pages already waiting
//   - repeats of the same thing replace each other instead of stacking
//   - a layout identical to what is already showing is dropped, because the
//     board would not flip anyway
//   - during quiet hours only alarm and timer fires get through, and anything
//     else is dropped rather than saved for morning; a stale snapshot at 7am
//     is worse than no snapshot. The window is household wall-clock
//     (`timeZone`), not the process TZ, so a UTC container does not treat
//     8pm Utah as 2am quiet.
//   - a live hold is session-scoped (`laneLock`, still exposed as `gameLock`).
//     Word Scramble still takes it explicitly (`acquireGameLock`); Huupe,
//     Autodarts and now-playing acquire it from the payload. The lock is not
//     inferred from a frame's `holdSeconds`.
//
// Time and the transport are injected so the whole thing can be tested
// without waiting fifteen real seconds for anything.

const { dateParts } = require('./clock');
const {
  classify: classifyHold,
  LANES,
  GAME_LOCK_TTL_MS,
  isHoldLane,
  lockTtlMs,
} = require('./holds');

const DEFAULT_RATE_WINDOW_SECONDS = 15;
const DEFAULT_DWELL_SECONDS = 15;
const DEFAULT_ROTATION_GAP_SECONDS = 600;

// Repeated commands for the same device inside this window collapse into one.
const COALESCE_WINDOW_MS = 5 * 60 * 1000;

// 7.3: two quick retries, then a slow one once the board is declared unhealthy.
const RETRY_DELAYS_MS = [30_000, 60_000];
const UNHEALTHY_RETRY_MS = 5 * 60 * 1000;
const FAILURES_BEFORE_UNHEALTHY = 3;

// The only things worth waking the house for.
const QUIET_HOURS_EXEMPT = new Set(['alarm.fired', 'timer.fired']);

// A hold session releases its own lock. This only bounds the damage when a
// session dies without closing (crash, lost tick) so the board cannot wedge
// forever; every live update pushes the deadline back out.

// Later phases may sit behind an earlier one that has not flipped yet
// (scores before the next grid). A new card only drops pending pages at
// this rank or below — round 2 must not evict an unshown intermission.
const GAME_CARD_RANK = Object.freeze({
  invite: 1,
  invited: 1,
  lobby: 2,
  round: 3,
  intermission: 4,
  scores: 4,
  final: 5,
  best: 5,
  clear: 6,
  closed: 6,
});

function gameCardRank(card) {
  const rank = GAME_CARD_RANK[String(card || '')];
  return rank != null ? rank : 0;
}

function sameLayout(a, b) {
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** "22:00" -> minutes since midnight, or null if unusable. */
function parseHhMm(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * Quiet hours are local wall-clock and usually cross midnight, so the window
 * is "start <= t OR t < end" whenever start is after end.
 */
function inQuietHours(date, quietHours, timeZone) {
  if (!quietHours || quietHours.enabled === false) return false;
  const start = parseHhMm(quietHours.start);
  const end = parseHhMm(quietHours.end);
  if (start === null || end === null || start === end) return false;

  const parts = dateParts(date, timeZone);
  if (!parts) return false;
  const minutes = parts.hour * 60 + parts.minute;
  return start < end
    ? minutes >= start && minutes < end
    : minutes >= start || minutes < end;
}

function createQueue({
  board = {},
  transport: initialTransport,
  log = console,
  now = () => Date.now(),
  setTimer = setInterval,
  clearTimer = clearInterval,
  tickMs = 1000,
  timeZone = null,
} = {}) {
  let config = { ...board };
  let transport = initialTransport;
  let nextItemId = 1;

  const state = {
    current: null,
    lastSnapshot: null,
    lastPostAt: null,
    lastSchedulerFlipAt: null,
    holdUntil: null,
    /** `guest` parks scheduler pages only, for the length of `holdUntil`. */
    holdKind: null,
    /**
     * A live hold owns the board: `{ source, lane, expiresAt }`. Games
     * (scramble / Huupe / Autodarts) and now-playing (YouTube / Plex /
     * Steam / PSN) take this; alerts do not — they are timed dwells.
     * `gameLock` stays in sync as the public alias the simulator pill reads.
     */
    laneLock: null,
    gameLock: null,
    health: 'ok',
    healthReason: null,
    failures: 0,
    retryNotBefore: null,
    restoreAfter: null,
    /**
     * When the current snapshot has had the board's configured dwell.
     * Rotation pages wait for this; alerts and live hold cards do not.
     */
    snapshotUntil: null,
    /**
     * Display-only: when the live game's current phase card is due to
     * change. Does not park the queue — the session lock does that — but
     * the simulator "Next flip" pill reads it so lobby/round timers show.
     */
    phaseUntil: null,
  };

  const items = [];
  const coalesceSeen = new Map();
  const listeners = new Set();
  let queueRevision = 0;
  let timer = null;
  let posting = false;
  let tickTail = Promise.resolve();

  function rateWindowMs() {
    const seconds = Number(config.rateWindowSeconds);
    return (Number.isFinite(seconds) ? seconds : DEFAULT_RATE_WINDOW_SECONDS) * 1000;
  }

  function rotationGapMs() {
    const seconds = Number(config.minRotationGapSeconds);
    return (Number.isFinite(seconds) ? seconds : DEFAULT_ROTATION_GAP_SECONDS) * 1000;
  }

  function dwellMsOf(frame) {
    const seconds = Number(frame?.dwellSeconds);
    return (Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_DWELL_SECONDS) * 1000;
  }

  /** Board Settings → Dwell. Zero / missing means "rate window only". */
  function boardDwellMs() {
    const seconds = Number(config.dwellSeconds);
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
  }

  function snapshotDwellActive(at = now()) {
    return Boolean(state.snapshotUntil && at < state.snapshotUntil);
  }

  /** How long until a rotation page may replace what is showing. */
  function snapshotCooldownMs(at = now()) {
    if (!state.snapshotUntil) {
      return 0;
    }
    return Math.max(0, state.snapshotUntil - at);
  }

  /** How long until the live game's current phase is due to change. */
  function phaseCooldownMs(at = now()) {
    if (!state.phaseUntil) {
      return 0;
    }
    return Math.max(0, state.phaseUntil - at);
  }

  /**
   * How long until the next page the queue is willing to post becomes
   * eligible by its own `notBefore` (rate window / dwell are separate).
   * `null` when nothing is waiting that is not held by a lock.
   */
  function pendingReadyMs(at = now()) {
    let soonest = null;
    for (const item of items) {
      if (itemHeld(item, at)) {
        continue;
      }
      if (item.notBefore && at < item.notBefore) {
        const wait = item.notBefore - at;
        soonest = soonest == null ? wait : Math.min(soonest, wait);
      } else {
        return 0;
      }
    }
    return soonest;
  }

  /**
   * Remaining wait before the board's next content change, ignoring the
   * Local API rate window (the simulator owns that). During a game this is
   * the sooner of a queued phase card and the current phase timer; otherwise
   * it is Settings dwell (and any sequenced `notBefore`).
   */
  function nextFlipCooldownMs(at = now()) {
    const pending = pendingReadyMs(at);
    if (laneLockActive(at)) {
      if (pending != null) {
        return pending;
      }
      return phaseCooldownMs(at);
    }
    return Math.max(snapshotCooldownMs(at), pending || 0);
  }

  function holdMsOf(frame) {
    const seconds = Number(frame?.holdSeconds);
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
  }

  function emit(event, detail) {
    for (const listener of listeners) {
      try {
        listener(event, detail);
      } catch {
        // A broken listener must not stall the board.
      }
    }
  }

  function syncGameLockAlias() {
    state.gameLock = state.laneLock
      ? { source: state.laneLock.source, expiresAt: state.laneLock.expiresAt, lane: state.laneLock.lane }
      : null;
  }

  function laneLockActive(at = now()) {
    if (!state.laneLock) return false;
    if (at >= state.laneLock.expiresAt) {
      log?.warn?.(`Vestaboard ${config.id} ${state.laneLock.lane} lock expired without a close`);
      state.laneLock = null;
      syncGameLockAlias();
      state.phaseUntil = null;
      return false;
    }
    return true;
  }

  const gameLockActive = laneLockActive;

  /** Is this page the live hold's own card? */
  function ownedByLock(item) {
    if (!state.laneLock) return false;
    const lock = state.laneLock.source;
    return String(item.frame?.source || '') === lock
      || String(item.ownerSource || '') === lock;
  }

  const ownedByGame = ownedByLock;

  function acquireLaneLock(source, lane = 'game', { ttlMs } = {}) {
    const owner = String(source || '');
    if (!owner || !isHoldLane(lane)) return false;
    const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : lockTtlMs(lane);
    const fresh = state.laneLock?.source !== owner;
    state.laneLock = { source: owner, lane, expiresAt: now() + ttl };
    syncGameLockAlias();
    if (fresh) announceQueue();
    return true;
  }

  function releaseLaneLock(source = '') {
    const owner = String(source || '');
    if (!state.laneLock) return false;
    if (owner && state.laneLock.source !== owner) return false;
    state.laneLock = null;
    syncGameLockAlias();
    state.phaseUntil = null;
    announceQueue();
    return true;
  }

  function itemHeld(item, at = now()) {
    // A live hold owns the board. Rotation waits. Alerts still get through
    // — they outrank games and now-playing.
    if (laneLockActive(at)) {
      if (ownedByLock(item)) return false;
      if (item.priority === 'alert' || item.lane === 'alert') return false;
      return true;
    }
    if (item.priority === 'alert') return false;
    if (!state.holdUntil || at >= state.holdUntil) return false;
    return item.scheduler;
  }

  function pending() {
    return items.map((item) => ({
      id: item.id,
      label: item.frame.label || 'Frame',
      source: item.frame.source || '',
      priority: item.priority,
      scheduler: Boolean(item.scheduler),
      notBefore: item.notBefore ? new Date(item.notBefore).toISOString() : null,
      status: item.notBefore
        ? null
        : (itemHeld(item) ? 'held' : 'waiting'),
    }));
  }

  function announceQueue() {
    queueRevision += 1;
    emit('queue', { boardId: config.id, items: pending(), revision: queueRevision });
  }

  function recoverFromBadKey() {
    if (state.health === 'degraded' && state.healthReason === 'auth') {
      // A new key (or a new client holding one) deserves a fresh attempt.
      setHealth('ok');
      state.failures = 0;
      state.retryNotBefore = null;
    }
  }

  function setHealth(health, reason = null) {
    if (state.health === health && state.healthReason === reason) {
      return;
    }
    state.health = health;
    state.healthReason = reason;
    log?.debug?.(`Vestaboard ${config.id} health ${health}${reason ? ` (${reason})` : ''}`);
    emit('health', { boardId: config.id, health, reason });
  }

  function isExempt(frame, override) {
    const event = String(frame?.source || '').split(' ')[0];
    if (QUIET_HOURS_EXEMPT.has(event)) return true;
    if (typeof override === 'boolean') return override;
    return false;
  }

  /**
   * Fold consecutive identical pages into one, keeping their combined dwell.
   *
   * A formatter that repeats a frame to express a longer hold — guest snaps
   * emits one copy per 30 seconds — queues pages that can never post: the
   * head-of-queue dedupe drops anything already on the board, and the board
   * holds its last layout anyway. All the copies bought was a place in the
   * line ahead of frames that did have something to show.
   */
  function foldRepeats(list) {
    const folded = [];
    for (const frame of list) {
      const last = folded[folded.length - 1];
      if (last && sameLayout(last.rows, frame.rows)) {
        last.dwellSeconds = (Number(last.dwellSeconds) || DEFAULT_DWELL_SECONDS)
          + (Number(frame.dwellSeconds) || DEFAULT_DWELL_SECONDS);
        continue;
      }
      folded.push({ ...frame });
    }
    return folded;
  }

  function resolveHold(list, options) {
    const firstSource = options.gameSource
      || list[0]?.source
      || options.replaceSource
      || '';
    let hold = options.hold || classifyHold(
      options.payload || {},
      options.type || firstSource,
      firstSource,
    );
    // Unit tests (and testFlip) still pass priority: 'alert' without a
    // classified hold. Do not let that override a real game/watch lane —
    // Huupe used to arrive as an alert and stack a page per shot.
    if (options.priority === 'alert' && hold.lane === 'rotation') {
      hold = {
        ...hold,
        lane: 'alert',
        rank: LANES.alert,
        live: true,
      };
    }
    return hold;
  }

  function dropSourcePending(source) {
    const owner = String(source || '');
    if (!owner) return 0;
    let dropped = 0;
    for (let i = items.length - 1; i >= 0; i -= 1) {
      if (String(items[i].frame?.source || '') === owner
        || String(items[i].ownerSource || '') === owner) {
        items.splice(i, 1);
        dropped += 1;
      }
    }
    return dropped;
  }

  /**
   * Take frames for the board.
   *
   * Rotation snapshots queue in order. Alerts jump the line without throwing
   * the rest away. A live hold (game / now-playing) keeps the board until it
   * ends or an equal/higher lane arrives; updates of the same source replace
   * the live card instead of stacking.
   */
  function submit(frames, options = {}) {
    const offered = (Array.isArray(frames) ? frames : [frames]).filter(Boolean);
    const hold = resolveHold(offered, options);
    const at = now();

    if (hold.close) {
      releaseLaneLock(hold.source);
      const dropped = dropSourcePending(hold.source);
      if (dropped) announceQueue();
      if (!offered.length) {
        return { accepted: 0, dropped, reason: 'closed' };
      }
    }

    if (!offered.length) {
      return { accepted: 0, dropped: 0, reason: 'empty' };
    }
    const list = foldRepeats(offered);
    if (list.length < offered.length) {
      log?.debug?.(
        `Vestaboard ${config.id} folded ${offered.length - list.length} repeat page(s) `
        + `of ${list[0].label || ''}`.trimEnd(),
      );
    }

    const priority = hold.lane === 'alert' ? 'alert' : 'snapshot';
    const coalesceKey = options.coalesceKey || hold.coalesceKey || null;

    // A rotation flip too soon after the last one is dropped, not delayed:
    // by the time the gap passes the content is stale anyway.
    if (priority === 'snapshot' && options.scheduler && state.lastSchedulerFlipAt !== null) {
      if (at - state.lastSchedulerFlipAt < rotationGapMs()) {
        log?.debug?.(`Vestaboard ${config.id} skip (gap) ${list[0].label || ''}`.trim());
        return { accepted: 0, dropped: list.length, reason: 'gap' };
      }
    }

    // Same-source live updates always replace the pending card. Rotation
    // coalescing still uses the five-minute window (smart-home, etc.).
    if (coalesceKey) {
      const existing = items.find((item) => item.coalesceKey === coalesceKey);
      const seenAt = coalesceSeen.get(coalesceKey);
      const holdReplace = isHoldLane(hold.lane) || hold.lane === 'alert';
      const inWindow = seenAt === undefined || at - seenAt < COALESCE_WINDOW_MS;
      if (existing && (holdReplace || inWindow)) {
        existing.frame = list[0];
        existing.priority = priority;
        existing.lane = hold.lane;
        existing.quietHoursExempt = isExempt(list[0], options.quietHoursExempt);
        coalesceSeen.set(coalesceKey, at);
        if (hold.live && isHoldLane(hold.lane)) {
          acquireLaneLock(hold.source, hold.lane);
        } else if (isHoldLane(hold.lane) && laneLockActive(at)
          && state.laneLock.source === hold.source) {
          acquireLaneLock(hold.source, hold.lane);
        }
        log?.debug?.(`Vestaboard ${config.id} coalesce replace ${coalesceKey}`);
        announceQueue();
        return { accepted: 1, dropped: 0, reason: 'coalesced' };
      }
      coalesceSeen.set(coalesceKey, at);
    }

    const sequenceId = `s${nextItemId}`;
    const ownerSource = options.gameSource || hold.source || options.replaceSource || null;
    const made = list.map((frame) => ({
      id: `i${nextItemId++}`,
      frame,
      priority,
      lane: hold.lane,
      // Only the first page may go immediately; later pages get their time
      // when the page before them actually lands.
      notBefore: null,
      sequenceId: list.length > 1 ? sequenceId : null,
      coalesceKey,
      quietHoursExempt: isExempt(frame, options.quietHoursExempt),
      scheduler: Boolean(options.scheduler),
      ownerSource: ownerSource ? String(ownerSource) : null,
    }));

    if (!made[0].quietHoursExempt && inQuietHours(new Date(at), config.quietHours, timeZone)) {
      log?.debug?.(`Vestaboard ${config.id} skip (quiet) ${list[0].label || ''}`.trim());
      return { accepted: 0, dropped: list.length, reason: 'quiet' };
    }

    // Last-played / a non-live card of the current watch source hands the
    // board back, then queues as an ordinary snapshot.
    if (laneLockActive(at)
      && state.laneLock.source === hold.source
      && !hold.live
      && !hold.close
      && hold.lane === 'rotation') {
      releaseLaneLock(hold.source);
    }

    const lockNow = laneLockActive(at) ? state.laneLock : null;
    const lockRank = lockNow ? (LANES[lockNow.lane] || 0) : 0;
    const offeredSource = String(
      options.gameSource || hold.source || list[0].source || options.replaceSource || '',
    );
    const mine = Boolean(lockNow && offeredSource === lockNow.source);
    const preempt = hold.lane === 'alert'
      || (lockNow && hold.rank > lockRank)
      || (lockNow && hold.rank === lockRank && !mine && (hold.live || hold.lane === 'alert'));
    const takesBoard = !lockNow || mine || preempt;

    if (isHoldLane(hold.lane) && takesBoard) {
      if (hold.live) {
        acquireLaneLock(hold.source, hold.lane);
      } else if (lockNow && lockNow.source === hold.source) {
        acquireLaneLock(hold.source, hold.lane);
      }
    }

    const locked = laneLockActive(at);
    const mineNow = locked && offeredSource === state.laneLock.source;

    // Only an explicit takeover (game invite, first guest-book page) jumps
    // the line. Manual Push / Air now join the back like the scheduler.
    const mayBreakHold = Boolean(options.breakHold) && takesBoard;
    if (mayBreakHold) {
      state.holdUntil = null;
      state.holdKind = null;
    }

    /** Put these pages ahead of the ones already parked, keeping their order. */
    function queueInFront() {
      const firstSnapshot = items.findIndex((item) => item.priority !== 'alert');
      if (firstSnapshot === -1) {
        items.push(...made);
      } else {
        items.splice(firstSnapshot, 0, ...made);
      }
    }

    /**
     * A later game phase sits behind earlier game pages that have not flipped
     * yet (intermission scores, then the next grid) and still ahead of every
     * non-game page the lock is holding.
     */
    function queueAfterHold() {
      let insertAt = 0;
      for (let i = 0; i < items.length; i += 1) {
        if (items[i].priority === 'alert') {
          insertAt = i + 1;
          continue;
        }
        if (ownedByLock(items[i])) {
          insertAt = i + 1;
          continue;
        }
        break;
      }
      items.splice(insertAt, 0, ...made);
    }

    const replaceSource = options.replaceSource ? String(options.replaceSource) : '';
    const replaceCard = options.replaceCard != null && options.replaceCard !== ''
      ? String(options.replaceCard)
      : '';
    if (replaceSource) {
      const newRank = replaceCard ? gameCardRank(replaceCard) : null;
      for (let i = items.length - 1; i >= 0; i -= 1) {
        if (String(items[i].frame.source || '') !== replaceSource
          && String(items[i].ownerSource || '') !== replaceSource) {
          continue;
        }
        if (newRank == null) {
          items.splice(i, 1);
          continue;
        }
        if (gameCardRank(items[i].frame.card) <= newRank) {
          items.splice(i, 1);
        }
      }
    }

    if (priority === 'alert' && takesBoard) {
      // Jump the line. Leave every waiting page where it is — an alarm
      // must not throw away the guest book or the weather behind it.
      queueInFront();
    } else if (priority === 'alert') {
      queueInFront();
    } else if (preempt && !mineNow) {
      queueInFront();
    } else if (mineNow && !mayBreakHold) {
      queueAfterHold();
    } else if (mineNow || mayBreakHold) {
      queueInFront();
    } else {
      items.push(...made);
    }

    announceQueue();
    return { accepted: made.length, dropped: 0, reason: 'queued' };
  }

  function dropAt(index, reason, item) {
    items.splice(index, 1);
    log?.debug?.(`Vestaboard ${config.id} ${reason} ${item.frame.label || ''}`.trim());
    announceQueue();
  }

  function dropHead(reason, item) {
    dropAt(0, reason, item);
  }

  function onPosted(item, at) {
    state.current = item.frame.rows;
    state.lastPostAt = at;
    state.failures = 0;
    state.retryNotBefore = null;
    setHealth('ok');

    if (item.priority === 'alert') {
      // Once the alert has had its time, the board should go back to what it
      // was showing rather than sitting on a stale warning.
      state.restoreAfter = at + dwellMsOf(item.frame);
      // An alert is not a rotation page. Leave no leftover dwell that would
      // park the restore (or the next snapshot) after the alert has finished.
      state.snapshotUntil = null;
      state.phaseUntil = null;
    } else {
      state.lastSnapshot = item.frame;
      state.restoreAfter = null;
      if (item.scheduler) {
        state.lastSchedulerFlipAt = at;
      }
      // A game card's own `holdSeconds` is not what parks the queue — the
      // session lock does that — so it must not leave a guest hold behind
      // that outlives the game.
      const holdMs = ownedByGame(item) ? 0 : holdMsOf(item.frame);
      state.holdUntil = holdMs ? at + holdMs : null;
      state.holdKind = holdMs ? 'guest' : null;
      // The Settings dwell is how long a rotation page stays. Game cards
      // keep their own phase timing; do not stretch them to 60s, and do
      // not leave a pre-game dwell that would park the next page after.
      if (!ownedByGame(item)) {
        const dwell = boardDwellMs();
        state.snapshotUntil = dwell ? at + dwell : null;
        state.phaseUntil = null;
      } else {
        state.snapshotUntil = null;
        // Lobby / round / intermission — the pill counts this down until
        // the session posts the next card (or a sequenced page is ready).
        const phaseMs = holdMsOf(item.frame);
        state.phaseUntil = phaseMs ? at + phaseMs : null;
      }
    }

    // Hand the next page of this sequence its turn.
    const next = items[0];
    if (next && item.sequenceId && next.sequenceId === item.sequenceId) {
      next.notBefore = Math.max(next.notBefore || 0, at + dwellMsOf(item.frame));
    }
  }

  function onFailed(reason, status) {
    if (reason === 'auth') {
      // A bad key will not fix itself; spinning on it just fills the log.
      setHealth('degraded', 'auth');
      log?.warn?.(`Vestaboard ${config.id} refused the key — check its settings`);
      return;
    }

    state.failures += 1;
    const delay = RETRY_DELAYS_MS[state.failures - 1] ?? UNHEALTHY_RETRY_MS;
    state.retryNotBefore = now() + delay;
    if (state.failures >= FAILURES_BEFORE_UNHEALTHY) {
      setHealth('unhealthy', reason);
    }
    log?.debug?.(
      `Vestaboard ${config.id} retry in ${Math.round(delay / 1000)}s after ${reason}`
      + `${status ? ` (${status})` : ''}`,
    );
  }

  /**
   * Move the queue along by at most one post.
   *
   * Overlapping calls wait for the in-flight post instead of no-opping, so a
   * kick from `pushEvent` and the 1s timer (or a test drain) cannot miss
   * `lastSchedulerFlipAt` being set.
   */
  async function tickOnce() {
    const at = now();

    if (state.restoreAfter && at >= state.restoreAfter && state.lastSnapshot
      && !sameLayout(state.lastSnapshot.rows, state.current)) {
      // Empty queue: put back what the alert covered (queued this tick,
      // posted on the next — the rate window still applies). Held queue
      // during a live lock: put the hold card back too, otherwise an
      // alarm would leave the board on the warning while weather sat parked.
      const locked = laneLockActive(at);
      const wasEmpty = !items.length;
      const nothingReady = wasEmpty || items.every((item) => itemHeld(item, at));
      if (nothingReady && (locked || wasEmpty)) {
        state.restoreAfter = null;
        submit([state.lastSnapshot], { priority: 'snapshot' });
        if (wasEmpty) {
          return null;
        }
      }
    }

    if (!items.length) {
      return null;
    }

    if (state.health === 'degraded' && state.healthReason === 'auth') {
      return null;
    }

    // A live lock parks every non-hold page — skip those to reach the
    // session's own card (or an alert, which still gets through). A guest
    // hold only parks scheduler pages; the head of the line still has to
    // finish (or drop as a duplicate) before a later Push / Air now may flip.
    let index = 0;
    while (index < items.length && itemHeld(items[index], at)) {
      if (sameLayout(items[index].frame.rows, state.current)) {
        dropAt(index, 'dedupe drop', items[index]);
        return 'duplicate';
      }
      if (!laneLockActive(at)) {
        return null;
      }
      index += 1;
    }
    if (index >= items.length) {
      return null;
    }
    const item = items[index];
    if (item.notBefore && at < item.notBefore) return null;
    if (state.retryNotBefore && at < state.retryNotBefore) return null;
    if (state.lastPostAt !== null && at < state.lastPostAt + rateWindowMs()) return null;
    // Hardware can take another flip after the rate window; a 60s dwell
    // still keeps the current page up. Alerts and the live game skip it.
    if (item.priority !== 'alert' && !ownedByLock(item) && snapshotDwellActive(at)) {
      return null;
    }

    if (!item.quietHoursExempt && inQuietHours(new Date(at), config.quietHours, timeZone)) {
      dropAt(index, 'skip (quiet)', item);
      return 'quiet';
    }

    // The physical board would not move for this, so neither should we.
    if (sameLayout(item.frame.rows, state.current)) {
      dropAt(index, 'dedupe drop', item);
      return 'duplicate';
    }

    posting = true;
    const itemId = item.id;
    let outcome;
    try {
      outcome = await transport.post(item.frame.rows, {
        strategy: config.transitionStrategy || null,
      });
    } catch (error) {
      outcome = { ok: false, reason: 'network', retryable: true, message: error?.message };
    } finally {
      posting = false;
    }

    if (outcome.ok) {
      const atPosted = items.findIndex((row) => row.id === itemId);
      if (atPosted >= 0) items.splice(atPosted, 1);
      onPosted(item, now());
      announceQueue();
      emit('posted', { boardId: config.id, frame: item.frame });
      return 'posted';
    }

    if (outcome.reason === 'busy') {
      // Ordinary back-pressure while the flaps finish. Wait out the rest of
      // the window and try the very same frame again.
      state.retryNotBefore = (state.lastPostAt || now()) + rateWindowMs() + 1000;
      log?.debug?.(`Vestaboard ${config.id} 503 wait`);
      return 'busy';
    }

    if (outcome.reason === 'layout') {
      // Retrying an unshowable frame forever would wedge everything behind it.
      log?.warn?.(`Vestaboard ${config.id} refused a layout: ${outcome.message || 'invalid'}`);
      dropAt(index, 'skip (bad layout)', item);
      return 'rejected';
    }

    onFailed(outcome.reason, outcome.status);
    return 'failed';
  }

  function tick() {
    const run = tickTail.then(tickOnce, tickOnce);
    tickTail = run.then(() => {}, () => {});
    return run;
  }

  return {
    submit,
    tick,
    pending,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    state: () => ({
      boardId: config.id,
      health: state.health,
      healthReason: state.healthReason,
      queued: items.length,
      lastPostAt: state.lastPostAt,
      holdUntil: state.holdUntil,
      holdKind: state.holdKind,
      snapshotUntil: state.snapshotUntil,
      snapshotCooldownMs: snapshotCooldownMs(),
      phaseUntil: state.phaseUntil,
      phaseCooldownMs: phaseCooldownMs(),
      nextFlipCooldownMs: nextFlipCooldownMs(),
      gameLock: state.gameLock ? { ...state.gameLock } : null,
      quietHours: inQuietHours(new Date(now()), config.quietHours, timeZone),
      queueRevision,
    }),
    /**
     * A live hold takes the board until it says otherwise. Re-acquiring is
     * how the session pushes the safety deadline out.
     */
    acquireLaneLock,
    acquireGameLock(source, { ttlMs, lane = 'game' } = {}) {
      return acquireLaneLock(source, lane, { ttlMs });
    },
    /** The session ended — finished, stopped, or abandoned. */
    releaseLaneLock,
    releaseGameLock(source = '') {
      return releaseLaneLock(source);
    },
    /**
     * Honour a flip the process did not itself post — a simulator that
     * persisted `lastAcceptedAt`, or this queue's own last post after a
     * recreate. Without this the first tick after boot hits the Local API
     * 15s window and comes back 503.
     */
    noteLastPostAt(at) {
      const ts = typeof at === 'number' ? at : Date.parse(at);
      if (!Number.isFinite(ts)) {
        return;
      }
      if (state.lastPostAt == null || ts > state.lastPostAt) {
        state.lastPostAt = ts;
      }
    },
    /** Settings changes apply live — no restart, no lost queue. */
    setConfig(next) {
      config = { ...config, ...next };
      recoverFromBadKey();
    },
    /**
     * A URL or key change must replace the HTTP client the timer closes
     * over. Assigning `entry.transport` on the hub is not enough.
     */
    setTransport(next) {
      if (!next) {
        return;
      }
      transport = next;
      recoverFromBadKey();
    },
    config: () => ({ ...config }),
    start() {
      if (timer) return;
      timer = setTimer(() => {
        tick().catch((error) => {
          log?.warn?.(`Vestaboard ${config.id} tick failed`, error?.message || error);
        });
      }, tickMs);
      if (typeof timer?.unref === 'function') {
        timer.unref();
      }
    },
    stop() {
      if (!timer) return;
      clearTimer(timer);
      timer = null;
    },
    clear() {
      const dropped = items.length;
      if (!dropped) {
        return 0;
      }
      items.length = 0;
      announceQueue();
      return dropped;
    },
    /**
     * Drop the pending pages a caller no longer wants waiting. Used when one
     * feature takes the board over and a half-finished multi-page run from
     * somewhere else would otherwise surface in the middle of it. Whatever is
     * already showing stays; this only touches the queue.
     */
    dropPending(predicate) {
      if (typeof predicate !== 'function') return 0;
      let dropped = 0;
      for (let i = items.length - 1; i >= 0; i -= 1) {
        if (predicate(items[i].frame, items[i])) {
          items.splice(i, 1);
          dropped += 1;
        }
      }
      if (dropped) announceQueue();
      return dropped;
    },
    /** Drop one waiting page from the simulator (or any caller that has its id). */
    cancel(id) {
      const key = String(id || '');
      const index = items.findIndex((item) => item.id === key);
      if (index < 0) {
        return false;
      }
      dropAt(index, 'cancelled', items[index]);
      return true;
    },
    /**
     * Put waiting pages in this order. Unknown ids are ignored; anything
     * not listed stays at the end in its current relative order.
     */
    reorder(ids) {
      const wanted = (Array.isArray(ids) ? ids : []).map((id) => String(id || ''));
      if (!wanted.length || !items.length) {
        return pending();
      }
      const byId = new Map(items.map((item) => [item.id, item]));
      const next = [];
      for (const id of wanted) {
        const item = byId.get(id);
        if (!item) {
          continue;
        }
        next.push(item);
        byId.delete(id);
      }
      for (const item of items) {
        if (byId.has(item.id)) {
          next.push(item);
        }
      }
      const changed = next.length !== items.length
        || next.some((item, index) => item.id !== items[index].id);
      if (changed) {
        items.length = 0;
        items.push(...next);
        announceQueue();
      }
      return pending();
    },
  };
}

module.exports = {
  createQueue,
  inQuietHours,
  parseHhMm,
  sameLayout,
  COALESCE_WINDOW_MS,
  RETRY_DELAYS_MS,
  UNHEALTHY_RETRY_MS,
  FAILURES_BEFORE_UNHEALTHY,
  QUIET_HOURS_EXEMPT,
  DEFAULT_RATE_WINDOW_SECONDS,
};
