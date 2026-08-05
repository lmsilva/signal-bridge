/**
 * Single source of truth for every page the bridge can push to a display.
 *
 * Adding a command used to mean hand-editing four places — a payload builder,
 * the `switch (pathname)` in `web-server.js`, a `<button>` in `index.html` and
 * a click listener in `app.js` — with nothing keeping them in step. The Display
 * Scheduler needs to enumerate commands at runtime rather than hardcode them a
 * fifth time, so the list lives here and the admin Push grid, the scheduler
 * rule editor and `GET /api/commands` all read from it.
 *
 * Descriptors are pure data so they can be serialised straight to the client
 * and asserted in tests. Anything that needs live bridge state (a content
 * check, a variable duration) is registered separately in `createCommandRegistry`
 * and looked up by command id.
 */

const { estimateDuration: estimateOverheadDuration } = require('./overhead-settings');

/**
 * @typedef {Object} CommandDescriptor
 * @property {string} id            Dotted namespace, e.g. `steam.now-playing`.
 * @property {string} title         Shown on the push tile and in the scheduler.
 * @property {string} [subtitle]    Secondary line on the push tile.
 * @property {string} group         Groups tiles and the scheduler command picker.
 * @property {string} route         POST endpoint that fires it.
 * @property {string} [icon]        Key into the admin icon map; falls back to `group`.
 * @property {boolean} pushable     Render a one-tap tile in the admin Push tab.
 * @property {boolean} schedulable  Offer it in the Display Scheduler.
 * @property {Object} [body]        Extra POST body merged into the push request.
 * @property {Array} [params]       Param schema for the scheduler rule editor.
 * @property {boolean} supportsContentCheck
 * @property {boolean} variableDuration
 * @property {number|null} defaultDurationSeconds
 */

/** @type {CommandDescriptor[]} */
const COMMANDS = [
  {
    id: 'tesla.dashboard',
    title: 'Tesla Dashboard',
    subtitle: 'Map, climate, tires & more',
    group: 'Tesla',
    route: '/api/push/tesla-dashboard',
    icon: 'tesla-dashboard',
    pushable: true,
    schedulable: true,
    supportsContentCheck: false,
    variableDuration: false,
    defaultDurationSeconds: 120,
  },
  {
    id: 'tesla.battery',
    title: 'Tesla Battery',
    subtitle: 'Charge level & status',
    group: 'Tesla',
    route: '/api/push/tesla-battery',
    icon: 'tesla-battery',
    pushable: true,
    schedulable: true,
    supportsContentCheck: false,
    variableDuration: false,
    defaultDurationSeconds: 90,
  },
  {
    id: 'signal.slideshow',
    title: 'Shared Photo Slideshow',
    subtitle: 'Play every uploaded photo',
    group: 'Signal',
    route: '/api/push/photo-slideshow',
    icon: 'photo',
    pushable: true,
    schedulable: true,
    // The admin tile resolves `/api/photos` first; the scheduler asks the
    // bridge to do the same server-side.
    supportsContentCheck: true,
    variableDuration: false,
    defaultDurationSeconds: 180,
  },
  {
    id: 'alexa.weather',
    title: 'Weather Forecast',
    subtitle: 'Current conditions & outlook',
    group: 'Alexa',
    route: '/api/push/weather',
    icon: 'weather',
    pushable: true,
    schedulable: true,
    supportsContentCheck: false,
    variableDuration: false,
    defaultDurationSeconds: 60,
  },
  {
    id: 'alexa.shopping-list',
    title: 'Shopping List',
    subtitle: 'Everything on the list now',
    group: 'Alexa',
    route: '/api/push/shopping-list',
    icon: 'shopping-list',
    pushable: true,
    schedulable: true,
    supportsContentCheck: false,
    variableDuration: false,
    defaultDurationSeconds: 60,
  },
  {
    id: 'alexa.timers',
    title: 'Active Timers',
    subtitle: 'Everything running now',
    group: 'Alexa',
    route: '/api/push/timers',
    icon: 'timer',
    pushable: true,
    schedulable: true,
    supportsContentCheck: false,
    variableDuration: false,
    defaultDurationSeconds: 45,
  },
  {
    id: 'signal.guest-snaps',
    title: 'Guest Snaps',
    subtitle: 'Wi‑Fi + booth QR welcome',
    group: 'Signal',
    route: '/api/push/guest-photobooth',
    icon: 'guest-snaps',
    pushable: true,
    schedulable: true,
    supportsContentCheck: false,
    variableDuration: false,
    defaultDurationSeconds: 90,
  },
  {
    id: 'alexa.air-quality',
    title: 'Indoor Air Quality',
    subtitle: 'All monitors right now',
    group: 'Alexa',
    route: '/api/push/air-quality',
    icon: 'air-quality',
    pushable: true,
    schedulable: true,
    supportsContentCheck: false,
    variableDuration: false,
    defaultDurationSeconds: 60,
  },
  {
    id: 'alexa.now-playing',
    title: 'Now Playing',
    subtitle: 'Whatever Alexa is playing',
    group: 'Alexa',
    route: '/api/push/now-playing',
    icon: 'now-playing',
    pushable: true,
    schedulable: true,
    supportsContentCheck: false,
    variableDuration: false,
    defaultDurationSeconds: 60,
  },
  {
    id: 'alexa.alarms',
    title: 'Show Alarms',
    subtitle: 'Everything scheduled now',
    group: 'Alexa',
    route: '/api/push/alarms',
    icon: 'alarm',
    pushable: true,
    schedulable: true,
    supportsContentCheck: false,
    variableDuration: false,
    defaultDurationSeconds: 45,
  },
  {
    id: 'steam.now-playing',
    title: 'Steam',
    subtitle: 'Now playing, or last played',
    group: 'Steam',
    route: '/api/push/steam-now-playing',
    icon: 'steam',
    // No mode → push handler `auto`, same as the Settings test button.
    body: {},
    pushable: true,
    schedulable: true,
    supportsContentCheck: true,
    variableDuration: false,
    defaultDurationSeconds: 90,
  },
  {
    id: 'steam.last-played',
    title: 'Steam — last played',
    subtitle: 'The most recent game',
    group: 'Steam',
    route: '/api/push/steam-now-playing',
    icon: 'steam',
    body: { mode: 'last-played' },
    // Scheduler-only: the Push tab exposes one Steam tile that auto-picks.
    pushable: false,
    schedulable: true,
    supportsContentCheck: false,
    variableDuration: false,
    defaultDurationSeconds: 90,
  },
  {
    id: 'steam.library-tour',
    title: 'Steam Library Tour',
    subtitle: 'Walk the library — full game cards',
    group: 'Steam',
    route: '/api/push/steam-library-tour',
    icon: 'steam',
    pushable: true,
    schedulable: true,
    supportsContentCheck: true,
    variableDuration: true,
    defaultDurationSeconds: null,
    params: [
      {
        key: 'secondsPerGame',
        label: 'Seconds per game',
        type: 'number',
        min: 5,
        max: 300,
      },
    ],
  },
  {
    id: 'psn.now-playing',
    title: 'PSN',
    subtitle: 'Now playing, or last played',
    group: 'PSN',
    route: '/api/push/psn-now-playing',
    icon: 'psn',
    body: {},
    pushable: true,
    schedulable: true,
    supportsContentCheck: true,
    variableDuration: false,
    defaultDurationSeconds: 90,
  },
  {
    id: 'psn.last-played',
    title: 'PSN — last played',
    subtitle: 'The most recent game',
    group: 'PSN',
    route: '/api/push/psn-now-playing',
    icon: 'psn',
    body: { mode: 'last-played' },
    pushable: false,
    schedulable: true,
    supportsContentCheck: false,
    variableDuration: false,
    defaultDurationSeconds: 90,
  },
  {
    id: 'psn.library-tour',
    title: 'PSN Library Tour',
    subtitle: 'Walk the library — full game cards',
    group: 'PSN',
    route: '/api/push/psn-library-tour',
    icon: 'psn',
    pushable: true,
    schedulable: true,
    supportsContentCheck: true,
    variableDuration: true,
    defaultDurationSeconds: null,
    params: [
      {
        key: 'secondsPerGame',
        label: 'Seconds per game',
        type: 'number',
        min: 5,
        max: 300,
      },
    ],
  },
  {
    id: 'trivia.show',
    title: 'Trivia',
    subtitle: 'A short round of questions',
    group: 'Trivia',
    route: '/api/push/trivia',
    icon: 'trivia',
    pushable: true,
    schedulable: true,
    params: [
      { key: 'count', label: 'Questions', type: 'number', min: 1, max: 10 },
      {
        key: 'difficulty',
        label: 'Difficulty',
        type: 'enum',
        values: ['easy', 'medium', 'hard'],
      },
      { key: 'questionSeconds', label: 'Seconds per question', type: 'number', min: 2, max: 120 },
      { key: 'answerSeconds', label: 'Seconds per answer', type: 'number', min: 2, max: 120 },
    ],
    supportsContentCheck: true,
    // Multi-page command: the display must stay busy for the whole sequence,
    // so its duration is computed per invocation rather than fixed.
    variableDuration: true,
    defaultDurationSeconds: null,
  },
  {
    id: 'goodnews.show',
    title: 'The Upside News',
    subtitle: 'Positive headlines, then each story',
    group: 'News',
    route: '/api/push/upside-news',
    icon: 'news',
    pushable: true,
    schedulable: true,
    params: [
      {
        key: 'period',
        label: 'Period',
        type: 'enum',
        values: ['daily', 'weekly', 'monthly', 'yearly'],
      },
      { key: 'items', label: 'Stories', type: 'number', min: 3, max: 8 },
      { key: 'storySeconds', label: 'Seconds per story', type: 'number', min: 8, max: 30 },
    ],
    supportsContentCheck: true,
    variableDuration: true,
    defaultDurationSeconds: null,
  },
  {
    id: 'wiki.show',
    title: 'Wikipedia Common Knowledge',
    subtitle: 'Wikipedia most-read, then each article',
    group: 'Knowledge',
    route: '/api/push/wiki-common-knowledge',
    icon: 'wiki',
    pushable: true,
    schedulable: true,
    params: [
      {
        key: 'period',
        label: 'Period',
        type: 'enum',
        values: ['daily', 'weekly', 'monthly', 'yearly'],
      },
      { key: 'items', label: 'Articles', type: 'number', min: 3, max: 8 },
      { key: 'articleSeconds', label: 'Seconds per article', type: 'number', min: 8, max: 30 },
    ],
    supportsContentCheck: true,
    variableDuration: true,
    defaultDurationSeconds: null,
  },
  {
    id: 'overhead.show',
    title: 'Overhead',
    subtitle: 'Nearby aircraft on the scope',
    group: 'Sky',
    route: '/api/push/overhead',
    icon: 'sky',
    pushable: true,
    schedulable: true,
    params: [
      { key: 'radiusNm', label: 'Radius (nm)', type: 'number', min: 10, max: 150 },
      { key: 'pageSeconds', label: 'Seconds per page', type: 'number', min: 3, max: 60 },
      { key: 'maxPages', label: 'Max pages', type: 'number', min: 1, max: 12 },
      {
        key: 'sort',
        label: 'Sort',
        type: 'enum',
        values: ['nearest', 'altitude', 'callsign'],
      },
    ],
    supportsContentCheck: true,
    variableDuration: true,
    defaultDurationSeconds: null,
  },
  {
    id: 'youtube.now-playing',
    title: 'YouTube',
    subtitle: 'Now playing, or last played',
    group: 'YouTube',
    route: '/api/push/youtube-now-playing',
    icon: 'youtube',
    body: {},
    pushable: true,
    schedulable: true,
    supportsContentCheck: true,
    variableDuration: false,
    defaultDurationSeconds: 60,
  },
  {
    id: 'youtube.last-played',
    title: 'YouTube — last played',
    subtitle: 'The most recent video',
    group: 'YouTube',
    route: '/api/push/youtube-now-playing',
    icon: 'youtube',
    body: { mode: 'last-played' },
    pushable: false,
    schedulable: true,
    // Empty history used to look "ready" and Air now returned a cryptic 502.
    supportsContentCheck: true,
    variableDuration: false,
    defaultDurationSeconds: 60,
  },
];

const REQUIRED_KEYS = [
  'id', 'title', 'group', 'route',
  'pushable', 'schedulable', 'supportsContentCheck', 'variableDuration',
];

/** Throws on a malformed table so a typo fails at boot, not at air time. */
function assertValid(commands = COMMANDS) {
  const seen = new Set();
  for (const command of commands) {
    for (const key of REQUIRED_KEYS) {
      if (command[key] === undefined) {
        throw new Error(`Command "${command.id || '?'}" is missing "${key}"`);
      }
    }
    if (seen.has(command.id)) {
      throw new Error(`Duplicate command id: ${command.id}`);
    }
    seen.add(command.id);
    if (command.variableDuration && command.defaultDurationSeconds != null) {
      throw new Error(`Command "${command.id}" is variableDuration but sets defaultDurationSeconds`);
    }
    if (!command.variableDuration && !(command.defaultDurationSeconds > 0)) {
      throw new Error(`Command "${command.id}" needs a positive defaultDurationSeconds`);
    }
  }
  return true;
}

/**
 * Bind the static table to live bridge state.
 *
 * Every dependency is optional — an unwired feature simply reports no content,
 * which is the safe answer for a scheduler guard (`display-scheduler.md` §7.3:
 * showing an empty "now playing" panel is worse than showing nothing).
 */
function createCommandRegistry(deps = {}) {
  const {
    getSteamStatus = null,
    getPsnStatus = null,
    getSteamLibraryCount = null,
    getPsnLibraryCount = null,
    getLibraryTourSettings = null,
    getYoutubeStatus = null,
    getTriviaStatus = null,
    getUpsideNewsStatus = null,
    getWikiCommonKnowledgeStatus = null,
    getOverheadStatus = null,
    getPhotoCount = null,
    log = null,
  } = deps;

  function call(fn) {
    if (typeof fn !== 'function') {
      return null;
    }
    try {
      return fn();
    } catch (error) {
      log?.warn?.(`command-registry: status probe failed — ${error?.message || error}`);
      return null;
    }
  }

  /** id → () => boolean. Absent means "always has content". */
  const contentChecks = {
    'steam.now-playing': () => {
      const status = call(getSteamStatus);
      return Boolean(status?.session && !status.session.suppressed);
    },
    'steam.library-tour': () => Number(call(getSteamLibraryCount) || 0) > 0,
    'psn.now-playing': () => {
      const status = call(getPsnStatus);
      return Boolean(status?.session && !status.session.suppressed);
    },
    'psn.library-tour': () => Number(call(getPsnLibraryCount) || 0) > 0,
    'youtube.now-playing': () => {
      const status = call(getYoutubeStatus);
      return Boolean(status?.playing);
    },
    'youtube.last-played': () => {
      const status = call(getYoutubeStatus);
      return Boolean(status?.hasHistory || status?.lastPlayed);
    },
    'trivia.show': (params) => {
      const status = call(getTriviaStatus);
      if (!status) {
        return false;
      }
      const need = Number(params?.count) || Number(status.questionsPerSession) || 1;
      return Number(status.available ?? status.size ?? 0) >= need;
    },
    'goodnews.show': (params) => {
      const status = call(getUpsideNewsStatus);
      if (!status) {
        return false;
      }
      if (status.hasContent === false) {
        return false;
      }
      const need = Math.min(8, Math.max(3, Number(params?.items) || Number(status.settings?.items) || 5));
      return Number(status.available ?? 0) >= Math.min(3, need);
    },
    'wiki.show': (params) => {
      const status = call(getWikiCommonKnowledgeStatus);
      if (!status) {
        return false;
      }
      if (status.hasContent === false) {
        return false;
      }
      const need = Math.min(8, Math.max(3, Number(params?.items) || Number(status.settings?.items) || 5));
      return Number(status.available ?? 0) >= Math.min(3, need);
    },
    'overhead.show': () => {
      const status = call(getOverheadStatus);
      if (!status) {
        return false;
      }
      return Boolean(status.hasContent);
    },
    'signal.slideshow': () => Number(call(getPhotoCount) || 0) > 0,
  };

  /** id → (params) => seconds. Only needed for variableDuration commands. */
  const durationEstimators = {
    'trivia.show': (params) => {
      const status = call(getTriviaStatus) || {};
      const settings = status.settings || {};
      const num = (a, b, fallback) => {
        const value = Number(a ?? b);
        return Number.isFinite(value) && value > 0 ? value : fallback;
      };
      const count = Math.min(10, Math.max(1, Math.round(
        num(params?.count, settings.questionsPerSession, 5),
      )));
      const question = num(params?.questionSeconds, settings.questionSeconds, 15);
      const answer = num(params?.answerSeconds, settings.answerSeconds, 7);
      const intro = settings.showIntroCard === false ? 0 : num(null, settings.introSeconds, 4);
      const summary = settings.showSummaryCard === false || count < 2
        ? 0
        : num(null, settings.summarySeconds, 6);
      return Math.round(intro + count * (question + answer) + summary);
    },
    'goodnews.show': (params) => {
      const status = call(getUpsideNewsStatus) || {};
      const settings = status.settings || {};
      const items = Math.min(8, Math.max(3, Math.round(
        Number(params?.items ?? settings.items) || 5,
      )));
      const storySeconds = Math.min(30, Math.max(8, Math.round(
        Number(params?.storySeconds ?? settings.storySeconds) || 15,
      )));
      let indexSeconds = settings.indexSeconds;
      if (params?.indexSeconds != null) {
        indexSeconds = Number(params.indexSeconds);
      }
      if (!Number.isFinite(Number(indexSeconds))) {
        indexSeconds = Math.round(4 + 1.6 * items);
      }
      if (Number.isFinite(Number(status.cycleSeconds)) && !params?.items && !params?.storySeconds) {
        return Math.round(Number(status.cycleSeconds));
      }
      return Math.round(Number(indexSeconds) + items * storySeconds);
    },
    'wiki.show': (params) => {
      const status = call(getWikiCommonKnowledgeStatus) || {};
      const settings = status.settings || {};
      const items = Math.min(8, Math.max(3, Math.round(
        Number(params?.items ?? settings.items) || 5,
      )));
      const articleSeconds = Math.min(30, Math.max(8, Math.round(
        Number(params?.articleSeconds ?? settings.articleSeconds) || 15,
      )));
      let indexSeconds = settings.indexSeconds;
      if (params?.indexSeconds != null) {
        indexSeconds = Number(params.indexSeconds);
      }
      if (!Number.isFinite(Number(indexSeconds))) {
        indexSeconds = Math.round(4 + 1.6 * items);
      }
      if (Number.isFinite(Number(status.cycleSeconds)) && !params?.items && !params?.articleSeconds) {
        return Math.round(Number(status.cycleSeconds));
      }
      return Math.round(Number(indexSeconds) + items * articleSeconds);
    },
    'overhead.show': (params) => {
      const status = call(getOverheadStatus) || {};
      const settings = { ...(status.settings || {}), ...(params || {}) };
      const count = Number(status.aircraftInRange ?? status.hasContent ? 1 : 0) || 0;
      if (Number.isFinite(Number(status.estimatedDurationSeconds))
        && !params?.radiusNm
        && !params?.pageSeconds
        && !params?.maxPages) {
        return Math.round(Number(status.estimatedDurationSeconds));
      }
      const aircraftCount = Math.max(1, count);
      return Math.round(estimateOverheadDuration(settings, aircraftCount));
    },
    'steam.library-tour': (params) => {
      const count = Number(call(getSteamLibraryCount) || 0);
      const prefs = call(getLibraryTourSettings) || {};
      const seconds = Number(
        params?.secondsPerGame ?? prefs.steam?.secondsPerGame ?? prefs.secondsPerGame ?? 60,
      );
      if (!Number.isFinite(count) || count <= 0 || !Number.isFinite(seconds) || seconds <= 0) {
        return null;
      }
      return Math.round(count * seconds);
    },
    'psn.library-tour': (params) => {
      const count = Number(call(getPsnLibraryCount) || 0);
      const prefs = call(getLibraryTourSettings) || {};
      const seconds = Number(
        params?.secondsPerGame ?? prefs.psn?.secondsPerGame ?? prefs.secondsPerGame ?? 60,
      );
      if (!Number.isFinite(count) || count <= 0 || !Number.isFinite(seconds) || seconds <= 0) {
        return null;
      }
      return Math.round(count * seconds);
    },
  };

  function get(id) {
    return COMMANDS.find((command) => command.id === id) || null;
  }

  function hasContent(id, params = {}) {
    const check = contentChecks[id];
    if (typeof check !== 'function') {
      return true;
    }
    try {
      return Boolean(check(params));
    } catch (error) {
      log?.warn?.(`command-registry: hasContent(${id}) failed — ${error?.message || error}`);
      return false;
    }
  }

  function estimateDuration(id, params = {}) {
    const command = get(id);
    if (!command) {
      return null;
    }
    const estimator = durationEstimators[id];
    if (typeof estimator === 'function') {
      try {
        const seconds = Number(estimator(params));
        if (Number.isFinite(seconds) && seconds > 0) {
          return Math.round(seconds);
        }
      } catch (error) {
        log?.warn?.(`command-registry: estimateDuration(${id}) failed — ${error?.message || error}`);
      }
    }
    const override = Number(params?.displayDurationSeconds);
    if (Number.isFinite(override) && override > 0) {
      return Math.round(override);
    }
    return command.defaultDurationSeconds || null;
  }

  /** JSON-safe view for `GET /api/commands` and the admin UI. */
  function list({ pushableOnly = false, schedulableOnly = false } = {}) {
    return COMMANDS
      .filter((command) => (!pushableOnly || command.pushable))
      .filter((command) => (!schedulableOnly || command.schedulable))
      .map((command) => ({
        id: command.id,
        title: command.title,
        subtitle: command.subtitle || '',
        group: command.group,
        route: command.route,
        icon: command.icon || command.group.toLowerCase(),
        body: command.body || null,
        params: command.params || [],
        pushable: Boolean(command.pushable),
        schedulable: Boolean(command.schedulable),
        supportsContentCheck: Boolean(command.supportsContentCheck),
        variableDuration: Boolean(command.variableDuration),
        defaultDurationSeconds: command.defaultDurationSeconds ?? null,
        hasContent: command.supportsContentCheck ? hasContent(command.id) : true,
        estimatedDurationSeconds: estimateDuration(command.id),
      }));
  }

  return {
    commands: COMMANDS,
    get,
    list,
    hasContent,
    estimateDuration,
  };
}

module.exports = {
  COMMANDS,
  assertValid,
  createCommandRegistry,
};
