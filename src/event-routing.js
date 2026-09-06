/**
 * Event routing — where automatic (non-manual, non-scheduler) events may go.
 *
 * Each event family has one or more routes. A route targets destinations
 * (all / software / Vestaboards / specific ids) and optional week-grid slots
 * (Mon–Sun × 24h). Empty slots = any hour. At send time, every route whose
 * slots allow "now" contributes its destinations (union). No matching route
 * → skip the push.
 *
 * Legacy v1 shape `{ destinations, windows:[{start,end}] }` migrates to one
 * route with slots expanded across all seven days.
 */

'use strict';

const FAMILIES = Object.freeze([
  { id: 'alexa.alarms', label: 'Alarms', blurb: 'Wake alarms from Alexa' },
  { id: 'alexa.timers', label: 'Timers', blurb: 'Kitchen and reminder timers' },
  { id: 'alexa.reminders', label: 'Reminders', blurb: 'Alexa reminder fires' },
  { id: 'alexa.broadcast', label: 'Broadcasts', blurb: 'Alexa announce / broadcast messages' },
  { id: 'alexa.music', label: 'Alexa music', blurb: 'Now Playing cards from Echo speakers' },
  { id: 'alexa.shopping', label: 'Shopping list', blurb: 'Shopping list snapshots' },
  { id: 'alexa.voice', label: 'Voice answers', blurb: 'Weather, time, Tesla, and other spoken answers' },
  { id: 'media.youtube', label: 'YouTube', blurb: 'TV Lounge now playing' },
  { id: 'media.steam', label: 'Steam', blurb: 'Steam Now Playing' },
  { id: 'media.psn', label: 'PlayStation', blurb: 'PSN Now Playing' },
  { id: 'media.plex', label: 'Feature Presentation', blurb: 'Plex theater sessions' },
  { id: 'media.huupe', label: 'Huupe', blurb: 'Basketball sessions' },
  { id: 'media.autodarts', label: 'Autodarts', blurb: 'Darts match live cards' },
  { id: 'home.ring', label: 'Ring doorbell', blurb: 'Ding and motion alerts' },
  { id: 'travel.overhead', label: 'Overhead', blurb: 'Planes overhead' },
  { id: 'travel.flightplan', label: 'Flight Plan', blurb: 'Tracked flight updates' },
  { id: 'guest.book', label: 'Guest Book', blurb: 'Guest messages to the board' },
  { id: 'guest.snaps', label: 'Guest Snaps', blurb: 'Photobooth and slideshow pushes' },
  { id: 'games.live', label: 'Live games', blurb: 'Scramble, prompts, Wheel, Hangman' },
]);

const FAMILY_IDS = new Set(FAMILIES.map((row) => row.id));

const TYPE_TO_FAMILY = Object.freeze({
  'alarm.snapshot': 'alexa.alarms',
  'alarm.fired': 'alexa.alarms',
  'timer.snapshot': 'alexa.timers',
  'timer.fired': 'alexa.timers',
  'reminder.fired': 'alexa.reminders',
  broadcast: 'alexa.broadcast',
  'music.playing': 'alexa.music',
  'shopping-list.snapshot': 'alexa.shopping',
  'weather.query': 'alexa.voice',
  'weather.weekly': 'alexa.voice',
  'time.query': 'alexa.voice',
  'indoor-temperature.query': 'alexa.voice',
  'air-quality.query': 'alexa.voice',
  'tesla-battery.query': 'alexa.voice',
  'tesla-dashboard.query': 'alexa.voice',
  'route-planner.query': 'alexa.voice',
  'trivia.round': 'alexa.voice',
  'youtube.now-playing': 'media.youtube',
  'youtube.now-playing.close': 'media.youtube',
  'steam.now-playing': 'media.steam',
  'steam.now-playing.close': 'media.steam',
  'psn.now-playing': 'media.psn',
  'psn.now-playing.close': 'media.psn',
  'plex.now-playing': 'media.plex',
  'plex.now-playing.close': 'media.plex',
  'huupe.session': 'media.huupe',
  'huupe.session.close': 'media.huupe',
  'huupe.dashboard': 'media.huupe',
  'autodarts.match': 'media.autodarts',
  'autodarts.match.close': 'media.autodarts',
  'autodarts.dashboard': 'media.autodarts',
  'ring.doorbell': 'home.ring',
  'overhead.round': 'travel.overhead',
  'overhead.update': 'travel.overhead',
  'overhead.close': 'travel.overhead',
  'flightplan.flight': 'travel.flightplan',
  'guest.book': 'guest.book',
  'guest.photobooth': 'guest.snaps',
  'photo.slideshow': 'guest.snaps',
  'qr.display': 'guest.snaps',
  'game.scramble': 'games.live',
  'game.party-prompts': 'games.live',
  'game.wheel': 'games.live',
  'game.hangman': 'games.live',
  'game.library-tour': 'alexa.voice',
});

const WEEKDAY_TO_INDEX = Object.freeze({
  Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6,
});

function clampInt(value, min, max, fallback = null) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function defaultRoute() {
  return { destinations: 'all', slots: [] };
}

function defaultFamilyRule() {
  return { routes: [defaultRoute()] };
}

function defaultSettings() {
  const families = {};
  for (const row of FAMILIES) {
    families[row.id] = defaultFamilyRule();
  }
  return { version: 2, families };
}

function clampHhMm(value) {
  const raw = String(value == null ? '' : value).trim();
  const match = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) {
    return null;
  }
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function minutesOfDay(hhmm) {
  const parsed = clampHhMm(hhmm);
  if (!parsed) return null;
  const [hh, mm] = parsed.split(':').map(Number);
  return hh * 60 + mm;
}

function sanitiseWindow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const start = clampHhMm(raw.start);
  const end = clampHhMm(raw.end);
  if (!start || !end) return null;
  return { start, end };
}

function sanitiseDestinations(raw) {
  if (raw == null || raw === '' || raw === 'all' || raw === '*') return 'all';
  if (raw === 'full' || raw === 'software') return 'full';
  if (raw === 'vestaboard' || raw === 'vestaboards') return 'vestaboard';
  if (!Array.isArray(raw)) return 'all';
  const out = [];
  const seen = new Set();
  for (const entry of raw) {
    const id = String(entry || '').trim();
    if (!id) continue;
    const key = id === 'software' ? 'full' : id;
    if (key === 'all' || key === '*') continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  if (!out.length) return 'all';
  if (out.length === 1 && (out[0] === 'full' || out[0] === 'vestaboard')) return out[0];
  return out;
}

function sanitiseSlot(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const day = clampInt(raw.day, 0, 6, null);
  const hour = clampInt(raw.hour, 0, 23, null);
  if (day == null || hour == null) return null;
  return {
    day,
    hour,
    minute: clampInt(raw.minute, 0, 59, 0),
  };
}

/** Expand legacy HH:mm windows onto every weekday as hour slots. */
function windowsToSlots(windows) {
  const slots = [];
  const seen = new Set();
  for (const window of windows || []) {
    const start = minutesOfDay(window.start);
    const end = minutesOfDay(window.end);
    if (start == null || end == null) continue;
    for (let day = 0; day < 7; day += 1) {
      for (let hour = 0; hour < 24; hour += 1) {
        const mins = hour * 60;
        let ok = false;
        if (start === end) ok = true;
        else if (start < end) ok = mins >= start && mins < end;
        else ok = mins >= start || mins < end;
        if (!ok) continue;
        const key = `${day}:${hour}`;
        if (seen.has(key)) continue;
        seen.add(key);
        slots.push({ day, hour, minute: 0 });
      }
    }
  }
  return slots;
}

function slotsFromWeekStrings(week) {
  const slots = [];
  if (!Array.isArray(week)) return slots;
  for (let day = 0; day < 7; day += 1) {
    const row = String(week[day] || '').padEnd(24, '0').slice(0, 24);
    for (let hour = 0; hour < 24; hour += 1) {
      if (row[hour] === '1') slots.push({ day, hour, minute: 0 });
    }
  }
  return slots;
}

function sanitiseRoute(raw) {
  if (!raw || typeof raw !== 'object') return defaultRoute();
  const destinations = sanitiseDestinations(raw.destinations);
  let slots = [];
  if (Array.isArray(raw.slots) && raw.slots.length) {
    slots = raw.slots.map(sanitiseSlot).filter(Boolean).slice(0, 7 * 24);
  } else if (Array.isArray(raw.week) && raw.week.length) {
    slots = slotsFromWeekStrings(raw.week).slice(0, 7 * 24);
  } else if (Array.isArray(raw.windows) && raw.windows.length) {
    slots = windowsToSlots(raw.windows.map(sanitiseWindow).filter(Boolean));
  }
  return { destinations, slots };
}

function sanitiseFamilyRule(raw) {
  if (!raw || typeof raw !== 'object') return defaultFamilyRule();
  if (Array.isArray(raw.routes)) {
    const routes = raw.routes.map(sanitiseRoute).slice(0, 12);
    return { routes: routes.length ? routes : [defaultRoute()] };
  }
  // Legacy single-route: destinations + windows/slots/week.
  if (
    raw.destinations != null
    || raw.windows != null
    || raw.slots != null
    || raw.week != null
  ) {
    return { routes: [sanitiseRoute(raw)] };
  }
  return defaultFamilyRule();
}

function sanitiseSettings(raw) {
  const next = defaultSettings();
  const incoming = raw && typeof raw === 'object' ? raw.families : null;
  if (incoming && typeof incoming === 'object') {
    for (const id of FAMILY_IDS) {
      if (Object.prototype.hasOwnProperty.call(incoming, id)) {
        next.families[id] = sanitiseFamilyRule(incoming[id]);
      }
    }
  }
  return next;
}

function classifyPayload(payload = {}, options = {}) {
  const type = String(payload?.type || options.type || '').trim();
  if (TYPE_TO_FAMILY[type]) return TYPE_TO_FAMILY[type];
  if (type.startsWith('game.')) return 'games.live';
  if (type.startsWith('steam.')) return 'media.steam';
  if (type.startsWith('psn.')) return 'media.psn';
  if (type.startsWith('youtube.')) return 'media.youtube';
  if (type.startsWith('plex.')) return 'media.plex';
  if (type.startsWith('huupe.')) return 'media.huupe';
  if (type.startsWith('autodarts.')) return 'media.autodarts';
  if (type.startsWith('overhead.')) return 'travel.overhead';
  if (type.startsWith('flightplan.')) return 'travel.flightplan';
  if (type.startsWith('alarm.')) return 'alexa.alarms';
  if (type.startsWith('timer.')) return 'alexa.timers';
  if (type.startsWith('reminder.')) return 'alexa.reminders';
  if (type.startsWith('music.')) return 'alexa.music';
  if (type.startsWith('shopping')) return 'alexa.shopping';
  return null;
}

function shouldBypassRouting(options = {}, payload = {}) {
  if (options.bypassEventRouting || options._eventRoutingApplied) return true;
  const source = String(options.source || payload.source || '').toLowerCase();
  if (source === 'scheduler' || source === 'web-api' || source === 'manual') return true;
  const trigger = String(options.trigger || payload.trigger || '').toLowerCase();
  if (trigger === 'web-api' || trigger === 'manual') return true;
  if (options.scheduler) return true;
  return false;
}

function localWeekParts(timeZone, now = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || 'America/Denver',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    const weekday = parts.find((p) => p.type === 'weekday')?.value || 'Mon';
    const hour = Number(parts.find((p) => p.type === 'hour')?.value || 0);
    const minute = Number(parts.find((p) => p.type === 'minute')?.value || 0);
    return {
      day: WEEKDAY_TO_INDEX[weekday] ?? 0,
      hour,
      minute,
    };
  } catch {
    const jsDay = now.getDay(); // 0=Sun
    return {
      day: jsDay === 0 ? 6 : jsDay - 1,
      hour: now.getHours(),
      minute: now.getMinutes(),
    };
  }
}

function localMinutesNow(timeZone, now = new Date()) {
  const parts = localWeekParts(timeZone, now);
  return parts.hour * 60 + parts.minute;
}

function inAnyWindow(windows, timeZone, now = new Date()) {
  if (!windows || !windows.length) return true;
  const mins = localMinutesNow(timeZone, now);
  return windows.some((window) => {
    const start = minutesOfDay(window.start);
    const end = minutesOfDay(window.end);
    if (start == null || end == null) return false;
    if (start === end) return true;
    if (start < end) return mins >= start && mins < end;
    return mins >= start || mins < end;
  });
}

/** Empty slots = always. Otherwise the current weekday+hour must be painted. */
function slotsAllow(slots, timeZone, now = new Date()) {
  if (!slots || !slots.length) return true;
  const { day, hour } = localWeekParts(timeZone, now);
  return slots.some((slot) => slot.day === day && slot.hour === hour);
}

function destinationsToTargets(destinations) {
  if (destinations === 'all') return ['all'];
  if (destinations === 'full' || destinations === 'vestaboard') return [destinations];
  if (Array.isArray(destinations) && destinations.length) return [...destinations];
  return ['all'];
}

function unionTargets(routes) {
  const out = new Set();
  let hasAll = false;
  for (const route of routes) {
    const targets = destinationsToTargets(route.destinations);
    if (targets.length === 1 && targets[0] === 'all') {
      hasAll = true;
      break;
    }
    for (const id of targets) out.add(id);
  }
  if (hasAll) return null;
  return [...out];
}

/**
 * @returns {{ skip: boolean, reason?: string, targets?: string[]|null, family?: string|null, bypassed?: boolean }}
 */
function resolveRoute(payload, options = {}, settings, ctx = {}) {
  if (shouldBypassRouting(options, payload)) {
    return { skip: false, bypassed: true, targets: null, family: null };
  }
  const family = classifyPayload(payload, options);
  if (!family) {
    return { skip: false, bypassed: true, targets: null, family: null };
  }
  const conf = sanitiseSettings(settings || {});
  const rule = conf.families[family] || defaultFamilyRule();
  const matching = (rule.routes || []).filter((route) => (
    slotsAllow(route.slots, ctx.timeZone, ctx.now)
  ));
  if (!matching.length) {
    return {
      skip: true,
      reason: `event-routing:${family}:outside-window`,
      family,
      targets: [],
    };
  }
  const targets = unionTargets(matching);
  if (targets == null) {
    return { skip: false, family, targets: null, destinations: 'all' };
  }
  if (!targets.length) {
    return {
      skip: true,
      reason: `event-routing:${family}:no-targets`,
      family,
      targets: [],
    };
  }
  return { skip: false, family, targets, destinations: targets };
}

function cloneFamilyRule(rule) {
  const safe = sanitiseFamilyRule(rule);
  return {
    routes: safe.routes.map((route) => ({
      destinations: Array.isArray(route.destinations)
        ? [...route.destinations]
        : route.destinations,
      slots: (route.slots || []).map((slot) => ({ ...slot })),
    })),
  };
}

module.exports = {
  FAMILIES,
  FAMILY_IDS,
  TYPE_TO_FAMILY,
  defaultRoute,
  defaultFamilyRule,
  defaultSettings,
  clampHhMm,
  sanitiseWindow,
  sanitiseDestinations,
  sanitiseSlot,
  windowsToSlots,
  slotsFromWeekStrings,
  sanitiseRoute,
  sanitiseFamilyRule,
  sanitiseSettings,
  classifyPayload,
  shouldBypassRouting,
  localWeekParts,
  localMinutesNow,
  inAnyWindow,
  slotsAllow,
  destinationsToTargets,
  unionTargets,
  resolveRoute,
  cloneFamilyRule,
};
