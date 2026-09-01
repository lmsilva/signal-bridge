// What may hold the Vestaboard, and at which rank.
//
// The physical board is one page at a time. Most snapshots join the back of
// the line. A few live events own it until they end — or until something of
// equal or higher rank arrives:
//
//   alert (3)  alarms, timers, reminders, the doorbell, a spoken announce
//   game  (2)  Word Scramble (and later vestaboard games), Huupe live,
//              Autodarts live
//   watch (1)  detected now-playing: YouTube, Feature Presentation, Steam, PSN
//   rotation (0)  everything else — weather, guest book, dashboards, last-played
//
// Score / metadata updates of the same source replace the live card; they
// must not stack a new queue page per shot. Weather alerts, space-launch
// cards, and Alexa "what's playing" are snapshots, not holds.

const LANES = Object.freeze({
  alert: 3,
  game: 2,
  watch: 1,
  rotation: 0,
});

const GAME_LOCK_TTL_MS = 15 * 60 * 1000;
const WATCH_LOCK_TTL_MS = 6 * 60 * 60 * 1000;

const ALERT_TYPES = new Set([
  'alarm.fired',
  'timer.fired',
  'reminder.fired',
  'ring.doorbell',
  // A spoken "announce …" is a live household interrupt, not a rotation page.
  'broadcast',
]);

/** Close payloads release a hold even when there is no card to paint. */
const CLOSE_TO_SOURCE = Object.freeze({
  'huupe.session.close': 'huupe.session',
  'autodarts.match.close': 'autodarts.match',
  'youtube.now-playing.close': 'youtube.now-playing',
  'steam.now-playing.close': 'steam.now-playing',
  'psn.now-playing.close': 'psn.now-playing',
});

function baseType(value) {
  return String(value || '').split(' ')[0];
}

function rotation(source, extra = {}) {
  return {
    lane: 'rotation',
    rank: LANES.rotation,
    source: source || '',
    live: false,
    close: false,
    coalesceKey: null,
    ...extra,
  };
}

function isPlayingMode(mode) {
  const raw = String(mode || '');
  return raw !== 'last-played' && raw !== 'library-tour';
}

/**
 * Classify a payload (or a frame source, when tests submit without one)
 * into a hold lane. Missing session/match status means "live" — a score
 * update that forgot the field must still coalesce, not stack.
 */
function classify(payload = {}, type, frameSource) {
  const raw = String(type || payload.type || frameSource || '');
  const t = baseType(raw);

  const closeSource = CLOSE_TO_SOURCE[t];
  if (closeSource) {
    return {
      lane: 'rotation',
      rank: LANES.rotation,
      source: closeSource,
      live: false,
      close: true,
      coalesceKey: closeSource,
    };
  }

  if (ALERT_TYPES.has(t)) {
    return {
      lane: 'alert',
      rank: LANES.alert,
      source: t,
      live: true,
      close: false,
      coalesceKey: t,
    };
  }

  // Fires travel as the list snapshot type plus `event.kind`. The frame
  // source is `alarm.fired` / `timer.fired`; the hold must follow that.
  if (t === 'alarm.snapshot' && payload.event?.kind === 'fired') {
    return {
      lane: 'alert',
      rank: LANES.alert,
      source: 'alarm.fired',
      live: true,
      close: false,
      coalesceKey: 'alarm.fired',
    };
  }
  if (t === 'timer.snapshot' && payload.event?.kind === 'fired') {
    return {
      lane: 'alert',
      rank: LANES.alert,
      source: 'timer.fired',
      live: true,
      close: false,
      coalesceKey: 'timer.fired',
    };
  }

  if (t === 'word.scramble') {
    return {
      lane: 'game',
      rank: LANES.game,
      source: 'word.scramble',
      live: true,
      close: false,
      // Phases line up (lobby, then the grid). Do not collapse them.
      coalesceKey: null,
    };
  }

  if (t === 'huupe.session') {
    const live = payload.session?.status !== 'finished';
    return {
      lane: 'game',
      rank: LANES.game,
      source: 'huupe.session',
      live,
      close: false,
      coalesceKey: 'huupe.session',
    };
  }

  if (t === 'autodarts.match') {
    const live = payload.match?.status !== 'finished';
    return {
      lane: 'game',
      rank: LANES.game,
      source: 'autodarts.match',
      live,
      close: false,
      coalesceKey: 'autodarts.match',
    };
  }

  if (t === 'youtube.now-playing') {
    const live = isPlayingMode(payload.youtube?.mode);
    return {
      lane: live ? 'watch' : 'rotation',
      rank: live ? LANES.watch : LANES.rotation,
      source: 'youtube.now-playing',
      live,
      close: false,
      coalesceKey: 'youtube.now-playing',
    };
  }

  if (t === 'plex.now-playing') {
    const live = payload.plex?.mode !== 'last-played';
    return {
      lane: live ? 'watch' : 'rotation',
      rank: live ? LANES.watch : LANES.rotation,
      source: 'plex.now-playing',
      live,
      close: false,
      coalesceKey: 'plex.now-playing',
    };
  }

  if (t === 'steam.now-playing') {
    const live = isPlayingMode(payload.steam?.mode);
    return {
      lane: live ? 'watch' : 'rotation',
      rank: live ? LANES.watch : LANES.rotation,
      source: 'steam.now-playing',
      live,
      close: false,
      coalesceKey: 'steam.now-playing',
    };
  }

  if (t === 'psn.now-playing') {
    const live = isPlayingMode(payload.psn?.mode);
    return {
      lane: live ? 'watch' : 'rotation',
      rank: live ? LANES.watch : LANES.rotation,
      source: 'psn.now-playing',
      live,
      close: false,
      coalesceKey: 'psn.now-playing',
    };
  }

  return rotation(t);
}

function lockTtlMs(lane) {
  return lane === 'watch' ? WATCH_LOCK_TTL_MS : GAME_LOCK_TTL_MS;
}

function isHoldLane(lane) {
  return lane === 'game' || lane === 'watch';
}

module.exports = {
  LANES,
  GAME_LOCK_TTL_MS,
  WATCH_LOCK_TTL_MS,
  ALERT_TYPES,
  CLOSE_TO_SOURCE,
  classify,
  lockTtlMs,
  isHoldLane,
};
