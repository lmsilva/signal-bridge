// Per-board jump / hold / immediate policy for the Vestaboard queue.
//
// Three separate ideas:
//   jump       — this card goes to the front of the waiting line
//   immediate  — also cut in now: drop the current page's dwell and flip as
//                soon as the Local API rate window allows (alarms by default)
//   hold       — this card owns the board until the session ends or the
//                safety timeout fires (Word Scramble, Huupe, Autodarts)
//
// Anything not on the board's list joins the back of the line. An empty
// saved list means "use the house defaults", so a fresh board still treats
// alarms as interrupts and live games as holds without anyone configuring it.
//
// The Add-an-event picker lists every board-capable push (Roast Me, Dad Jokes,
// …) plus the live interrupts that are not Push tiles. Relative rank among
// listed events is the list order; unlisted events just queue.

const {
  COMMANDS,
  kindsOf,
  pushCategoryOf,
  PUSH_CATEGORIES,
} = require('../command-registry');

const MIN_HOLD_MINUTES = 1;
const MAX_HOLD_MINUTES = 180;
const DEFAULT_HOLD_MINUTES = 30;

/** Groups follow the Push page categories so the picker feels familiar. */
const GROUPS = Object.freeze([
  { id: 'house', label: 'Around the house' },
  { id: 'games', label: 'Game night' },
  { id: 'media', label: 'Now playing' },
  { id: 'news', label: 'Headlines' },
  { id: 'language', label: 'Word of the flip' },
  { id: 'travel', label: 'Car & sky' },
  { id: 'share', label: 'Share' },
]);

const GROUP_FROM_PUSH = Object.freeze({
  home: 'house',
  games: 'games',
  media: 'media',
  news: 'news',
  language: 'language',
  travel: 'travel',
  share: 'share',
});

/**
 * Hand-tuned rows: live interrupts, hold defaults, and hints. Labels here are
 * fallbacks only — when a vestaboard Push command maps to the same source,
 * that command's `title` wins so Priorities matches the rest of Signal.
 * `recommended` seeds the house default list.
 */
const SPECIALS = Object.freeze([
  {
    source: 'alarm.fired',
    label: 'Alarm fired',
    group: 'house',
    holdCaution: true,
    recommended: true,
    hint: 'Jumps the line, then the queue continues.',
  },
  {
    source: 'timer.fired',
    label: 'Timer done',
    group: 'house',
    holdCaution: true,
    recommended: true,
    hint: 'Jumps the line, then the queue continues.',
  },
  {
    source: 'reminder.fired',
    label: 'Reminder',
    group: 'house',
    holdCaution: true,
    recommended: true,
    hint: 'Jumps the line, then the queue continues.',
  },
  {
    source: 'ring.doorbell',
    // Fallback; Push title "Ring Doorbell" replaces this when the catalog builds.
    label: 'Ring Doorbell',
    group: 'house',
    holdCaution: true,
    recommended: true,
    hint: 'Jumps the line, then the queue continues.',
  },
  {
    source: 'broadcast',
    label: 'Spoken announce',
    group: 'house',
    holdCaution: true,
    recommended: true,
    hint: 'A live “announce …” from Alexa.',
  },
  {
    source: 'word.scramble',
    label: 'Word Scramble',
    group: 'games',
    canHold: true,
    defaultHold: true,
    defaultHoldMinutes: 30,
    recommended: true,
    hint: 'Holds the board for the whole session. The timeout is a safety net.',
  },
  {
    source: 'party.prompts',
    label: 'Party Prompts',
    group: 'games',
    canHold: true,
    defaultHold: true,
    defaultHoldMinutes: 30,
    recommended: true,
    hint: 'Holds the board for the whole session. The timeout is a safety net.',
  },
  {
    source: 'wheel.fortune',
    label: 'Wheel of Fortune',
    group: 'games',
    canHold: true,
    defaultHold: true,
    defaultHoldMinutes: 30,
    recommended: true,
    hint: 'Holds the board for the whole session. The timeout is a safety net.',
  },
  {
    source: 'huupe.session',
    label: 'Huupe Live',
    group: 'games',
    canHold: true,
    defaultHold: true,
    defaultHoldMinutes: 30,
    recommended: true,
    hint: 'Score updates replace the live card. The timeout is a safety net.',
  },
  {
    source: 'autodarts.match',
    label: 'Autodarts',
    group: 'games',
    canHold: true,
    defaultHold: true,
    defaultHoldMinutes: 30,
    recommended: true,
    hint: 'Holds through the match. The timeout is a safety net.',
  },
  {
    source: 'youtube.now-playing',
    label: 'YouTube',
    group: 'media',
    canHold: true,
    defaultHoldMinutes: 180,
    hint: 'Detected watching. Leave off Hold unless you want it to pin the board.',
  },
  {
    source: 'plex.now-playing',
    label: 'Feature Presentation',
    group: 'media',
    canHold: true,
    defaultHoldMinutes: 180,
    hint: 'A movie starting in the theater.',
  },
  {
    source: 'steam.now-playing',
    label: 'Steam',
    group: 'media',
    canHold: true,
    defaultHoldMinutes: 180,
    hint: 'Detected Steam play.',
  },
  {
    source: 'psn.now-playing',
    label: 'PSN',
    group: 'media',
    canHold: true,
    defaultHoldMinutes: 180,
    hint: 'Detected PlayStation play.',
  },
  {
    source: 'guest.book',
    label: 'Guest Book',
    group: 'share',
    hint: 'A signed guest message on the board.',
  },
]);

/** Command ids whose UDP / frame type differs from the command id. */
const COMMAND_SOURCE = Object.freeze({
  'tesla.dashboard': 'tesla-dashboard.query',
  'tesla.battery': 'tesla-battery.query',
  'alexa.weather': 'weather.query',
  'alexa.shopping-list': 'shopping-list.snapshot',
  'alexa.timers': 'timer.snapshot',
  'alexa.alarms': 'alarm.snapshot',
  'alexa.notifications': 'alexa-notifications.query',
  'alexa.now-playing': 'music.playing',
  'alexa.air-quality': 'air-quality.query',
  'signal.guest-snaps': 'guest.photobooth',
  'steam.now-playing': 'steam.now-playing',
  'steam.last-played': 'steam.now-playing',
  'psn.now-playing': 'psn.now-playing',
  'psn.last-played': 'psn.now-playing',
  'credits.show': 'roll-credits.tour',
  'autodarts.now': 'autodarts.match',
  'autodarts.last-match': 'autodarts.match',
  'autodarts.dashboard': 'autodarts.dashboard',
  'huupe.now': 'huupe.session',
  'huupe.last-game': 'huupe.session',
  'huupe.dashboard': 'huupe.dashboard',
  'trivia.show': 'trivia.round',
  'goodnews.show': 'upside-news.round',
  'wiki.show': 'wiki-common-knowledge.round',
  'overhead.show': 'overhead.round',
  'youtube.now-playing': 'youtube.now-playing',
  'youtube.last-played': 'youtube.now-playing',
  'plex.now-playing': 'plex.now-playing',
  'plex.last-played': 'plex.now-playing',
  'plex.top10': 'plex.top10',
  'flightplan.next': 'flightplan.flight',
  'flightplan.board': 'flightplan.flight',
  'weather.weekly': 'weather.weekly',
  'weather.alerts': 'weather.alerts',
  'japanese.learn': 'japanese.learn',
  'portuguese.learn': 'portuguese.learn',
  'spanish.learn': 'spanish.learn',
  'french.learn': 'french.learn',
  'german.learn': 'german.learn',
  'italian.learn': 'italian.learn',
  'signal.quiet-hours': 'quiet-hours.reminder',
  'chuck.facts': 'chuck.facts',
  'roast.me': 'roast.me',
  'family.quotes': 'family.quotes',
  'misheard.lyrics': 'misheard.lyrics',
  'warm.fuzzies': 'warm.fuzzies',
  'bucket.fillers': 'bucket.fillers',
  'periodic.table': 'periodic.table',
  'state.facts': 'state.facts',
  'word.day': 'word.day',
  'dad.jokes': 'dad.jokes',
  'us.weather-map': 'us.weather-map',
  'word.riddles': 'word.riddles',
  'scramble.invite': 'word.scramble',
  'prompts.invite': 'party.prompts',
  'wheel.invite': 'wheel.fortune',
  'amazing.facts': 'amazing.facts',
  'geo.facts': 'geo.facts',
  'talk.starters': 'talk.starters',
  'stoic.quotes': 'stoic.quotes',
  'history.day': 'history.day',
  'bake.inspire': 'bake.inspire',
  'world.population': 'world.population',
  'calendar.clock': 'calendar.clock',
  'word.clock': 'word.clock',
  'redletter.show': 'red-letter.card',
  'guestbook.invite': 'guest.book.invite',
  'ring.doorbell': 'ring.doorbell',
  'stocks.market': 'stocks.market',
  'fx.rates': 'fx.rates',
  'iss.track': 'iss.track',
  'starlink.track': 'starlink.track',
  'launch.alert': 'launch.alert',
});

/** Internal / not useful as a priority row. */
const SKIP_SOURCES = new Set([
  'signal.identity',
]);

let cachedCatalog = null;
let catalogBySource = null;

function groupForPushCategory(pushCategory) {
  return GROUP_FROM_PUSH[pushCategory] || 'news';
}

function sourceForCommand(commandId) {
  return COMMAND_SOURCE[commandId] || commandId;
}

/**
 * Scheduler-only "last played" tiles share a source with the Push tile.
 * Their longer titles must not replace Steam / YouTube / Huupe Live / …
 */
function isSecondaryCommand(command) {
  if (command?.pushable === false) {
    return true;
  }
  return /\.(last-played|last-match|last-game)$/.test(String(command?.id || ''));
}

function buildCatalog() {
  if (cachedCatalog) {
    return cachedCatalog;
  }

  /** @type {Map<string, object>} */
  const bySource = new Map();

  function upsert(entry, { labelWins = false } = {}) {
    const source = String(entry.source || '').trim();
    if (!source || SKIP_SOURCES.has(source)) {
      return;
    }
    const existing = bySource.get(source);
    if (!existing) {
      bySource.set(source, { ...entry, source });
      return;
    }
    // Specials keep hold / recommended / hints. Push titles replace special
    // labels so Priorities matches the Push grid (Ring Doorbell, Steam, …).
    bySource.set(source, {
      ...entry,
      ...existing,
      source,
      label: labelWins
        ? (entry.label || existing.label)
        : (existing.label || entry.label),
      hint: existing.hint || entry.hint || '',
      group: existing.group || entry.group,
      fromPush: Boolean(existing.fromPush || entry.fromPush),
    });
  }

  for (const special of SPECIALS) {
    upsert(special);
  }

  for (const command of COMMANDS) {
    if (!kindsOf(command).includes('vestaboard')) {
      continue;
    }
    const source = sourceForCommand(command.id);
    const secondary = isSecondaryCommand(command);
    const existing = bySource.get(source);
    // Scheduler-only / last-played aliases share a source with the Push tile.
    // Never let them rename Steam → "Steam — last played".
    if (secondary && (existing?.fromPush || (existing?.label && existing.label !== source))) {
      continue;
    }
    // Two pushable tiles can share a source (Next Flight + Trip Board). Keep
    // the first Push title so the name stays stable.
    if (!secondary && existing?.fromPush) {
      continue;
    }
    const pushCat = pushCategoryOf(command);
    upsert({
      source,
      label: command.title,
      group: groupForPushCategory(pushCat),
      hint: command.subtitle || '',
      canHold: true,
      fromPush: !secondary,
    }, { labelWins: !secondary });
  }

  // Do not walk FORMATTERS. Game modes register a key per card
  // (`party.prompts.lobby`, `wheel.fortune.round`) and some commands keep a
  // legacy type next to the real source (`credits.show` → `roll-credits.tour`).
  // Those are updates of one event, not events of their own — listing them
  // would show raw dotted ids. Specials + vestaboard Push commands already
  // name every row a person can pick.

  const groupOrder = new Map(GROUPS.map((group, index) => [group.id, index]));
  const events = [...bySource.values()].sort((a, b) => {
    const ga = groupOrder.get(a.group) ?? 99;
    const gb = groupOrder.get(b.group) ?? 99;
    if (ga !== gb) return ga - gb;
    return String(a.label).localeCompare(String(b.label));
  });

  cachedCatalog = events;
  catalogBySource = bySource;
  return events;
}

function catalogMap() {
  buildCatalog();
  return catalogBySource;
}

function defaultHoldMinutesFor(source) {
  const item = catalogMap().get(source);
  const raw = Number(item?.defaultHoldMinutes);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_HOLD_MINUTES;
}

function clampHoldMinutes(value, source) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return defaultHoldMinutesFor(source);
  }
  return Math.min(MAX_HOLD_MINUTES, Math.max(MIN_HOLD_MINUTES, Math.round(number)));
}

function defaultPriorities() {
  // Keep the curated order (alarms before games), not the A–Z picker sort.
  return SPECIALS
    .filter((item) => item.recommended)
    .map((item) => ({
      source: item.source,
      jump: true,
      // House defaults cut in — missing `immediate` on older saves means the
      // same (see normaliseRule).
      immediate: true,
      hold: Boolean(item.defaultHold),
      holdMinutes: defaultHoldMinutesFor(item.source),
    }));
}

function normaliseRule(input = {}) {
  const source = String(input.source || '').trim();
  if (!source || !catalogMap().has(source)) {
    return null;
  }
  const hold = Boolean(input.hold);
  const jump = hold || input.jump !== false;
  // Omitted `immediate` keeps prior interrupt behaviour (cut in). Only an
  // explicit false waits out the page already on the board.
  const immediate = jump && input.immediate !== false;
  return {
    source,
    jump,
    immediate,
    hold,
    holdMinutes: clampHoldMinutes(input.holdMinutes, source),
  };
}

/**
 * `null` / `undefined` → house defaults.
 * An array (including `[]`) is the board's explicit list.
 */
function normalisePriorities(value) {
  if (value == null) {
    return defaultPriorities();
  }
  if (!Array.isArray(value)) {
    return defaultPriorities();
  }
  const seen = new Set();
  const list = [];
  for (const entry of value) {
    const rule = normaliseRule(entry);
    if (!rule || seen.has(rule.source)) {
      continue;
    }
    seen.add(rule.source);
    list.push(rule);
  }
  return list;
}

function catalogForClient() {
  const events = buildCatalog();
  return {
    groups: GROUPS.map((group) => ({ ...group })),
    events: events.map((item) => ({
      source: item.source,
      label: item.label,
      group: item.group,
      hint: item.hint || '',
      canHold: true,
      holdCaution: item.holdCaution === true,
      defaultHold: item.defaultHold === true,
      defaultHoldMinutes: defaultHoldMinutesFor(item.source),
    })),
    defaults: defaultPriorities(),
    minHoldMinutes: MIN_HOLD_MINUTES,
    maxHoldMinutes: MAX_HOLD_MINUTES,
    // Expose Push category labels for any client that wants them.
    pushCategories: PUSH_CATEGORIES.map((entry) => ({ ...entry })),
  };
}

function minutesToMs(minutes, source) {
  return clampHoldMinutes(minutes, source) * 60 * 1000;
}

function rankAt(policy, index) {
  if (!Array.isArray(policy) || index < 0 || index >= policy.length) {
    return 0;
  }
  return policy.length - index;
}

function applyPolicy(structural = {}, priorities) {
  const source = String(structural.source || '');
  if (structural.close) {
    return {
      lane: 'rotation',
      rank: 0,
      source: source || structural.source,
      live: false,
      close: true,
      jump: false,
      immediate: false,
      hold: false,
      ttlMs: 0,
      coalesceKey: structural.coalesceKey || source,
    };
  }

  // Last-played / a watch source that is no longer live never pins the board.
  if (structural.kind === 'watch' && structural.sessionLive === false) {
    return {
      lane: 'rotation',
      rank: 0,
      source,
      live: false,
      close: false,
      jump: false,
      immediate: false,
      hold: false,
      ttlMs: 0,
      coalesceKey: structural.coalesceKey || source,
    };
  }

  const policy = normalisePriorities(priorities == null ? null : priorities);
  const index = policy.findIndex((rule) => rule.source === source);
  if (index < 0) {
    return {
      lane: 'rotation',
      rank: 0,
      source,
      live: false,
      close: false,
      jump: false,
      immediate: false,
      hold: false,
      ttlMs: 0,
      coalesceKey: structural.coalesceKey || null,
    };
  }

  const rule = policy[index];
  const sessionOk = structural.sessionLive !== false;
  const wantHold = Boolean(rule.hold);
  // A finished game card must keep the hold lane so the lock can stay
  // (or be refreshed) until close. Last-played watch already returned.
  const hold = wantHold && (sessionOk || structural.kind === 'game');
  const jump = Boolean(rule.jump) || hold;
  const immediate = jump && Boolean(rule.immediate);
  const rank = rankAt(policy, index);
  return {
    lane: hold ? 'game' : (jump ? 'alert' : 'rotation'),
    rank,
    source,
    live: wantHold && sessionOk,
    close: false,
    jump,
    immediate,
    hold,
    ttlMs: hold ? minutesToMs(rule.holdMinutes, source) : 0,
    coalesceKey: structural.coalesceKey ?? null,
  };
}

function labelFor(source) {
  return catalogMap().get(source)?.label || source;
}

/** Test helper — drop the memoised catalog after stubbing commands. */
function resetCatalogCache() {
  cachedCatalog = null;
  catalogBySource = null;
}

module.exports = {
  GROUPS,
  SPECIALS,
  MIN_HOLD_MINUTES,
  MAX_HOLD_MINUTES,
  DEFAULT_HOLD_MINUTES,
  COMMAND_SOURCE,
  defaultPriorities,
  normalisePriorities,
  normaliseRule,
  catalogForClient,
  applyPolicy,
  minutesToMs,
  rankAt,
  labelFor,
  clampHoldMinutes,
  resetCatalogCache,
  // Back-compat for older tests that imported CATALOG.
  get CATALOG() {
    return buildCatalog();
  },
};
