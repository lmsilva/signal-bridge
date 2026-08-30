// The (event type, display kind) table, and the fan-out that uses it.
//
// A push to All Displays is safe because each board looks up its own
// formatter. Content a board cannot show — photos, posters, library tours,
// remote input — has no row in the table, so the board is skipped and the
// UDP path is the only one that fires. One debug line per skipped board,
// never a silent miss and never a blank flip.

const alexa = require('./formatters/alexa');
const tesla = require('./formatters/tesla');
const gaming = require('./formatters/gaming');
const feeds = require('./formatters/feeds');
const signal = require('./formatters/signal');
const cinema = require('./formatters/cinema');

const FORMATTERS = {
  ...alexa.FORMATTERS,
  ...tesla.FORMATTERS,
  ...gaming.FORMATTERS,
  ...feeds.FORMATTERS,
  ...signal.FORMATTERS,
  ...cinema.FORMATTERS,
};

/**
 * Scheduler / Push command ids that produce a payload whose `type` is
 * different from the command id. Voice events already carry the UDP type
 * and do not go through this map.
 */
const COMMAND_TO_TYPE = {
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
  'amazing.facts': 'amazing.facts',
  'geo.facts': 'geo.facts',
  'talk.starters': 'talk.starters',
  'stoic.quotes': 'stoic.quotes',
  'history.day': 'history.day',
  'bake.inspire': 'bake.inspire',
  'world.population': 'world.population',
  'calendar.clock': 'calendar.clock',
  'redletter.show': 'red-letter.card',
  'guestbook.invite': 'guest.book.invite',
  'stocks.market': 'stocks.market',
  'fx.rates': 'fx.rates',
  'iss.track': 'iss.track',
  'starlink.track': 'starlink.track',
};

function typeOf(payload, commandId) {
  if (payload?.type && FORMATTERS[payload.type]) {
    return payload.type;
  }
  if (commandId && (FORMATTERS[commandId] || COMMAND_TO_TYPE[commandId])) {
    return COMMAND_TO_TYPE[commandId] || commandId;
  }
  return payload?.type || commandId || '';
}

function formatterFor(typeOrCommand) {
  if (!typeOrCommand) {
    return null;
  }
  return FORMATTERS[typeOrCommand] || FORMATTERS[COMMAND_TO_TYPE[typeOrCommand]] || null;
}

function boardAllows(board, type, commandId) {
  const allow = board?.events;
  if (!allow || allow === 'all') {
    return true;
  }
  if (!Array.isArray(allow)) {
    return true;
  }
  return allow.includes(type) || (commandId && allow.includes(commandId));
}

function coalesceKeyFor(payload, type) {
  if (type !== 'smart-home.command') {
    return null;
  }
  const command = payload?.command || {};
  const entity = command.matchedName || command.target || command.spokenTarget || '';
  return entity ? `smart-home:${entity}` : 'smart-home';
}

function isAllTarget(targetId) {
  const raw = String(targetId == null ? '' : targetId).trim();
  return !raw || raw === '*' || raw.toLowerCase() === 'all';
}

/**
 * Which running boards should see this event.
 *
 * `all` and `vestaboard` mean every enabled board. `full` means none — that
 * class is UDP only. A bare id means that board alone.
 */
function matchBoards(boards, targetId) {
  const raw = String(targetId == null ? '' : targetId).trim();
  if (raw.toLowerCase() === 'full') {
    return [];
  }
  if (isAllTarget(raw) || raw.toLowerCase() === 'vestaboard') {
    return boards;
  }
  return boards.filter((entry) => entry.board.id === raw);
}

/**
 * Format one payload and hand the frames to the boards that should show it.
 *
 * `submit` is injected so tests can watch the call without standing up a
 * queue. `log` gets the skip line, once per board, when there is no formatter.
 */
function routeEvent({
  payload,
  boards = [],
  targetId = 'all',
  commandId = null,
  explicit = true,
  scheduler = false,
  breakHold = null,
  quietHoursExempt = null,
  ctx = {},
  now = () => Date.now(),
  submit,
  log = null,
} = {}) {
  const type = typeOf(payload, commandId);
  const formatter = formatterFor(type);
  const targets = matchBoards(boards, targetId);
  const results = [];

  if (!formatter) {
    for (const entry of targets) {
      log?.debug?.(`no board formatter for ${type || payload?.type || 'unknown'}, skipped ${entry.board.id}`);
      results.push({
        boardId: entry.board.id,
        skipped: true,
        reason: 'no-formatter',
      });
    }
    return results;
  }

  for (const entry of targets) {
    if (!boardAllows(entry.board, type, commandId)) {
      log?.debug?.(`Vestaboard ${entry.board.id} skip (allowlist) ${type}`);
      results.push({ boardId: entry.board.id, skipped: true, reason: 'allowlist' });
      continue;
    }

    let frames;
    try {
      frames = formatter(payload, {
        now: new Date(now()),
        explicit,
        board: entry.board,
        ...ctx,
      }) || [];
    } catch (error) {
      log?.debug?.(`board formatter ${type} threw on ${entry.board.id}: ${error?.message || error}`);
      results.push({ boardId: entry.board.id, skipped: true, reason: 'error' });
      continue;
    }

    if (!frames.length) {
      results.push({ boardId: entry.board.id, skipped: true, reason: 'empty' });
      continue;
    }

    const priority = frames[0].priority === 'alert' ? 'alert' : 'snapshot';
    const outcome = submit(entry.board.id, frames, {
      priority,
      scheduler,
      // Quiet hours: only alarm/timer fires get through, plus a caller that
      // opts in (Quiet Hours Reminder, Feature Presentation live, guests may
      // wake). Admin Push / Air now / a spoken ask are not exempt — the
      // checkbox says so, and a 2am flip is still a flip.
      quietHoursExempt: quietHoursExempt != null
        ? Boolean(quietHoursExempt)
        : undefined,
      coalesceKey: coalesceKeyFor(payload, type),
      replaceSource: (type === 'guest.book' || type === 'guest.book.invite')
        ? 'guest.book'
        : null,
      breakHold: breakHold != null
        ? Boolean(breakHold)
        : Boolean(explicit && !scheduler),
    });
    results.push({
      boardId: entry.board.id,
      skipped: !outcome?.ok,
      reason: outcome?.reason || (outcome?.ok ? 'posted' : 'rejected'),
      accepted: outcome?.accepted || 0,
    });
  }

  return results;
}

module.exports = {
  FORMATTERS,
  COMMAND_TO_TYPE,
  formatterFor,
  typeOf,
  matchBoards,
  isAllTarget,
  boardAllows,
  coalesceKeyFor,
  routeEvent,
};
