// What may jump, cut in, or hold the Vestaboard.
//
// Three separate ideas (see `priorities.js` for the per-board list):
//
//   jump       — this card goes to the front of the waiting line
//   immediate  — also replace what is showing as soon as flaps can move
//                (alarms / doorbell / announce by default)
//   hold       — this card owns the board until the session ends or the
//                safety timeout fires (Word Scramble, Huupe, Autodarts)
//
// Anything not on the board's priority list joins the back of the line.
// Detected now-playing (YouTube / Plex / Steam / PSN) is a snapshot unless
// the board's list says otherwise — it must not pin the flaps by default.
//
// Score / metadata updates of the same source replace the live card; they
// must not stack a new queue page per shot.

const { applyPolicy } = require('./priorities');

const LANES = Object.freeze({
  alert: 3,
  game: 2,
  watch: 1,
  rotation: 0,
});

const GAME_LOCK_TTL_MS = 30 * 60 * 1000;
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

function isPlayingMode(mode) {
  const raw = String(mode || '');
  return raw !== 'last-played' && raw !== 'library-tour';
}

/**
 * Facts the policy layer needs: who this is, whether the session is still
 * live, and which pending page a score update should replace.
 */
function classifyStructural(payload = {}, type, frameSource) {
  const raw = String(type || payload.type || frameSource || '');
  const t = baseType(raw);

  const closeSource = CLOSE_TO_SOURCE[t];
  if (closeSource) {
    return {
      kind: 'close',
      source: closeSource,
      sessionLive: false,
      close: true,
      coalesceKey: closeSource,
    };
  }

  if (ALERT_TYPES.has(t)) {
    return {
      kind: 'interrupt',
      source: t,
      sessionLive: undefined,
      close: false,
      coalesceKey: t,
    };
  }

  // Fires travel as the list snapshot type plus `event.kind`. The frame
  // source is `alarm.fired` / `timer.fired`; the hold must follow that.
  if (t === 'alarm.snapshot' && payload.event?.kind === 'fired') {
    return {
      kind: 'interrupt',
      source: 'alarm.fired',
      sessionLive: undefined,
      close: false,
      coalesceKey: 'alarm.fired',
    };
  }
  if (t === 'timer.snapshot' && payload.event?.kind === 'fired') {
    return {
      kind: 'interrupt',
      source: 'timer.fired',
      sessionLive: undefined,
      close: false,
      coalesceKey: 'timer.fired',
    };
  }

  if (t === 'word.scramble') {
    return {
      kind: 'game',
      source: 'word.scramble',
      sessionLive: true,
      close: false,
      // Phases line up (lobby, then the grid). Do not collapse them.
      coalesceKey: null,
    };
  }

  if (t === 'party.prompts') {
    return {
      kind: 'game',
      source: 'party.prompts',
      sessionLive: true,
      close: false,
      // Prompt, then voting, then the winner — every card is a beat of the
      // round and collapsing them would skip the reveal.
      coalesceKey: null,
    };
  }

  if (t === 'wheel.fortune') {
    return {
      kind: 'game',
      source: 'wheel.fortune',
      sessionLive: true,
      close: false,
      // Spin, letter, solve — each board refresh is a beat, not a score tick.
      coalesceKey: null,
    };
  }

  if (t === 'hangman.game') {
    return {
      kind: 'game',
      source: 'hangman.game',
      sessionLive: true,
      close: false,
      // A letter, a life, a turn — collapsing them would skip the gallows.
      coalesceKey: null,
    };
  }

  if (t === 'huupe.session') {
    return {
      kind: 'game',
      source: 'huupe.session',
      sessionLive: payload.session?.status !== 'finished',
      close: false,
      coalesceKey: 'huupe.session',
    };
  }

  if (t === 'autodarts.match') {
    return {
      kind: 'game',
      source: 'autodarts.match',
      sessionLive: payload.match?.status !== 'finished',
      close: false,
      coalesceKey: 'autodarts.match',
    };
  }

  if (t === 'youtube.now-playing') {
    return {
      kind: 'watch',
      source: 'youtube.now-playing',
      sessionLive: isPlayingMode(payload.youtube?.mode),
      close: false,
      coalesceKey: 'youtube.now-playing',
    };
  }

  if (t === 'plex.now-playing') {
    return {
      kind: 'watch',
      source: 'plex.now-playing',
      sessionLive: payload.plex?.mode !== 'last-played',
      close: false,
      coalesceKey: 'plex.now-playing',
    };
  }

  if (t === 'steam.now-playing') {
    return {
      kind: 'watch',
      source: 'steam.now-playing',
      sessionLive: isPlayingMode(payload.steam?.mode),
      close: false,
      coalesceKey: 'steam.now-playing',
    };
  }

  if (t === 'psn.now-playing') {
    return {
      kind: 'watch',
      source: 'psn.now-playing',
      sessionLive: isPlayingMode(payload.psn?.mode),
      close: false,
      coalesceKey: 'psn.now-playing',
    };
  }

  // One car, one card. A voice ask sends a cached preview and then the
  // live reading — those must replace, not stack four Tesla pages.
  if (t === 'tesla-battery.query' || t === 'tesla.battery') {
    return {
      kind: 'snapshot',
      source: 'tesla-battery.query',
      sessionLive: undefined,
      close: false,
      coalesceKey: 'tesla-battery.query',
    };
  }
  if (t === 'tesla-dashboard.query' || t === 'tesla.dashboard') {
    return {
      kind: 'snapshot',
      source: 'tesla-dashboard.query',
      sessionLive: undefined,
      close: false,
      coalesceKey: 'tesla-dashboard.query',
    };
  }

  return {
    kind: 'snapshot',
    source: t,
    sessionLive: undefined,
    close: false,
    coalesceKey: null,
  };
}

/**
 * Classify a payload (or a frame source, when tests submit without one)
 * into a jump / hold decision. Pass `{ priorities }` from the board; omit
 * it to use the house defaults. An empty array means nothing jumps.
 */
function classify(payload = {}, type, frameSource, options = {}) {
  const structural = classifyStructural(payload, type, frameSource);
  return applyPolicy(structural, options.priorities);
}

function lockTtlMs(lane, ttlMs) {
  if (Number.isFinite(ttlMs) && ttlMs > 0) {
    return ttlMs;
  }
  return lane === 'watch' ? WATCH_LOCK_TTL_MS : GAME_LOCK_TTL_MS;
}

function isHoldLane(lane) {
  return lane === 'game';
}

module.exports = {
  LANES,
  GAME_LOCK_TTL_MS,
  WATCH_LOCK_TTL_MS,
  ALERT_TYPES,
  CLOSE_TO_SOURCE,
  classify,
  classifyStructural,
  lockTtlMs,
  isHoldLane,
};
