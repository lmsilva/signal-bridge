const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const { readAuthStatus } = require('./auth-status');
const { readTeslaAuthStatus } = require('./tesla-auth-status');
const { loadTeslaSession } = require('./tesla-session');
const { isFleetConfigured } = require('./tesla-fleet-client');
const { ensureWebTls } = require('./web-tls');
const {
  buildAuthorizeUrl,
  parseRedirect,
  resolveCallbackListen,
  isLoopbackHost,
  saveTokensFromCode,
  createRedirectCallbackServer,
} = require('./tesla-auth');
const {
  buildWebOpenPayload,
  buildWebClosePayload,
  buildSystemCommandPayload,
  buildDisplayDiscoverPayload,
  buildDisplayAuthPinPayload,
  buildDisplayAuthOkPayload,
  buildInputPointerPayload,
  buildInputKeyPayload,
  buildInputTextPayload,
  buildQrDisplayPayload,
  buildWifiQrContent,
  buildPhotoSlideshowPayload,
  buildGuestPhotoboothPayload,
  buildWeatherQueryPayload,
} = require('./udp-payload');
const {
  resolveGuestPhotoboothSettings,
  resolveBoothPushUrl,
  photosToSlideshowEntries,
} = require('./guest-photobooth');
const { createGuestSnapsAuth } = require('./guest-snaps-auth');
const { createGuestSnapsSettings } = require('./guest-snaps-settings');
const { getIndoorLocations } = require('./indoor-locations');
const { ALL_TARGET_ID } = require('./display-registry');
const {
  buildSteamAuthorizeUrl,
  publicOriginFromRequest,
  verifySteamOpenIdCallback,
  completeSteamLink,
  saveSteamApiKey,
  createSteamLinkPending,
  consumeSteamLinkPending,
} = require('./steam-auth');
const {
  resolveSteamCredentials,
  readSteamAuthStatus,
} = require('./steam-session');
const { fetchPlayerSummary } = require('./steam-api');
const {
  exchangeNpssoForSession,
} = require('./psn-api');
const {
  resolvePsnCredentials,
  savePsnSession,
  clearPsnSession,
  markPsnAuthStatus,
  clearPsnAuthStatus,
  readPsnAuthStatus,
} = require('./psn-session');
const { createDisplayControlAuth } = require('./display-control-auth');
const { createQrImageCache, parseThumbRouteTail } = require('./qr-image-cache');
const { createWebAdminAuth } = require('./web-admin-auth');
const { createHouseUsers, AVATAR_TEMPLATES } = require('./house-users');
const { createUserAudit } = require('./user-audit');
const { createGmailMailer } = require('./gmail-mailer');
const { createCommandRegistry } = require('./command-registry');
const {
  savePlexToken,
  defaultCredentialsPath,
  resolvePlexToken,
} = require('./plex-credentials');
const {
  loadNotificationsCache,
  buildReplayPayload,
  hasCachedNotification,
} = require('./notifications-cache');
const { createDisplayScheduler } = require('./display-scheduler');
const { normaliseTarget: normaliseSchedulerTarget } = require('./scheduler-rules');
const {
  CHAR_BY_CODE: VESTABOARD_CHAR_BY_CODE,
  CHIPS: VESTABOARD_CHIPS,
  drumOrder: vestaboardDrumOrder,
} = require('./vestaboard/encoder');
const { SIMULATOR_ID } = require('./vestaboard/settings');
const {
  ARTWORK_ROUTE_PREFIX: TRIVIA_ARTWORK_ROUTE_PREFIX,
} = require('./trivia-categories');
const {
  ARTWORK_ROUTE_PREFIX: UPSIDE_NEWS_ARTWORK_ROUTE_PREFIX,
} = require('./upside-news-categories');
const {
  ARTWORK_ROUTE_PREFIX: WIKI_ARTWORK_ROUTE_PREFIX,
} = require('./wiki-common-knowledge-categories');

/** Cached YouTube thumbnails and channel avatars, served from `data/`. */
const YOUTUBE_IMAGE_ROUTE_PREFIX = '/youtube-images/';
const FLIGHTPLAN_ARTWORK_ROUTE_PREFIX = '/flightplan-artwork/';
const {
  createSlideshowSettings,
  VALID_ORDERS,
  MIN_SECONDS_PER_PHOTO,
  MAX_SECONDS_PER_PHOTO,
  clampSecondsPerPhoto,
} = require('./slideshow-settings');
const {
  createLibraryTourSettings,
  VALID_SORTS,
  MIN_SECONDS_PER_GAME,
  MAX_SECONDS_PER_GAME,
  clampSecondsPerGame,
} = require('./library-tour-settings');
const { createRollCreditsService } = require('./roll-credits-service');
const { createRollCreditsPayload } = require('./roll-credits-payload');
const { createAutodartsService } = require('./autodarts-service');
const { createHuupeService } = require('./huupe-service');
const { createFlightplanService } = require('./flightplan-service');
const { filterLegsByAirport } = require('./flightplan-api');
const { createLocaleSettings } = require('./locale-settings');
const { createPublicUrlSettings, publicUrl, isUsableShortLinkOrigin } = require('./public-url');
const { createGuestBookSettings, sanitiseAlias, publicSettings } = require('./guest-book-settings');
const { createGuestBook, guestClientIp } = require('./guest-book');
const { createShortlinks, GUESTBOOK_NAME, GUESTBOOK_PATH, GUESTSNAPS_NAME, GUESTSNAPS_PATH, GAMES_NAME, GAMES_PATH } = require('./shortlinks');
const { houseTimeZone } = require('./vestaboard/clock');
const { labelFor: vestaboardSourceLabel } = require('./vestaboard/priorities');
const {
  defaultCredentialsPath: defaultTinyurlCredentialsPath,
  saveTinyurlToken,
  clearTinyurlToken,
  credentialsStatus: tinyurlCredentialsStatus,
} = require('./tinyurl-credentials');
const { createGameSettings } = require('./games/settings');
const { createGameArchive } = require('./games/archive');
const { createGameSessions, parseCookie: parseGamesCookie, cookieHeader: gamesCookieHeader } = require('./games/sessions');
const { fetchWeatherForecast, resolveHouseLocale } = require('./weather-fetch');
const { extractWeatherLocation } = require('./weather-location');
const { loadWeatherCache, saveWeatherCache } = require('./weather-cache');
const { buildWeeklyWeatherPayload } = require('./weekly-weather');
const { createLearnJapanese } = require('./learn-japanese');
const { createLearnLanguages, languageOf } = require('./learn-language');
const { createChuckNorris } = require('./chuck-norris');
const { createRoastMe } = require('./roast-me');
const { createFamilyQuotes } = require('./family-quotes');
const { createMisheardLyrics } = require('./misheard-lyrics');
const { createWarmFuzzies } = require('./warm-fuzzies');
const { createDailyBucketFillers } = require('./daily-bucket-fillers');
const { createPeriodicTable } = require('./periodic-table');
const { createUsStateFacts } = require('./us-state-facts');
const { createWordOfTheDay } = require('./word-of-the-day');
const { createDadJokes } = require('./dad-jokes');
const { createUsWeatherMap } = require('./us-weather-map');
const { createWordRiddles } = require('./word-riddles');
const { createAmazingFacts } = require('./amazing-facts');
const { createWorldGeographyFacts } = require('./world-geography-facts');
const { createConversationStarters } = require('./conversation-starters');
const { createStoicQuotes } = require('./stoic-quotes');
const { createOnThisDay } = require('./on-this-day');
const { createBakingInspiration } = require('./baking-inspiration');
const { createWorldPopulation } = require('./world-population');
const { createCalendarClock } = require('./calendar-clock');
const { createWordClock } = require('./word-clock');
const { createDateBook } = require('./date-book');
const { createRedLetter } = require('./red-letter');
const { createPlexTop10 } = require('./plex-top10');
const { createRingDoorbellService } = require('./ring-doorbell');
const { createWeatherAlerts } = require('./weather-alerts');
const { createStockMarket } = require('./stock-market');
const { createCurrencyRates } = require('./currency-rates');
const { createIssTracker } = require('./iss-tracker');
const { createStarlinkTracker } = require('./starlink-tracker');
const { createSpaceLaunchAlerts } = require('./space-launch-alerts');
const { createQuietHoursReminder } = require('./quiet-hours-reminder');

const DEFAULT_PORT = 47810;
const DEFAULT_HTTP_REDIRECT_PORT = 47811;
const MAX_BODY_BYTES = 64 * 1024;
// Uploaded photos travel as base64 JSON (~1.4x raw size) — cap the request
// body generously above qrImageCache.maxBytes so legitimate uploads never
// get rejected by the body-size guard before the cache's own size check runs.
const QR_IMAGE_BODY_OVERHEAD_FACTOR = 1.4;
const QR_IMAGE_BODY_PADDING_BYTES = 16 * 1024;
/** Cropped avatars are small, but allow headroom for uncropped uploads. */
const AVATAR_MAX_BYTES = 1_500_000;
const AVATAR_BODY_LIMIT = Math.ceil(AVATAR_MAX_BYTES * QR_IMAGE_BODY_OVERHEAD_FACTOR)
  + QR_IMAGE_BODY_PADDING_BYTES;
const URL_CHECK_TIMEOUT_MS = 5000;
// Tesla's OAuth callback server is opened on demand and must not hold the
// port forever when the user abandons the login.
const TESLA_CALLBACK_TIMEOUT_MS = 10 * 60 * 1000;
const RESTART_DELAY_MS = 4000;

// Placeholder in `src/web/admin/index.html` swapped for the Push tile catalog
// as the page is served. Keep the two in step.
const PUSH_CATALOG_TOKEN = '"__PUSH_CATALOG__"';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wav': 'audio/wav',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

/**
 * Hyphen URLs (`film-portrait`) and underscore uploads (`film_portrait`),
 * plus the American `theater` spelling used by some generator packs.
 */
function triviaArtworkStemVariants(stem) {
  const base = String(stem || '');
  const variants = [base];
  if (base.includes('-')) {
    variants.push(base.replace(/-(portrait|landscape)$/i, '_$1'));
  }
  if (base.includes('_')) {
    variants.push(base.replace(/_(portrait|landscape)$/i, '-$1'));
  }
  const aliases = [];
  for (const value of variants) {
    if (value.includes('musicals-theatre')) {
      aliases.push(value.replace('musicals-theatre', 'musicals-theater'));
    }
    if (value.includes('musicals-theater')) {
      aliases.push(value.replace('musicals-theater', 'musicals-theatre'));
    }
    if (value.includes('musicals_theatre')) {
      aliases.push(value.replace('musicals_theatre', 'musicals_theater'));
    }
    if (value.includes('musicals_theater')) {
      aliases.push(value.replace('musicals_theater', 'musicals_theatre'));
    }
  }
  return [...new Set([...variants, ...aliases])].filter(Boolean);
}

function validatePushUrl(url) {
  const trimmed = String(url || '').trim();
  if (!trimmed) {
    return { ok: false, error: 'URL is required' };
  }
  if (!/^https?:\/\//i.test(trimmed)) {
    return { ok: false, error: 'URL must start with http:// or https://' };
  }
  try {
    const parsed = new URL(trimmed);
    if (!parsed.hostname) {
      return { ok: false, error: 'URL is missing a host' };
    }
  } catch {
    return { ok: false, error: 'URL is not valid' };
  }
  return { ok: true, url: trimmed };
}

function resolveStaticPath(webRoot, urlPathname) {
  let pathname;
  try {
    pathname = decodeURIComponent(urlPathname || '/');
  } catch {
    return null;
  }
  if (pathname === '/' || pathname === '') {
    pathname = '/index.html';
  } else if (pathname === '/admin' || pathname === '/admin/') {
    pathname = '/admin/index.html';
  } else if (pathname === '/admin/login' || pathname === '/admin/login/') {
    pathname = '/admin/login.html';
  } else if (pathname === '/guestbook' || pathname === '/guestbook/') {
    pathname = '/guestbook/index.html';
  } else if (pathname === '/guestsnaps' || pathname === '/guestsnaps/') {
    pathname = '/guestsnaps/index.html';
  } else if (pathname === '/games' || pathname === '/games/') {
    pathname = '/games/index.html';
  } else if (pathname === '/user' || pathname === '/user/') {
    pathname = '/user/index.html';
  } else if (pathname === '/user/reset' || pathname === '/user/reset/') {
    pathname = '/user/reset.html';
  } else if (pathname === '/privacy' || pathname === '/privacy/') {
    pathname = '/privacy.html';
  } else if (pathname === '/terms' || pathname === '/terms/') {
    pathname = '/terms.html';
  }
  const resolved = path.normalize(path.join(webRoot, pathname));
  if (resolved !== webRoot && !resolved.startsWith(webRoot + path.sep)) {
    return null;
  }
  return resolved;
}

function isAdminHtmlPath(pathname) {
  return pathname === '/admin'
    || pathname === '/admin/'
    || pathname === '/admin/index.html';
}

function isUserHtmlPath(pathname) {
  return pathname === '/user'
    || pathname === '/user/'
    || pathname === '/user/index.html';
}

function isAdminLoginPath(pathname) {
  return pathname === '/admin/login'
    || pathname === '/admin/login/'
    || pathname === '/admin/login.html';
}

/**
 * Directory path for a control-page URL, always ending with `/`.
 * Used by the SPA `<base href>` so assets/API work at `/` or under a
 * reverse-proxy prefix (proxy strips the prefix before requests hit here).
 */
function computeWebBasePath(pathname) {
  let pathName = String(pathname || '/');
  if (!pathName.startsWith('/')) {
    pathName = `/${pathName}`;
  }
  if (/\/index\.html$/i.test(pathName)) {
    pathName = pathName.slice(0, -'index.html'.length);
  } else if (!pathName.endsWith('/')) {
    pathName += '/';
  }
  if (!pathName.endsWith('/')) {
    pathName += '/';
  }
  return pathName;
}

async function checkUrlReachable(url, timeoutMs = URL_CHECK_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        // Some sites block obvious non-browser agents; look like the WebView.
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      },
    });
    return {
      reachable: response.status >= 200 && response.status < 400,
      status: response.status,
    };
  } catch (error) {
    return { reachable: false, status: null, error: error?.message || String(error) };
  } finally {
    clearTimeout(timer);
  }
}

function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function indoorTemperatureQuickPushQuery(config = {}) {
  const locations = getIndoorLocations(config.indoorTemperature || {});
  const primary = locations[0];
  const name = String(primary?.entity || primary?.label || '').trim();
  if (name) {
    return `what's the temperature on the ${name}`;
  }
  return "what's the temperature inside";
}

function createWebServer({
  config,
  log,
  sendUdpPayload: sendUdpPayloadIn,
  recordVoiceEvent,
  displayRegistry = null,
  deliverTargetedPayload: deliverTargetedPayloadIn = null,
  requestTimerPoll = null,
  requestAlarmPoll = null,
  recordSteamPresence = null,
  getSteamStatus = null,
  steamNowPlaying = null,
  getPsnStatus = null,
  psnNowPlaying = null,
  getYoutubeStatus = null,
  youtubeNowPlaying = null,
  getPlexStatus = null,
  plexNowPlaying = null,
  getRingStatus = null,
  ringDoorbell = null,
  autodarts = null,
  getAutodartsStatus = null,
  huupe = null,
  getHuupeStatus = null,
  trivia = null,
  getTriviaStatus = null,
  upsideNews = null,
  getUpsideNewsStatus = null,
  wikiCommonKnowledge = null,
  getWikiCommonKnowledgeStatus = null,
  overhead = null,
  getOverheadStatus = null,
  flightplan = null,
  getFlightplanStatus = null,
  rollCredits = null,
  displayBusy = null,
  libraryTourSettings: libraryTourSettingsInjected = null,
  steamLibraryTour = null,
  psnLibraryTour = null,
  getSteamLibraryCount = null,
  getPsnLibraryCount = null,
  guestSnapsAuth: guestSnapsAuthInjected = null,
  vestaboardSimulator = null,
  vestaboardHub = null,
  scheduleRestart,
  webRoot,
  localeSettings: localeSettingsInjected = null,
  publicUrlSettings: publicUrlSettingsInjected = null,
  guestBookSettings: guestBookSettingsInjected = null,
  guestBook: guestBookInjected = null,
  guestSnapsSettings: guestSnapsSettingsInjected = null,
  gameSessions: gameSessionsInjected = null,
  shortlinks: shortlinksInjected = null,
  shortlinksFetch = null,
  shortlinksHealthIntervalMs = undefined,
} = {}) {
  let schedulerAir = null;
  let requestActor = null;

  function sendUdpPayload(payload, options = {}) {
    if (typeof sendUdpPayloadIn !== 'function') {
      return undefined;
    }
    return sendUdpPayloadIn(payload, {
      ...options,
      actor: options.actor || requestActor || undefined,
      ...(schedulerAir || {}),
    });
  }

  function deliverTargetedPayload(payload, targetId, extraSendOptions = {}) {
    const sendOptions = {
      ...extraSendOptions,
      actor: extraSendOptions.actor || requestActor || undefined,
      ...(schedulerAir || {}),
    };
    if (typeof deliverTargetedPayloadIn !== 'function') {
      return sendUdpPayload(payload, sendOptions);
    }
    return deliverTargetedPayloadIn(payload, targetId, sendOptions);
  }

  const settings = {
    enabled: config.webServer?.enabled !== false,
    // Allow port 0 (ephemeral) for tests — `Number(0) || DEFAULT` would wrongly use 47810.
    port: config.webServer?.port == null || config.webServer?.port === ''
      ? DEFAULT_PORT
      : Number(config.webServer.port),
    // HTTPS is on by default — live camera QR on iOS Chrome requires a secure context.
    https: config.webServer?.https !== false,
    httpRedirectPort: config.webServer?.httpRedirectPort == null
      ? DEFAULT_HTTP_REDIRECT_PORT
      : Number(config.webServer.httpRedirectPort),
  };
  const staticRoot = webRoot || path.join(__dirname, 'web');
  const controlAuth = createDisplayControlAuth(config, log);
  const houseUsers = createHouseUsers(config, log);
  houseUsers.ensureBootstrap();
  const userAudit = createUserAudit(config, log);
  const gmailMailer = createGmailMailer({ config, log });
  const adminAuth = createWebAdminAuth(config, log, { houseUsers });
  const avatarDir = path.resolve(config.ROOT || path.resolve(__dirname, '..'), 'data', 'user-avatars');
  const guestSnapsAuth = guestSnapsAuthInjected || createGuestSnapsAuth(config, log);
  const qrImageCache = createQrImageCache(config, log);
  // Existing camera-roll photos predate thumbnail support — fill them in the
  // background so the Slideshow tab does not download multi‑MB originals.
  if (typeof qrImageCache.backfillThumbnails === 'function') {
    Promise.resolve()
      .then(() => qrImageCache.backfillThumbnails())
      .catch((error) => {
        log.warn?.('QR image thumbnail backfill failed to start', error?.message || error);
      });
  }
  const slideshowSettings = createSlideshowSettings(config, log);
  const localeSettings = localeSettingsInjected || createLocaleSettings(config, log);
  const publicUrlSettings = publicUrlSettingsInjected || createPublicUrlSettings(config, log);
  const guestBookSettings = guestBookSettingsInjected || createGuestBookSettings(config, log);
  const guestSnapsSettings = guestSnapsSettingsInjected || createGuestSnapsSettings(config, log);
  const shortlinks = shortlinksInjected || createShortlinks(config, log, {
    fetchImpl: shortlinksFetch,
    healthIntervalMs: shortlinksHealthIntervalMs != null
      ? shortlinksHealthIntervalMs
      : (process.env.NODE_TEST_CONTEXT ? 0 : undefined),
  });
  const guestBook = guestBookInjected || createGuestBook(config, log, {
    getSettings: () => guestBookSettings.get(),
    getShortlink: () => shortlinks.status(GUESTBOOK_NAME),
    pushToBoard: (payload, options = {}) => {
      if (!vestaboardHub?.pushEvent) {
        return { boards: [] };
      }
      return vestaboardHub.pushEvent(payload, {
        targetId: 'vestaboard',
        quietHoursExempt: options.quietHoursExempt,
        explicit: options.explicit,
        breakHold: options.breakHold,
        replaceSource: options.replaceSource,
        actor: options.actor || requestActor,
      });
    },
    getTimeZone: () => localeSettings.get()?.timeZone || houseTimeZone(config),
    getQuietHours: () => {
      const boards = typeof vestaboardHub?.boards === 'function' ? vestaboardHub.boards() : [];
      return boards[0]?.quietHours || null;
    },
  });
  guestBook.start?.();
  const gameSettings = createGameSettings(config, log);
  const gameArchive = createGameArchive(config, log);
  const gameSessions = gameSessionsInjected || createGameSessions(config, log, {
    gameSettings,
    archive: gameArchive,
    getShortlink: (name) => shortlinks.status(name || GAMES_NAME),
    pushBoard: (payload, options = {}) => {
      if (!vestaboardHub?.pushEvent) {
        return { boards: [] };
      }
      return vestaboardHub.pushEvent(payload, options);
    },
    dropPendingBoard: (predicate) => vestaboardHub?.dropPending?.(predicate) || 0,
    setGameLock: (source, active) => vestaboardHub?.setGameLock?.(source, active),
  });
  const learnJapanese = createLearnJapanese(config, log);
  const learnLanguages = createLearnLanguages(config, log);
  const chuckNorris = createChuckNorris(config, log);
  const roastMe = createRoastMe(config, log);
  const familyQuotes = createFamilyQuotes(config, log);
  const misheardLyrics = createMisheardLyrics(config, log);
  const warmFuzzies = createWarmFuzzies(config, log);
  const dailyBucketFillers = createDailyBucketFillers(config, log);
  const periodicTable = createPeriodicTable(config, log);
  const usStateFacts = createUsStateFacts(config, log);
  const wordOfTheDay = createWordOfTheDay(config, log);
  const dadJokes = createDadJokes(config, log);
  const usWeatherMap = createUsWeatherMap(config, log, {
    getLocaleSettings: () => localeSettings.get(),
  });
  const wordRiddles = createWordRiddles(config, log);
  const amazingFacts = createAmazingFacts(config, log);
  const worldGeographyFacts = createWorldGeographyFacts(config, log);
  const conversationStarters = createConversationStarters(config, log);
  const stoicQuotes = createStoicQuotes(config, log);
  const onThisDay = createOnThisDay(config, log, {
    getLocaleSettings: () => localeSettings.get(),
  });
  const bakingInspiration = createBakingInspiration(config, log);
  const worldPopulation = createWorldPopulation(config, log);
  const calendarClock = createCalendarClock(config, log);
  const wordClock = createWordClock(config, log);
  const dateBook = createDateBook(config, log);
  const redLetter = createRedLetter(config, log, { dateBook });
  const plexTop10 = createPlexTop10(config, log, {
    // The Feature Presentation service already owns the server URL and the
    // encrypted token; Top 10 borrows both rather than reading them twice.
    resolvePlex: () => {
      const settings = plexService()?.settings?.get?.() || {};
      const { token } = resolvePlexToken({
        credentialsPath: config.plexCredentialsPath || defaultCredentialsPath(config.ROOT),
      });
      return { serverUrl: settings.serverUrl || '', token };
    },
  });
  const weatherAlerts = createWeatherAlerts(config, log);
  const stockMarket = createStockMarket(config, log);
  const currencyRates = createCurrencyRates(config, log);
  const issTracker = createIssTracker(config, log);
  const starlinkTracker = createStarlinkTracker(config, log);
  const spaceLaunchAlerts = createSpaceLaunchAlerts(config, log);
  spaceLaunchAlerts.ensureWarm();
  const ringDoorbellInstance = typeof ringDoorbell === 'function'
    ? ringDoorbell()
    : (ringDoorbell || createRingDoorbellService({
      config,
      log,
      sendUdpPayload,
      getTimeZone: () => localeSettings.get()?.timeZone || null,
    }));
  // Live ding/motion subscription is owned by the listener; the web server
  // only needs the same instance for Settings / preview / Push.
  const quietHoursReminder = createQuietHoursReminder({
    persistPath: config.quietHoursReminderPath
      || path.join(config.ROOT || path.resolve(__dirname, '..'), 'data', 'quiet-hours-reminder.json'),
  });
  const libraryTourSettings = libraryTourSettingsInjected || createLibraryTourSettings(config, log);
  const rollCreditsInstance = typeof rollCredits === 'function'
    ? rollCredits()
    : (rollCredits || createRollCreditsService({ config, log }));
  const rollCreditsPayload = createRollCreditsPayload({
    rollCredits: rollCreditsInstance,
    config,
  });
  const autodartsInstance = typeof autodarts === 'function'
    ? autodarts()
    : (autodarts || createAutodartsService({
      config,
      log,
      sendUdpPayload,
      displayBusy,
    }));

  const huupeInstance = typeof huupe === 'function'
    ? huupe()
    : (huupe || createHuupeService({
      config,
      log,
      sendUdpPayload,
      displayBusy,
    }));
  const flightplanInstance = typeof flightplan === 'function'
    ? flightplan()
    : (flightplan || createFlightplanService({
      config,
      log,
      sendUdpPayload,
    }));
  const commandRegistry = createCommandRegistry({
    log,
    getSteamStatus,
    getPsnStatus,
    getSteamLibraryCount: () => {
      if (typeof getSteamLibraryCount === 'function') {
        return getSteamLibraryCount();
      }
      return steamLibraryTourService()?.libraryCount?.() || 0;
    },
    getPsnLibraryCount: () => {
      if (typeof getPsnLibraryCount === 'function') {
        return getPsnLibraryCount();
      }
      return psnLibraryTourService()?.libraryCount?.() || 0;
    },
    getLibraryTourSettings: () => libraryTourSettings.get(),
    getRollCreditsStatus: () => ({
      ...rollCreditsInstance.statusSnapshot(),
      settings: rollCreditsInstance.getSettings(),
    }),
    getYoutubeStatus: () => getYoutubeStatus?.() || youtubeService()?.statusSnapshot?.() || null,
    getAutodartsStatus: () => getAutodartsStatus?.() || autodartsInstance.statusSnapshot?.() || null,
    getHuupeStatus: () => getHuupeStatus?.() || huupeInstance.statusSnapshot?.() || null,
    getTriviaStatus: () => getTriviaStatus?.() || triviaService()?.statusSnapshot?.() || null,
    getUpsideNewsStatus: () => getUpsideNewsStatus?.() || upsideNewsService()?.statusSnapshot?.() || null,
    getWikiCommonKnowledgeStatus: () => getWikiCommonKnowledgeStatus?.()
      || wikiCommonKnowledgeService()?.statusSnapshot?.()
      || null,
    getOverheadStatus: () => getOverheadStatus?.()
      || overheadService()?.statusSnapshot?.()
      || null,
    getFlightplanStatus: () => getFlightplanStatus?.()
      || flightplanService()?.statusSnapshot?.()
      || null,
    getPlexStatus: () => getPlexStatus?.()
      || plexService()?.statusSnapshot?.()
      || null,
    getPlexTop10Status: () => plexTop10.statusSnapshot(),
    getRedLetterStatus: () => redLetter.statusSnapshot(),
    getGuestBookStatus: () => guestBook.publicStatus(),
    getRingStatus: () => getRingStatus?.()
      || ringDoorbellInstance?.statusSnapshot?.()
      || null,
    getLocaleSettings: () => localeSettings.get(),
    getLearnJapaneseStatus: () => learnJapanese.statusSnapshot(),
    getLearnLanguageStatus: (commandId) => learnLanguages[commandId]?.statusSnapshot() || null,
    getChuckNorrisStatus: () => chuckNorris.statusSnapshot(),
    getRoastMeStatus: () => roastMe.statusSnapshot(),
    getFamilyQuotesStatus: () => familyQuotes.statusSnapshot(),
    getWarmFuzziesStatus: () => warmFuzzies.statusSnapshot(),
    getDailyBucketFillersStatus: () => dailyBucketFillers.statusSnapshot(),
    getMisheardLyricsStatus: () => misheardLyrics.statusSnapshot(),
    getPeriodicTableStatus: () => periodicTable.statusSnapshot(),
    getUsStateFactsStatus: () => usStateFacts.statusSnapshot(),
    getWordOfTheDayStatus: () => wordOfTheDay.statusSnapshot(),
    getDadJokesStatus: () => dadJokes.statusSnapshot(),
    getUsWeatherMapStatus: () => usWeatherMap.statusSnapshot(),
    getWordRiddlesStatus: () => wordRiddles.statusSnapshot(),
    getScrambleInviteStatus: () => ({
      inviteReady: Boolean(shortlinks.status(GAMES_NAME)?.alias),
    }),
    getAmazingFactsStatus: () => amazingFacts.statusSnapshot(),
    getWorldGeographyFactsStatus: () => worldGeographyFacts.statusSnapshot(),
    getConversationStartersStatus: () => conversationStarters.statusSnapshot(),
    getStoicQuotesStatus: () => stoicQuotes.statusSnapshot(),
    getOnThisDayStatus: () => onThisDay.statusSnapshot(),
    getBakingInspirationStatus: () => bakingInspiration.statusSnapshot(),
    getStockMarketStatus: () => stockMarket.statusSnapshot(),
    getCurrencyRatesStatus: () => currencyRates.statusSnapshot(localeSettings.get()),
    getSpaceLaunchAlertsStatus: () => spaceLaunchAlerts.statusSnapshot(),
    getPhotoCount: () => qrImageCache.list().length,
    getNotificationsCacheStatus: () => ({
      hasContent: hasCachedNotification(loadNotificationsCache(config)),
    }),
  });
  let server = null;
  let redirectServer = null;

  // Best-effort browser state: UDP is one-way, so this reflects the last
  // command we sent, not ground truth from the display PC.
  let activeWebPush = null;

  const teslaAuth = {
    running: false,
    status: null,
    authorizeUrl: null,
    redirectUri: null,
    error: null,
    startedAt: null,
    server: null,
    timeoutTimer: null,
    pendingState: null,
    // When redirect URI is a public domain (Apache proxy), keep :4381 listening
    // so the proxy never sees "connection refused" between login attempts.
    persistent: false,
  };

  const steamAuth = {
    running: false,
    status: null,
    authorizeUrl: null,
    error: null,
    startedAt: null,
  };

  function presenceSecretOk(provided) {
    const steam = config.steam || {};
    const expected = String(
      steam.presenceSecret
      || steam.apiKey
      || resolveSteamCredentials(steam).apiKey
      || '',
    ).trim();
    if (!expected) {
      return false;
    }
    return String(provided || '').trim() === expected;
  }

  function handleSteamPresence(req, body, res) {
    if (typeof recordSteamPresence !== 'function') {
      sendJson(res, 503, { ok: false, error: 'Steam presence unavailable — listener not ready' });
      return;
    }
    const secret = body?.secret
      || req.headers['x-steam-presence-secret']
      || req.headers['x-presence-secret'];
    const adminOk = adminAuth.assertAuthorized(req).ok;
    if (!adminOk && !presenceSecretOk(secret)) {
      sendJson(res, 401, { ok: false, error: 'Unauthorized presence heartbeat' });
      return;
    }
    const result = recordSteamPresence({
      hostname: body?.hostname || body?.host,
      appId: body?.appId || body?.appid || body?.gameId,
    });
    if (!result?.ok) {
      sendJson(res, 400, { ok: false, error: result?.error || 'Invalid presence' });
      return;
    }
    sendJson(res, 202, { ok: true, presence: result.entry });
  }

  async function handleSteamAuthStart(req, res) {
    const steam = config.steam || {};
    try {
      const publicOrigin = publicOriginFromRequest(req, config);
      const state = createSteamLinkPending();
      const authorizeUrl = buildSteamAuthorizeUrl(config, steam, publicOrigin, { state });
      steamAuth.running = true;
      steamAuth.status = 'waiting';
      steamAuth.error = null;
      steamAuth.authorizeUrl = authorizeUrl;
      steamAuth.startedAt = new Date().toISOString();
      sendJson(res, 200, { ok: true, authorizeUrl });
    } catch (error) {
      steamAuth.status = 'error';
      steamAuth.error = error?.message || String(error);
      sendJson(res, 500, { ok: false, error: steamAuth.error });
    }
  }

  async function handleSteamAuthCallback(reqUrl, res) {
    const query = Object.fromEntries(reqUrl.searchParams.entries());
    const fail = (message) => {
      steamAuth.status = 'error';
      steamAuth.error = message || 'Steam link failed';
      steamAuth.running = false;
      // Admin UI reads ?steam= and opens the Settings tab (Auth card).
      res.writeHead(302, { Location: '/admin/?steam=error' });
      res.end();
    };
    try {
      // State may arrive as a top-level query param (return_to?state=…) or only
      // inside openid.return_to depending on the OpenID RP redirect shape.
      let state = String(query.state || '').trim();
      if (!state) {
        try {
          const returnTo = String(query['openid.return_to'] || '');
          state = new URL(returnTo).searchParams.get('state') || '';
        } catch {
          state = '';
        }
      }
      if (!consumeSteamLinkPending(state)) {
        fail('Steam link state missing or expired — start linking again from Auth');
        return;
      }

      const verified = await verifySteamOpenIdCallback(query);
      if (!verified.ok) {
        fail(verified.error);
        return;
      }
      let personaName = null;
      try {
        const creds = resolveSteamCredentials(config.steam || {});
        if (creds.apiKey) {
          const summary = await fetchPlayerSummary(creds.apiKey, verified.steamId);
          personaName = summary?.personaName || null;
        }
      } catch {
        // optional enrichment
      }
      completeSteamLink(config.steam, {
        steamId: verified.steamId,
        personaName,
      });
      steamAuth.status = 'success';
      steamAuth.running = false;
      steamAuth.error = null;
      // Kick an immediate poll if the poller is up.
      try {
        const controller = typeof steamNowPlaying === 'function' ? steamNowPlaying() : steamNowPlaying;
        controller?.tick?.();
      } catch {
        // ignore
      }
      // Admin UI reads ?steam= and opens the Settings tab (Auth card).
      res.writeHead(302, { Location: '/admin/?steam=ok' });
      res.end();
    } catch (error) {
      fail(error?.message || String(error));
    }
  }

  function handleSteamApiKeySave(body, res) {
    const apiKey = String(body?.apiKey || '').trim();
    if (apiKey.length < 8) {
      sendJson(res, 400, { ok: false, error: 'API key looks too short' });
      return;
    }
    const envKey = String(process.env.STEAM_API_KEY || '').trim();
    if (envKey) {
      sendJson(res, 409, {
        ok: false,
        error: 'STEAM_API_KEY is already set in .env and takes precedence. '
          + 'Update or remove it in .env — this screen does not rewrite .env.',
        source: 'env',
      });
      return;
    }
    // Session file only (data/steam-session.json) — never writes .env.
    saveSteamApiKey(config.steam, apiKey);
    sendJson(res, 200, { ok: true, source: 'session' });
  }

  async function handleSteamNowPlayingPush(body, res) {
    const controller = typeof steamNowPlaying === 'function' ? steamNowPlaying() : steamNowPlaying;
    if (!controller?.pushManualPreview) {
      sendJson(res, 503, { ok: false, error: 'Steam Now Playing is not available' });
      return;
    }
    const targetId = targetIdFrom(body);
    if (typeof displayRegistry?.resolveDelivery === 'function') {
      const delivery = displayRegistry.resolveDelivery(targetId);
      if (delivery.error && !delivery.isAll) {
        sendJson(res, 404, { ok: false, error: delivery.error });
        return;
      }
    }
    try {
      const result = await controller.pushManualPreview({
        device: deviceFrom(body),
        requestedMode: previewModeFrom(body),
        send: (payload) => {
          if (typeof deliverTargetedPayload === 'function') {
            return deliverTargetedPayload(payload, targetId);
          }
          return sendUdpPayload(payload);
        },
      });
      if (!result?.ok) {
        sendJson(res, 400, { ok: false, error: result?.error || 'Steam preview failed' });
        return;
      }
      log.info('Steam Now Playing manual preview', {
        mode: result.mode,
        appId: result.appId,
        name: result.name,
        targetId,
      });
      sendJson(res, 200, { ok: true, ...result, targetId });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error?.message || String(error) });
    }
  }

  async function handlePsnAuthLink(body, res) {
    const npsso = String(body?.npsso || body?.NPSSO || '').trim();
    if (!npsso) {
      sendJson(res, 400, { ok: false, error: 'Paste your NPSSO cookie value' });
      return;
    }
    try {
      const tokens = await exchangeNpssoForSession(npsso);
      const existing = resolvePsnCredentials(config.psn).session || {};
      const session = savePsnSession(config.psn.sessionPath, {
        ...existing,
        ...tokens,
        // Never persist the NPSSO itself.
        linkedAt: new Date().toISOString(),
      });
      clearPsnAuthStatus(config.psn);
      markPsnAuthStatus(config.psn, {
        status: 'ok',
        message: 'PSN linked via NPSSO',
      });
      log.info('PSN account linked via NPSSO');
      sendJson(res, 200, {
        ok: true,
        linkedAt: session.linkedAt,
        expiresAt: session.expiresAt || null,
      });
    } catch (error) {
      const message = error?.message || String(error);
      markPsnAuthStatus(config.psn, { status: 'auth_error', message });
      sendJson(res, 400, { ok: false, error: message });
    }
  }

  function handlePsnAuthClear(_body, res) {
    try {
      clearPsnSession(config.psn?.sessionPath);
      clearPsnAuthStatus(config.psn);
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error?.message || String(error) });
    }
  }

  async function handlePsnNowPlayingPush(body, res) {
    const controller = typeof psnNowPlaying === 'function' ? psnNowPlaying() : psnNowPlaying;
    if (!controller?.pushManualPreview) {
      sendJson(res, 503, { ok: false, error: 'PSN Now Playing is not available' });
      return;
    }
    const targetId = targetIdFrom(body);
    if (typeof displayRegistry?.resolveDelivery === 'function') {
      const delivery = displayRegistry.resolveDelivery(targetId);
      if (delivery.error && !delivery.isAll) {
        sendJson(res, 404, { ok: false, error: delivery.error });
        return;
      }
    }
    try {
      const result = await controller.pushManualPreview({
        device: deviceFrom(body),
        requestedMode: previewModeFrom(body),
        send: (payload) => {
          if (typeof deliverTargetedPayload === 'function') {
            return deliverTargetedPayload(payload, targetId);
          }
          return sendUdpPayload(payload);
        },
      });
      if (!result?.ok) {
        sendJson(res, 400, { ok: false, error: result?.error || 'PSN preview failed' });
        return;
      }
      log.info('PSN Now Playing manual preview', {
        mode: result.mode,
        titleId: result.titleId,
        name: result.name,
        targetId,
      });
      sendJson(res, 200, { ok: true, ...result, targetId });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error?.message || String(error) });
    }
  }

  const alexaAuth = {
    running: false,
    status: null,
    proxyUrl: null,
    error: null,
    startedAt: null,
    restartScheduled: false,
  };

  const requestRestart = scheduleRestart || (() => {
    log.info(`Bridge will restart in ${RESTART_DELAY_MS / 1000}s to pick up the new Alexa session`);
    setTimeout(() => process.exit(0), RESTART_DELAY_MS);
  });

  function sendJson(res, statusCode, body) {
    const data = JSON.stringify(body);
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  }

  function deviceFrom(body) {
    const device = String(body?.device || '').trim();
    return device || 'Signal';
  }

  function targetIdFrom(body) {
    if (body?.targetId == null || body.targetId === '') {
      return ALL_TARGET_ID;
    }
    return String(body.targetId).trim();
  }

  /* ------------------------------------------------------------------ Trivia */

  function triviaService() {
    return typeof trivia === 'function' ? trivia() : trivia;
  }

  function upsideNewsService() {
    return typeof upsideNews === 'function' ? upsideNews() : upsideNews;
  }

  function wikiCommonKnowledgeService() {
    return typeof wikiCommonKnowledge === 'function' ? wikiCommonKnowledge() : wikiCommonKnowledge;
  }

  function overheadService() {
    return typeof overhead === 'function' ? overhead() : overhead;
  }

  function flightplanService() {
    return typeof flightplan === 'function' ? flightplan() : flightplan;
  }

  function upsideNewsOverridesFrom(body = {}) {
    const overrides = {};
    if (body.period != null) overrides.period = body.period;
    if (body.items != null) overrides.items = body.items;
    if (body.indexSeconds != null) overrides.indexSeconds = body.indexSeconds;
    if (body.storySeconds != null) overrides.storySeconds = body.storySeconds;
    if (body.loops != null) overrides.loops = body.loops;
    return overrides;
  }

  function handleUpsideNewsStatus(res) {
    const service = upsideNewsService();
    if (!service) {
      sendJson(res, 503, { ok: false, error: 'The Upside News is not available' });
      return;
    }
    sendJson(res, 200, { ok: true, ...service.statusSnapshot() });
  }

  function handleUpsideNewsSettingsGet(res) {
    const service = upsideNewsService();
    if (!service) {
      sendJson(res, 503, { ok: false, error: 'The Upside News is not available' });
      return;
    }
    sendJson(res, 200, { ok: true, settings: service.settings.get() });
  }

  function handleUpsideNewsSettingsPut(body, res) {
    const service = upsideNewsService();
    if (!service) {
      sendJson(res, 503, { ok: false, error: 'The Upside News is not available' });
      return;
    }
    try {
      const settings = service.settings.update(body || {});
      sendJson(res, 200, {
        ok: true,
        settings,
        cycleSeconds: service.statusSnapshot().cycleSeconds,
      });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error?.message || String(error) });
    }
  }

  async function handleUpsideNewsApiKeySave(body, res) {
    const service = upsideNewsService();
    if (!service) {
      sendJson(res, 503, { ok: false, error: 'The Upside News is not available' });
      return;
    }
    const apiKey = String(body?.apiKey || '').trim();
    if (apiKey.length < 8) {
      sendJson(res, 400, { ok: false, error: 'API key looks too short' });
      return;
    }
    const result = await service.saveApiKey(apiKey);
    if (!result.ok) {
      sendJson(res, result.source === 'env' ? 409 : 400, result);
      return;
    }
    sendJson(res, 200, result);
  }

  async function handleUpsideNewsApiKeyTest(body, res) {
    const service = upsideNewsService();
    if (!service) {
      sendJson(res, 503, { ok: false, error: 'The Upside News is not available' });
      return;
    }
    const result = await service.testKey(body?.apiKey);
    sendJson(res, result.ok ? 200 : 400, result);
  }

  async function handleUpsideNewsArchivePoll(res) {
    const service = upsideNewsService();
    if (!service) {
      sendJson(res, 503, { ok: false, error: 'The Upside News is not available' });
      return;
    }
    sendJson(res, 202, { ok: true, started: true });
    service.archive.poll({ force: true }).catch((error) => {
      log.warn('Upside News archive poll failed', error?.message || error);
    });
  }

  function handleUpsideNewsStories(query, res) {
    const service = upsideNewsService();
    if (!service) {
      sendJson(res, 503, { ok: false, error: 'The Upside News is not available' });
      return;
    }
    const overrides = {};
    if (query.get('period')) overrides.period = query.get('period');
    if (query.get('limit')) overrides.items = Number(query.get('limit'));
    const stories = service.archive.selectStories(overrides);
    sendJson(res, 200, { ok: true, stories, count: stories.length });
  }

  function handleUpsideNewsPush(body, res) {
    const service = upsideNewsService();
    if (!service) {
      sendJson(res, 503, { ok: false, error: 'The Upside News is not available' });
      return;
    }
    const targetId = targetIdFrom(body);
    if (typeof displayRegistry?.resolveDelivery === 'function') {
      const delivery = displayRegistry.resolveDelivery(targetId);
      if (delivery.error && !delivery.isAll) {
        sendJson(res, 404, { ok: false, error: delivery.error });
        return;
      }
    }
    const result = service.push(upsideNewsOverridesFrom(body), {
      device: deviceFrom(body),
      triggeredBy: String(body?.triggeredBy || 'manual'),
      send: (payload) => {
        if (typeof deliverTargetedPayload === 'function') {
          return deliverTargetedPayload(payload, targetId);
        }
        return sendUdpPayload(payload);
      },
    });
    if (!result.ok) {
      sendJson(res, 400, result);
      return;
    }
    sendJson(res, 202, { ...result, targetId });
  }

  /* -------------------------------------------------- Wiki Common Knowledge */

  function wikiOverridesFrom(body = {}) {
    const overrides = {};
    if (body.period != null) overrides.period = body.period;
    if (body.items != null) overrides.items = body.items;
    if (body.indexSeconds != null) overrides.indexSeconds = body.indexSeconds;
    if (body.articleSeconds != null) overrides.articleSeconds = body.articleSeconds;
    if (body.loops != null) overrides.loops = body.loops;
    return overrides;
  }

  function handleWikiStatus(res) {
    const service = wikiCommonKnowledgeService();
    if (!service) {
      sendJson(res, 503, { ok: false, error: 'Wiki Common Knowledge is not available' });
      return;
    }
    sendJson(res, 200, { ok: true, ...service.statusSnapshot() });
  }

  function handleWikiSettingsGet(res) {
    const service = wikiCommonKnowledgeService();
    if (!service) {
      sendJson(res, 503, { ok: false, error: 'Wiki Common Knowledge is not available' });
      return;
    }
    sendJson(res, 200, { ok: true, settings: service.settings.get() });
  }

  function handleWikiSettingsPut(body, res) {
    const service = wikiCommonKnowledgeService();
    if (!service) {
      sendJson(res, 503, { ok: false, error: 'Wiki Common Knowledge is not available' });
      return;
    }
    try {
      const settings = service.settings.update(body || {});
      sendJson(res, 200, {
        ok: true,
        settings,
        cycleSeconds: service.statusSnapshot().cycleSeconds,
      });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error?.message || String(error) });
    }
  }

  async function handleWikiTest(res) {
    const service = wikiCommonKnowledgeService();
    if (!service) {
      sendJson(res, 503, { ok: false, error: 'Wiki Common Knowledge is not available' });
      return;
    }
    const result = await service.testConnection();
    sendJson(res, result.ok ? 200 : 400, result);
  }

  async function handleWikiCachePoll(res) {
    const service = wikiCommonKnowledgeService();
    if (!service) {
      sendJson(res, 503, { ok: false, error: 'Wiki Common Knowledge is not available' });
      return;
    }
    sendJson(res, 202, { ok: true, started: true });
    service.cache.poll({ force: true }).catch((error) => {
      log.warn('Wiki Common Knowledge poll failed', error?.message || error);
    });
  }

  async function handleWikiBackfill(body, res) {
    const service = wikiCommonKnowledgeService();
    if (!service) {
      sendJson(res, 503, { ok: false, error: 'Wiki Common Knowledge is not available' });
      return;
    }
    const days = Math.max(1, Math.min(30, Number(body?.days) || 7));
    sendJson(res, 202, { ok: true, started: true, days });
    service.cache.backfill(days).catch((error) => {
      log.warn('Wiki Common Knowledge backfill failed', error?.message || error);
    });
  }

  function handleWikiPush(body, res) {
    const service = wikiCommonKnowledgeService();
    if (!service) {
      sendJson(res, 503, { ok: false, error: 'Wiki Common Knowledge is not available' });
      return;
    }
    const targetId = targetIdFrom(body);
    if (typeof displayRegistry?.resolveDelivery === 'function') {
      const delivery = displayRegistry.resolveDelivery(targetId);
      if (delivery.error && !delivery.isAll) {
        sendJson(res, 404, { ok: false, error: delivery.error });
        return;
      }
    }
    const result = service.push(wikiOverridesFrom(body), {
      device: deviceFrom(body),
      triggeredBy: String(body?.triggeredBy || 'manual'),
      send: (payload) => {
        if (typeof deliverTargetedPayload === 'function') {
          return deliverTargetedPayload(payload, targetId);
        }
        return sendUdpPayload(payload);
      },
    });
    if (!result.ok) {
      sendJson(res, 400, result);
      return;
    }
    sendJson(res, 202, { ...result, targetId });
  }

  /* -------------------------------------------------- Overhead (flight radar) */

  function overheadOverridesFrom(body = {}) {
    const overrides = {};
    if (body.radiusNm != null) overrides.radiusNm = body.radiusNm;
    if (body.refreshSeconds != null) overrides.refreshSeconds = body.refreshSeconds;
    if (body.rowsPerPage != null) overrides.rowsPerPage = body.rowsPerPage;
    if (body.pageSeconds != null) overrides.pageSeconds = body.pageSeconds;
    if (body.maxPages != null) overrides.maxPages = body.maxPages;
    if (body.loops != null) overrides.loops = body.loops;
    if (body.sort != null) overrides.sort = body.sort;
    if (body.altitudeFloorFt != null) overrides.altitudeFloorFt = body.altitudeFloorFt;
    if (body.includeGround != null) overrides.includeGround = body.includeGround;
    if (body.showRoutes != null) overrides.showRoutes = body.showRoutes;
    if (body.provider != null) overrides.provider = body.provider;
    if (body.localReceiverUrl != null) overrides.localReceiverUrl = body.localReceiverUrl;
    if (body.mapStyle != null) overrides.mapStyle = body.mapStyle;
    return overrides;
  }

  function handleOverheadStatus(res) {
    const service = overheadService();
    if (!service) {
      sendJson(res, 503, { ok: false, error: 'Overhead is not available' });
      return;
    }
    sendJson(res, 200, { ok: true, ...service.statusSnapshot() });
  }

  function handleOverheadSettingsGet(res) {
    const service = overheadService();
    if (!service) {
      sendJson(res, 503, { ok: false, error: 'Overhead is not available' });
      return;
    }
    sendJson(res, 200, { ok: true, settings: service.settings.get() });
  }

  function handleOverheadSettingsPut(body, res) {
    const service = overheadService();
    if (!service) {
      sendJson(res, 503, { ok: false, error: 'Overhead is not available' });
      return;
    }
    try {
      const next = service.settings.update(body || {});
      sendJson(res, 200, {
        ok: true,
        settings: next,
        cycleSeconds: service.statusSnapshot().cycleSeconds,
        estimatedDurationSeconds: service.statusSnapshot().estimatedDurationSeconds,
      });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error?.message || String(error) });
    }
  }

  async function handleOverheadProviderTest(body, res) {
    const service = overheadService();
    if (!service) {
      sendJson(res, 503, { ok: false, error: 'Overhead is not available' });
      return;
    }
    const result = await service.testProvider(overheadOverridesFrom(body));
    sendJson(res, result.ok ? 200 : 400, result);
  }

  async function handleOverheadPush(body, res) {
    const service = overheadService();
    if (!service) {
      sendJson(res, 503, { ok: false, error: 'Overhead is not available' });
      return;
    }
    const targetId = targetIdFrom(body);
    if (typeof displayRegistry?.resolveDelivery === 'function') {
      const delivery = displayRegistry.resolveDelivery(targetId);
      if (delivery.error && !delivery.isAll) {
        sendJson(res, 404, { ok: false, error: delivery.error });
        return;
      }
    }
    try {
      const result = await service.push(overheadOverridesFrom(body), {
        device: deviceFrom(body),
        triggeredBy: String(body?.triggeredBy || 'manual'),
        send: (payload) => {
          if (typeof deliverTargetedPayload === 'function') {
            return deliverTargetedPayload(payload, targetId);
          }
          return sendUdpPayload(payload);
        },
      });
      if (!result.ok) {
        sendJson(res, 400, result);
        return;
      }
      sendJson(res, 202, { ...result, targetId });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error?.message || String(error) });
    }
  }

  function handleOverheadClose(body, res) {
    const service = overheadService();
    if (!service) {
      sendJson(res, 503, { ok: false, error: 'Overhead is not available' });
      return;
    }
    const result = service.closeSession(String(body?.reason || 'manual'));
    sendJson(res, 200, result);
  }

  function handleFlightplanStatus(res) {
    const service = flightplanService();
    if (!service) {
      sendJson(res, 503, { ok: false, error: 'Flight Plan is not available' });
      return;
    }
    sendJson(res, 200, { ok: true, ...service.statusSnapshot() });
  }

  function handleFlightplanSettingsGet(res) {
    const service = flightplanService();
    if (!service) {
      sendJson(res, 503, { ok: false, error: 'Flight Plan is not available' });
      return;
    }
    sendJson(res, 200, { ok: true, settings: service.settings.get() });
  }

  async function handleFlightplanSettingsPut(body, res) {
    const service = flightplanService();
    if (!service) {
      sendJson(res, 503, { ok: false, error: 'Flight Plan is not available' });
      return;
    }
    if (body?.rapidApiKey) {
      try {
        const saved = await service.saveApiKey(body.rapidApiKey);
        if (!saved.ok) {
          sendJson(res, 402, saved);
          return;
        }
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error?.message || String(error) });
        return;
      }
    }
    const patch = { ...body };
    delete patch.rapidApiKey;
    if (patch.homeAirport != null) {
      patch.homeAirport = service.resolveAirportCode(patch.homeAirport);
    }
    const result = service.settings.update(patch);
    sendJson(res, 200, result);
  }

  function handleFlightplanAirports(query, res) {
    const service = flightplanService();
    if (!service) {
      sendJson(res, 503, { ok: false, error: 'Flight Plan is not available' });
      return;
    }
    const q = String(query.get('q') || '').trim();
    sendJson(res, 200, { ok: true, airports: service.searchAirports(q) });
  }

  async function handleFlightplanPushNext(body, res) {
    const service = flightplanService();
    if (!service) {
      sendJson(res, 503, { ok: false, error: 'Flight Plan is not available' });
      return;
    }
    const targetId = targetIdFrom(body);
    const result = await service.pushNext({
      tripId: body?.tripId || null,
      send: (payload, options = {}) => deliverTargetedPayload(payload, targetId, {
        source: 'manual',
        commandId: 'flightplan.next',
        ...options,
      }),
    });
    sendJson(res, result.ok ? 202 : 400, { ...result, targetId });
  }

  async function handleFlightplanPushBoard(body, res) {
    const service = flightplanService();
    if (!service) {
      sendJson(res, 503, { ok: false, error: 'Flight Plan is not available' });
      return;
    }
    const targetId = targetIdFrom(body);
    const result = await service.pushBoard({
      tripId: body?.tripId,
      send: (payload, options = {}) => deliverTargetedPayload(payload, targetId, {
        source: 'manual',
        commandId: 'flightplan.board',
        ...options,
      }),
    });
    sendJson(res, result.ok ? 202 : 400, { ...result, targetId });
  }

  async function handleFlightplanApi(method, pathname, body, res, query) {
    const service = flightplanService();
    if (!service) {
      sendJson(res, 503, { ok: false, error: 'Flight Plan is not available' });
      return;
    }
    const tail = pathname.slice('/api/flightplan/'.length);
    try {
      if (method === 'GET') {
        if (tail === 'status') {
          handleFlightplanStatus(res);
          return;
        }
        if (tail === 'settings') {
          handleFlightplanSettingsGet(res);
          return;
        }
        if (tail === 'airports') {
          handleFlightplanAirports(query, res);
          return;
        }
        if (tail === 'trips') {
          sendJson(res, 200, {
            ok: true,
            trips: service.store.listTrips({
              filter: query.get('filter') || 'all',
              sort: query.get('sort') || 'date',
              dir: query.get('dir') || 'desc',
            }),
          });
          return;
        }
        if (tail === 'images/curated') {
          sendJson(res, 200, { ok: true, curated: service.images.curatedCandidates() });
          return;
        }
        const tripMatch = /^trips\/([^/]+)$/.exec(tail);
        if (tripMatch) {
          const trip = service.store.getTrip(tripMatch[1]);
          if (!trip) {
            sendJson(res, 404, { ok: false, error: 'Trip not found' });
            return;
          }
          sendJson(res, 200, {
            ok: true,
            trip,
            flights: service.store.flightsForTrip(trip.id),
          });
          return;
        }
        const flightMatch = /^flights\/([^/]+)$/.exec(tail);
        if (flightMatch) {
          const flight = service.store.getFlight(flightMatch[1]);
          if (!flight) {
            sendJson(res, 404, { ok: false, error: 'Flight not found' });
            return;
          }
          sendJson(res, 200, { ok: true, flight });
          return;
        }
        sendJson(res, 404, { ok: false, error: 'Not found' });
        return;
      }

      if (method === 'POST') {
        if (tail === 'settings') {
          await handleFlightplanSettingsPut(body, res);
          return;
        }
        if (tail === 'trips') {
          sendJson(res, 200, service.store.createTrip(body));
          return;
        }
        if (tail === 'search') {
          service.refreshApiKey();
          const result = await service.api.searchByNumber({
            airline: body?.airline,
            number: body?.number,
            date: body?.date,
            manual: true,
          });
          if (!result.ok) {
            sendJson(res, 402, result);
            return;
          }
          const airport = body?.airport ? service.resolveAirportCode(body.airport) : '';
          const allLegs = result.legs || [];
          const legs = airport ? filterLegsByAirport(allLegs, airport) : allLegs;
          sendJson(res, 200, {
            ...result,
            legs,
            airport: airport || null,
            allLegCount: allLegs.length,
            airportFiltered: Boolean(airport && allLegs.length && legs.length !== allLegs.length),
          });
          return;
        }
        if (tail === 'verify-key') {
          const result = await service.verifyApiKey(body?.rapidApiKey);
          sendJson(res, result.ok ? 200 : 402, result);
          return;
        }
        const importMatch = /^trips\/([^/]+)\/flights\/import$/.exec(tail);
        if (importMatch) {
          const leg = body?.leg || body;
          const created = await service.importFlightLeg(importMatch[1], leg, { date: body?.date });
          sendJson(res, created.ok ? 200 : 400, created);
          return;
        }
        const refreshMatch = /^flights\/([^/]+)\/refresh$/.exec(tail);
        if (refreshMatch) {
          const result = await service.poller.refreshFlight(refreshMatch[1], { manual: true });
          sendJson(res, result.ok ? 200 : 400, result);
          return;
        }
        const candMatch = /^trips\/([^/]+)\/images\/candidates$/.exec(tail);
        if (candMatch) {
          const trip = service.store.getTrip(candMatch[1]);
          if (!trip) {
            sendJson(res, 404, { ok: false, error: 'Trip not found' });
            return;
          }
          const cfg = service.settings.get();
          const limit = cfg.imageCandidateCount || 4;
          const contactEmail = config.contactEmail || process.env.CONTACT_EMAIL || '';
          let candidates = [];
          if (body?.query) {
            candidates = await service.images.locationCandidates(body.query, { limit, contactEmail });
          } else if (body?.title || trip.name) {
            candidates = await service.images.titleCandidates(body?.title || trip.name, { limit, contactEmail });
          }
          sendJson(res, 200, { ok: true, candidates });
          return;
        }
        const cacheMatch = /^trips\/([^/]+)\/images\/cache$/.exec(tail);
        if (cacheMatch) {
          const trip = service.store.getTrip(cacheMatch[1]);
          if (!trip) {
            sendJson(res, 404, { ok: false, error: 'Trip not found' });
            return;
          }
          const cached = await service.images.cacheRemoteImage(body?.url, {
            caption: body?.caption,
            source: body?.source || 'remote',
          });
          if (!cached) {
            sendJson(res, 400, { ok: false, error: 'Image URL required' });
            return;
          }
          const images = [...(trip.images || []), cached];
          service.store.updateTrip(trip.id, { images });
          sendJson(res, 200, { ok: true, image: cached, trip: service.store.getTrip(trip.id) });
          return;
        }
        sendJson(res, 404, { ok: false, error: 'Not found' });
        return;
      }

      if (method === 'PUT') {
        const tripMatch = /^trips\/([^/]+)$/.exec(tail);
        if (tripMatch) {
          sendJson(res, 200, service.store.updateTrip(tripMatch[1], body));
          return;
        }
        const flightMatch = /^flights\/([^/]+)$/.exec(tail);
        if (flightMatch) {
          sendJson(res, 200, service.store.updateFlight(flightMatch[1], body));
          return;
        }
        const reorderMatch = /^trips\/([^/]+)\/flights\/reorder$/.exec(tail);
        if (reorderMatch) {
          sendJson(res, 200, service.store.reorderTripFlights(reorderMatch[1], body?.flightIds || []));
          return;
        }
        sendJson(res, 404, { ok: false, error: 'Not found' });
        return;
      }

      if (method === 'DELETE') {
        const tripMatch = /^trips\/([^/]+)$/.exec(tail);
        if (tripMatch) {
          const trip = service.store.getTrip(tripMatch[1]);
          if (trip?.images?.length) {
            service.images.deleteTripImages(trip.images.map((row) => row.id || path.basename(String(row.url || ''))));
          }
          sendJson(res, 200, service.store.deleteTrip(tripMatch[1]));
          return;
        }
        const flightMatch = /^flights\/([^/]+)$/.exec(tail);
        if (flightMatch) {
          sendJson(res, 200, service.store.deleteFlight(flightMatch[1]));
          return;
        }
        sendJson(res, 404, { ok: false, error: 'Not found' });
        return;
      }
      sendJson(res, 405, { ok: false, error: 'Method not allowed' });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error?.message || String(error) });
    }
  }

  // ------------------------------------------------------------- YouTube

  function youtubeService() {
    return typeof youtubeNowPlaying === 'function' ? youtubeNowPlaying() : youtubeNowPlaying;
  }

  function steamLibraryTourService() {
    return typeof steamLibraryTour === 'function' ? steamLibraryTour() : steamLibraryTour;
  }

  function psnLibraryTourService() {
    return typeof psnLibraryTour === 'function' ? psnLibraryTour() : psnLibraryTour;
  }

  /** Every YouTube route needs the service; fail the same way in one place. */
  function withYoutube(res, handler) {
    const service = youtubeService();
    if (!service) {
      sendJson(res, 503, { ok: false, error: 'YouTube is not available' });
      return undefined;
    }
    const outcome = handler(service);
    // Some handlers talk to the sidecar and are async; a rejection here would
    // otherwise take down the process instead of answering the request.
    if (outcome && typeof outcome.catch === 'function') {
      return outcome.catch((error) => {
        log.warn('YouTube request failed', error?.message || error);
        sendJson(res, 500, { ok: false, error: error?.message || 'YouTube request failed' });
      });
    }
    return outcome;
  }

  function handleYoutubeSettingsGet(res) {
    withYoutube(res, (service) => {
      sendJson(res, 200, { ok: true, settings: service.store.getSettings() });
    });
  }

  function handleYoutubeSettingsPut(body, res) {
    withYoutube(res, (service) => {
      sendJson(res, 200, { ok: true, settings: service.store.updateSettings(body || {}) });
    });
  }

  function handleYoutubeDevicesGet(res) {
    withYoutube(res, (service) => {
      sendJson(res, 200, { ok: true, devices: service.store.publicDevices() });
    });
  }

  async function handleYoutubeDiscover(res) {
    return withYoutube(res, async (service) => {
      const result = await service.discover();
      // A missing detection agent is this bridge being unequipped, not a bad
      // answer from the TVs — 503 so it reads as "set this up first".
      const status = result.ok ? 200 : (result.unavailable ? 503 : 502);
      sendJson(res, status, result);
    });
  }

  async function handleYoutubeLink(body, res) {
    return withYoutube(res, async (service) => {
      const result = await service.linkDevice({
        label: body?.label ? String(body.label) : null,
        pairingCode: body?.pairingCode ? String(body.pairingCode) : null,
        screenId: body?.screenId ? String(body.screenId) : null,
      });
      sendJson(res, result.ok ? 201 : 400, result);
    });
  }

  function handleYoutubeDeviceUpdate(id, body, res) {
    withYoutube(res, async (service) => {
      const device = service.store.getDevice(id);
      if (!device) {
        sendJson(res, 404, { ok: false, error: 'Unknown device' });
        return;
      }
      // Only the two user-editable fields; tokens are never accepted over HTTP.
      service.store.saveDevice({
        ...device,
        label: body?.label != null ? String(body.label) : device.label,
      });
      // Pausing has to release the agent session, not just flip the flag.
      if (body?.enabled != null) {
        await service.setDeviceEnabled(id, body.enabled !== false);
      }
      sendJson(res, 200, {
        ok: true,
        device: service.store.publicDevices().find((entry) => entry.id === String(id)),
      });
    });
  }

  function handleYoutubeDeviceDelete(id, res) {
    withYoutube(res, async (service) => {
      const removed = await service.forgetDevice(id);
      sendJson(res, removed ? 200 : 404, {
        ok: removed,
        ...(removed ? {} : { error: 'Unknown device' }),
      });
    });
  }

  async function handleYoutubeRelink(id, res) {
    return withYoutube(res, async (service) => {
      const result = await service.relinkDevice(id);
      sendJson(res, result.ok ? 200 : 400, result);
    });
  }

  function handleYoutubeNowPlayingGet(res) {
    withYoutube(res, (service) => {
      const status = service.statusSnapshot();
      sendJson(res, 200, {
        ok: true,
        playing: status.playing,
        sessions: status.sessions,
        lastPlayed: status.lastPlayed,
      });
    });
  }

  function handleYoutubeHistory(query, res) {
    withYoutube(res, (service) => {
      sendJson(res, 200, {
        ok: true,
        sessions: service.store.history({
          limit: Math.min(200, Number(query.get('limit')) || 20),
          deviceId: query.get('deviceId') || null,
        }),
      });
    });
  }

  async function handleYoutubeVideoGet(videoId, res) {
    return withYoutube(res, async (service) => {
      try {
        sendJson(res, 200, { ok: true, video: await service.api.resolveVideo(videoId) });
      } catch (error) {
        sendJson(res, 502, { ok: false, error: error?.message || String(error) });
      }
    });
  }

  function handleYoutubeCacheStats(res) {
    withYoutube(res, (service) => {
      sendJson(res, 200, { ok: true, ...service.api.stats() });
    });
  }

  function handleYoutubeCacheClear(query, res) {
    withYoutube(res, (service) => {
      sendJson(res, 200, { ok: true, ...service.api.clear(query.get('scope') || 'all') });
    });
  }

  /** Save an API key from the admin page, then prove it works in one round trip. */
  async function handleYoutubeApiKeySave(body, res) {
    const key = String(body?.apiKey || '').trim();
    if (!key) {
      sendJson(res, 400, { ok: false, error: 'Paste a YouTube Data API key' });
      return undefined;
    }
    const envKey = String(process.env.YOUTUBE_API_KEY || '').trim();
    if (envKey) {
      sendJson(res, 409, {
        ok: false,
        error: 'YOUTUBE_API_KEY is already set in .env and takes precedence. '
          + 'Update or remove it in .env — this screen does not rewrite .env.',
        source: 'env',
      });
      return undefined;
    }
    // Probe before writing so a bad paste does not clobber a working key.
    config.youtube = { ...(config.youtube || {}), apiKey: key, apiKeySource: 'session' };
    return withYoutube(res, async (service) => {
      try {
        // "Me at the zoo" — the oldest video on YouTube, and the least likely
        // to ever be deleted, so a failure here means the key, not the video.
        const [probe] = await service.api.fetchVideos(['jNQXAC9IVRw']);
        if (!probe?.core) {
          sendJson(res, 400, {
            ok: false,
            error: 'The key was accepted but returned no data',
          });
          return;
        }
        const { saveYoutubeApiKey } = require('./youtube-credentials');
        const credentialsPath = config.youtube.credentialsPath
          || require('./youtube-credentials').defaultCredentialsPath(config.ROOT);
        saveYoutubeApiKey(credentialsPath, key);
        config.youtube = {
          ...(config.youtube || {}),
          apiKey: key,
          apiKeySource: 'session',
          credentialsPath,
        };
        sendJson(res, 200, { ok: true, source: 'session' });
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error?.message || String(error) });
      }
    });
  }

  async function handleYoutubeNowPlayingPush(body, res) {
    const service = youtubeService();
    if (!service?.pushManualPreview) {
      sendJson(res, 503, { ok: false, error: 'YouTube is not available' });
      return;
    }
    const targetId = targetIdFrom(body);
    if (typeof displayRegistry?.resolveDelivery === 'function') {
      const delivery = displayRegistry.resolveDelivery(targetId);
      if (delivery.error && !delivery.isAll) {
        sendJson(res, 404, { ok: false, error: delivery.error });
        return;
      }
    }
    try {
      const result = await service.pushManualPreview({
        device: deviceFrom(body),
        requestedMode: previewModeFrom(body),
        deviceId: body?.deviceId ? String(body.deviceId) : null,
        videoId: body?.videoId ? String(body.videoId) : null,
        send: (payload) => {
          if (typeof deliverTargetedPayload === 'function') {
            return deliverTargetedPayload(payload, targetId);
          }
          return sendUdpPayload(payload);
        },
      });
      if (!result?.ok) {
        sendJson(res, 400, { ok: false, error: result?.error || 'YouTube preview failed' });
        return;
      }
      log.info('YouTube manual preview', { mode: result.mode, videoId: result.videoId, targetId });
      sendJson(res, 200, { ok: true, ...result, targetId });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error?.message || String(error) });
    }
  }

  // ------------------------------------------------------------- Plex / Feature Presentation

  function plexService() {
    return typeof plexNowPlaying === 'function' ? plexNowPlaying() : plexNowPlaying;
  }

  function plexTargetId(body) {
    const targetId = targetIdFrom(body);
    const raw = String(targetId || '').trim().toLowerCase();
    if (raw === 'vestaboard') {
      return 'vestaboard';
    }
    if (typeof displayRegistry?.get === 'function') {
      const entry = displayRegistry.get(targetId);
      if (entry && (entry.static || entry.kind === 'vestaboard')) {
        return targetId;
      }
    }
    return 'vestaboard';
  }

  function handlePlexStatus(res) {
    const service = plexService();
    if (!service) {
      sendJson(res, 503, { ok: false, error: 'Feature Presentation is not available' });
      return;
    }
    sendJson(res, 200, { ok: true, ...service.statusSnapshot() });
  }

  function handlePlexSettingsGet(res) {
    const service = plexService();
    if (!service) {
      sendJson(res, 503, { ok: false, error: 'Feature Presentation is not available' });
      return;
    }
    sendJson(res, 200, { ok: true, settings: service.settings.get() });
  }

  function handlePlexSettingsPut(body, res) {
    const service = plexService();
    if (!service) {
      sendJson(res, 503, { ok: false, error: 'Feature Presentation is not available' });
      return;
    }
    try {
      const settings = service.applySettings(body || {});
      sendJson(res, 200, { ok: true, settings, ...service.statusSnapshot() });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error?.message || String(error) });
    }
  }

  function handlePlexTokenSave(body, res) {
    const token = String(body?.token || '').trim();
    if (!token) {
      sendJson(res, 400, { ok: false, error: 'Plex token is empty' });
      return;
    }
    if (String(process.env.PLEX_TOKEN || '').trim()) {
      sendJson(res, 409, {
        ok: false,
        error: 'PLEX_TOKEN is set in the environment and cannot be replaced here',
        source: 'env',
      });
      return;
    }
    try {
      const credPath = config.plexCredentialsPath
        || defaultCredentialsPath(config.ROOT);
      savePlexToken(credPath, token);
      const serverUrl = String(body?.serverUrl || '').trim();
      const service = plexService();
      if (serverUrl && service?.applySettings) {
        service.applySettings({ serverUrl });
      }
      sendJson(res, 200, {
        ok: true,
        source: 'session',
        ...(service?.statusSnapshot?.() || {}),
      });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error?.message || String(error) });
    }
  }

  async function handlePlexTest(body, res) {
    const service = plexService();
    if (!service?.testConnection) {
      sendJson(res, 503, { ok: false, error: 'Feature Presentation is not available' });
      return;
    }
    const result = await service.testConnection({
      serverUrl: String(body?.serverUrl || '').trim() || undefined,
    });
    sendJson(res, result.ok ? 200 : 400, result);
  }

  async function handlePlexNowPlayingPush(body, res) {
    const service = plexService();
    if (!service?.pushManualPreview) {
      sendJson(res, 503, { ok: false, error: 'Feature Presentation is not available' });
      return;
    }
    const targetId = plexTargetId(body);
    try {
      const result = await service.pushManualPreview({
        requestedMode: previewModeFrom(body),
        explicit: body?.triggeredBy !== 'scheduler',
        send: (payload, options) => {
          const extra = { ...(options || {}) };
          if (body?.triggeredBy === 'scheduler') {
            extra.source = 'scheduler';
            extra.explicit = false;
            extra.quietHoursExempt = false;
          }
          if (typeof deliverTargetedPayload === 'function') {
            return deliverTargetedPayload(payload, targetId, extra);
          }
          return sendUdpPayload(payload, { ...extra, targetId });
        },
      });
      if (!result?.ok) {
        sendJson(res, 400, { ok: false, error: result?.error || 'Feature Presentation preview failed' });
        return;
      }
      log.info('Feature Presentation preview', { mode: result.mode, title: result.title, targetId });
      sendJson(res, 200, { ok: true, ...result, targetId });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error?.message || String(error) });
    }
  }

  async function handlePlexPreview(body, res) {
    await handlePlexNowPlayingPush({ ...body, mode: body?.mode || 'auto' }, res);
  }

  function handleLocaleSettingsGet(res) {
    sendJson(res, 200, { ok: true, settings: localeSettings.get() });
  }

  async function handleLocaleSettingsPut(body, res) {
    const city = String(body?.city ?? localeSettings.get().city ?? '').trim();
    const postalCode = String(body?.postalCode ?? localeSettings.get().postalCode ?? '').trim();
    const temperatureUnit = body?.temperatureUnit;
    const currencyCode = body?.currencyCode;
    if (!city && !postalCode) {
      if (localeSettings.hasLocation() && (temperatureUnit || currencyCode != null)) {
        const settings = localeSettings.update({
          ...(temperatureUnit ? { temperatureUnit } : {}),
          ...(currencyCode != null ? { currencyCode } : {}),
        });
        sendJson(res, 200, { ok: true, settings });
        return;
      }
      sendJson(res, 400, { ok: false, error: 'Enter a city or ZIP code' });
      return;
    }
    try {
      const resolved = await resolveHouseLocale({ city, postalCode });
      if (!resolved) {
        sendJson(res, 400, { ok: false, error: 'Could not find that city or ZIP' });
        return;
      }
      const settings = localeSettings.update({
        ...resolved,
        ...(temperatureUnit ? { temperatureUnit } : {}),
        ...(currencyCode != null ? { currencyCode } : {}),
      });
      sendJson(res, 200, { ok: true, settings });
    } catch (error) {
      sendJson(res, 502, { ok: false, error: error?.message || 'Location lookup failed' });
    }
  }

  function publicUrlEnvNote() {
    const envSet = Boolean(String(process.env.GUEST_PHOTOBOOTH_URL || '').trim());
    return {
      envGuestPhotoboothUrlSet: envSet,
      envNote: envSet
        ? 'GUEST_PHOTOBOOTH_URL is also set in .env — the Public base URL above wins while it is set.'
        : '',
    };
  }

  function handlePublicUrlSettingsGet(res) {
    const settings = publicUrlSettings.get();
    sendJson(res, 200, {
      ok: true,
      settings,
      origin: publicUrl('', config),
      shortLinkReady: isUsableShortLinkOrigin(publicUrl('/guestbook/', config)),
      ...publicUrlEnvNote(),
    });
  }

  async function handlePublicUrlSettingsPut(body, res) {
    try {
      const settings = publicUrlSettings.update({
        publicBaseUrl: body?.publicBaseUrl,
      });
      const guest = guestBookSettings.get();
      if (guest.preferredAlias) {
        await shortlinks.ensure(GUESTBOOK_NAME, GUESTBOOK_PATH, {
          preferredAlias: guest.preferredAlias,
        });
      }
      const snaps = guestSnapsSettings.get();
      if (snaps.preferredAlias) {
        await shortlinks.ensure(GUESTSNAPS_NAME, GUESTSNAPS_PATH, {
          preferredAlias: snaps.preferredAlias,
        });
      }
      sendJson(res, 200, {
        ok: true,
        settings,
        origin: publicUrl('', config),
        shortLinkReady: isUsableShortLinkOrigin(publicUrl('/guestbook/', config)),
        shortlink: shortlinks.status(GUESTBOOK_NAME),
        guestSnapsShortlink: shortlinks.status(GUESTSNAPS_NAME),
        ...publicUrlEnvNote(),
      });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error?.message || String(error) });
    }
  }

  function tinyurlCredPath() {
    return config.tinyurlCredentialsPath || defaultTinyurlCredentialsPath(config.ROOT);
  }

  function handleGuestBookSettingsGet(res) {
    const settings = guestBookSettings.get();
    sendJson(res, 200, {
      ok: true,
      settings: publicSettings(settings),
      credentials: tinyurlCredentialsStatus(tinyurlCredPath(), { scope: 'guestbook' }),
      shortlink: shortlinks.status(GUESTBOOK_NAME),
      targetPath: GUESTBOOK_PATH,
      targetUrl: publicUrl(GUESTBOOK_PATH, config),
      shortLinkReady: isUsableShortLinkOrigin(publicUrl(GUESTBOOK_PATH, config)),
      boardCode: settings.whoCanSend === 'code' ? guestBook.currentCode().pin : '',
      ...publicUrlEnvNote(),
    });
  }

  async function handleGuestBookSettingsPut(body, res) {
    const credPath = tinyurlCredPath();
    if (Object.prototype.hasOwnProperty.call(body || {}, 'apiToken')
      || Object.prototype.hasOwnProperty.call(body || {}, 'token')) {
      const token = String(body.apiToken || body.token || '').trim();
      if (token) {
        if (String(process.env.TINYURL_API_TOKEN || '').trim()
          || String(process.env.TINYURL_API_TOKEN_GUESTBOOK || '').trim()) {
          sendJson(res, 409, {
            ok: false,
            error: 'TINYURL_API_TOKEN is set in the environment and cannot be replaced here',
            source: 'env',
          });
          return;
        }
        try {
          saveTinyurlToken(credPath, token, { scope: 'guestbook' });
        } catch (error) {
          sendJson(res, 400, { ok: false, error: error?.message || String(error) });
          return;
        }
      }
    }
    if (body?.clearOverride || body?.clearToken) {
      clearTinyurlToken(credPath, { scope: 'guestbook' });
    }

    let settings = guestBookSettings.get();
    const patch = {};
    if (Object.prototype.hasOwnProperty.call(body || {}, 'preferredAlias')) {
      try {
        patch.preferredAlias = sanitiseAlias(body.preferredAlias);
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error?.message || String(error) });
        return;
      }
    }
    for (const key of [
      'enabled', 'paused', 'whoCanSend', 'rateLimitEnabled', 'ratePerGuest',
      'rateWindowMinutes', 'dailyCap', 'blockedWordsEnabled', 'blockedWords',
      'approval',
      'inviteFooter', 'guestsMayWake',
    ]) {
      if (Object.prototype.hasOwnProperty.call(body || {}, key)) {
        patch[key] = body[key];
      }
    }
    if (Object.prototype.hasOwnProperty.call(body || {}, 'password')) {
      patch.password = body.password;
    }
    if (body?.clearPassword) {
      patch.clearPassword = true;
    }
    if (Object.keys(patch).length) {
      settings = guestBookSettings.update(patch);
    }

    let shortlink = shortlinks.status(GUESTBOOK_NAME);
    if (settings.preferredAlias) {
      shortlink = await shortlinks.ensure(GUESTBOOK_NAME, GUESTBOOK_PATH, {
        preferredAlias: settings.preferredAlias,
      });
    }

    sendJson(res, 200, {
      ok: true,
      settings: publicSettings(settings),
      credentials: tinyurlCredentialsStatus(credPath, { scope: 'guestbook' }),
      shortlink,
      targetPath: GUESTBOOK_PATH,
      targetUrl: publicUrl(GUESTBOOK_PATH, config),
      shortLinkReady: isUsableShortLinkOrigin(publicUrl(GUESTBOOK_PATH, config)),
      boardCode: settings.whoCanSend === 'code' ? guestBook.currentCode().pin : '',
      ...publicUrlEnvNote(),
    });
  }

  async function handleGuestBookCheck(body, res) {
    try {
      let settings = guestBookSettings.get();
      if (String(body?.preferredAlias || '').trim()) {
        settings = guestBookSettings.update({
          preferredAlias: sanitiseAlias(body.preferredAlias),
        });
      }
      if (settings.preferredAlias) {
        await shortlinks.ensure(GUESTBOOK_NAME, GUESTBOOK_PATH, {
          preferredAlias: settings.preferredAlias,
        });
      }
      const shortlink = await shortlinks.check(GUESTBOOK_NAME);
      sendJson(res, 200, {
        ok: true,
        settings: publicSettings(settings),
        credentials: tinyurlCredentialsStatus(tinyurlCredPath(), { scope: 'guestbook' }),
        shortlink,
        targetPath: GUESTBOOK_PATH,
        targetUrl: publicUrl(GUESTBOOK_PATH, config),
      });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error?.message || String(error) });
    }
  }

  function handleGuestSnapsSettingsGet(res) {
    const settings = guestSnapsSettings.get();
    sendJson(res, 200, {
      ok: true,
      settings,
      credentials: tinyurlCredentialsStatus(tinyurlCredPath(), { scope: 'guestsnaps' }),
      shortlink: shortlinks.status(GUESTSNAPS_NAME),
      targetPath: GUESTSNAPS_PATH,
      targetUrl: publicUrl(GUESTSNAPS_PATH, config),
      shortLinkReady: isUsableShortLinkOrigin(publicUrl(GUESTSNAPS_PATH, config)),
      booth: resolveGuestPhotoboothSettings(config),
      ...publicUrlEnvNote(),
    });
  }

  async function handleGuestSnapsSettingsPut(body, res) {
    const credPath = tinyurlCredPath();
    if (Object.prototype.hasOwnProperty.call(body || {}, 'apiToken')
      || Object.prototype.hasOwnProperty.call(body || {}, 'token')) {
      const token = String(body.apiToken || body.token || '').trim();
      if (token) {
        if (String(process.env.TINYURL_API_TOKEN || '').trim()
          || String(process.env.TINYURL_API_TOKEN_GUESTSNAPS || '').trim()) {
          sendJson(res, 409, {
            ok: false,
            error: 'TINYURL_API_TOKEN is set in the environment and cannot be replaced here',
            source: 'env',
          });
          return;
        }
        try {
          saveTinyurlToken(credPath, token, { scope: 'guestsnaps' });
        } catch (error) {
          sendJson(res, 400, { ok: false, error: error?.message || String(error) });
          return;
        }
      }
    }
    if (body?.clearOverride || body?.clearToken) {
      clearTinyurlToken(credPath, { scope: 'guestsnaps' });
    }

    const patch = {};
    if (Object.prototype.hasOwnProperty.call(body || {}, 'preferredAlias')) {
      try {
        patch.preferredAlias = sanitiseAlias(body.preferredAlias);
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error?.message || String(error) });
        return;
      }
    }

    const settings = Object.keys(patch).length
      ? guestSnapsSettings.update(patch)
      : guestSnapsSettings.get();

    let shortlink = shortlinks.status(GUESTSNAPS_NAME);
    if (settings.preferredAlias) {
      await shortlinks.ensure(GUESTSNAPS_NAME, GUESTSNAPS_PATH, {
        preferredAlias: settings.preferredAlias,
      });
      shortlink = shortlinks.status(GUESTSNAPS_NAME);
    }

    sendJson(res, 200, {
      ok: true,
      settings,
      credentials: tinyurlCredentialsStatus(credPath, { scope: 'guestsnaps' }),
      shortlink,
      targetPath: GUESTSNAPS_PATH,
      targetUrl: publicUrl(GUESTSNAPS_PATH, config),
      shortLinkReady: isUsableShortLinkOrigin(publicUrl(GUESTSNAPS_PATH, config)),
      booth: resolveGuestPhotoboothSettings(config),
      ...publicUrlEnvNote(),
    });
  }

  async function handleGuestSnapsCheck(body, res) {
    try {
      let settings = guestSnapsSettings.get();
      if (String(body?.preferredAlias || '').trim()) {
        settings = guestSnapsSettings.update({
          preferredAlias: sanitiseAlias(body.preferredAlias),
        });
      }
      if (settings.preferredAlias) {
        await shortlinks.ensure(GUESTSNAPS_NAME, GUESTSNAPS_PATH, {
          preferredAlias: settings.preferredAlias,
        });
      }
      const shortlink = await shortlinks.check(GUESTSNAPS_NAME);
      sendJson(res, 200, {
        ok: true,
        settings,
        credentials: tinyurlCredentialsStatus(tinyurlCredPath(), { scope: 'guestsnaps' }),
        shortlink,
        targetPath: GUESTSNAPS_PATH,
        targetUrl: publicUrl(GUESTSNAPS_PATH, config),
      });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error?.message || String(error) });
    }
  }

  function handleTinyurlSettingsGet(res) {
    sendJson(res, 200, {
      ok: true,
      credentials: tinyurlCredentialsStatus(tinyurlCredPath()),
      ...publicUrlEnvNote(),
    });
  }

  function handleTinyurlSettingsPut(body, res) {
    const credPath = tinyurlCredPath();
    if (String(process.env.TINYURL_API_TOKEN || '').trim()) {
      if (body?.clearToken || String(body?.apiToken || body?.token || '').trim()) {
        sendJson(res, 409, {
          ok: false,
          error: 'TINYURL_API_TOKEN is set in the environment and cannot be replaced here',
          source: 'env',
        });
        return;
      }
    }
    if (body?.clearToken) {
      clearTinyurlToken(credPath);
    }
    const token = String(body?.apiToken || body?.token || '').trim();
    if (token) {
      try {
        saveTinyurlToken(credPath, token);
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error?.message || String(error) });
        return;
      }
    }
    sendJson(res, 200, {
      ok: true,
      credentials: tinyurlCredentialsStatus(credPath),
      ...publicUrlEnvNote(),
    });
  }

  function scrambleSettingsPayload() {
    const settings = gameSettings.get('scramble');
    return {
      ok: true,
      settings,
      credentials: tinyurlCredentialsStatus(tinyurlCredPath(), { scope: 'games' }),
      shortlink: shortlinks.status(GAMES_NAME),
      targetPath: GAMES_PATH,
      targetUrl: publicUrl(GAMES_PATH, config),
      shortLinkReady: isUsableShortLinkOrigin(publicUrl(GAMES_PATH, config)),
      ...publicUrlEnvNote(),
    };
  }

  function handleWordScrambleSettingsGet(res) {
    sendJson(res, 200, scrambleSettingsPayload());
  }

  async function handleWordScrambleSettingsPut(body, res) {
    const credPath = tinyurlCredPath();
    if (Object.prototype.hasOwnProperty.call(body || {}, 'apiToken')
      || Object.prototype.hasOwnProperty.call(body || {}, 'token')) {
      const token = String(body.apiToken || body.token || '').trim();
      if (token) {
        if (String(process.env.TINYURL_API_TOKEN || '').trim()
          || String(process.env.TINYURL_API_TOKEN_GAMES || '').trim()) {
          sendJson(res, 409, {
            ok: false,
            error: 'TINYURL_API_TOKEN is set in the environment and cannot be replaced here',
            source: 'env',
          });
          return;
        }
        try {
          saveTinyurlToken(credPath, token, { scope: 'games' });
        } catch (error) {
          sendJson(res, 400, { ok: false, error: error?.message || String(error) });
          return;
        }
      }
    }
    if (body?.clearOverride || body?.clearToken) {
      clearTinyurlToken(credPath, { scope: 'games' });
    }
    const patch = {};
    for (const key of [
      'lobbySeconds', 'roundSeconds', 'intermissionSeconds', 'rounds',
      'inviteTtlMinutes', 'idleTimeoutSeconds', 'maxPlayers', 'minSolutions',
      'duplicateRule', 'allowLateJoin',
    ]) {
      if (Object.prototype.hasOwnProperty.call(body || {}, key)) {
        patch[key] = body[key];
      }
    }
    if (Object.prototype.hasOwnProperty.call(body || {}, 'preferredAlias')) {
      patch.preferredAlias = body.preferredAlias;
    }
    if (Object.keys(patch).length) {
      gameSettings.update('scramble', patch);
    }
    const settings = gameSettings.get('scramble');
    let shortlink = shortlinks.status(GAMES_NAME);
    if (settings.preferredAlias) {
      try {
        await shortlinks.ensure(GAMES_NAME, GAMES_PATH, {
          preferredAlias: settings.preferredAlias,
        });
        shortlink = shortlinks.status(GAMES_NAME);
      } catch (error) {
        log.warn?.('Word Scramble short link failed', error?.message || error);
      }
    }
    sendJson(res, 200, { ...scrambleSettingsPayload(), shortlink });
  }

  async function handleWordScramblePush(body, res) {
    try {
      const settings = gameSettings.get('scramble');
      if (settings.preferredAlias) {
        try {
          await shortlinks.ensure(GAMES_NAME, GAMES_PATH, {
            preferredAlias: settings.preferredAlias,
          });
        } catch (error) {
          log.warn?.('Word Scramble invite short link failed', error?.message || error);
        }
      }
      const session = gameSessions.create({ gameType: 'scramble' });
      log.info('Word Scramble invite', { code: session.code });
      sendJson(res, 200, { ok: true, type: 'word.scramble', session });
    } catch (error) {
      sendJson(res, 409, { ok: false, error: error?.message || String(error) });
    }
  }

  function handleGameSessionsGet(res) {
    sendJson(res, 200, { ok: true, sessions: gameSessions.listActive() });
  }

  function handleGameSessionsHistory(query, res) {
    sendJson(res, 200, {
      ok: true,
      ...gameSessions.history({
        offset: query?.offset,
        limit: query?.limit || query?.pageSize,
      }),
    });
  }

  function handleGameSessionsEnd(body, res) {
    const ids = Array.isArray(body?.sessionIds)
      ? body.sessionIds
      : [body?.sessionId || body?.id];
    const wanted = ids.map((id) => String(id || '').trim()).filter(Boolean);
    if (!wanted.length) {
      sendJson(res, 400, { ok: false, error: 'sessionId required' });
      return;
    }
    let ended = 0;
    for (const id of wanted) {
      if (gameSessions.end(id).ok) ended += 1;
    }
    sendJson(res, ended ? 200 : 404, {
      ok: ended > 0,
      ended,
      error: ended ? undefined : 'Session not found',
    });
  }

  function handleGameSessionsForget(body, res) {
    const ids = Array.isArray(body?.sessionIds)
      ? body.sessionIds
      : [body?.sessionId || body?.id];
    const result = gameSessions.forget(ids.map((id) => String(id || '').trim()).filter(Boolean));
    sendJson(res, 200, result);
  }

  function handleGamesSessionGet(query, res) {
    const session = gameSessions.getByCode(query?.code);
    if (!session) {
      sendJson(res, 404, { ok: false, error: 'No game uses that code' });
      return;
    }
    sendJson(res, 200, { ok: true, session: gameSessions.publicSession(session) });
  }

  function handleGamesJoin(body, req, res) {
    const seated = parseGamesCookie(req.headers.cookie);
    const result = gameSessions.join({
      code: body?.code,
      name: body?.name,
      playerId: seated.playerId,
    });
    if (!result.ok) {
      sendJson(res, 400, result);
      return;
    }
    const data = JSON.stringify({
      ok: true,
      player: result.player,
      session: result.session,
    });
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Set-Cookie': gamesCookieHeader(result.cookie),
    });
    res.end(data);
  }

  function handleGamesSubmit(body, req, res) {
    const seated = parseGamesCookie(req.headers.cookie);
    const result = gameSessions.submit({
      sessionId: seated.sessionId || body?.sessionId,
      playerId: seated.playerId,
      action: body?.action || 'word',
      payload: body?.payload || {},
    });
    sendJson(res, result.ok ? 200 : 400, result);
  }

  function handleGamesLeave(req, res) {
    const seated = parseGamesCookie(req.headers.cookie);
    const result = gameSessions.leave({
      sessionId: seated.sessionId,
      playerId: seated.playerId,
    });
    sendJson(res, 200, result);
  }

  function handleGamesEvents(req, reqUrl, res) {
    const sessionId = String(reqUrl.searchParams.get('sessionId') || '').trim();
    const session = gameSessions.getById(sessionId);
    if (!session) {
      sendJson(res, 404, { ok: false, error: 'Session not found' });
      return;
    }
    // The cookie decides whose found-words list rides along on this stream.
    const seated = parseGamesCookie(req.headers.cookie);
    const playerId = seated.sessionId === sessionId ? seated.playerId : '';
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    res.write(`event: session\ndata: ${JSON.stringify({
      reason: 'hello',
      session: gameSessions.publicSession(session, playerId),
    })}\n\n`);
    const unsubscribe = gameSessions.subscribe(sessionId, res, playerId);
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(heartbeat);
      }
    }, 15000);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  }

  function handleGuestbookStatus(res) {
    sendJson(res, 200, { ok: true, ...guestBook.publicStatus() });
  }

  function handleGuestbookPreview(body, res) {
    const layout = guestBook.preview(body || {});
    sendJson(res, layout.ok ? 200 : 400, { ok: layout.ok, ...layout });
  }

  function handleGuestbookUnlock(body, req, res) {
    const result = guestBook.unlock({
      password: body?.password,
      code: body?.code,
    }, guestClientIp(req));
    if (!result.ok) {
      sendJson(res, result.locked ? 429 : 401, result);
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Set-Cookie': result.setCookie,
    });
    res.end(JSON.stringify({
      ok: true,
      expiresAt: new Date(result.expiresAt).toISOString(),
    }));
  }

  function handleGuestbookSend(body, req, res) {
    const result = guestBook.send(body || {}, { ip: guestClientIp(req), req });
    if (!result.ok && result.retryAfterSeconds > 0) {
      const data = JSON.stringify(result);
      res.writeHead(429, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Retry-After': String(result.retryAfterSeconds),
      });
      res.end(data);
      return;
    }
    const status = result.ok
      ? 200
      : (result.closed ? 403 : (result.needsUnlock ? 401 : 400));
    sendJson(res, status, result);
  }

  function handleGuestBookList(query = {}, res) {
    const pageSize = Math.min(50, Math.max(1, Number(query.pageSize) || 10));
    const status = String(query.status || '').trim().toLowerCase();
    const filter = (status === 'waiting' || status === 'released') ? status : '';
    const total = guestBook.count({ status: filter || undefined });
    const pages = Math.max(1, Math.ceil(total / pageSize) || 1);
    const page = Math.min(pages, Math.max(1, Number(query.page) || 1));
    const entries = guestBook.list({
      limit: pageSize,
      offset: (page - 1) * pageSize,
      status: filter || undefined,
    });
    sendJson(res, 200, {
      ok: true,
      entries,
      total,
      page,
      pageSize,
      pages,
      status: filter || 'all',
      waiting: guestBook.count({ status: 'waiting' }),
    });
  }

  function handleGuestBookReplay(body, res) {
    const ids = Array.isArray(body?.ids) ? body.ids : null;
    const result = ids ? guestBook.replayMany(ids) : guestBook.replay(body?.id);
    const status = result.ok ? 200 : (result.error?.includes('Release') || result.error?.includes('Nothing') ? 409 : 404);
    sendJson(res, status, result);
  }

  function handleGuestBookRelease(body, res) {
    const ids = Array.isArray(body?.ids) ? body.ids : null;
    const result = ids ? guestBook.releaseMany(ids) : guestBook.release(body?.id);
    sendJson(res, result.ok ? 200 : (result.error?.includes('waiting') || result.error?.includes('Only waiting') ? 409 : 404), result);
  }

  function handleGuestBookInvitePush(body, res) {
    const built = guestBook.invitePayload();
    if (!built.ok) {
      sendJson(res, 409, built);
      return;
    }
    const targetId = plexTargetId(body);
    const extra = {};
    if (body?.triggeredBy === 'scheduler') {
      extra.source = 'scheduler';
      extra.explicit = false;
    } else {
      extra.explicit = true;
    }
    const delivery = typeof deliverTargetedPayload === 'function'
      ? deliverTargetedPayload({
        type: 'guest.book.invite',
        rows: built.rows,
        shortLabel: built.shortLabel,
      }, targetId, extra)
      : sendUdpPayload({
        type: 'guest.book.invite',
        rows: built.rows,
        shortLabel: built.shortLabel,
      }, { ...extra, targetId });
    log.info('Guest Book invite', { targetId, shortLabel: built.shortLabel });
    sendJson(res, 200, {
      ok: true,
      type: 'guest.book.invite',
      targetId,
      shortLabel: built.shortLabel,
      vestaboard: delivery?.vestaboard || null,
    });
  }

  function handleGuestBookDelete(body, res) {
    const ids = Array.isArray(body?.ids) ? body.ids : null;
    const result = guestBook.remove(ids || body?.id);
    sendJson(res, result.ok ? 200 : 404, result);
  }

  function ringService() {
    return ringDoorbellInstance;
  }

  function handleRingSettingsGet(res) {
    const service = ringService();
    if (!service) {
      sendJson(res, 503, { ok: false, error: 'Ring Doorbell is not available' });
      return;
    }
    sendJson(res, 200, { ok: true, ...service.statusSnapshot() });
  }

  async function handleRingSettingsPut(body, res) {
    const service = ringService();
    if (!service) {
      sendJson(res, 503, { ok: false, error: 'Ring Doorbell is not available' });
      return;
    }
    if (body?.reset) {
      service.resetSettings();
    } else {
      service.updateSettings({
        enabled: body?.enabled,
        title: body?.title,
        message: body?.message,
        pushOnDing: body?.pushOnDing,
        pushOnMotion: body?.pushOnMotion,
        showTime: body?.showTime,
        quietHoursExempt: body?.quietHoursExempt,
        cameraIds: body?.cameraIds,
      });
    }
    sendJson(res, 200, { ok: true, ...service.statusSnapshot() });
  }

  function handleRingPreview(body, res) {
    const service = ringService();
    if (!service) {
      sendJson(res, 503, { ok: false, error: 'Ring Doorbell is not available' });
      return;
    }
    const payload = service.previewPayload({
      title: body?.title,
      message: body?.message,
      showTime: body?.showTime,
      kind: body?.kind,
    });
    sendJson(res, 200, { ok: true, payload, rows: payload.rows });
  }

  async function handleRingAuthLink(body, res) {
    const service = ringService();
    if (!service) {
      sendJson(res, 503, { ok: false, error: 'Ring Doorbell is not available' });
      return;
    }
    const token = String(body?.refreshToken || body?.token || '').trim();
    if (!token) {
      sendJson(res, 400, { ok: false, error: 'Refresh token is required' });
      return;
    }
    try {
      const status = await service.saveToken(token);
      sendJson(res, 200, { ok: true, ...status });
    } catch (error) {
      if (error?.code === 'ENV_BLOCKS') {
        sendJson(res, 409, { ok: false, error: error.message });
        return;
      }
      sendJson(res, 400, { ok: false, error: error?.message || String(error) });
    }
  }

  async function handleRingAuthLogin(body, res) {
    const service = ringService();
    if (!service) {
      sendJson(res, 503, { ok: false, error: 'Ring Doorbell is not available' });
      return;
    }
    try {
      const result = await service.loginWithPassword({
        email: body?.email,
        password: body?.password,
      });
      sendJson(res, 200, result);
    } catch (error) {
      const code = error?.code;
      const statusCode = code === 'ENV_BLOCKS' ? 409
        : code === 'BAD_REQUEST' ? 400
          : 400;
      sendJson(res, statusCode, { ok: false, error: error?.message || String(error) });
    }
  }

  async function handleRingAuthVerify(body, res) {
    const service = ringService();
    if (!service) {
      sendJson(res, 503, { ok: false, error: 'Ring Doorbell is not available' });
      return;
    }
    try {
      const result = await service.verify2fa({ code: body?.code || body?.twoFactorCode });
      sendJson(res, 200, result);
    } catch (error) {
      const code = error?.code;
      const statusCode = code === 'ENV_BLOCKS' ? 409
        : code === 'NO_PENDING' || code === 'EXPIRED' ? 409
          : 400;
      sendJson(res, statusCode, {
        ok: false,
        error: error?.message || String(error),
        prompt: error?.prompt || '',
        needs2fa: code === 'BAD_2FA',
      });
    }
  }

  async function handleRingAuthClear(_body, res) {
    const service = ringService();
    if (!service) {
      sendJson(res, 503, { ok: false, error: 'Ring Doorbell is not available' });
      return;
    }
    try {
      const status = await service.clearToken();
      sendJson(res, 200, { ok: true, ...status });
    } catch (error) {
      if (error?.code === 'ENV_BLOCKS') {
        sendJson(res, 409, { ok: false, error: error.message });
        return;
      }
      sendJson(res, 400, { ok: false, error: error?.message || String(error) });
    }
  }

  async function handleRingReconnect(_body, res) {
    const service = ringService();
    if (!service) {
      sendJson(res, 503, { ok: false, error: 'Ring Doorbell is not available' });
      return;
    }
    const status = await service.connect();
    sendJson(res, 200, { ok: true, ...status });
  }

  function handleRingDoorbellPush(body, res) {
    const service = ringService();
    if (!service) {
      sendJson(res, 503, { ok: false, error: 'Ring Doorbell is not available' });
      return;
    }
    const payload = service.nextPayload({
      title: body?.title,
      message: body?.message,
      showTime: body?.showTime,
      kind: body?.kind || 'ding',
    });
    const targetId = plexTargetId(body);
    const cfg = service.getSettings();
    const extra = {
      explicit: true,
      quietHoursExempt: true,
      replaceSource: 'ring.doorbell',
    };
    if (body?.triggeredBy === 'scheduler') {
      extra.source = 'scheduler';
      extra.explicit = false;
      extra.quietHoursExempt = Boolean(cfg.quietHoursExempt);
    }
    const delivery = typeof deliverTargetedPayload === 'function'
      ? deliverTargetedPayload(payload, targetId, extra)
      : sendUdpPayload(payload, { ...extra, targetId });
    log.info('Ring doorbell push', { targetId, kind: payload.kind });
    sendJson(res, 200, {
      ok: true,
      type: payload.type,
      targetId,
      rows: payload.rows,
      payload,
      vestaboard: delivery?.vestaboard || null,
    });
  }

  async function handleWeeklyWeatherPush(body, res) {
    const settings = localeSettings.get();
    let location = localeSettings.weatherLocation();
    if (!location) {
      sendJson(res, 400, { ok: false, error: 'Set the house location under Settings → Global' });
      return;
    }
    let weather = null;
    try {
      weather = await fetchWeatherForecast(location);
    } catch (error) {
      log.warn?.('Weekly weather fetch failed', error?.message || error);
    }
    if (!weather?.next7Days?.length) {
      const cached = loadWeatherCache(config);
      if (cached?.weather?.next7Days?.length) {
        weather = cached.weather;
        if (cached.location) {
          location = { ...location, ...cached.location };
        }
      }
    }
    const payload = buildWeeklyWeatherPayload({
      weather,
      location: {
        ...location,
        city: settings.city || location.city || '',
        label: settings.label || location.resolvedName || location.name,
      },
      temperatureUnit: settings.temperatureUnit,
    });
    if (!payload) {
      sendJson(res, 502, { ok: false, error: 'Weather forecast is unavailable' });
      return;
    }
    if (weather) {
      saveWeatherCache(config, { location: weather.location || location, weather }, log);
    }
    const targetId = plexTargetId(body);
    const extra = {};
    if (body?.triggeredBy === 'scheduler') {
      extra.source = 'scheduler';
      extra.explicit = false;
    } else {
      extra.explicit = true;
    }
    const delivery = typeof deliverTargetedPayload === 'function'
      ? deliverTargetedPayload(payload, targetId, extra)
      : sendUdpPayload(payload, { ...extra, targetId });
    log.info('Weekly weather report', { targetId, days: payload.days.length });
    sendJson(res, 200, {
      ok: true,
      type: payload.type,
      targetId,
      vestaboard: delivery?.vestaboard || null,
    });
  }

  function handleWeatherAlertsSettingsGet(res) {
    const locale = localeSettings.get();
    sendJson(res, 200, {
      ok: true,
      ...weatherAlerts.statusSnapshot(),
      hasLocation: localeSettings.hasLocation(),
      location: {
        city: locale.city || '',
        label: locale.label || '',
        country: locale.country || '',
        latitude: locale.latitude,
        longitude: locale.longitude,
        timeZone: locale.timeZone || '',
      },
    });
  }

  function handleWeatherAlertsSettingsPut(body, res) {
    if (body?.reset) {
      weatherAlerts.resetSettings();
      handleWeatherAlertsSettingsGet(res);
      return;
    }
    weatherAlerts.updateSettings({
      minSeverity: body?.minSeverity,
      includeWatches: body?.includeWatches,
      includeAdvisories: body?.includeAdvisories,
      maxAlerts: body?.maxAlerts,
    });
    handleWeatherAlertsSettingsGet(res);
  }

  async function handleWeatherAlertsPush(body, res) {
    const locale = localeSettings.get();
    if (!localeSettings.hasLocation()) {
      sendJson(res, 400, { ok: false, error: 'Set the house location under Settings → Global' });
      return;
    }
    let payload = null;
    try {
      payload = await weatherAlerts.nextPayload({ locale });
    } catch (error) {
      log.warn?.('Weather alerts fetch failed', error?.message || error);
      sendJson(res, 502, { ok: false, error: error?.message || 'Weather alerts are unavailable' });
      return;
    }
    if (!payload) {
      sendJson(res, 502, { ok: false, error: 'Weather alerts are unavailable' });
      return;
    }
    const targetId = plexTargetId(body);
    const extra = {};
    if (body?.triggeredBy === 'scheduler') {
      extra.source = 'scheduler';
      extra.explicit = false;
    } else {
      extra.explicit = true;
    }
    const delivery = typeof deliverTargetedPayload === 'function'
      ? deliverTargetedPayload(payload, targetId, extra)
      : sendUdpPayload(payload, { ...extra, targetId });
    log.info('Weather alerts', {
      targetId,
      mode: payload.mode,
      count: payload.alerts?.length || 0,
    });
    sendJson(res, 200, {
      ok: true,
      type: payload.type,
      targetId,
      mode: payload.mode,
      alerts: payload.alerts,
      location: payload.location,
      vestaboard: delivery?.vestaboard || null,
    });
  }

  function handleStockMarketSettingsGet(res) {
    sendJson(res, 200, { ok: true, ...stockMarket.statusSnapshot() });
  }

  function handleStockMarketSettingsPut(body, res) {
    if (body?.reset) {
      stockMarket.resetSettings();
      handleStockMarketSettingsGet(res);
      return;
    }
    stockMarket.updateSettings({
      tickers: body?.tickers,
      changeMode: body?.changeMode,
      provider: body?.provider,
      finnhubApiKey: body?.finnhubApiKey,
      clearFinnhubApiKey: body?.clearFinnhubApiKey,
    });
    handleStockMarketSettingsGet(res);
  }

  async function handleStockMarketPush(body, res) {
    let payload = null;
    try {
      payload = await stockMarket.nextPayload();
    } catch (error) {
      log.warn?.('Stock market fetch failed', error?.message || error);
      sendJson(res, 502, { ok: false, error: error?.message || 'Stock quotes are unavailable' });
      return;
    }
    if (!payload) {
      sendJson(res, 502, {
        ok: false,
        error: 'No stock quotes returned — check tickers under Settings → News',
      });
      return;
    }
    const targetId = plexTargetId(body);
    const extra = {};
    if (body?.triggeredBy === 'scheduler') {
      extra.source = 'scheduler';
      extra.explicit = false;
    } else {
      extra.explicit = true;
    }
    const delivery = typeof deliverTargetedPayload === 'function'
      ? deliverTargetedPayload(payload, targetId, extra)
      : sendUdpPayload(payload, { ...extra, targetId });
    log.info('Stock market', {
      targetId,
      count: payload.quotes?.length || 0,
      errors: payload.errors?.length || 0,
    });
    sendJson(res, 200, {
      ok: true,
      type: payload.type,
      targetId,
      quotes: payload.quotes,
      errors: payload.errors,
      asOf: payload.asOf,
      vestaboard: delivery?.vestaboard || null,
    });
  }

  function handleUsWeatherMapSettingsGet(res) {
    sendJson(res, 200, { ok: true, ...usWeatherMap.statusSnapshot() });
  }

  function handleUsWeatherMapSettingsPut(body, res) {
    if (body?.reset) {
      usWeatherMap.resetSettings();
      handleUsWeatherMapSettingsGet(res);
      return;
    }
    usWeatherMap.updateSettings({
      mode: body?.mode,
      refreshMinutes: body?.refreshMinutes,
    });
    handleUsWeatherMapSettingsGet(res);
  }

  async function handleUsWeatherMapPush(body, res) {
    let payload = null;
    try {
      payload = await usWeatherMap.nextPayload({
        // The settings card's own test button asks for a fresh read; the
        // scheduler is happy with whatever is cached.
        force: body?.force === true,
        mode: body?.mode,
      });
    } catch (error) {
      log.warn?.('US Weather Map fetch failed', error?.message || error);
      sendJson(res, 502, { ok: false, error: error?.message || 'The weather map is unavailable' });
      return;
    }
    if (!payload) {
      sendJson(res, 502, {
        ok: false,
        error: 'The weather map came back incomplete — try again in a moment',
      });
      return;
    }
    const targetId = plexTargetId(body);
    const extra = {};
    if (body?.triggeredBy === 'scheduler') {
      extra.source = 'scheduler';
      extra.explicit = false;
    } else {
      extra.explicit = true;
    }
    const delivery = typeof deliverTargetedPayload === 'function'
      ? deliverTargetedPayload(payload, targetId, extra)
      : sendUdpPayload(payload, { ...extra, targetId });
    log.info('US Weather Map', {
      targetId,
      mode: payload.mode,
      cells: payload.cells?.length || 0,
      range: payload.range ? `${payload.range.minF}-${payload.range.maxF}F` : null,
    });
    sendJson(res, 200, {
      ok: true,
      type: payload.type,
      targetId,
      mode: payload.mode,
      unit: payload.unit,
      range: payload.range,
      cells: payload.cells,
      asOf: payload.asOf,
      vestaboard: delivery?.vestaboard || null,
    });
  }

  function handleCurrencyRatesSettingsGet(res) {
    sendJson(res, 200, { ok: true, ...currencyRates.statusSnapshot(localeSettings.get()) });
  }

  function handleCurrencyRatesSettingsPut(body, res) {
    if (body?.reset) {
      currencyRates.resetSettings();
      handleCurrencyRatesSettingsGet(res);
      return;
    }
    currencyRates.updateSettings({
      quotes: body?.quotes,
    });
    handleCurrencyRatesSettingsGet(res);
  }

  async function handleCurrencyRatesPush(body, res) {
    let payload = null;
    const base = localeSettings.get().currencyCode || 'USD';
    try {
      payload = await currencyRates.nextPayload({ base });
    } catch (error) {
      log.warn?.('Currency rates fetch failed', error?.message || error);
      sendJson(res, 502, { ok: false, error: error?.message || 'Currency rates are unavailable' });
      return;
    }
    if (!payload) {
      sendJson(res, 502, {
        ok: false,
        error: 'No currency quotes returned — check the list under Settings → News',
      });
      return;
    }
    const targetId = plexTargetId(body);
    const extra = {};
    if (body?.triggeredBy === 'scheduler') {
      extra.source = 'scheduler';
      extra.explicit = false;
    } else {
      extra.explicit = true;
    }
    const delivery = typeof deliverTargetedPayload === 'function'
      ? deliverTargetedPayload(payload, targetId, extra)
      : sendUdpPayload(payload, { ...extra, targetId });
    log.info('Currency rates', {
      targetId,
      base: payload.base,
      count: payload.quotes?.length || 0,
      source: payload.source,
    });
    sendJson(res, 200, {
      ok: true,
      type: payload.type,
      targetId,
      base: payload.base,
      quotes: payload.quotes,
      source: payload.source,
      asOf: payload.asOf,
      vestaboard: delivery?.vestaboard || null,
    });
  }

  function handleIssTrackerSettingsGet(res) {
    sendJson(res, 200, {
      ok: true,
      ...issTracker.statusSnapshot(localeSettings.get()),
      location: {
        city: localeSettings.get().city || '',
        label: localeSettings.get().label || '',
        latitude: localeSettings.get().latitude,
        longitude: localeSettings.get().longitude,
      },
    });
  }

  function handleIssTrackerSettingsPut(body, res) {
    if (body?.reset) {
      issTracker.resetSettings();
      handleIssTrackerSettingsGet(res);
      return;
    }
    issTracker.updateSettings({
      distanceUnit: body?.distanceUnit,
      showAltitude: body?.showAltitude,
      showCoordinates: body?.showCoordinates,
      showVisibility: body?.showVisibility,
    });
    handleIssTrackerSettingsGet(res);
  }

  async function handleIssTrackerPush(body, res) {
    let payload = null;
    try {
      payload = await issTracker.nextPayload({ locale: localeSettings.get() });
    } catch (error) {
      log.warn?.('ISS tracker fetch failed', error?.message || error);
      sendJson(res, 502, { ok: false, error: error?.message || 'ISS position is unavailable' });
      return;
    }
    if (!payload) {
      sendJson(res, 502, { ok: false, error: 'ISS position is unavailable' });
      return;
    }
    const targetId = plexTargetId(body);
    const extra = {};
    if (body?.triggeredBy === 'scheduler') {
      extra.source = 'scheduler';
      extra.explicit = false;
    } else {
      extra.explicit = true;
    }
    const delivery = typeof deliverTargetedPayload === 'function'
      ? deliverTargetedPayload(payload, targetId, extra)
      : sendUdpPayload(payload, { ...extra, targetId });
    log.info('ISS tracker', {
      targetId,
      source: payload.source,
      relative: payload.relativeLabel || null,
    });
    sendJson(res, 200, {
      ok: true,
      type: payload.type,
      targetId,
      latitude: payload.latitude,
      longitude: payload.longitude,
      relativeLabel: payload.relativeLabel,
      speedLabel: payload.speedLabel,
      altitudeLabel: payload.altitudeLabel,
      source: payload.source,
      asOf: payload.asOf,
      vestaboard: delivery?.vestaboard || null,
    });
  }

  function handleStarlinkTrackerSettingsGet(res) {
    sendJson(res, 200, {
      ok: true,
      ...starlinkTracker.statusSnapshot(localeSettings.get()),
      location: {
        city: localeSettings.get().city || '',
        label: localeSettings.get().label || '',
        latitude: localeSettings.get().latitude,
        longitude: localeSettings.get().longitude,
        timeZone: localeSettings.get().timeZone || '',
      },
    });
  }

  function handleStarlinkTrackerSettingsPut(body, res) {
    if (body?.reset) {
      starlinkTracker.resetSettings();
      handleStarlinkTrackerSettingsGet(res);
      return;
    }
    starlinkTracker.updateSettings({
      hoursAhead: body?.hoursAhead,
      minElevation: body?.minElevation,
      sampleSize: body?.sampleSize,
      preferVisible: body?.preferVisible,
      showWeather: body?.showWeather,
      showVisibility: body?.showVisibility,
    });
    handleStarlinkTrackerSettingsGet(res);
  }

  async function handleStarlinkTrackerPush(body, res) {
    if (!localeSettings.hasLocation()) {
      sendJson(res, 400, { ok: false, error: 'Set the house location under Settings → Global' });
      return;
    }
    let payload = null;
    try {
      payload = await starlinkTracker.nextPayload({
        locale: localeSettings.get(),
        weatherFetch: fetchWeatherForecast,
      });
    } catch (error) {
      log.warn?.('Starlink tracker fetch failed', error?.message || error);
      sendJson(res, 502, { ok: false, error: error?.message || 'Starlink passes are unavailable' });
      return;
    }
    if (!payload) {
      sendJson(res, 502, { ok: false, error: 'Starlink passes are unavailable' });
      return;
    }
    const targetId = plexTargetId(body);
    const extra = {};
    if (body?.triggeredBy === 'scheduler') {
      extra.source = 'scheduler';
      extra.explicit = false;
    } else {
      extra.explicit = true;
    }
    const delivery = typeof deliverTargetedPayload === 'function'
      ? deliverTargetedPayload(payload, targetId, extra)
      : sendUdpPayload(payload, { ...extra, targetId });
    log.info('Starlink tracker', {
      targetId,
      when: payload.whenLabel,
      direction: payload.direction,
      mode: payload.mode || 'pass',
    });
    sendJson(res, 200, {
      ok: true,
      type: payload.type,
      targetId,
      whenLabel: payload.whenLabel,
      directionLabel: payload.directionLabel,
      weatherLabel: payload.weatherLabel,
      visibilityBoard: payload.visibilityBoard,
      mode: payload.mode || 'pass',
      source: payload.source,
      asOf: payload.asOf,
      vestaboard: delivery?.vestaboard || null,
    });
  }

  function handleSpaceLaunchAlertsSettingsGet(res) {
    sendJson(res, 200, {
      ok: true,
      ...spaceLaunchAlerts.statusSnapshot(),
    });
  }

  async function handleSpaceLaunchAlertsSettingsPut(body, res) {
    if (body?.reset) {
      spaceLaunchAlerts.resetSettings();
      handleSpaceLaunchAlertsSettingsGet(res);
      return;
    }
    if (body?.refresh) {
      try {
        await spaceLaunchAlerts.refreshCache({ force: true });
      } catch (error) {
        sendJson(res, 502, { ok: false, error: error?.message || 'Could not refresh launch cache' });
        return;
      }
    } else {
      spaceLaunchAlerts.updateSettings({
        hoursAhead: body?.hoursAhead,
        refreshHours: body?.refreshHours,
        chipColor: body?.chipColor,
        includeSuborbital: body?.includeSuborbital,
      });
    }
    handleSpaceLaunchAlertsSettingsGet(res);
  }

  async function handleSpaceLaunchAlertsPush(body, res) {
    let payload = null;
    try {
      payload = await spaceLaunchAlerts.nextPayload({
        launchId: body?.launchId || body?.id,
        forceRefresh: Boolean(body?.refresh),
      });
    } catch (error) {
      log.warn?.('Space Launch Alerts fetch failed', error?.message || error);
      sendJson(res, 502, { ok: false, error: error?.message || 'Launch data is unavailable' });
      return;
    }
    if (!payload) {
      sendJson(res, 409, {
        ok: false,
        error: 'No upcoming launches fit the board — open Settings → Travel',
      });
      return;
    }
    const targetId = plexTargetId(body);
    const extra = {};
    if (body?.triggeredBy === 'scheduler') {
      extra.source = 'scheduler';
      extra.explicit = false;
    } else {
      extra.explicit = true;
    }
    const delivery = typeof deliverTargetedPayload === 'function'
      ? deliverTargetedPayload(payload, targetId, extra)
      : sendUdpPayload(payload, { ...extra, targetId });
    log.info('Space launch alert', {
      targetId,
      id: payload.launch?.id,
      net: payload.launch?.net,
      rocket: payload.launch?.rocket,
    });
    sendJson(res, 200, {
      ok: true,
      type: payload.type,
      targetId,
      launch: payload.launch,
      asOf: payload.asOf,
      vestaboard: delivery?.vestaboard || null,
    });
  }

  function handleLearnJapaneseSettingsGet(res) {
    sendJson(res, 200, { ok: true, ...learnJapanese.statusSnapshot() });
  }

  function handleLearnJapaneseSettingsPut(body, res) {
    const settings = learnJapanese.updateSettings({
      levels: body?.levels,
      partsOfSpeech: body?.partsOfSpeech,
    });
    sendJson(res, 200, { ok: true, ...learnJapanese.statusSnapshot(), settings });
  }

  function learnLanguageService(commandOrLang) {
    const spec = languageOf(commandOrLang);
    return spec ? learnLanguages[spec.commandId] : null;
  }

  function handleLearnLanguageSettingsGet(languageId, res) {
    const service = learnLanguageService(languageId);
    if (!service) {
      sendJson(res, 404, { ok: false, error: 'Unknown language' });
      return;
    }
    sendJson(res, 200, { ok: true, ...service.statusSnapshot() });
  }

  function handleLearnLanguageSettingsPut(languageId, body, res) {
    const service = learnLanguageService(languageId);
    if (!service) {
      sendJson(res, 404, { ok: false, error: 'Unknown language' });
      return;
    }
    const settings = service.updateSettings({
      levels: body?.levels,
      partsOfSpeech: body?.partsOfSpeech,
    });
    sendJson(res, 200, { ok: true, ...service.statusSnapshot(), settings });
  }

  function handleLearnLanguagePush(languageId, body, res) {
    const service = learnLanguageService(languageId);
    if (!service) {
      sendJson(res, 404, { ok: false, error: 'Unknown language' });
      return;
    }
    const payload = service.nextPayload();
    if (!payload) {
      sendJson(res, 409, {
        ok: false,
        error: `No ${service.spec.title.replace(/^Learn /, '')} words match the current filters — open Settings → Language`,
      });
      return;
    }
    const targetId = plexTargetId(body);
    const extra = {};
    if (body?.triggeredBy === 'scheduler') {
      extra.source = 'scheduler';
      extra.explicit = false;
    } else {
      extra.explicit = true;
    }
    const delivery = typeof deliverTargetedPayload === 'function'
      ? deliverTargetedPayload(payload, targetId, extra)
      : sendUdpPayload(payload, { ...extra, targetId });
    log.info(service.spec.title, {
      targetId,
      word: payload.word.word,
      pos: payload.word.pos,
    });
    sendJson(res, 200, {
      ok: true,
      type: payload.type,
      targetId,
      word: payload.word,
      vestaboard: delivery?.vestaboard || null,
    });
  }

  function handleWordRiddlesGet(query, res) {
    sendJson(res, 200, { ok: true, ...wordRiddles.statusSnapshot({
      query: query?.q || query?.query,
      page: query?.page,
      pageSize: query?.pageSize,
      hidden: query?.hidden === '1' || query?.hidden === 'true',
    }) });
  }

  function handleWordRiddlePost(body, res) {
    const result = wordRiddles.addRiddle(body?.riddle, body?.answer);
    sendJson(res, result.ok ? 200 : 400, result);
  }

  function handleWordRiddlePut(body, res) {
    const result = wordRiddles.updateRiddle(body?.id, {
      riddle: body?.riddle,
      answer: body?.answer,
      hidden: body?.hidden,
      remove: body?.remove,
    });
    sendJson(res, result.ok ? 200 : 400, result);
  }

  function handleWordRiddlesSettingsPut(body, res) {
    const result = wordRiddles.updateSettings({
      revealDelaySeconds: body?.revealDelaySeconds,
      showIntro: body?.showIntro,
    });
    sendJson(res, result.ok ? 200 : 400, result);
  }

  function handleWordRiddlesPush(body, res) {
    const payload = wordRiddles.nextPayload({
      revealDelaySeconds: body?.revealDelaySeconds,
      showIntro: body?.showIntro,
    });
    if (!payload) {
      sendJson(res, 409, {
        ok: false,
        error: 'No Word Riddles are left — open Settings → Game night',
      });
      return;
    }
    const targetId = plexTargetId(body);
    const extra = {};
    if (body?.triggeredBy === 'scheduler') {
      extra.source = 'scheduler';
      extra.explicit = false;
    } else {
      extra.explicit = true;
    }
    const delivery = typeof deliverTargetedPayload === 'function'
      ? deliverTargetedPayload(payload, targetId, extra)
      : sendUdpPayload(payload, { ...extra, targetId });
    log.info('Word riddle', { targetId, id: payload.riddle.id });
    sendJson(res, 200, {
      ok: true,
      type: payload.type,
      targetId,
      riddle: payload.riddle,
      revealDelaySeconds: payload.revealDelaySeconds,
      showIntro: payload.showIntro,
      vestaboard: delivery?.vestaboard || null,
    });
  }

  function handleChuckNorrisFactsGet(query, res) {
    sendJson(res, 200, { ok: true, ...chuckNorris.statusSnapshot({
      query: query?.q || query?.query,
      page: query?.page,
      pageSize: query?.pageSize,
      hidden: query?.hidden === '1' || query?.hidden === 'true',
    }) });
  }

  function handleChuckNorrisFactPost(body, res) {
    const result = chuckNorris.addFact(body?.text);
    sendJson(res, result.ok ? 200 : 400, result);
  }

  function handleChuckNorrisFactPut(body, res) {
    const result = chuckNorris.updateFact(body?.id, {
      text: body?.text,
      hidden: body?.hidden,
      remove: body?.remove,
    });
    sendJson(res, result.ok ? 200 : 400, result);
  }

  function handleChuckNorrisPush(body, res) {
    const payload = chuckNorris.nextPayload();
    if (!payload) {
      sendJson(res, 409, {
        ok: false,
        error: 'No Chuck Norris facts are left — open Settings → News',
      });
      return;
    }
    const targetId = plexTargetId(body);
    const extra = {};
    if (body?.triggeredBy === 'scheduler') {
      extra.source = 'scheduler';
      extra.explicit = false;
    } else {
      extra.explicit = true;
    }
    const delivery = typeof deliverTargetedPayload === 'function'
      ? deliverTargetedPayload(payload, targetId, extra)
      : sendUdpPayload(payload, { ...extra, targetId });
    log.info('Chuck Norris fun fact', { targetId, id: payload.fact.id });
    sendJson(res, 200, {
      ok: true,
      type: payload.type,
      targetId,
      fact: payload.fact,
      vestaboard: delivery?.vestaboard || null,
    });
  }

  function handleRoastMeGet(query, res) {
    sendJson(res, 200, { ok: true, ...roastMe.statusSnapshot({
      query: query?.q || query?.query,
      page: query?.page,
      pageSize: query?.pageSize,
      hidden: query?.hidden === '1' || query?.hidden === 'true',
    }) });
  }

  function handleRoastMePost(body, res) {
    const result = roastMe.addRoast(body?.text);
    sendJson(res, result.ok ? 200 : 400, result);
  }

  function handleRoastMePut(body, res) {
    const result = roastMe.updateRoast(body?.id, {
      text: body?.text,
      hidden: body?.hidden,
      remove: body?.remove,
    });
    sendJson(res, result.ok ? 200 : 400, result);
  }

  function handleRoastMePush(body, res) {
    const payload = roastMe.nextPayload();
    if (!payload) {
      sendJson(res, 409, {
        ok: false,
        error: 'No roasts are left — open Settings → News',
      });
      return;
    }
    const targetId = plexTargetId(body);
    const extra = {};
    if (body?.triggeredBy === 'scheduler') {
      extra.source = 'scheduler';
      extra.explicit = false;
    } else {
      extra.explicit = true;
    }
    const delivery = typeof deliverTargetedPayload === 'function'
      ? deliverTargetedPayload(payload, targetId, extra)
      : sendUdpPayload(payload, { ...extra, targetId });
    log.info('Roast Me', { targetId, id: payload.roast.id });
    sendJson(res, 200, {
      ok: true,
      type: payload.type,
      targetId,
      roast: payload.roast,
      vestaboard: delivery?.vestaboard || null,
    });
  }

  function handleFamilyQuotesGet(query, res) {
    sendJson(res, 200, { ok: true, ...familyQuotes.statusSnapshot({
      query: query?.q || query?.query,
      page: query?.page,
      pageSize: query?.pageSize,
      hidden: query?.hidden === '1' || query?.hidden === 'true',
    }) });
  }

  function handleFamilyQuotePost(body, res) {
    const result = familyQuotes.addQuote(body?.text, body?.author);
    sendJson(res, result.ok ? 200 : 400, result);
  }

  function handleFamilyQuotePut(body, res) {
    const result = familyQuotes.updateQuote(body?.id, {
      text: body?.text,
      author: body?.author,
      hidden: body?.hidden,
      remove: body?.remove,
    });
    sendJson(res, result.ok ? 200 : 400, result);
  }

  function handleFamilyQuotesPush(body, res) {
    const payload = familyQuotes.nextPayload();
    if (!payload) {
      sendJson(res, 409, {
        ok: false,
        error: 'No family quotes are left — open Settings → News',
      });
      return;
    }
    const targetId = plexTargetId(body);
    const extra = {};
    if (body?.triggeredBy === 'scheduler') {
      extra.source = 'scheduler';
      extra.explicit = false;
    } else {
      extra.explicit = true;
    }
    const delivery = typeof deliverTargetedPayload === 'function'
      ? deliverTargetedPayload(payload, targetId, extra)
      : sendUdpPayload(payload, { ...extra, targetId });
    log.info('Family quote', { targetId, id: payload.quote.id });
    sendJson(res, 200, {
      ok: true,
      type: payload.type,
      targetId,
      quote: payload.quote,
      vestaboard: delivery?.vestaboard || null,
    });
  }

  function handleMisheardLyricsGet(query, res) {
    sendJson(res, 200, { ok: true, ...misheardLyrics.statusSnapshot({
      query: query?.q || query?.query,
      page: query?.page,
      pageSize: query?.pageSize,
      hidden: query?.hidden === '1' || query?.hidden === 'true',
    }) });
  }

  function handleWarmFuzziesGet(query, res) {
    sendJson(res, 200, { ok: true, ...warmFuzzies.statusSnapshot({
      query: query?.q || query?.query,
      page: query?.page,
      pageSize: query?.pageSize,
      hidden: query?.hidden === '1' || query?.hidden === 'true',
    }) });
  }

  function handleWarmFuzzyPost(body, res) {
    const result = warmFuzzies.addFuzzy(body?.text);
    sendJson(res, result.ok ? 200 : 400, result);
  }

  function handleWarmFuzzyPut(body, res) {
    const result = warmFuzzies.updateFuzzy(body?.id, {
      text: body?.text,
      hidden: body?.hidden,
      remove: body?.remove,
    });
    sendJson(res, result.ok ? 200 : 400, result);
  }

  function handleWarmFuzziesPush(body, res) {
    const payload = warmFuzzies.nextPayload();
    if (!payload) {
      sendJson(res, 409, {
        ok: false,
        error: 'No warm fuzzies are left — open Settings → News',
      });
      return;
    }
    const targetId = plexTargetId(body);
    const extra = {};
    if (body?.triggeredBy === 'scheduler') {
      extra.source = 'scheduler';
      extra.explicit = false;
    } else {
      extra.explicit = true;
    }
    const delivery = typeof deliverTargetedPayload === 'function'
      ? deliverTargetedPayload(payload, targetId, extra)
      : sendUdpPayload(payload, { ...extra, targetId });
    log.info('Warm fuzzy', { targetId, id: payload.fuzzy.id });
    sendJson(res, 200, {
      ok: true,
      type: payload.type,
      targetId,
      fuzzy: payload.fuzzy,
      vestaboard: delivery?.vestaboard || null,
    });
  }

  function handleDailyBucketFillersGet(query, res) {
    sendJson(res, 200, { ok: true, ...dailyBucketFillers.statusSnapshot({
      query: query?.q || query?.query,
      page: query?.page,
      pageSize: query?.pageSize,
      hidden: query?.hidden === '1' || query?.hidden === 'true',
    }) });
  }

  function handleDailyBucketFillerPost(body, res) {
    const result = dailyBucketFillers.addFiller(body?.text);
    sendJson(res, result.ok ? 200 : 400, result);
  }

  function handleDailyBucketFillerPut(body, res) {
    const result = dailyBucketFillers.updateFiller(body?.id, {
      text: body?.text,
      hidden: body?.hidden,
      remove: body?.remove,
    });
    sendJson(res, result.ok ? 200 : 400, result);
  }

  function handleDailyBucketFillersPush(body, res) {
    const payload = dailyBucketFillers.nextPayload();
    if (!payload) {
      sendJson(res, 409, {
        ok: false,
        error: 'No bucket fillers are left — open Settings → News',
      });
      return;
    }
    const targetId = plexTargetId(body);
    const extra = {};
    if (body?.triggeredBy === 'scheduler') {
      extra.source = 'scheduler';
      extra.explicit = false;
    } else {
      extra.explicit = true;
    }
    const delivery = typeof deliverTargetedPayload === 'function'
      ? deliverTargetedPayload(payload, targetId, extra)
      : sendUdpPayload(payload, { ...extra, targetId });
    log.info('Daily bucket filler', { targetId, id: payload.filler.id });
    sendJson(res, 200, {
      ok: true,
      type: payload.type,
      targetId,
      filler: payload.filler,
      vestaboard: delivery?.vestaboard || null,
    });
  }

  function handleMisheardLyricPost(body, res) {
    const result = misheardLyrics.addLyric(body?.text, body?.artist);
    sendJson(res, result.ok ? 200 : 400, result);
  }

  function handleMisheardLyricPut(body, res) {
    const result = misheardLyrics.updateLyric(body?.id, {
      text: body?.text,
      artist: body?.artist,
      hidden: body?.hidden,
      remove: body?.remove,
    });
    sendJson(res, result.ok ? 200 : 400, result);
  }

  function handleMisheardLyricsPush(body, res) {
    const payload = misheardLyrics.nextPayload();
    if (!payload) {
      sendJson(res, 409, {
        ok: false,
        error: 'No misheard lyrics are left — open Settings → News',
      });
      return;
    }
    const targetId = plexTargetId(body);
    const extra = {};
    if (body?.triggeredBy === 'scheduler') {
      extra.source = 'scheduler';
      extra.explicit = false;
    } else {
      extra.explicit = true;
    }
    const delivery = typeof deliverTargetedPayload === 'function'
      ? deliverTargetedPayload(payload, targetId, extra)
      : sendUdpPayload(payload, { ...extra, targetId });
    log.info('Misheard lyric', { targetId, id: payload.lyric.id });
    sendJson(res, 200, {
      ok: true,
      type: payload.type,
      targetId,
      lyric: payload.lyric,
      vestaboard: delivery?.vestaboard || null,
    });
  }

  function handlePeriodicTableGet(_query, res) {
    sendJson(res, 200, { ok: true, ...periodicTable.statusSnapshot() });
  }

  function handlePeriodicTableSettingsPost(body, res) {
    if (body?.reset) {
      periodicTable.updateSettings({ categories: [], recentIds: [] });
      sendJson(res, 200, { ok: true, ...periodicTable.statusSnapshot() });
      return;
    }
    periodicTable.updateSettings({
      categories: body?.categories,
    });
    sendJson(res, 200, { ok: true, ...periodicTable.statusSnapshot() });
  }

  function handlePeriodicTablePush(body, res) {
    const payload = periodicTable.nextPayload({
      id: body?.id,
      number: body?.number,
      symbol: body?.symbol,
    });
    if (!payload) {
      sendJson(res, 409, {
        ok: false,
        error: 'No periodic table elements match your filters — open Settings → News',
      });
      return;
    }
    const targetId = plexTargetId(body);
    const extra = {};
    if (body?.triggeredBy === 'scheduler') {
      extra.source = 'scheduler';
      extra.explicit = false;
    } else {
      extra.explicit = true;
    }
    const delivery = typeof deliverTargetedPayload === 'function'
      ? deliverTargetedPayload(payload, targetId, extra)
      : sendUdpPayload(payload, { ...extra, targetId });
    log.info('Periodic table element', { targetId, id: payload.element.id, number: payload.element.number });
    sendJson(res, 200, {
      ok: true,
      type: payload.type,
      targetId,
      element: payload.element,
      vestaboard: delivery?.vestaboard || null,
    });
  }

  function handleUsStateFactsGet(_query, res) {
    sendJson(res, 200, { ok: true, ...usStateFacts.statusSnapshot() });
  }

  function handleUsStateFactsSettingsPost(body, res) {
    if (body?.reset) {
      usStateFacts.updateSettings({ regions: [], recentIds: [] });
      sendJson(res, 200, { ok: true, ...usStateFacts.statusSnapshot() });
      return;
    }
    usStateFacts.updateSettings({
      regions: body?.regions,
    });
    sendJson(res, 200, { ok: true, ...usStateFacts.statusSnapshot() });
  }

  function handleUsStateFactsPush(body, res) {
    const payload = usStateFacts.nextPayload({
      id: body?.id,
      name: body?.name,
    });
    if (!payload) {
      sendJson(res, 409, {
        ok: false,
        error: 'No US state facts match your filters — open Settings → News',
      });
      return;
    }
    const targetId = plexTargetId(body);
    const extra = {};
    if (body?.triggeredBy === 'scheduler') {
      extra.source = 'scheduler';
      extra.explicit = false;
    } else {
      extra.explicit = true;
    }
    const delivery = typeof deliverTargetedPayload === 'function'
      ? deliverTargetedPayload(payload, targetId, extra)
      : sendUdpPayload(payload, { ...extra, targetId });
    log.info('US State Facts', { targetId, id: payload.state.id, name: payload.state.name });
    sendJson(res, 200, {
      ok: true,
      type: payload.type,
      targetId,
      state: payload.state,
      vestaboard: delivery?.vestaboard || null,
    });
  }

  function handleWordOfTheDayGet(query, res) {
    sendJson(res, 200, { ok: true, ...wordOfTheDay.statusSnapshot({
      query: query?.q || query?.query,
      limit: query?.limit,
    }) });
  }

  function handleWordOfTheDaySettingsPost(body, res) {
    if (body?.reset) {
      wordOfTheDay.updateSettings({ partsOfSpeech: [], recentIds: [] });
      sendJson(res, 200, { ok: true, ...wordOfTheDay.statusSnapshot() });
      return;
    }
    wordOfTheDay.updateSettings({
      partsOfSpeech: body?.partsOfSpeech,
    });
    sendJson(res, 200, { ok: true, ...wordOfTheDay.statusSnapshot() });
  }

  function handleWordOfTheDayPush(body, res) {
    const payload = wordOfTheDay.nextPayload({
      id: body?.id,
      word: body?.word,
    });
    if (!payload) {
      sendJson(res, 409, {
        ok: false,
        error: 'No Word of the Day entries match your filters — open Settings → News',
      });
      return;
    }
    const targetId = plexTargetId(body);
    const extra = {};
    if (body?.triggeredBy === 'scheduler') {
      extra.source = 'scheduler';
      extra.explicit = false;
    } else {
      extra.explicit = true;
    }
    const delivery = typeof deliverTargetedPayload === 'function'
      ? deliverTargetedPayload(payload, targetId, extra)
      : sendUdpPayload(payload, { ...extra, targetId });
    log.info('Word of the Day', { targetId, id: payload.entry.id, word: payload.entry.word });
    sendJson(res, 200, {
      ok: true,
      type: payload.type,
      targetId,
      entry: payload.entry,
      vestaboard: delivery?.vestaboard || null,
    });
  }

  function handleDadJokesGet(query, res) {
    sendJson(res, 200, { ok: true, ...dadJokes.statusSnapshot({
      query: query?.q || query?.query,
      page: query?.page,
      pageSize: query?.pageSize,
      hidden: query?.hidden === '1' || query?.hidden === 'true',
    }) });
  }

  function handleDadJokePost(body, res) {
    const result = dadJokes.addJoke(body?.setup, body?.punchline);
    sendJson(res, result.ok ? 200 : 400, result);
  }

  function handleDadJokePut(body, res) {
    const result = dadJokes.updateJoke(body?.id, {
      setup: body?.setup,
      punchline: body?.punchline,
      hidden: body?.hidden,
      remove: body?.remove,
    });
    sendJson(res, result.ok ? 200 : 400, result);
  }

  function handleDadJokesPush(body, res) {
    const payload = dadJokes.nextPayload();
    if (!payload) {
      sendJson(res, 409, {
        ok: false,
        error: 'No dad jokes are left — open Settings → News',
      });
      return;
    }
    const targetId = plexTargetId(body);
    const extra = {};
    if (body?.triggeredBy === 'scheduler') {
      extra.source = 'scheduler';
      extra.explicit = false;
    } else {
      extra.explicit = true;
    }
    const delivery = typeof deliverTargetedPayload === 'function'
      ? deliverTargetedPayload(payload, targetId, extra)
      : sendUdpPayload(payload, { ...extra, targetId });
    log.info('Dad joke', { targetId, id: payload.joke.id });
    sendJson(res, 200, {
      ok: true,
      type: payload.type,
      targetId,
      joke: payload.joke,
      vestaboard: delivery?.vestaboard || null,
    });
  }

  function handleAmazingFactsGet(query, res) {
    sendJson(res, 200, { ok: true, ...amazingFacts.statusSnapshot({
      query: query?.q || query?.query,
      page: query?.page,
      pageSize: query?.pageSize,
      hidden: query?.hidden === '1' || query?.hidden === 'true',
      category: query?.category,
    }) });
  }

  function handleAmazingFactPost(body, res) {
    if (body?.categories != null || body?.filters) {
      const result = amazingFacts.updateFilters({
        categories: body?.categories,
      });
      sendJson(res, result.ok ? 200 : 400, result);
      return;
    }
    const result = amazingFacts.addFact(body?.text, body?.category);
    sendJson(res, result.ok ? 200 : 400, result);
  }

  function handleAmazingFactPut(body, res) {
    const result = amazingFacts.updateFact(body?.id, {
      text: body?.text,
      hidden: body?.hidden,
      category: body?.category,
      remove: body?.remove,
    });
    sendJson(res, result.ok ? 200 : 400, result);
  }

  function handleAmazingFactsPush(body, res) {
    const payload = amazingFacts.nextPayload();
    if (!payload) {
      sendJson(res, 409, {
        ok: false,
        error: 'No Amazing Facts are left — open Settings → News',
      });
      return;
    }
    const targetId = plexTargetId(body);
    const extra = {};
    if (body?.triggeredBy === 'scheduler') {
      extra.source = 'scheduler';
      extra.explicit = false;
    } else {
      extra.explicit = true;
    }
    const delivery = typeof deliverTargetedPayload === 'function'
      ? deliverTargetedPayload(payload, targetId, extra)
      : sendUdpPayload(payload, { ...extra, targetId });
    log.info('Amazing fact', { targetId, id: payload.fact.id, category: payload.fact.category });
    sendJson(res, 200, {
      ok: true,
      type: payload.type,
      targetId,
      fact: payload.fact,
      vestaboard: delivery?.vestaboard || null,
    });
  }

  function handleWorldGeographyFactsGet(query, res) {
    sendJson(res, 200, { ok: true, ...worldGeographyFacts.statusSnapshot({
      query: query?.q || query?.query,
      page: query?.page,
      pageSize: query?.pageSize,
      hidden: query?.hidden === '1' || query?.hidden === 'true',
      category: query?.category,
    }) });
  }

  function handleWorldGeographyFactPost(body, res) {
    if (body?.categories != null || body?.filters) {
      const result = worldGeographyFacts.updateFilters({
        categories: body?.categories,
      });
      sendJson(res, result.ok ? 200 : 400, result);
      return;
    }
    const result = worldGeographyFacts.addFact(body?.text, body?.category);
    sendJson(res, result.ok ? 200 : 400, result);
  }

  function handleWorldGeographyFactPut(body, res) {
    const result = worldGeographyFacts.updateFact(body?.id, {
      text: body?.text,
      hidden: body?.hidden,
      category: body?.category,
      remove: body?.remove,
    });
    sendJson(res, result.ok ? 200 : 400, result);
  }

  function handleWorldGeographyFactsPush(body, res) {
    const payload = worldGeographyFacts.nextPayload();
    if (!payload) {
      sendJson(res, 409, {
        ok: false,
        error: 'No World Geography Facts are left — open Settings → News',
      });
      return;
    }
    const targetId = plexTargetId(body);
    const extra = {};
    if (body?.triggeredBy === 'scheduler') {
      extra.source = 'scheduler';
      extra.explicit = false;
    } else {
      extra.explicit = true;
    }
    const delivery = typeof deliverTargetedPayload === 'function'
      ? deliverTargetedPayload(payload, targetId, extra)
      : sendUdpPayload(payload, { ...extra, targetId });
    log.info('World geography fact', { targetId, id: payload.fact.id, category: payload.fact.category });
    sendJson(res, 200, {
      ok: true,
      type: payload.type,
      targetId,
      fact: payload.fact,
      vestaboard: delivery?.vestaboard || null,
    });
  }

  function handleConversationStartersGet(query, res) {
    sendJson(res, 200, { ok: true, ...conversationStarters.statusSnapshot({
      query: query?.q || query?.query,
      page: query?.page,
      pageSize: query?.pageSize,
      hidden: query?.hidden === '1' || query?.hidden === 'true',
    }) });
  }

  function handleConversationStarterPost(body, res) {
    const result = conversationStarters.addPrompt(body?.text);
    sendJson(res, result.ok ? 200 : 400, result);
  }

  function handleConversationStarterPut(body, res) {
    const result = conversationStarters.updatePrompt(body?.id, {
      text: body?.text,
      hidden: body?.hidden,
      remove: body?.remove,
    });
    sendJson(res, result.ok ? 200 : 400, result);
  }

  function handleConversationStartersPush(body, res) {
    const payload = conversationStarters.nextPayload();
    if (!payload) {
      sendJson(res, 409, {
        ok: false,
        error: 'No conversation starters are left — open Settings → News',
      });
      return;
    }
    const targetId = plexTargetId(body);
    const extra = {};
    if (body?.triggeredBy === 'scheduler') {
      extra.source = 'scheduler';
      extra.explicit = false;
    } else {
      extra.explicit = true;
    }
    const delivery = typeof deliverTargetedPayload === 'function'
      ? deliverTargetedPayload(payload, targetId, extra)
      : sendUdpPayload(payload, { ...extra, targetId });
    log.info('Conversation starter', { targetId, id: payload.prompt.id });
    sendJson(res, 200, {
      ok: true,
      type: payload.type,
      targetId,
      prompt: payload.prompt,
      vestaboard: delivery?.vestaboard || null,
    });
  }

  function handleStoicQuotesGet(query, res) {
    sendJson(res, 200, { ok: true, ...stoicQuotes.statusSnapshot({
      query: query?.q || query?.query,
      page: query?.page,
      pageSize: query?.pageSize,
      hidden: query?.hidden === '1' || query?.hidden === 'true',
    }) });
  }

  function handleStoicQuotePost(body, res) {
    const result = stoicQuotes.addQuote(body?.text, body?.author);
    sendJson(res, result.ok ? 200 : 400, result);
  }

  function handleStoicQuotePut(body, res) {
    const result = stoicQuotes.updateQuote(body?.id, {
      text: body?.text,
      author: body?.author,
      hidden: body?.hidden,
      remove: body?.remove,
    });
    sendJson(res, result.ok ? 200 : 400, result);
  }

  function handleStoicQuotesPush(body, res) {
    const payload = stoicQuotes.nextPayload();
    if (!payload) {
      sendJson(res, 409, {
        ok: false,
        error: 'No Stoic quotes are left — open Settings → News',
      });
      return;
    }
    const targetId = plexTargetId(body);
    const extra = {};
    if (body?.triggeredBy === 'scheduler') {
      extra.source = 'scheduler';
      extra.explicit = false;
    } else {
      extra.explicit = true;
    }
    const delivery = typeof deliverTargetedPayload === 'function'
      ? deliverTargetedPayload(payload, targetId, extra)
      : sendUdpPayload(payload, { ...extra, targetId });
    log.info('Stoic quote', { targetId, id: payload.quote.id, author: payload.quote.author });
    sendJson(res, 200, {
      ok: true,
      type: payload.type,
      targetId,
      quote: payload.quote,
      vestaboard: delivery?.vestaboard || null,
    });
  }

  function handleOnThisDayGet(query, res) {
    sendJson(res, 200, { ok: true, ...onThisDay.statusSnapshot({
      query: query?.q || query?.query,
      page: query?.page,
      pageSize: query?.pageSize,
      hidden: query?.hidden === '1' || query?.hidden === 'true',
      month: query?.month,
      day: query?.day,
    }) });
  }

  function handleOnThisDayPost(body, res) {
    if (body?.filters || body?.minYear !== undefined || body?.maxYear !== undefined) {
      const result = onThisDay.updateFilters({
        minYear: body?.minYear,
        maxYear: body?.maxYear,
      });
      sendJson(res, result.ok ? 200 : 400, result);
      return;
    }
    const result = onThisDay.addEvent({
      month: body?.month,
      day: body?.day,
      year: body?.year,
      text: body?.text,
    });
    sendJson(res, result.ok ? 200 : 400, result);
  }

  function handleOnThisDayPut(body, res) {
    const result = onThisDay.updateEvent(body?.id, {
      text: body?.text,
      year: body?.year,
      month: body?.month,
      day: body?.day,
      hidden: body?.hidden,
      remove: body?.remove,
    });
    sendJson(res, result.ok ? 200 : 400, result);
  }

  function handleOnThisDayPush(body, res) {
    const payload = onThisDay.nextPayload({
      month: body?.month,
      day: body?.day,
    });
    if (!payload) {
      sendJson(res, 409, {
        ok: false,
        error: 'No On This Day events for that date — open Settings → News',
      });
      return;
    }
    const targetId = plexTargetId(body);
    const extra = {};
    if (body?.triggeredBy === 'scheduler') {
      extra.source = 'scheduler';
      extra.explicit = false;
    } else {
      extra.explicit = true;
    }
    const delivery = typeof deliverTargetedPayload === 'function'
      ? deliverTargetedPayload(payload, targetId, extra)
      : sendUdpPayload(payload, { ...extra, targetId });
    log.info('On This Day', {
      targetId,
      id: payload.event.id,
      year: payload.event.year,
      date: payload.event.dateLine,
    });
    sendJson(res, 200, {
      ok: true,
      type: payload.type,
      targetId,
      event: payload.event,
      vestaboard: delivery?.vestaboard || null,
    });
  }

  function handleBakingInspirationGet(query, res) {
    sendJson(res, 200, { ok: true, ...bakingInspiration.statusSnapshot({
      query: query?.q || query?.query,
      page: query?.page,
      pageSize: query?.pageSize,
      hidden: query?.hidden === '1' || query?.hidden === 'true',
    }) });
  }

  function handleBakingInspirationPost(body, res) {
    const result = bakingInspiration.addIdea(body?.title, body?.ingredients);
    sendJson(res, result.ok ? 200 : 400, result);
  }

  function handleBakingInspirationPut(body, res) {
    const result = bakingInspiration.updateIdea(body?.id, {
      title: body?.title,
      ingredients: body?.ingredients,
      hidden: body?.hidden,
      remove: body?.remove,
    });
    sendJson(res, result.ok ? 200 : 400, result);
  }

  function handleBakingInspirationPush(body, res) {
    const payload = bakingInspiration.nextPayload();
    if (!payload) {
      sendJson(res, 409, {
        ok: false,
        error: 'No baking ideas are left — open Settings → News',
      });
      return;
    }
    const targetId = plexTargetId(body);
    const extra = {};
    if (body?.triggeredBy === 'scheduler') {
      extra.source = 'scheduler';
      extra.explicit = false;
    } else {
      extra.explicit = true;
    }
    const delivery = typeof deliverTargetedPayload === 'function'
      ? deliverTargetedPayload(payload, targetId, extra)
      : sendUdpPayload(payload, { ...extra, targetId });
    log.info('Baking inspiration', {
      targetId,
      id: payload.idea.id,
      title: payload.idea.title,
    });
    sendJson(res, 200, {
      ok: true,
      type: payload.type,
      targetId,
      idea: payload.idea,
      vestaboard: delivery?.vestaboard || null,
    });
  }

  function handleWorldPopulationSettingsGet(res) {
    sendJson(res, 200, { ok: true, ...worldPopulation.statusSnapshot() });
  }

  function handleWorldPopulationSettingsPut(body, res) {
    if (body?.reset) {
      const settings = worldPopulation.resetSettings();
      sendJson(res, 200, { ok: true, ...worldPopulation.statusSnapshot(), settings });
      return;
    }
    const settings = worldPopulation.updateSettings({
      basePopulation: body?.basePopulation,
      baseAt: body?.baseAt,
      birthsPerYear: body?.birthsPerYear,
      deathsPerYear: body?.deathsPerYear,
      sourceLabel: body?.sourceLabel,
    });
    sendJson(res, 200, { ok: true, ...worldPopulation.statusSnapshot(), settings });
  }

  function handleWorldPopulationPush(body, res) {
    const payload = worldPopulation.nextPayload();
    const targetId = plexTargetId(body);
    const extra = {};
    if (body?.triggeredBy === 'scheduler') {
      extra.source = 'scheduler';
      extra.explicit = false;
    } else {
      extra.explicit = true;
    }
    const delivery = typeof deliverTargetedPayload === 'function'
      ? deliverTargetedPayload(payload, targetId, extra)
      : sendUdpPayload(payload, { ...extra, targetId });
    log.info('World population', {
      targetId,
      total: payload.population?.total,
    });
    sendJson(res, 200, {
      ok: true,
      type: payload.type,
      targetId,
      population: payload.population,
      asOf: payload.asOf,
      vestaboard: delivery?.vestaboard || null,
    });
  }

  function handleCalendarClockSettingsGet(res) {
    sendJson(res, 200, { ok: true, ...calendarClock.statusSnapshot() });
  }

  function handleCalendarClockSettingsPut(body, res) {
    if (body?.reset) {
      const settings = calendarClock.resetSettings();
      sendJson(res, 200, { ok: true, ...calendarClock.statusSnapshot(), settings });
      return;
    }
    const settings = calendarClock.updateSettings({
      weekStartsOn: body?.weekStartsOn,
    });
    sendJson(res, 200, { ok: true, ...calendarClock.statusSnapshot(), settings });
  }

  function handleCalendarClockPush(body, res) {
    const payload = calendarClock.nextPayload();
    if (!payload) {
      sendJson(res, 409, {
        ok: false,
        error: 'Calendar Clock could not read the house clock',
      });
      return;
    }
    const targetId = plexTargetId(body);
    const extra = {};
    if (body?.triggeredBy === 'scheduler') {
      extra.source = 'scheduler';
      extra.explicit = false;
    } else {
      extra.explicit = true;
    }
    const delivery = typeof deliverTargetedPayload === 'function'
      ? deliverTargetedPayload(payload, targetId, extra)
      : sendUdpPayload(payload, { ...extra, targetId });
    log.info('Calendar Clock', {
      targetId,
      date: `${payload.monthName} ${payload.day}`,
      time: payload.timeLabel,
    });
    sendJson(res, 200, {
      ok: true,
      type: payload.type,
      targetId,
      weekdayName: payload.weekdayName,
      monthName: payload.monthName,
      day: payload.day,
      timeLabel: payload.timeLabel,
      showHeader: payload.showHeader,
      vestaboard: delivery?.vestaboard || null,
    });
  }

  function handleWordClockSettingsGet(res) {
    sendJson(res, 200, { ok: true, ...wordClock.statusSnapshot() });
  }

  function handleWordClockSettingsPut(body, res) {
    if (body?.reset) {
      const settings = wordClock.resetSettings();
      sendJson(res, 200, { ok: true, ...wordClock.statusSnapshot(), settings });
      return;
    }
    const settings = wordClock.updateSettings({
      ...(body && Object.prototype.hasOwnProperty.call(body, 'rounding')
        ? { rounding: body.rounding }
        : {}),
      ...(body && Object.prototype.hasOwnProperty.call(body, 'dayPart')
        ? { dayPart: body.dayPart }
        : {}),
    });
    sendJson(res, 200, { ok: true, ...wordClock.statusSnapshot(), settings });
  }

  function handleWordClockPush(body, res) {
    const payload = wordClock.nextPayload();
    if (!payload) {
      sendJson(res, 409, {
        ok: false,
        error: 'Word Clock could not read the house clock',
      });
      return;
    }
    const targetId = plexTargetId(body);
    const extra = {};
    if (body?.triggeredBy === 'scheduler') {
      extra.source = 'scheduler';
      extra.explicit = false;
    } else {
      extra.explicit = true;
    }
    const delivery = typeof deliverTargetedPayload === 'function'
      ? deliverTargetedPayload(payload, targetId, extra)
      : sendUdpPayload(payload, { ...extra, targetId });
    log.info('Word Clock', { targetId, text: payload.text });
    sendJson(res, 200, {
      ok: true,
      type: payload.type,
      targetId,
      text: payload.text,
      lines: payload.lines,
      timeLabel: payload.timeLabel,
      vestaboard: delivery?.vestaboard || null,
    });
  }

  function redLetterState() {
    return {
      ...redLetter.statusSnapshot(),
      events: dateBook.withNext(),
      // Same pick Push Now uses, so the settings bezel is not stuck on nextUp.
      boardPreview: redLetter.nextPayload({ trigger: 'push' }),
    };
  }

  function handleRedLetterSettingsGet(res) {
    sendJson(res, 200, { ok: true, ...redLetterState() });
  }

  function handleRedLetterSettingsPut(body, res) {
    const settings = body?.reset
      ? redLetter.resetSettings()
      : redLetter.updateSettings({
        ...(body && Object.prototype.hasOwnProperty.call(body, 'pushSelection')
          ? { pushSelection: body.pushSelection } : {}),
        ...(body && Object.prototype.hasOwnProperty.call(body, 'scheduleSelection')
          ? { scheduleSelection: body.scheduleSelection } : {}),
        ...(body && Object.prototype.hasOwnProperty.call(body, 'showTime')
          ? { showTime: body.showTime } : {}),
      });
    sendJson(res, 200, { ok: true, ...redLetterState(), settings });
  }

  /**
   * Date Book CRUD. The collection is small and entirely user-owned, so it
   * gets REST shapes (PUT/DELETE on an id) rather than the shipped+custom
   * corpus dance the fact decks use.
   */
  function handleDateBookApi(method, pathname, body, res) {
    try {
      routeDateBook(method, pathname, body, res);
    } catch (error) {
      // A half-filled form is the caller's problem, not a server fault.
      sendJson(res, 400, { ok: false, error: error?.message || 'Could not save the event' });
    }
  }

  function routeDateBook(method, pathname, body, res) {
    const tail = pathname.slice('/api/date-book/'.length);

    if (tail === 'events') {
      if (method === 'GET') {
        sendJson(res, 200, { ok: true, ...redLetterState() });
        return;
      }
      if (method === 'POST') {
        const event = dateBook.add(body || {});
        log.info('Date Book event added', { id: event.id, date: event.date });
        sendJson(res, 200, { ok: true, event, ...redLetterState() });
        return;
      }
    }

    const idMatch = /^events\/([^/]+)$/.exec(tail);
    if (idMatch) {
      const id = decodeURIComponent(idMatch[1]);
      if (method === 'PUT') {
        if (!dateBook.get(id)) {
          sendJson(res, 404, { ok: false, error: 'Unknown event' });
          return;
        }
        sendJson(res, 200, { ok: true, event: dateBook.update(id, body || {}), ...redLetterState() });
        return;
      }
      if (method === 'DELETE') {
        if (!dateBook.remove(id)) {
          sendJson(res, 404, { ok: false, error: 'Unknown event' });
          return;
        }
        sendJson(res, 200, { ok: true, removed: id, ...redLetterState() });
        return;
      }
    }

    // The designer previews unsaved edits, so an inline event beats an id.
    if (tail === 'preview' && method === 'POST') {
      const inline = body?.event && typeof body.event === 'object' ? body.event : null;
      const preview = redLetter.preview({
        event: inline,
        eventId: String(body?.eventId || '').trim(),
      });
      if (!preview) {
        sendJson(res, 400, { ok: false, error: 'Give the preview an event with a name and a date' });
        return;
      }
      sendJson(res, 200, { ok: true, ...preview });
      return;
    }

    sendJson(res, 404, { ok: false, error: 'Unknown endpoint' });
  }

  function handleRedLetterPush(body, res) {
    const scheduled = body?.triggeredBy === 'scheduler';
    const payload = redLetter.nextPayload({
      trigger: scheduled ? 'schedule' : 'push',
      eventId: String(body?.eventId || '').trim(),
    });
    if (!payload) {
      sendJson(res, 409, {
        ok: false,
        error: 'The Date Book has nothing to count down to',
      });
      return;
    }
    const targetId = plexTargetId(body);
    const extra = scheduled
      ? { source: 'scheduler', explicit: false }
      : { explicit: true };
    const delivery = typeof deliverTargetedPayload === 'function'
      ? deliverTargetedPayload(payload, targetId, extra)
      : sendUdpPayload(payload, { ...extra, targetId });
    log.info('Red Letter', {
      targetId,
      card: payload.card,
      event: payload.event.name,
      daysAway: payload.occurrence.daysAway,
    });
    sendJson(res, 200, {
      ok: true,
      type: payload.type,
      targetId,
      card: payload.card,
      custom: payload.custom,
      event: payload.event,
      occurrence: payload.occurrence,
      vestaboard: delivery?.vestaboard || null,
    });
  }

  async function handlePlexTop10SettingsGet(res) {
    let genres = [];
    try {
      genres = await plexTop10.listGenres();
    } catch (error) {
      log.warn?.('Could not list Plex genres', error?.message || error);
    }
    sendJson(res, 200, { ok: true, ...plexTop10.statusSnapshot(), genres });
  }

  async function handlePlexTop10SettingsPut(body, res) {
    if (body?.reset) {
      plexTop10.resetSettings();
      await handlePlexTop10SettingsGet(res);
      return;
    }
    const patch = {};
    if (body?.source !== undefined) patch.source = body.source;
    if (body?.genres !== undefined) patch.genres = body.genres;
    if (body?.librarySectionKey !== undefined) patch.librarySectionKey = body.librarySectionKey;
    if (body?.cacheMinutes !== undefined) patch.cacheMinutes = body.cacheMinutes;
    plexTop10.updateSettings(patch);
    await handlePlexTop10SettingsGet(res);
  }

  async function handlePlexTop10Push(body, res) {
    let payload = null;
    try {
      payload = await plexTop10.nextPayload({ refresh: body?.refresh === true });
    } catch (error) {
      sendJson(res, error?.status === 401 ? 409 : 502, {
        ok: false,
        error: error?.message || 'Plex Top 10 could not reach Plex',
      });
      return;
    }
    if (!payload) {
      const { source } = plexTop10.getSettings();
      sendJson(res, 409, {
        ok: false,
        error: source === 'global'
          ? 'Plex Discover returned no movies for these genres — open Settings → Media'
          : 'No watched movies match these genres — open Settings → Media',
      });
      return;
    }
    const targetId = plexTargetId(body);
    const extra = {};
    if (body?.triggeredBy === 'scheduler') {
      extra.source = 'scheduler';
      extra.explicit = false;
    } else {
      extra.explicit = true;
    }
    const delivery = typeof deliverTargetedPayload === 'function'
      ? deliverTargetedPayload(payload, targetId, extra)
      : sendUdpPayload(payload, { ...extra, targetId });
    log.info('Plex Top 10 Movies', {
      targetId,
      source: payload.source,
      movies: payload.movies.length,
    });
    sendJson(res, 200, {
      ok: true,
      type: payload.type,
      targetId,
      source: payload.source,
      sourceLabel: payload.sourceLabel,
      genres: payload.genres,
      genresApplied: payload.genresApplied,
      movies: payload.movies,
      vestaboard: delivery?.vestaboard || null,
    });
  }

  function handleLearnJapanesePush(body, res) {
    const payload = learnJapanese.nextPayload();
    if (!payload) {
      sendJson(res, 409, {
        ok: false,
        error: 'No Japanese words match the current filters — open Settings → Language',
      });
      return;
    }
    const targetId = plexTargetId(body);
    const extra = {};
    if (body?.triggeredBy === 'scheduler') {
      extra.source = 'scheduler';
      extra.explicit = false;
    } else {
      extra.explicit = true;
    }
    const delivery = typeof deliverTargetedPayload === 'function'
      ? deliverTargetedPayload(payload, targetId, extra)
      : sendUdpPayload(payload, { ...extra, targetId });
    log.info('Learn Japanese', {
      targetId,
      romaji: payload.word.romaji,
      pos: payload.word.pos,
    });
    sendJson(res, 200, {
      ok: true,
      type: payload.type,
      targetId,
      word: payload.word,
      vestaboard: delivery?.vestaboard || null,
    });
  }

  function handleQuietHoursReminderPush(body, res) {
    const boards = typeof vestaboardHub?.boards === 'function' ? vestaboardHub.boards() : [];
    const board = boards.find((entry) => entry?.quietHours?.enabled !== false) || boards[0] || null;
    const payload = typeof vestaboardHub?.nextQuietHoursPayload === 'function'
      ? vestaboardHub.nextQuietHoursPayload({ quietHours: board?.quietHours })
      : quietHoursReminder.nextPayload({ quietHours: board?.quietHours });
    const targetId = plexTargetId(body);
    const extra = { quietHoursExempt: true };
    if (body?.triggeredBy === 'scheduler') {
      extra.source = 'scheduler';
      extra.explicit = false;
    } else {
      extra.explicit = true;
    }
    const delivery = typeof deliverTargetedPayload === 'function'
      ? deliverTargetedPayload(payload, targetId, extra)
      : sendUdpPayload(payload, { ...extra, targetId });
    log.info('Quiet hours reminder', { targetId, variant: payload.variant });
    sendJson(res, 200, {
      ok: true,
      type: payload.type,
      targetId,
      variant: payload.variant,
      vestaboard: delivery?.vestaboard || null,
    });
  }

  /**
   * Weather Forecast used to go through the synthetic voice-query pipeline,
   * which answered 202 before a forecast existed. A failed fetch (or a missing
   * `extractWeatherLocation` import) then looked like a successful push while
   * both the overlay and the board stayed blank. Build and deliver a real
   * `weather.query` here, same as Weekly Weather.
   */
  async function handleWeatherForecastPush(body, res) {
    const settings = localeSettings.get();
    let location = localeSettings.weatherLocation();
    if (!location) {
      location = extractWeatherLocation(
        'what is the weather',
        config.voiceEvents?.defaultLocation,
      );
    }
    let weather = null;
    try {
      weather = await fetchWeatherForecast(location);
    } catch (error) {
      log.warn?.('Weather forecast fetch failed', error?.message || error);
    }
    if (!weather?.current) {
      const cached = loadWeatherCache(config);
      if (cached?.weather?.current) {
        weather = cached.weather;
        if (cached.location) {
          location = { ...(location || {}), ...cached.location };
        }
      }
    }
    if (!weather?.current) {
      const hasPin = localeSettings.hasLocation()
        || (config.voiceEvents?.defaultLocation?.latitude != null
          && config.voiceEvents?.defaultLocation?.longitude != null);
      sendJson(res, hasPin ? 502 : 400, {
        ok: false,
        error: hasPin
          ? 'Weather forecast is unavailable'
          : 'Set the house location under Settings → Global',
      });
      return;
    }
    if (weather) {
      saveWeatherCache(config, { location: weather.location || location, weather }, log);
    }
    const payload = buildWeatherQueryPayload({
      kind: 'weather',
      device: deviceFrom(body),
      query: 'what is the weather',
      trigger: 'weather-query',
      timestamp: Date.now(),
      spokenResponse: null,
    }, config, {
      location: {
        ...(weather.location || location || {}),
        label: settings.label || location?.resolvedName || location?.name,
      },
      weather,
    });
    const targetId = targetIdFrom(body);
    if (typeof displayRegistry?.resolveDelivery === 'function') {
      const deliveryCheck = displayRegistry.resolveDelivery(targetId);
      if (deliveryCheck.error && !deliveryCheck.isAll) {
        sendJson(res, 404, { ok: false, error: deliveryCheck.error });
        return;
      }
    }
    const extra = {};
    if (body?.triggeredBy === 'scheduler') {
      extra.source = 'scheduler';
      extra.explicit = false;
    } else {
      extra.explicit = true;
    }
    const delivery = typeof deliverTargetedPayload === 'function'
      ? deliverTargetedPayload(payload, targetId, extra)
      : sendUdpPayload(payload, { ...extra, targetId });
    log.info('Weather forecast', {
      targetId,
      condition: weather.current?.condition || null,
    });
    sendJson(res, 200, {
      ok: true,
      type: payload.type,
      targetId,
      vestaboard: delivery?.vestaboard || null,
    });
  }

  /**
   * Serve a cached thumbnail or avatar. Unauthenticated like the other image
   * routes so the display client can fetch without a session, and read-only
   * against a fixed directory with a strict filename pattern.
   */
  function handleYoutubeImageServe(pathname, res) {
    const service = youtubeService();
    const name = path.basename(decodeURIComponent(pathname));
    const dir = config.youtube?.thumbnailCachePath;
    if (!service || !dir || !/^[a-f0-9]{40}\.(jpg|png|webp)$/i.test(name)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const filePath = path.join(dir, name);
    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const stat = fs.statSync(filePath);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'image/jpeg',
      'Content-Length': stat.size,
      'Cache-Control': 'public, max-age=604800',
      ETag: `"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`,
    });
    fs.createReadStream(filePath).pipe(res);
  }

  function triviaOverridesFrom(body) {
    const overrides = {};
    if (body?.count != null && body.count !== '') {
      overrides.count = Number(body.count);
    }
    if (Array.isArray(body?.categoryIds) && body.categoryIds.length) {
      overrides.categoryIds = body.categoryIds.map(String);
    }
    if (body?.difficulty) {
      overrides.difficulty = String(body.difficulty);
    }
    for (const key of ['questionSeconds', 'answerSeconds']) {
      if (body?.[key] != null && body[key] !== '') {
        overrides[key] = Number(body[key]);
      }
    }
    return overrides;
  }

  function handleTriviaStatus(res) {
    const service = triviaService();
    if (!service) {
      sendJson(res, 503, { ok: false, error: 'Trivia is not available' });
      return;
    }
    sendJson(res, 200, { ok: true, ...service.statusSnapshot() });
  }

  function handleTriviaCategories(res) {
    const service = triviaService();
    if (!service) {
      sendJson(res, 503, { ok: false, error: 'Trivia is not available' });
      return;
    }
    sendJson(res, 200, { ok: true, categories: service.categoriesWithCounts() });
  }

  function handleTriviaSettingsGet(res) {
    const service = triviaService();
    if (!service) {
      sendJson(res, 503, { ok: false, error: 'Trivia is not available' });
      return;
    }
    const settings = service.settings.get();
    sendJson(res, 200, {
      ok: true,
      settings,
      roundDurationSeconds: service.estimateDuration(),
    });
  }

  function handleTriviaSettingsPut(body, res) {
    const service = triviaService();
    if (!service) {
      sendJson(res, 503, { ok: false, error: 'Trivia is not available' });
      return;
    }
    const result = service.settings.update(body || {});
    if (!result.ok) {
      sendJson(res, 400, result);
      return;
    }
    sendJson(res, 200, {
      ...result,
      roundDurationSeconds: service.estimateDuration(),
    });
  }

  /**
   * Start a replenishment pass and answer straight away.
   *
   * A full pass walks every enabled category at one call per six seconds, so
   * awaiting it holds the request open for minutes — long enough for the
   * browser or any intermediary to give up and report a bare failure. The pool
   * already reports `refilling`, so the settings card polls for the outcome.
   */
  function handleTriviaRefill(res) {
    const service = triviaService();
    if (!service) {
      sendJson(res, 503, { ok: false, error: 'Trivia is not available' });
      return;
    }
    service.pool.refill({ force: true }).then(
      (result) => {
        if (result?.error) {
          log.warn('Trivia refill finished with an error', result.error);
        }
      },
      (error) => log.warn('Trivia refill threw', error?.message || error),
    );
    sendJson(res, 202, {
      ok: true,
      started: true,
      status: service.statusSnapshot(),
    });
  }

  function handleTriviaPush(body, res) {
    const service = triviaService();
    if (!service) {
      sendJson(res, 503, { ok: false, error: 'Trivia is not available' });
      return;
    }
    const targetId = targetIdFrom(body);
    if (typeof displayRegistry?.resolveDelivery === 'function') {
      const delivery = displayRegistry.resolveDelivery(targetId);
      if (delivery.error && !delivery.isAll) {
        sendJson(res, 404, { ok: false, error: delivery.error });
        return;
      }
    }
    const result = service.push(triviaOverridesFrom(body), {
      device: deviceFrom(body),
      triggeredBy: String(body?.triggeredBy || 'manual'),
      send: (payload) => {
        if (typeof deliverTargetedPayload === 'function') {
          return deliverTargetedPayload(payload, targetId);
        }
        return sendUdpPayload(payload);
      },
    });
    if (!result.ok) {
      sendJson(res, 400, result);
      return;
    }
    sendJson(res, 202, { ...result, targetId });
  }

  // ------------------------------------------------- Display Scheduler

  /**
   * Fire a registry command the same way the admin Push tile does.
   *
   * A scheduled airing goes through the identical handler as a manual push —
   * a parallel dispatch path would drift the moment one of them is fixed. The
   * handlers speak HTTP, so a capturing shim stands in for `res`.
   */
  async function airCommand(commandId, params = {}, {
    device = 'Scheduler',
    targetId = 'full',
    manual = false,
  } = {}) {
    const command = commandRegistry.get(commandId);
    if (!command) {
      throw new Error(`Unknown command: ${commandId}`);
    }
    let captured = { status: 0, body: null };
    const res = {
      writeHead(status) { captured.status = status; },
      end(data) {
        try {
          captured.body = data ? JSON.parse(data) : null;
        } catch {
          captured.body = null;
        }
      },
      setHeader() {},
    };
    let deliveryId = normaliseSchedulerTarget(targetId);
    // Vestaboard-only skills have nothing to show on a Windows overlay. Rules
    // created before boards defaulted to `full`; Air now / ticks must still
    // reach the flaps rather than "succeeding" into the void.
    const kinds = Array.isArray(command.kinds) ? command.kinds : null;
    const boardOnly = kinds?.length === 1 && kinds[0] === 'vestaboard';
    if (boardOnly && (deliveryId === 'full' || deliveryId === 'all')) {
      deliveryId = 'vestaboard';
    }
    const body = {
      ...(command.body || {}),
      ...params,
      device,
      targetId: deliveryId,
      // Air now is a human press — same path as the Push tile (explicit,
      // still waits its turn in the board queue). Quiet hours still apply:
      // only alarm/timer fires reach the board unless the caller opts in.
      // Automated ticks stay soft. Game invites pass breakHold themselves.
      triggeredBy: manual ? 'manual' : 'scheduler',
    };

    schedulerAir = {
      source: manual ? 'manual' : 'scheduler',
      scheduler: !manual,
      explicit: Boolean(manual),
      breakHold: false,
      targetId: deliveryId,
    };
    try {
      switch (commandId) {
        case 'tesla.dashboard': handleTeslaPush('tesla-dashboard', body, res); break;
        case 'tesla.battery': handleTeslaPush('tesla-battery', body, res); break;
        case 'alexa.weather':
          await handleWeatherForecastPush(body, res); break;
        case 'alexa.shopping-list':
          await handleVoiceQueryPush('shopping-list', 'show my shopping list', 'shopping-list-show', body, res); break;
        case 'alexa.timers': handleTimersPush(body, res); break;
        case 'alexa.alarms': handleAlarmsPush(body, res); break;
        case 'alexa.notifications': handleNotificationsPush(body, res); break;
        case 'alexa.air-quality':
          await handleVoiceQueryPush('air-quality', 'show indoor air quality', 'air-quality-query', body, res); break;
        case 'alexa.now-playing':
          await handleVoiceQueryPush('music', "what's playing", 'music-query', body, res); break;
        case 'signal.slideshow': handlePhotoSlideshowPush(body, res); break;
        case 'signal.guest-snaps': await handleGuestPhotoboothPush(body, res); break;
        case 'steam.now-playing':
          await handleSteamNowPlayingPush({ ...body, mode: 'now-playing' }, res); break;
        case 'steam.last-played':
          await handleSteamNowPlayingPush({ ...body, mode: 'last-played' }, res); break;
        case 'steam.library-tour':
          await handleSteamLibraryTourPush(body, res); break;
        case 'psn.now-playing':
          await handlePsnNowPlayingPush({ ...body, mode: 'now-playing' }, res); break;
        case 'psn.last-played':
          await handlePsnNowPlayingPush({ ...body, mode: 'last-played' }, res); break;
        case 'psn.library-tour':
          await handlePsnLibraryTourPush(body, res); break;
        case 'credits.show':
          handleRollCreditsPush(body, res); break;
        case 'autodarts.now':
          handleAutodartsNowPush({ ...body, mode: body?.mode || 'auto' }, res); break;
        case 'autodarts.last-match':
          handleAutodartsLastMatchPush({ ...body, mode: 'last-match' }, res); break;
        case 'autodarts.dashboard':
          handleAutodartsDashboardPush(body, res); break;
        case 'huupe.now':
          handleHuupeNowPush({ ...body, mode: body?.mode || 'auto' }, res); break;
        case 'huupe.last-game':
          handleHuupeLastGamePush({ ...body, mode: 'last-game' }, res); break;
        case 'huupe.dashboard':
          handleHuupeDashboardPush(body, res); break;
        case 'youtube.now-playing':
          await handleYoutubeNowPlayingPush({ ...body, mode: 'now-playing' }, res); break;
        case 'youtube.last-played':
          await handleYoutubeNowPlayingPush({ ...body, mode: 'last-played' }, res); break;
        case 'plex.now-playing':
          await handlePlexNowPlayingPush({ ...body, mode: body?.mode || 'auto' }, res); break;
        case 'plex.top10':
          await handlePlexTop10Push(body, res); break;
        case 'weather.weekly':
          await handleWeeklyWeatherPush(body, res); break;
        case 'weather.alerts':
          await handleWeatherAlertsPush(body, res); break;
        case 'stocks.market':
          await handleStockMarketPush(body, res); break;
        case 'fx.rates':
          await handleCurrencyRatesPush(body, res); break;
        case 'iss.track':
          await handleIssTrackerPush(body, res); break;
        case 'starlink.track':
          await handleStarlinkTrackerPush(body, res); break;
        case 'launch.alert':
          await handleSpaceLaunchAlertsPush(body, res); break;
        case 'japanese.learn':
          handleLearnJapanesePush(body, res); break;
        case 'portuguese.learn':
          handleLearnLanguagePush('portuguese', body, res); break;
        case 'spanish.learn':
          handleLearnLanguagePush('spanish', body, res); break;
        case 'french.learn':
          handleLearnLanguagePush('french', body, res); break;
        case 'german.learn':
          handleLearnLanguagePush('german', body, res); break;
        case 'italian.learn':
          handleLearnLanguagePush('italian', body, res); break;
        case 'scramble.invite':
          await handleWordScramblePush(body, res); break;
        case 'word.riddles':
          handleWordRiddlesPush(body, res); break;
        case 'chuck.facts':
          handleChuckNorrisPush(body, res); break;
        case 'roast.me':
          handleRoastMePush(body, res); break;
        case 'family.quotes':
          handleFamilyQuotesPush(body, res); break;
        case 'warm.fuzzies':
          handleWarmFuzziesPush(body, res); break;
        case 'bucket.fillers':
          handleDailyBucketFillersPush(body, res); break;
        case 'misheard.lyrics':
          handleMisheardLyricsPush(body, res); break;
        case 'periodic.table':
          handlePeriodicTablePush(body, res); break;
        case 'state.facts':
          handleUsStateFactsPush(body, res); break;
        case 'word.day':
          handleWordOfTheDayPush(body, res); break;
        case 'dad.jokes':
          handleDadJokesPush(body, res); break;
        case 'us.weather-map':
          await handleUsWeatherMapPush(body, res); break;
        case 'amazing.facts':
          handleAmazingFactsPush(body, res); break;
        case 'geo.facts':
          handleWorldGeographyFactsPush(body, res); break;
        case 'talk.starters':
          handleConversationStartersPush(body, res); break;
        case 'stoic.quotes':
          handleStoicQuotesPush(body, res); break;
        case 'history.day':
          handleOnThisDayPush(body, res); break;
        case 'bake.inspire':
          handleBakingInspirationPush(body, res); break;
        case 'world.population':
          handleWorldPopulationPush(body, res); break;
        case 'calendar.clock':
          handleCalendarClockPush(body, res); break;
        case 'word.clock':
          handleWordClockPush(body, res); break;
        case 'guestbook.invite':
          handleGuestBookInvitePush(body, res); break;
        case 'ring.doorbell':
          handleRingDoorbellPush(body, res); break;
        case 'redletter.show':
          handleRedLetterPush(body, res); break;
        case 'signal.quiet-hours':
          handleQuietHoursReminderPush(body, res); break;
        case 'trivia.show': handleTriviaPush(body, res); break;
        case 'goodnews.show': handleUpsideNewsPush(body, res); break;
        case 'wiki.show': handleWikiPush(body, res); break;
        case 'overhead.show': await handleOverheadPush(body, res); break;
        case 'flightplan.next': await handleFlightplanPushNext(body, res); break;
        case 'flightplan.board': await handleFlightplanPushBoard(body, res); break;
        default:
          throw new Error(`Command "${commandId}" has no scheduler dispatch`);
      }
    } finally {
      schedulerAir = null;
    }

    if (captured.status >= 400) {
      throw new Error(captured.body?.error || `Push failed (${captured.status})`);
    }
    if (!captured.status) {
      throw new Error(`Command "${commandId}" produced no response`);
    }
    return {
      ...captured.body,
      boardOutcomes: captured.body?.vestaboard?.boards || captured.body?.boardOutcomes,
    };
  }

  const scheduler = createDisplayScheduler({
    config,
    log,
    commandRegistry,
    isBusy: () => Boolean(displayBusy?.isBusy?.()),
    timeZone: config.voiceEvents?.localTimeZone || null,
    isBoardTarget: (id) => {
      const entry = displayRegistry?.get?.(id);
      return Boolean(entry && (entry.kind === 'vestaboard' || entry.static));
    },
    air: (rule, _command, options = {}) => airCommand(rule.commandId, rule.params, {
      device: options.manual ? 'Air now' : 'Scheduler',
      targetId: rule.target,
      manual: Boolean(options.manual),
    }),
  });

  function schedulerRules() {
    return scheduler.rules.all().map((rule) => scheduler.describeRule(rule));
  }

  function handleSchedulerStatus(res) {
    sendJson(res, 200, {
      ok: true,
      ...scheduler.status(),
      display: displayBusy?.snapshot?.() || { busy: false },
    });
  }

  function handleSchedulerRulesGet(res) {
    sendJson(res, 200, { ok: true, rules: schedulerRules() });
  }

  function handleSchedulerRuleCreate(body, res) {
    if (!commandRegistry.get(String(body?.commandId || ''))) {
      sendJson(res, 400, { ok: false, error: 'Unknown commandId' });
      return;
    }
    const rule = scheduler.rules.add(body || {});
    sendJson(res, 201, { ok: true, rule: scheduler.describeRule(rule) });
  }

  function handleSchedulerRuleUpdate(id, body, res) {
    const rule = scheduler.rules.update(id, body || {});
    if (!rule) {
      sendJson(res, 404, { ok: false, error: 'Unknown rule' });
      return;
    }
    sendJson(res, 200, { ok: true, rule: scheduler.describeRule(rule) });
  }

  function handleSchedulerRuleDelete(id, res) {
    const removed = scheduler.rules.remove(id);
    sendJson(res, removed ? 200 : 404, {
      ok: removed,
      ...(removed ? {} : { error: 'Unknown rule' }),
    });
  }

  async function handleSchedulerRuleAir(id, res) {
    const rule = scheduler.rules.get(id);
    if (!rule) {
      sendJson(res, 404, { ok: false, error: 'Unknown rule' });
      return;
    }
    try {
      const event = await scheduler.airRule(rule, { manual: true });
      if (event?.outcome === 'aired') {
        sendJson(res, 202, { ok: true, event });
        return;
      }
      // Soft decline — nothing to show, not linked, empty history. Use 409 so a
      // reverse proxy / CDN does not replace the JSON body the way many do for
      // upstream 502, which left the admin toast as a bare "Request failed (502)".
      sendJson(res, 409, {
        ok: false,
        error: event?.detail || `${rule.label || rule.commandId} could not air`,
        event,
      });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error?.message || String(error) });
    }
  }

  function handleSchedulerRuleReset(id, res) {
    const rule = scheduler.rules.update(id, {
      nextEvalAt: new Date().toISOString(),
      lastAiredAt: null,
      airingsToday: 0,
      pending: false,
      pendingSince: null,
    });
    if (!rule) {
      sendJson(res, 404, { ok: false, error: 'Unknown rule' });
      return;
    }
    sendJson(res, 200, { ok: true, rule: scheduler.describeRule(rule) });
  }

  function windowMsFrom(value) {
    const map = { '6h': 6, '12h': 12, '24h': 24, '7d': 24 * 7, '30d': 24 * 30 };
    return (map[String(value || '24h')] || 24) * 3600 * 1000;
  }

  function handleSchedulerActivity(query, res) {
    const to = query.get('to') || new Date().toISOString();
    const from = query.get('from')
      || new Date(Date.parse(to) - windowMsFrom(query.get('window'))).toISOString();
    sendJson(res, 200, {
      ok: true,
      from,
      to,
      events: scheduler.activity.query({
        from,
        to,
        ruleId: query.get('ruleId') || undefined,
        outcomes: query.get('outcomes') ? query.get('outcomes').split(',') : undefined,
        limit: Math.min(20000, Number(query.get('limit')) || 5000),
      }),
      rules: schedulerRules(),
    });
  }

  function handleSchedulerStats(query, res) {
    const windowMs = windowMsFrom(query.get('window'));
    const to = new Date();
    const from = new Date(to.getTime() - windowMs);
    sendJson(res, 200, {
      ok: true,
      window: query.get('window') || '24h',
      stats: scheduler.activity.stats({
        from: from.toISOString(),
        to: to.toISOString(),
        ruleId: query.get('ruleId') || undefined,
      }),
      // Sparklines want a fixed 7-day series regardless of the stat window.
      daily: scheduler.activity.dailySeries({ days: 7, ruleId: query.get('ruleId') || undefined }),
      rules: schedulerRules(),
    });
  }

  function handleSchedulerHeatmap(query, res) {
    sendJson(res, 200, {
      ok: true,
      rows: scheduler.activity.heatmap({
        days: Math.min(60, Math.max(1, Number(query.get('days')) || 14)),
        ruleId: query.get('ruleId') || undefined,
      }),
    });
  }

  /** PUT/POST/DELETE under `/api/display-scheduler/` (display-scheduler.md §10). */
  async function handleSchedulerWrite(method, pathname, body, res) {
    const tail = pathname.slice('/api/display-scheduler/'.length);

    if (tail === 'settings' && (method === 'PUT' || method === 'POST')) {
      const previouslyActive = scheduler.settings.active;
      const settingsNow = scheduler.updateSettings(body || {});
      // Pause is the panic button when guests are over: it must take effect the
      // instant it is pressed, including cutting a round already on screen.
      if (previouslyActive && !settingsNow.active) {
        scheduler.reportInterruption();
      }
      sendJson(res, 200, { ok: true, settings: settingsNow });
      return;
    }
    if (tail === 'rules' && method === 'POST') {
      handleSchedulerRuleCreate(body, res);
      return;
    }
    if (tail === 'simulate' && method === 'POST') {
      handleSchedulerSimulate(body, res);
      return;
    }

    const match = /^rules\/([^/]+)(?:\/(air|reset))?$/.exec(tail);
    if (match) {
      const [, id, action] = match;
      if (action === 'air' && method === 'POST') { await handleSchedulerRuleAir(id, res); return; }
      if (action === 'reset' && method === 'POST') { handleSchedulerRuleReset(id, res); return; }
      if (!action && method === 'PUT') { handleSchedulerRuleUpdate(id, body, res); return; }
      if (!action && method === 'DELETE') { handleSchedulerRuleDelete(id, res); return; }
    }
    sendJson(res, 404, { ok: false, error: 'Unknown endpoint' });
  }

  function handleSchedulerSimulate(body, res) {
    sendJson(res, 200, {
      ok: true,
      ...scheduler.simulate({
        hours: Math.min(168, Math.max(1, Number(body?.hours) || 24)),
        runs: Math.min(1000, Math.max(1, Number(body?.runs) || 200)),
        seed: Number(body?.seed) || 1,
      }),
    });
  }

  // Steam/PSN previews default to `auto` (fall back to last played) because
  // that is what the admin test button has always done. Scheduler rules send
  // an explicit mode so a "now playing" rule cannot air a last-played card.
  function previewModeFrom(body) {
    const mode = String(body?.mode || '').trim();
    return mode === 'now-playing' || mode === 'last-played' ? mode : 'auto';
  }

  function controlTokenFrom(req, body) {
    const header = String(req?.headers?.authorization || '');
    if (header.toLowerCase().startsWith('bearer ')) {
      return header.slice(7).trim();
    }
    return String(body?.controlToken || '').trim();
  }

  function requireControlAuth(req, body, res) {
    const targetId = targetIdFrom(body);
    const gate = controlAuth.assertAuthorized(targetId, controlTokenFrom(req, body));
    if (!gate.ok) {
      sendJson(res, gate.status || 401, {
        ok: false,
        error: gate.error,
        code: gate.code,
      });
      return null;
    }
    return targetId;
  }

  function bindActor(session) {
    if (session?.ok && session.actor) {
      requestActor = session.actor;
    }
  }

  function writeAuthCookies(res, status, cookies, extraHeaders, body) {
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    };
    if (cookies) {
      headers['Set-Cookie'] = cookies;
    }
    res.writeHead(status, headers);
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  }

  function requireAdminSession(req, res) {
    const gate = adminAuth.assertAuthorized(req);
    if (!gate.ok) {
      sendJson(res, gate.status || 401, {
        ok: false,
        error: gate.error,
        code: gate.code,
      });
      return false;
    }
    bindActor(gate);
    return true;
  }

  function requireUserSession(req, res) {
    const gate = adminAuth.assertUserAuthorized(req);
    if (!gate.ok) {
      sendJson(res, gate.status || 401, {
        ok: false,
        error: gate.error,
        code: gate.code,
      });
      return false;
    }
    bindActor(gate);
    return gate;
  }

  function requirePermission(req, res, permission) {
    const gate = adminAuth.hasPermission(req, permission);
    if (!gate.ok) {
      sendJson(res, gate.status || 403, {
        ok: false,
        error: gate.error,
        code: gate.code,
      });
      return false;
    }
    bindActor(gate);
    return gate;
  }

  function isUserAccessiblePath(pathname) {
    if (pathname.startsWith('/api/user/')) return true;
    if (pathname.startsWith('/api/push/')) return true;
    if (pathname === '/api/commands') return true;
    if (pathname.startsWith('/api/vestaboard-sim')) return true;
    if (pathname === '/api/vestaboards/release-holds') return true;
    if (pathname.startsWith('/api/photos')) return true;
    if (pathname.startsWith('/api/date-book/')) return true;
    if (pathname.startsWith('/api/flightplan/trips')) return true;
    if (pathname.startsWith('/api/flightplan/flights')) return true;
    if (pathname === '/api/flightplan/search') return true;
    if (pathname === '/api/flightplan/airports') return true;
    if (pathname === '/api/flightplan/status') return true;
    if (pathname === '/api/displays') return true;
    if (pathname === '/api/displays/events') return true;
    return false;
  }

  function requirePathSession(req, res, pathname) {
    if (pathname.startsWith('/api/photos')) {
      return requirePermission(req, res, 'slideshow');
    }
    if (pathname.startsWith('/api/date-book/')) {
      return requirePermission(req, res, 'redLetter');
    }
    if (pathname.startsWith('/api/flightplan/')) {
      return requirePermission(req, res, 'flightPlan');
    }
    return requireUserSession(req, res);
  }

  /** Guest booth photo APIs: guest session OR admin session. */
  function requireGuestOrAdmin(req, res) {
    if (adminAuth.assertAuthorized(req).ok) {
      return true;
    }
    const gate = guestSnapsAuth.assertAuthorized(req);
    if (!gate.ok) {
      sendJson(res, gate.status || 401, {
        ok: false,
        error: gate.error,
        code: gate.code,
      });
      return false;
    }
    return true;
  }

  function sendGuestAuthFailure(result, res) {
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    };
    if (result.retryAfterSec > 0) {
      headers['Retry-After'] = String(result.retryAfterSec);
    }
    const payload = {
      ok: false,
      error: result.error,
      code: result.code,
    };
    if (result.retryAfterSec > 0) {
      payload.retryAfterSec = result.retryAfterSec;
    }
    res.writeHead(result.status || 401, headers);
    res.end(JSON.stringify(payload));
  }

  function handleGuestSession(req, res) {
    const info = guestSnapsAuth.getPublicPinInfo();
    const session = guestSnapsAuth.sessionFromRequest(req);
    sendJson(res, 200, {
      ok: true,
      authenticated: Boolean(session.ok),
      configured: Boolean(info.configured),
      pinDigits: info.pinDigits,
      expiresAt: session.ok
        ? new Date(session.expiresAt).toISOString()
        : info.expiresAt,
      code: session.ok ? undefined : session.code,
    });
  }

  function handleGuestLogin(body, req, res) {
    const result = guestSnapsAuth.login(body?.pin, req);
    if (!result.ok) {
      sendGuestAuthFailure(result, res);
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Set-Cookie': result.setCookie,
    });
    res.end(JSON.stringify({
      ok: true,
      expiresAt: new Date(result.expiresAt).toISOString(),
    }));
  }

  function handleGuestLogout(req, res) {
    const result = guestSnapsAuth.logout(req);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Set-Cookie': result.setCookie,
    });
    res.end(JSON.stringify({ ok: true }));
  }

  function handleGuestRequestPin(req, res) {
    const settings = resolveGuestPhotoboothSettings(config);
    if (!settings.configured) {
      sendJson(res, 503, {
        ok: false,
        error: 'Guest Snaps is not configured — set GUEST_WIFI_SSID and GUEST_PHOTOBOOTH_URL in .env',
        code: 'guest_not_configured',
      });
      return;
    }
    const result = guestSnapsAuth.beginRequestPin(req);
    if (!result.ok) {
      sendGuestAuthFailure(result, res);
      return;
    }
    const pinInfo = result.display;
    const boothPush = resolveBoothPushUrl(settings, shortlinks.status(GUESTSNAPS_NAME));
    const payload = buildGuestPhotoboothPayload(
      {
        device: 'Signal',
        trigger: 'guest-request-pin',
        query: 'request guest snaps pin',
        timestamp: Date.now(),
        targetId: '*',
      },
      config,
      {
        ...settings,
        boothUrl: boothPush.boothUrl,
        shortLabel: boothPush.shortLabel,
        accessPin: pinInfo?.accessPin,
        accessPinHint: pinInfo?.accessPinHint,
      },
    );
    if (!payload) {
      sendJson(res, 500, { ok: false, error: 'Could not build Guest Snaps overlay' });
      return;
    }
    if (typeof deliverTargetedPayload === 'function') {
      deliverTargetedPayload(payload, '*');
    } else if (typeof sendUdpPayload === 'function') {
      sendUdpPayload(payload);
    } else if (typeof recordVoiceEvent === 'function') {
      // Fallback: synthetic voice path (also fans out to all displays).
      recordVoiceEvent({
        kind: 'guest-photobooth',
        device: 'Signal',
        query: 'request guest snaps pin',
        trigger: 'guest-request-pin',
        timestamp: Date.now(),
        targetId: '*',
      });
    } else {
      sendJson(res, 503, { ok: false, error: 'Push unavailable — listener not ready' });
      return;
    }
    log.info('Guest Snaps PIN requested for display', { expiresAt: result.expiresAt });
    // Never include the PIN in the phone response.
    sendJson(res, 200, {
      ok: true,
      expiresAt: result.expiresAt,
      pinDigits: result.pinDigits,
    });
  }

  function handleAdminLogin(body, req, res) {
    const ip = adminAuth.clientIpFromRequest(req);
    const result = adminAuth.login({
      username: body?.username,
      password: body?.password,
    }, req);
    if (!result.ok) {
      userAudit.append({
        ip,
        action: 'login.fail',
        detail: { username: String(body?.username || houseUsers.adminUsername), code: result.code },
      });
      const headers = {};
      if (result.retryAfterSec > 0) {
        headers['Retry-After'] = String(result.retryAfterSec);
      }
      const payload = {
        ok: false,
        error: result.error,
        code: result.code,
      };
      if (result.retryAfterSec > 0) {
        payload.retryAfterSec = result.retryAfterSec;
      }
      writeAuthCookies(res, result.status || 401, null, headers, payload);
      return;
    }
    if (body?.requireAdmin && !result.user?.isAdmin) {
      adminAuth.dropSessionsForUser(result.user.id);
      writeAuthCookies(res, 403, adminAuth.logout(req).setCookie, {}, {
        ok: false,
        error: 'Admin access required',
        code: 'not_admin',
      });
      return;
    }
    userAudit.append({
      ip,
      actorUserId: result.user.id,
      action: 'login',
      targetUserId: result.user.id,
      detail: { username: result.user.username, isAdmin: result.user.isAdmin },
    });
    writeAuthCookies(res, 200, result.setCookie, {}, {
      ok: true,
      expiresAt: new Date(result.expiresAt).toISOString(),
      user: result.user,
    });
  }

  function handleAdminLogout(req, res) {
    const session = adminAuth.sessionFromRequest(req);
    const result = adminAuth.logout(req);
    if (session.ok) {
      userAudit.append({
        ip: adminAuth.clientIpFromRequest(req),
        actorUserId: session.userId,
        action: 'logout',
        targetUserId: session.userId,
        detail: { username: session.username },
      });
    }
    writeAuthCookies(res, 200, result.setCookie, {}, { ok: true });
  }

  function handleAdminSession(req, res) {
    const session = adminAuth.sessionFromRequest(req);
    if (!session.ok) {
      sendJson(res, 200, {
        ok: true,
        authenticated: false,
        configured: adminAuth.isConfigured(),
        adminUsername: houseUsers.adminUsername,
        code: session.code,
      });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      authenticated: true,
      configured: true,
      isAdmin: session.isAdmin === true,
      expiresAt: new Date(session.expiresAt).toISOString(),
      user: session.user,
      adminUsername: houseUsers.adminUsername,
    });
  }

  function publicOrigin(req) {
    const proto = String(req?.headers?.['x-forwarded-proto'] || (req?.socket?.encrypted ? 'https' : 'http'));
    const host = String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || 'localhost');
    return `${proto}://${host}`.replace(/\/$/, '');
  }

  function avatarUrlFor(user) {
    if (!user?.avatar) return `/user/avatars/${AVATAR_TEMPLATES[0].id}.svg`;
    if (user.avatar.kind === 'upload' && user.avatar.id) {
      return `/user-avatars/${user.avatar.id}`;
    }
    return `/user/avatars/${user.avatar.id || AVATAR_TEMPLATES[0].id}.svg`;
  }

  async function emailPassword(to, { subject, text }) {
    if (!to) return { ok: false, code: 'no_email', error: 'This account has no email address' };
    const result = await gmailMailer.sendMail({ to, subject, text });
    return result;
  }

  function handleHouseUsersList(res) {
    sendJson(res, 200, {
      ok: true,
      users: houseUsers.list().map((user) => ({ ...user, avatarUrl: avatarUrlFor(user) })),
      templates: AVATAR_TEMPLATES,
    });
  }

  function handleHouseUserCreate(body, req, res) {
    const session = adminAuth.sessionFromRequest(req);
    const result = houseUsers.create(body || {});
    if (!result.ok) {
      sendJson(res, 400, result);
      return;
    }
    userAudit.append({
      ip: adminAuth.clientIpFromRequest(req),
      actorUserId: session.userId,
      action: 'user.create',
      targetUserId: result.user.id,
      detail: { username: result.user.username },
    });
    sendJson(res, 200, result);
  }

  function handleHouseUserUpdate(id, body, req, res) {
    const session = adminAuth.sessionFromRequest(req);
    const before = houseUsers.getById(id);
    const result = houseUsers.update(id, body || {});
    if (!result.ok) {
      sendJson(res, result.error === 'User not found' ? 404 : 400, result);
      return;
    }
    if (before && result.user.active === false && before.active !== false) {
      adminAuth.dropSessionsForUser(id);
    }
    userAudit.append({
      ip: adminAuth.clientIpFromRequest(req),
      actorUserId: session.userId,
      action: 'user.update',
      targetUserId: id,
      detail: { username: result.user.username, active: result.user.active, isAdmin: result.user.isAdmin },
    });
    sendJson(res, 200, result);
  }

  function handleHouseUserPassword(id, body, req, res) {
    const session = adminAuth.sessionFromRequest(req);
    const generated = !String(body?.password || '').trim();
    const result = generated
      ? houseUsers.resetPassword(id)
      : houseUsers.setPassword(id, body.password);
    if (!result.ok) {
      sendJson(res, 400, result);
      return;
    }
    adminAuth.dropSessionsForUser(id);
    userAudit.append({
      ip: adminAuth.clientIpFromRequest(req),
      actorUserId: session.userId,
      action: generated ? 'password.generate' : 'password.reset',
      targetUserId: id,
      detail: { username: result.user.username },
    });
    sendJson(res, 200, result);
  }

  async function handleHouseUserEmailPassword(id, req, res) {
    const session = adminAuth.sessionFromRequest(req);
    const result = houseUsers.resetPassword(id);
    if (!result.ok) {
      sendJson(res, 400, result);
      return;
    }
    adminAuth.dropSessionsForUser(id);
    const mailed = await emailPassword(result.user.email, {
      subject: 'Your Signal password',
      text: `Hi ${result.user.firstName || result.user.username},\n\nA new password was created for your Signal account:\n\n${result.password}\n\nSign in at ${publicOrigin(req)}/\n`,
    });
    userAudit.append({
      ip: adminAuth.clientIpFromRequest(req),
      actorUserId: session.userId,
      action: mailed.ok ? 'password.email' : 'password.email.skip',
      targetUserId: id,
      detail: { username: result.user.username, code: mailed.code || null },
    });
    sendJson(res, 200, { ...result, emailed: mailed.ok === true, mailError: mailed.ok ? null : mailed.error });
  }

  function handleUserAudit(reqUrl, res) {
    sendJson(res, 200, {
      ok: true,
      entries: userAudit.list({
        limit: Number(reqUrl.searchParams.get('limit') || 200),
        action: reqUrl.searchParams.get('action') || '',
        userId: reqUrl.searchParams.get('userId') || '',
      }),
    });
  }

  function handleUserMe(req, res) {
    const session = requireUserSession(req, res);
    if (!session) return;
    sendJson(res, 200, {
      ok: true,
      user: { ...session.user, avatarUrl: avatarUrlFor(session.user) },
      templates: AVATAR_TEMPLATES,
    });
  }

  function handleUserProfile(body, req, res) {
    const session = requireUserSession(req, res);
    if (!session) return;
    const current = houseUsers.getById(session.userId);
    const result = houseUsers.update(session.userId, {
      firstName: body?.firstName,
      lastName: body?.lastName,
      email: houseUsers.isBootstrap(current) ? undefined : body?.email,
      avatar: body?.avatar,
      dashboardTiles: body?.dashboardTiles,
    });
    if (!result.ok) {
      sendJson(res, 400, result);
      return;
    }
    const identityChanged = ['firstName', 'lastName', 'email', 'avatar'].some(
      (key) => body && Object.prototype.hasOwnProperty.call(body, key),
    );
    if (identityChanged) {
      userAudit.append({
        ip: adminAuth.clientIpFromRequest(req),
        actorUserId: session.userId,
        action: 'profile.update',
        targetUserId: session.userId,
      });
    }
    sendJson(res, 200, { ok: true, user: { ...result.user, avatarUrl: avatarUrlFor(result.user) } });
  }

  function handleUserPasswordChange(body, req, res) {
    const session = requireUserSession(req, res);
    if (!session) return;
    const current = houseUsers.verifyLogin(session.username, body?.currentPassword);
    if (!current.ok) {
      sendJson(res, 401, { ok: false, error: 'Current password is incorrect' });
      return;
    }
    const result = houseUsers.setPassword(session.userId, body?.password);
    if (!result.ok) {
      sendJson(res, 400, result);
      return;
    }
    userAudit.append({
      ip: adminAuth.clientIpFromRequest(req),
      actorUserId: session.userId,
      action: 'password.change',
      targetUserId: session.userId,
    });
    sendJson(res, 200, { ok: true });
  }

  function handleUserGuestbookSend(body, req, res) {
    const session = requireUserSession(req, res);
    if (!session) return;
    const result = guestBook.send(body || {}, {
      ip: guestClientIp(req),
      req,
      skipUnlock: true,
      nameOverride: session.firstName || session.username,
      actor: session.actor,
    });
    sendJson(res, result.ok ? 200 : (result.closed ? 403 : 400), result);
  }

  function handleUserGames(res) {
    const rows = (gameSessions.listActive?.() || []).map((session) => ({
      sessionId: session.sessionId,
      game: session.title || session.gameType,
      gameType: session.gameType,
      code: session.code,
      phase: session.phase,
      startedAgoSeconds: session.elapsedSeconds,
      playerCount: session.playerCount,
      lobby: session.phase === 'lobby' || session.phase === 'invite',
    }));
    sendJson(res, 200, { ok: true, sessions: rows });
  }

  function handleUserCommands(res) {
    sendJson(res, 200, {
      ok: true,
      commands: commandRegistry.list({ skipContentCheck: true }).filter((row) => row.pushable),
    });
  }

  async function handleForgotPassword(body, req, res) {
    const reset = houseUsers.beginPasswordReset(body?.email);
    if (reset.sent) {
      const origin = publicOrigin(req);
      const mailed = await emailPassword(reset.user.email, {
        subject: 'Reset your Signal password',
        text: `Hi ${reset.user.firstName || reset.user.username},\n\nReset your password:\n${origin}/user/reset?token=${reset.token}\n\nThis link expires in one hour.\n`,
      });
      userAudit.append({
        ip: adminAuth.clientIpFromRequest(req),
        action: mailed.ok ? 'password.reset.email' : 'password.reset.email.skip',
        targetUserId: reset.user.id,
        detail: { code: mailed.code || null },
      });
    } else {
      userAudit.append({
        ip: adminAuth.clientIpFromRequest(req),
        action: 'password.reset.request',
        detail: { found: false },
      });
    }
    sendJson(res, 200, { ok: true });
  }

  function handleResetPassword(body, res) {
    const result = houseUsers.consumePasswordReset(body?.token, body?.password);
    if (!result.ok) {
      sendJson(res, 400, result);
      return;
    }
    userAudit.append({
      action: 'password.reset.consume',
      targetUserId: result.user.id,
      detail: { username: result.user.username },
    });
    sendJson(res, 200, { ok: true });
  }

  function writeAvatarFromDataUrl(userId, dataUrl) {
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || ''));
    if (!match) return { ok: false, error: 'Upload a PNG, JPEG, or WebP image' };
    const buffer = Buffer.from(match[2], 'base64');
    if (buffer.length > 1_500_000) {
      return { ok: false, error: 'That picture is too large (1.5 MB max)' };
    }
    const ext = match[1] === 'image/png' ? 'png' : (match[1] === 'image/webp' ? 'webp' : 'jpg');
    const id = `${userId}.${ext}`;
    fs.mkdirSync(avatarDir, { recursive: true });
    fs.writeFileSync(path.join(avatarDir, id), buffer);
    return { ok: true, id };
  }

  function handleAvatarUpload(body, req, res) {
    const session = requireUserSession(req, res);
    if (!session) return;
    const stored = writeAvatarFromDataUrl(session.userId, body?.image || body?.dataUrl);
    if (!stored.ok) {
      sendJson(res, 400, stored);
      return;
    }
    const result = houseUsers.update(session.userId, { avatar: { kind: 'upload', id: stored.id } });
    sendJson(res, 200, { ok: true, user: { ...result.user, avatarUrl: avatarUrlFor(result.user) } });
  }

  function handleHouseUserAvatar(id, body, req, res) {
    const session = adminAuth.sessionFromRequest(req);
    const stored = writeAvatarFromDataUrl(id, body?.image || body?.dataUrl);
    if (!stored.ok) {
      sendJson(res, 400, stored);
      return;
    }
    const result = houseUsers.update(id, { avatar: { kind: 'upload', id: stored.id } });
    if (!result.ok) {
      sendJson(res, result.error === 'User not found' ? 404 : 400, result);
      return;
    }
    userAudit.append({
      ip: adminAuth.clientIpFromRequest(req),
      actorUserId: session.userId,
      action: 'user.avatar',
      targetUserId: id,
      detail: { username: result.user.username },
    });
    sendJson(res, 200, { ok: true, user: { ...result.user, avatarUrl: avatarUrlFor(result.user) } });
  }

  function serveUserAvatar(pathname, res) {
    const name = path.basename(pathname);
    if (!/^[a-z0-9]+\.(png|jpg|jpeg|webp)$/i.test(name)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const filePath = path.join(avatarDir, name);
    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': ext === '.png' ? 'image/png' : (ext === '.webp' ? 'image/webp' : 'image/jpeg'),
      'Cache-Control': 'private, max-age=3600',
    });
    fs.createReadStream(filePath).pipe(res);
  }

  function sendCommandPayload(payload, targetId, res, okBody = {}) {
    const delivery = deliverTargetedPayload(payload, targetId);
    if (delivery?.error && !delivery.isAll) {
      sendJson(res, 404, { ok: false, error: delivery.error });
      return false;
    }
    sendJson(res, 200, {
      ok: true,
      ...(delivery?.target ? { target: delivery.target } : {}),
      ...okBody,
    });
    return true;
  }

  // ---- Push handlers -------------------------------------------------------

  function handleTeslaPush(kind, body, res) {
    if (typeof recordVoiceEvent !== 'function') {
      sendJson(res, 503, { ok: false, error: 'Tesla push unavailable — listener not ready' });
      return;
    }
    const targetId = targetIdFrom(body);
    if (typeof displayRegistry?.resolveDelivery === 'function') {
      const delivery = displayRegistry.resolveDelivery(targetId);
      if (delivery.error && !delivery.isAll) {
        sendJson(res, 404, { ok: false, error: delivery.error });
        return;
      }
    }
    const event = {
      kind,
      device: deviceFrom(body),
      query: `web push ${kind}`,
      trigger: 'web-api',
      timestamp: Date.now(),
      spokenResponse: null,
      targetId,
      triggeredBy: body?.triggeredBy || 'web-api',
    };
    // Fire and forget: Tesla fetches can take up to 30s (vehicle wake); the
    // voice pipeline already sends a cached preview / processing ack first.
    recordVoiceEvent(event).catch((error) => {
      log.error(`Web push ${kind} failed`, error?.message || error);
    });
    log.info(`Web push accepted (${kind})`, { device: event.device, targetId });
    sendJson(res, 202, { ok: true, kind, targetId });
  }

  // Weather / shopping list pushes reuse the same synthetic-event pipeline as
  // Tesla ("web push" trigger), just with a kind/query/trigger tailored to
  // what the voice-query path would have produced for "what's the weather"
  // or "show my shopping list".
  async function handleVoiceQueryPush(kind, query, trigger, body, res) {
    if (typeof recordVoiceEvent !== 'function') {
      sendJson(res, 503, { ok: false, error: 'Push unavailable — listener not ready' });
      return;
    }
    const targetId = targetIdFrom(body);
    if (typeof displayRegistry?.resolveDelivery === 'function') {
      const delivery = displayRegistry.resolveDelivery(targetId);
      if (delivery.error && !delivery.isAll) {
        sendJson(res, 404, { ok: false, error: delivery.error });
        return;
      }
    }
    const event = {
      kind,
      device: deviceFrom(body),
      query,
      trigger,
      timestamp: Date.now(),
      spokenResponse: null,
      targetId,
      triggeredBy: body?.triggeredBy || trigger,
    };
    const pending = recordVoiceEvent(event);
    if (body?.triggeredBy === 'scheduler') {
      const vestaboard = await pending;
      sendJson(res, 202, { ok: true, kind, targetId, vestaboard });
      return;
    }
    pending.catch((error) => {
      log.error(`Web push ${kind} failed`, error?.message || error);
    });
    log.info(`Web push accepted (${kind})`, { device: event.device, targetId });
    sendJson(res, 202, { ok: true, kind, targetId });
  }

  function handleTimersPush(body, res) {
    if (typeof requestTimerPoll !== 'function') {
      sendJson(res, 503, { ok: false, error: 'Timers push unavailable — listener not ready' });
      return;
    }
    const device = deviceFrom(body);
    requestTimerPoll(device);
    log.info('Web push accepted (timers)', { device });
    sendJson(res, 202, { ok: true, kind: 'timers' });
  }

  function handleAlarmsPush(body, res) {
    if (typeof requestAlarmPoll !== 'function') {
      sendJson(res, 503, { ok: false, error: 'Alarms push unavailable — listener not ready' });
      return;
    }
    const device = deviceFrom(body);
    requestAlarmPoll(device);
    log.info('Web push accepted (alarms)', { device });
    sendJson(res, 202, { ok: true, kind: 'alarms' });
  }

  function handleNotificationsPush(body, res) {
    const cached = loadNotificationsCache(config);
    const payload = buildReplayPayload(cached, {
      device: deviceFrom(body),
      trigger: body?.triggeredBy === 'scheduler' ? 'notifications-scheduler' : 'notifications-push',
      timestamp: Date.now(),
    });
    if (!payload) {
      sendJson(res, 404, {
        ok: false,
        error: 'No notification has been captured yet',
      });
      return;
    }
    const targetId = targetIdFrom(body);
    if (typeof displayRegistry?.resolveDelivery === 'function') {
      const delivery = displayRegistry.resolveDelivery(targetId);
      if (delivery.error && !delivery.isAll) {
        sendJson(res, 404, { ok: false, error: delivery.error });
        return;
      }
    }
    const deliveryResult = typeof deliverTargetedPayload === 'function'
      ? deliverTargetedPayload(payload, targetId, {
        source: body?.triggeredBy === 'scheduler' ? 'scheduler' : 'web-api',
      })
      : null;
    if (deliveryResult?.error && !deliveryResult?.isAll) {
      sendJson(res, 404, { ok: false, error: deliveryResult.error });
      return;
    }
    log.info('Web push accepted (notifications)', {
      device: payload.device,
      targetId,
      items: payload.notifications?.items?.length ?? 0,
    });
    const responseBody = {
      ok: true,
      kind: 'alexa-notifications',
      targetId,
      vestaboard: deliveryResult?.vestaboard,
    };
    if (body?.triggeredBy === 'scheduler') {
      sendJson(res, 202, responseBody);
      return;
    }
    sendJson(res, 200, responseBody);
  }

  async function handleGuestPhotoboothPush(body, res) {
    if (typeof recordVoiceEvent !== 'function') {
      sendJson(res, 503, { ok: false, error: 'Push unavailable — listener not ready' });
      return;
    }
    const settings = resolveGuestPhotoboothSettings(config);
    if (!settings.configured) {
      sendJson(res, 503, {
        ok: false,
        error: 'Guest Snaps is not configured — set GUEST_WIFI_SSID and GUEST_PHOTOBOOTH_URL in .env (or data/guest-photobooth.json)',
      });
      return;
    }
    const targetId = body?.triggeredBy === 'scheduler'
      ? (body.targetId || 'full')
      : '*';
    await handleVoiceQueryPush(
      'guest-photobooth',
      'open guest snaps',
      'web-api',
      { ...(body || {}), targetId },
      res,
    );
  }

  async function handleUrlPush(body, res) {
    const validation = validatePushUrl(body?.url);
    if (!validation.ok) {
      sendJson(res, 400, { ok: false, error: validation.error });
      return;
    }

    const payload = buildWebOpenPayload({
      url: validation.url,
      device: deviceFrom(body),
      trigger: 'web-api',
    }, config);
    if (!payload) {
      sendJson(res, 400, { ok: false, error: 'URL was rejected' });
      return;
    }

    const targetId = targetIdFrom(body);
    activeWebPush = { url: validation.url, pushedAt: new Date().toISOString(), targetId };
    log.info('Web URL pushed to display', { url: validation.url, targetId });

    // Best-effort reachability info for instant phone feedback; the client
    // does its own pre-flight and shows the friendly error when needed.
    const check = await checkUrlReachable(validation.url);
    if (typeof deliverTargetedPayload === 'function') {
      const delivery = deliverTargetedPayload(payload, targetId);
      if (delivery?.error && !delivery.isAll) {
        sendJson(res, 404, { ok: false, error: delivery.error });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        sent: true,
        url: validation.url,
        target: delivery.target,
        ...check,
      });
      return;
    }
    sendUdpPayload(payload);
    sendJson(res, 200, { ok: true, sent: true, url: validation.url, ...check });
  }

  function handleCloseBrowser(body, res) {
    const payload = buildWebClosePayload({ device: deviceFrom(body), trigger: 'web-api' }, config);
    activeWebPush = null;
    log.info('Web browser close sent to display');
    sendCommandPayload(payload, targetIdFrom(body), res);
  }

  function handleSystemCommand(req, action, body, res) {
    const targetId = requireControlAuth(req, body, res);
    if (targetId == null) {
      return;
    }
    const payload = buildSystemCommandPayload({
      action,
      device: deviceFrom(body),
      trigger: 'web-api',
    }, config);
    if (!payload) {
      sendJson(res, 400, { ok: false, error: `Unknown system action: ${action}` });
      return;
    }
    activeWebPush = null;
    log.info(`System ${action} sent to display PC`, { targetId });
    sendCommandPayload(payload, targetId, res, { action });
  }

  function handleControlAuthStart(body, res) {
    const targetId = targetIdFrom(body);
    const challenge = controlAuth.startChallenge(targetId);
    if (challenge.error) {
      sendJson(res, 400, { ok: false, error: challenge.error });
      return;
    }
    const payload = buildDisplayAuthPinPayload({
      pin: challenge.pin,
      displaySeconds: challenge.displaySeconds,
      device: deviceFrom(body),
      trigger: 'web-api',
    }, config);
    if (!payload) {
      sendJson(res, 500, { ok: false, error: 'Could not build PIN payload' });
      return;
    }
    if (typeof deliverTargetedPayload === 'function') {
      const delivery = deliverTargetedPayload(payload, targetId);
      if (delivery?.error && !delivery.isAll) {
        sendJson(res, 404, { ok: false, error: delivery.error });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        ...controlAuth.publicChallengeView(challenge),
        target: delivery.target,
      });
      return;
    }
    sendUdpPayload(payload);
    sendJson(res, 200, { ok: true, ...controlAuth.publicChallengeView(challenge) });
  }

  function handleControlAuthVerify(body, res) {
    const targetId = targetIdFrom(body);
    const result = controlAuth.verifyPin(targetId, body?.pin);
        if (result.error) {
      sendJson(res, 403, {
        ok: false,
        error: result.error,
        code: String(result.error).startsWith('Incorrect PIN')
          ? 'control_auth_incorrect_pin'
          : 'control_auth_failed',
      });
      return;
    }

    // Replace the on-screen PIN with a brief green "Authenticated" flash.
    const okPayload = buildDisplayAuthOkPayload({
      displaySeconds: 1,
      device: deviceFrom(body),
      trigger: 'web-api',
    });
    if (typeof deliverTargetedPayload === 'function') {
      deliverTargetedPayload(okPayload, targetId);
    } else {
      sendUdpPayload(okPayload);
    }

    sendJson(res, 200, { ok: true, ...result });
  }

  function handleControlAuthStatus(req, body, res) {
    const targetId = targetIdFrom(body);
    sendJson(res, 200, {
      ok: true,
      ...controlAuth.getStatus(targetId, controlTokenFrom(req, body)),
    });
  }

  function handleDisplaysList(res) {
    const displays = displayRegistry?.list?.() || [];
    sendJson(res, 200, { ok: true, displays });
  }

  async function handleDisplaysDiscover(res) {
    const payload = buildDisplayDiscoverPayload({ trigger: 'web-api' }, config);
    sendUdpPayload(payload);
    log.info('Display discover broadcast sent', {
      discoveryPort: payload.discovery?.port,
    });

    // Wait for live clients to re-announce, then drop anyone who stayed silent.
    let removed = [];
    let displays = displayRegistry?.list?.({ skipPrune: true }) || [];
    if (typeof displayRegistry?.scheduleDiscoverSweep === 'function') {
      const sweep = await displayRegistry.scheduleDiscoverSweep();
      removed = sweep.removed || [];
      displays = sweep.displays || displays;
      if (removed.length) {
        log.info('Discover sweep removed offline displays', { removed });
      }
    }

    sendJson(res, 200, {
      ok: true,
      sent: true,
      discoveryPort: payload.discovery?.port,
      removedIds: removed,
      displays,
    });
  }

  function handleDisplaysEvents(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');

    const sendList = (reason, entry = null) => {
      const body = JSON.stringify({
        reason,
        entry,
        displays: displayRegistry?.list?.() || [],
      });
      res.write(`event: displays\ndata: ${body}\n\n`);
    };

    sendList('hello');

    const unsubscribe = displayRegistry?.onChange
      ? displayRegistry.onChange((entry, displays) => {
        try {
          const body = JSON.stringify({ reason: 'announce', entry, displays });
          res.write(`event: displays\ndata: ${body}\n\n`);
        } catch {
          // client gone
        }
      })
      : () => {};

    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(heartbeat);
      }
    }, 15000);

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  }

  function handleInputPointer(req, body, res) {
    const targetId = requireControlAuth(req, body, res);
    if (targetId == null) {
      return;
    }
    if (!targetId || targetId === ALL_TARGET_ID || targetId.toLowerCase() === 'all') {
      sendJson(res, 400, {
        ok: false,
        error: 'Mouse control requires a single display — select one display first',
      });
      return;
    }
    const payload = buildInputPointerPayload({
      dx: body?.dx,
      dy: body?.dy,
      buttons: body?.buttons || null,
      wheel: body?.wheel,
      device: deviceFrom(body),
      trigger: 'web-api',
    });
    sendCommandPayload(payload, targetId, res);
  }

  function handleInputKey(req, body, res) {
    const targetId = requireControlAuth(req, body, res);
    if (targetId == null) {
      return;
    }
    if (!targetId || targetId === ALL_TARGET_ID || targetId.toLowerCase() === 'all') {
      sendJson(res, 400, {
        ok: false,
        error: 'Keyboard control requires a single display — select one display first',
      });
      return;
    }
    const payload = buildInputKeyPayload({
      key: body?.key,
      modifiers: body?.modifiers,
      action: body?.action,
      device: deviceFrom(body),
      trigger: 'web-api',
    });
    if (!payload) {
      sendJson(res, 400, { ok: false, error: 'Missing key' });
      return;
    }
    sendCommandPayload(payload, targetId, res);
  }

  function handleInputText(req, body, res) {
    const targetId = requireControlAuth(req, body, res);
    if (targetId == null) {
      return;
    }
    if (!targetId || targetId === ALL_TARGET_ID || targetId.toLowerCase() === 'all') {
      sendJson(res, 400, {
        ok: false,
        error: 'Keyboard control requires a single display — select one display first',
      });
      return;
    }
    const payload = buildInputTextPayload({
      value: body?.value,
      pressEnter: body?.pressEnter,
      device: deviceFrom(body),
      trigger: 'web-api',
    });
    if (!payload) {
      sendJson(res, 400, { ok: false, error: 'Missing text to send' });
      return;
    }
    sendCommandPayload(payload, targetId, res);
  }

  // ---- QR code generation ---------------------------------------------------

  function handleQrImageUpload(body, res) {
    const result = qrImageCache.store(body?.imageDataUrl);
    if (!result.ok) {
      sendJson(res, 400, { ok: false, error: result.error });
      return;
    }
    log.info('QR photo uploaded to cache', { token: result.token });
    sendJson(res, 200, { ok: true, path: result.path, token: result.token, createdAt: result.createdAt });
  }

  function collectQrPhotoEntries(body) {
    const raw = [];
    if (Array.isArray(body?.photos) && body.photos.length) {
      raw.push(...body.photos);
    } else if (Array.isArray(body?.urls) && body.urls.length) {
      raw.push(...body.urls);
    } else if (body?.url) {
      raw.push(body.url);
    }
    const entries = [];
    for (const item of raw) {
      const url = item && typeof item === 'object' ? item.url : item;
      const validation = validatePushUrl(url);
      if (!validation.ok) {
        return { ok: false, error: validation.error };
      }
      const uploadedAt = item && typeof item === 'object'
        ? (item.uploadedAt || item.createdAt || null)
        : null;
      entries.push({ url: validation.url, uploadedAt });
    }
    if (!entries.length) {
      return { ok: false, error: 'URL is required' };
    }
    if (entries.length > 20) {
      return { ok: false, error: 'Send up to 20 photos at a time' };
    }
    return { ok: true, entries };
  }

  function handleQrPush(req, body, res) {
    const mode = String(body?.mode || '').trim().toLowerCase();
    // Photo pushes need a Guest Snaps PIN session (or admin); URL/Wi-Fi admin-only.
    if (mode === 'photo') {
      if (!requireGuestOrAdmin(req, res)) {
        return;
      }
    } else if (!adminAuth.assertAuthorized(req).ok) {
      sendJson(res, 401, {
        ok: false,
        error: 'Admin login required to push URL or Wi-Fi QR codes',
        code: 'unauthorized',
      });
      return;
    }
    let qrType;
    let content;
    let label;

    if (mode === 'photo') {
      const collected = collectQrPhotoEntries(body);
      if (!collected.ok) {
        sendJson(res, 400, { ok: false, error: collected.error });
        return;
      }
      if (collected.entries.length > 1) {
        const payload = buildPhotoSlideshowPayload({
          photos: collected.entries,
          secondsPerPhoto: slideshowSettings.getSecondsPerPhoto(),
          device: deviceFrom(body),
          trigger: 'qr-photo-queue',
          order: 'queued',
        });
        if (!payload) {
          sendJson(res, 400, { ok: false, error: 'Could not build the photo slideshow' });
          return;
        }
        log.info('Queued photo slideshow pushed to display', {
          count: payload.slideshow.photos.length,
          secondsPerPhoto: payload.slideshow.secondsPerPhoto,
          targetId: targetIdFrom(body),
        });
        sendCommandPayload(payload, targetIdFrom(body), res, {
          slideshow: true,
          count: payload.slideshow.photos.length,
        });
        return;
      }
      qrType = 'photo';
      content = collected.entries[0].url;
      label = String(body?.label || '').trim() || 'Scan to save this photo';
    } else if (mode === 'url') {
      const validation = validatePushUrl(body?.url);
      if (!validation.ok) {
        sendJson(res, 400, { ok: false, error: validation.error });
        return;
      }
      // 'photo' tells the display to hero the image itself and tuck the QR
      // into the corner (slideshow-style); plain 'url' keeps the classic
      // full-size QR layout for arbitrary links.
      qrType = 'url';
      content = validation.url;
      label = String(body?.label || '').trim() || validation.url;
    } else if (mode === 'wifi') {
      const ssid = String(body?.ssid || '').trim();
      if (!ssid) {
        sendJson(res, 400, { ok: false, error: 'Wi-Fi network name is required' });
        return;
      }
      const security = String(body?.security || 'WPA').trim();
      const isOpen = security.toLowerCase() === 'nopass';
      if (!isOpen && !String(body?.password || '').trim()) {
        sendJson(res, 400, {
          ok: false,
          error: 'Wi-Fi password is required (or mark the network as open)',
        });
        return;
      }
      content = buildWifiQrContent({
        ssid,
        password: body?.password,
        security,
        hidden: Boolean(body?.hidden),
      });
      if (!content) {
        sendJson(res, 400, { ok: false, error: 'Could not build the Wi-Fi QR code' });
        return;
      }
      qrType = 'wifi';
      label = `Wi-Fi: ${ssid}`;
    } else {
      sendJson(res, 400, { ok: false, error: `Unknown QR mode: ${mode || '(none)'}` });
      return;
    }

    const payload = buildQrDisplayPayload({
      qrType,
      content,
      label,
      device: deviceFrom(body),
      trigger: 'qr-api',
    }, config);
    if (!payload) {
      sendJson(res, 400, { ok: false, error: 'Could not build the QR code' });
      return;
    }

    log.info('QR code pushed to display', { qrType, label, targetId: targetIdFrom(body) });
    sendCommandPayload(payload, targetIdFrom(body), res, { qrType, label });
  }

  async function handleQrImageServe(pathname, res) {
    const routeTail = pathname.slice(qrImageCache.routePrefix.length);
    let entry = qrImageCache.get(routeTail);
    if (!entry && typeof qrImageCache.ensureThumb === 'function') {
      const token = parseThumbRouteTail(routeTail.replace(/^\/+/, ''));
      if (token) {
        entry = await qrImageCache.ensureThumb(token);
      }
    }
    if (!entry) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found or expired');
      return;
    }
    // Thumbs are immutable per token and safe to cache in the browser so the
    // Slideshow grid stays snappy on revisit. Full originals stay no-store so
    // a delete is reflected immediately if a lightbox still has the URL.
    const cacheControl = entry.isThumb
      ? 'private, max-age=31536000, immutable'
      : 'no-store';
    res.writeHead(200, {
      'Content-Type': entry.mimeType,
      'Cache-Control': cacheControl,
    });
    fs.createReadStream(entry.filePath).pipe(res);
  }

  function rollCreditsError(res, error) {
    const message = error?.message || String(error);
    const status = /not found/i.test(message) ? 404
      : /too large|body too large|exceeds/i.test(message) ? 413
        : 400;
    sendJson(res, status, { ok: false, error: message });
  }

  /** Parses a single `bytes=a-b` range against a known size, or null. */
  function parseByteRange(header, size) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
    if (!match || (!match[1] && !match[2])) return null;
    let start;
    let end;
    if (match[1]) {
      start = Number(match[1]);
      end = match[2] ? Number(match[2]) : size - 1;
    } else {
      // Suffix form: the last N bytes.
      start = Math.max(0, size - Number(match[2]));
      end = size - 1;
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null;
    return { start, end: Math.min(end, size - 1) };
  }

  function handleRollCreditsMediaServe(pathname, res, req = null) {
    const tail = pathname.slice(rollCreditsInstance.media.routePrefix.length);
    try {
      const filePath = rollCreditsInstance.media.absolutePath(decodeURIComponent(tail));
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }
      const stat = fs.statSync(filePath);
      const headers = {
        'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()]
          || 'application/octet-stream',
        'Cache-Control': 'public, max-age=31536000, immutable',
        ETag: `"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`,
        'Accept-Ranges': 'bytes',
      };
      // Seeking in the admin's <video> trimmer depends on range replies; without
      // them the browser can only play a stored clip straight through.
      const range = parseByteRange(req?.headers?.range, stat.size);
      if (range) {
        res.writeHead(206, {
          ...headers,
          'Content-Range': `bytes ${range.start}-${range.end}/${stat.size}`,
          'Content-Length': range.end - range.start + 1,
        });
        if (req?.method === 'HEAD') {
          res.end();
          return;
        }
        fs.createReadStream(filePath, { start: range.start, end: range.end }).pipe(res);
        return;
      }
      res.writeHead(200, { ...headers, 'Content-Length': stat.size });
      if (req?.method === 'HEAD') {
        res.end();
        return;
      }
      fs.createReadStream(filePath).pipe(res);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    }
  }

  function handleRollCreditsEvents(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    const send = (event) => {
      try {
        res.write(`event: roll-credits\ndata: ${JSON.stringify(event)}\n\n`);
      } catch {
        // client gone
      }
    };
    send({ reason: 'hello' });
    const unsubscribe = rollCreditsInstance.onEvents?.(send) || (() => {});
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(heartbeat);
      }
    }, 15000);
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  }

  function rollCreditsListOptions(searchParams) {
    return Object.fromEntries([
      'sort', 'dir', 'page', 'pageSize', 'system', 'yearBeaten', 'q', 'noDate',
    ].map((key) => [key, searchParams.get(key)]).filter(([, value]) => value != null));
  }

  async function handleRollCreditsPost(pathname, body, res) {
    const tail = pathname.slice('/api/roll-credits/'.length);
    try {
      if (tail === 'games') {
        const game = body?.candidate
          ? await rollCreditsInstance.createFromCandidate(body)
          : rollCreditsInstance.createManual(body);
        sendJson(res, 201, { ok: true, game });
        return;
      }
      if (tail === 'games/bulk-delete') {
        sendJson(res, 200, { ok: true, ...rollCreditsInstance.bulkDelete(body?.ids) });
        return;
      }
      if (tail === 'games/reorder') {
        const result = body?.reset === true
          ? rollCreditsInstance.resetInductionOrder()
          : rollCreditsInstance.reorderGames(body?.ids);
        sendJson(res, 200, { ok: true, ...result });
        return;
      }
      if (tail === 'search') {
        const candidates = await rollCreditsInstance.search(body?.q, { limit: body?.limit });
        sendJson(res, 200, { ok: true, candidates });
        return;
      }
      if (tail === 'rescrape-bulk') {
        const results = [];
        const failed = [];
        for (const id of Array.isArray(body?.ids) ? body.ids : []) {
          try {
            results.push(await rollCreditsInstance.rescrape(String(id), body));
          } catch (error) {
            failed.push({ id: String(id), error: error?.message || String(error) });
          }
        }
        sendJson(res, 200, { ok: true, games: results, failed });
        return;
      }
      if (tail === 'settings') {
        const result = rollCreditsInstance.updateSettings(body);
        sendJson(res, result.ok ? 200 : 500, result);
        return;
      }
      if (tail === 'credentials') {
        const result = rollCreditsInstance.saveCredentials(body);
        sendJson(res, result.status || (result.ok ? 200 : 400), result);
        return;
      }
      if (tail === 'credentials/test') {
        sendJson(res, 200, await rollCreditsInstance.testCredentials());
        return;
      }
      if (tail === 'prune-orphans') {
        sendJson(res, 200, { ok: true, ...rollCreditsInstance.pruneOrphans() });
        return;
      }
      if (tail === 'rebuild-previews') {
        sendJson(res, 202, { ok: true, ...rollCreditsInstance.rebuildWallPreviews() });
        return;
      }
      const rescrapeMatch = /^games\/([^/]+)\/rescrape$/.exec(tail);
      if (rescrapeMatch) {
        const game = await rollCreditsInstance.rescrape(
          decodeURIComponent(rescrapeMatch[1]),
          body,
        );
        sendJson(res, 200, { ok: true, game });
        return;
      }
      const mediaMatch = /^games\/([^/]+)\/media$/.exec(tail);
      if (mediaMatch) {
        const gameId = decodeURIComponent(mediaMatch[1]);
        const media = body?.youtubeUrl
          ? rollCreditsInstance.addYoutube(gameId, body)
          : await rollCreditsInstance.addUploadedImage(gameId, body);
        sendJson(res, 201, { ok: true, media });
        return;
      }
      const retryMatch = /^games\/([^/]+)\/media\/([^/]+)\/retry$/.exec(tail);
      if (retryMatch) {
        const job = rollCreditsInstance.retryMedia(
          decodeURIComponent(retryMatch[1]),
          decodeURIComponent(retryMatch[2]),
        );
        sendJson(res, 202, { ok: true, job });
        return;
      }
      const trimMatch = /^games\/([^/]+)\/media\/([^/]+)\/trim$/.exec(tail);
      if (trimMatch) {
        const media = await rollCreditsInstance.setMediaTrim(
          decodeURIComponent(trimMatch[1]),
          decodeURIComponent(trimMatch[2]),
          { trimStart: body?.trimStart ?? null, trimEnd: body?.trimEnd ?? null },
        );
        sendJson(res, 200, { ok: true, media });
        return;
      }
      const resolutionMatch = /^games\/([^/]+)\/media\/([^/]+)\/resolution$/.exec(tail);
      if (resolutionMatch) {
        const result = rollCreditsInstance.setMediaResolution(
          decodeURIComponent(resolutionMatch[1]),
          decodeURIComponent(resolutionMatch[2]),
          body?.resolution,
        );
        sendJson(res, 202, { ok: true, ...result });
        return;
      }
      sendJson(res, 404, { ok: false, error: 'Unknown endpoint' });
    } catch (error) {
      rollCreditsError(res, error);
    }
  }

  async function handleRollCreditsWrite(req, pathname, body, res) {
    const tail = pathname.slice('/api/roll-credits/'.length);
    try {
      const uploadMatch = /^games\/([^/]+)\/media\/video-upload$/.exec(tail);
      if (req.method === 'PUT' && uploadMatch) {
        const row = await rollCreditsInstance.saveVideoUpload(
          decodeURIComponent(uploadMatch[1]),
          req,
          {
            mimeType: req.headers['content-type'],
            contentLength: req.headers['content-length'],
          },
        );
        sendJson(res, 201, { ok: true, media: row });
        return;
      }
      const mediaMatch = /^games\/([^/]+)\/media\/([^/]+)$/.exec(tail);
      if (req.method === 'DELETE' && mediaMatch) {
        const media = rollCreditsInstance.deleteMedia(
          decodeURIComponent(mediaMatch[1]),
          decodeURIComponent(mediaMatch[2]),
        );
        sendJson(res, 200, { ok: true, media });
        return;
      }
      const gameMatch = /^games\/([^/]+)$/.exec(tail);
      if (gameMatch) {
        const id = decodeURIComponent(gameMatch[1]);
        if (req.method === 'PUT') {
          const game = rollCreditsInstance.updateGame(id, body);
          sendJson(res, game ? 200 : 404, game
            ? { ok: true, game }
            : { ok: false, error: 'Roll Credits game not found' });
        } else {
          const deleted = rollCreditsInstance.deleteGame(id);
          sendJson(res, deleted ? 200 : 404, deleted
            ? { ok: true, deleted: id }
            : { ok: false, error: 'Roll Credits game not found' });
        }
        return;
      }
      sendJson(res, 404, { ok: false, error: 'Unknown endpoint' });
    } catch (error) {
      req.resume?.();
      rollCreditsError(res, error);
    }
  }

  // ---- Shared photo slideshow / Slideshow Manager ---------------------------

  function handlePhotosList(res) {
    sendJson(res, 200, { ok: true, photos: qrImageCache.list() });
  }

  /** SSE stream so every open Slideshow Manager tab — not just the one that
   * triggered a change — sees new uploads/deletes live, same pattern as
   * `handleDisplaysEvents`. Manual refresh (`GET /api/photos`) stays as a
   * fallback for browsers that drop/block the connection. */
  function handlePhotoEvents(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');

    const send = (reason, photos) => {
      try {
        res.write(`event: photos\ndata: ${JSON.stringify({ reason, photos })}\n\n`);
      } catch {
        // client gone
      }
    };

    send('hello', qrImageCache.list());

    const unsubscribe = qrImageCache.onChange
      ? qrImageCache.onChange((reason, photos) => send(reason, photos))
      : () => {};

    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(heartbeat);
      }
    }, 15000);

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  }

  /** The board list for the Settings tab. Health comes from the live queues. */
  function handleVestaboardsGet(res) {
    if (!vestaboardHub) {
      sendJson(res, 404, { ok: false, error: 'Vestaboards are not configured' });
      return;
    }
    sendJson(res, 200, vestaboardsPayload());
  }

  function vestaboardsPayload() {
    return {
      ok: true,
      boards: vestaboardHub.settingsView(),
      house: vestaboardHub.houseSettings?.() || vestaboardHub.settings?.house?.() || null,
      priorityCatalog: vestaboardHub.priorityCatalog?.() || null,
    };
  }

  function handleVestaboardHouse(body, res) {
    if (!vestaboardHub) {
      sendJson(res, 404, { ok: false, error: 'Vestaboards are not configured' });
      return;
    }
    const outcome = vestaboardHub.settings.setHouse(body || {});
    if (!outcome.ok) {
      sendJson(res, 400, { ok: false, error: outcome.error || 'Could not save house settings' });
      return;
    }
    log.info('Vestaboard house dwell / priorities updated');
    sendJson(res, 200, vestaboardsPayload());
  }

  function handleVestaboardSave(body, res) {
    if (!vestaboardHub) {
      sendJson(res, 404, { ok: false, error: 'Vestaboards are not configured' });
      return;
    }
    const outcome = vestaboardHub.settings.upsert(body || {});
    if (!outcome.ok) {
      sendJson(res, 400, { ok: false, error: outcome.error });
      return;
    }
    log.info(`Vestaboard ${outcome.created ? 'added' : 'updated'}: ${outcome.board.id}`);
    displayRegistry?.announce?.({ vestaboard: outcome.board.id });
    sendJson(res, 200, vestaboardsPayload());
  }

  function handleVestaboardRemove(body, res) {
    if (!vestaboardHub) {
      sendJson(res, 404, { ok: false, error: 'Vestaboards are not configured' });
      return;
    }
    const outcome = vestaboardHub.settings.remove(body?.id);
    if (!outcome.ok) {
      sendJson(res, 400, { ok: false, error: outcome.error });
      return;
    }
    log.info(`Vestaboard removed: ${body.id}`);
    displayRegistry?.announce?.({ vestaboard: body.id, removed: true });
    sendJson(res, 200, vestaboardsPayload());
  }

  function handleVestaboardEnable(body, res) {
    if (!vestaboardHub) {
      sendJson(res, 404, { ok: false, error: 'Vestaboards are not configured' });
      return;
    }
    if (typeof body?.enabled !== 'boolean') {
      sendJson(res, 400, { ok: false, error: 'enabled must be true or false' });
      return;
    }
    const outcome = vestaboardHub.settings.setEnabled(body.id, body.enabled);
    if (!outcome.ok) {
      sendJson(res, 400, { ok: false, error: outcome.error });
      return;
    }
    displayRegistry?.announce?.({ vestaboard: body.id, enabled: body.enabled });
    sendJson(res, 200, vestaboardsPayload());
  }

  /** Proof that a board answers, its key works, and every flap still turns. */
  async function handleVestaboardTestFlip(body, res) {
    if (!vestaboardHub) {
      sendJson(res, 404, { ok: false, error: 'Vestaboards are not configured' });
      return;
    }
    const outcome = await vestaboardHub.testFlip(body?.id);
    sendJson(res, outcome.ok ? 200 : 400, outcome);
  }

  /**
   * Drop active holds on every Vestaboard in the house (or one board when
   * `id` is set). From the Simulator page so Feature Presentation / games
   * do not keep rotation parked until their detectors notice an end.
   */
  function handleVestaboardReleaseHolds(body, res) {
    if (!vestaboardHub?.releaseHolds) {
      sendJson(res, 404, { ok: false, error: 'Vestaboards are not configured' });
      return;
    }
    const boardId = String(body?.id || '').trim();
    const outcome = vestaboardHub.releaseHolds(boardId ? { boardId } : {});
    // Sim state for the Board tab pill / queue "held" badges.
    const simState = vestaboardSimulator
      ? vestaboardSimPublicState()
      : null;
    sendJson(res, 200, {
      ok: true,
      ...outcome,
      state: simState,
      queue: vestaboardSimQueue(),
      queueRevision: vestaboardSimQueueRevision(),
    });
  }

  function vestaboardSimQueue() {
    const items = vestaboardHub?.queueFor?.(SIMULATOR_ID)?.pending?.() || [];
    return items.map((item) => ({
      ...item,
      eventTitle: resolveVestaboardQueueEventTitle(item),
    }));
  }

  function resolveVestaboardQueueEventTitle(item = {}) {
    const commandId = String(item.commandId || '').trim();
    if (commandId) {
      const command = commandRegistry.get(commandId);
      if (command?.title) return command.title;
    }
    const source = String(item.source || '').trim();
    if (source) {
      const fromCatalog = vestaboardSourceLabel(source);
      if (fromCatalog && fromCatalog !== source) return fromCatalog;
    }
    return item.label || 'Frame';
  }

  function vestaboardSimQueueRevision() {
    return Number(vestaboardHub?.queueFor?.(SIMULATOR_ID)?.state?.()?.queueRevision) || 0;
  }

  function vestaboardSimQueuePayload(items = null) {
    return {
      boardId: SIMULATOR_ID,
      items: items || vestaboardSimQueue(),
      revision: vestaboardSimQueueRevision(),
    };
  }

  /**
   * The Local API's own cooldown is the 15s flap window. The page's
   * "Next flip" pill also waits out Settings → Dwell, or a Now jumper's
   * remaining flap window — `nextFlipCooldownMs` already picks which.
   * Do not max in leftover snapshot dwell: a Now event that arrived while
   * a rotation page was still posting used to put 60s back on the pill
   * even though the doorbell was about to cut in.
   */
  function vestaboardSimPublicState(raw = null) {
    const state = raw || vestaboardSimulator?.state?.() || {};
    const queue = vestaboardHub?.queueFor?.(SIMULATOR_ID)?.state?.() || {};
    const queueWait = Number(queue.nextFlipCooldownMs) || 0;
    return {
      ...state,
      cooldownMs: Math.max(Number(state.cooldownMs) || 0, queueWait),
      gameLock: queue.gameLock || null,
      phaseUntil: queue.phaseUntil || null,
    };
  }

  /** Everything the simulator page needs to draw itself from a cold start. */
  function handleVestaboardSimState(res) {
    if (!vestaboardSimulator) {
      sendJson(res, 404, { ok: false, error: 'Simulator is not running' });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      state: vestaboardSimPublicState(),
      calls: vestaboardSimulator.calls(),
      queue: vestaboardSimQueue(),
      queueRevision: vestaboardSimQueueRevision(),
      // The page owns no knowledge of the character set; it renders whatever
      // the encoder says each code looks like.
      glyphs: Object.fromEntries(VESTABOARD_CHAR_BY_CODE),
      chips: VESTABOARD_CHIPS,
      // Drum order lives here so the page can walk flaps without owning the
      // character set. Unused codes are already omitted.
      drum: vestaboardDrumOrder(),
      port: vestaboardSimulator.port,
    });
  }

  /** Live board updates, same pattern as `handlePhotoEvents`. */
  function handleVestaboardSimEvents(req, res) {
    if (!vestaboardSimulator) {
      sendJson(res, 404, { ok: false, error: 'Simulator is not running' });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');

    const send = (name, detail) => {
      try {
        res.write(`event: ${name}\ndata: ${JSON.stringify(detail)}\n\n`);
      } catch {
        // client gone
      }
    };

    send('sim.state', vestaboardSimPublicState());
    send('sim.queue', vestaboardSimQueuePayload());

    const unsubscribeSim = vestaboardSimulator.onChange((event, detail) => {
      if (event === 'state') send('sim.state', vestaboardSimPublicState(detail));
      else if (event === 'flip') send('sim.flip', detail);
      else if (event === 'call') send('sim.call', detail);
    });

    const unsubscribeHub = vestaboardHub?.onChange?.((event, detail) => {
      if (detail?.boardId && detail.boardId !== SIMULATOR_ID) {
        return;
      }
      if (event === 'queue') {
        send('sim.queue', detail);
        // Phase hold / game lock live on the queue; refresh the pill when
        // a lobby ends or the session releases the board without a flip.
        send('sim.state', vestaboardSimPublicState());
      }
      // The Local API emits `state` during the POST, before the queue
      // records dwell. Push a second state after `posted` so the pill
      // counts down Settings → Dwell, not only the 15s flap window.
      if (event === 'posted') {
        send('sim.state', vestaboardSimPublicState());
      }
    }) || (() => {});

    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(heartbeat);
      }
    }, 15000);

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribeSim();
      unsubscribeHub();
    });
  }

  /** Board-tab power switch: Local API 503s, and the sim leaves the picker. */
  function handleVestaboardSimOnline(body, res) {
    if (!vestaboardSimulator) {
      sendJson(res, 404, { ok: false, error: 'Simulator is not running' });
      return;
    }
    if (typeof body?.online !== 'boolean') {
      sendJson(res, 400, { ok: false, error: 'online must be true or false' });
      return;
    }
    const state = vestaboardSimulator.setOnline(body.online);
    // The Board-tab toggle is the sim's power switch. An off board must leave
    // the display picker the same way a disabled board does, or Push still
    // offers "Vestaboard Simulator" and the queue keeps retrying 503s.
    if (vestaboardHub?.settings?.setEnabled) {
      vestaboardHub.settings.setEnabled(SIMULATOR_ID, state.online);
    }
    displayRegistry?.announce?.({ simulatorOnline: state.online });
    log.info(`Vestaboard simulator turned ${state.online ? 'on' : 'off'}`);
    sendJson(res, 200, { ok: true, state });
  }

  function vestaboardSimQueueApi() {
    return vestaboardHub?.queueFor?.(SIMULATOR_ID) || null;
  }

  function handleVestaboardSimQueueCancel(body, res) {
    const queue = vestaboardSimQueueApi();
    if (!queue) {
      sendJson(res, 404, { ok: false, error: 'Simulator queue is not running' });
      return;
    }
    const id = String(body?.id || '').trim();
    if (!id) {
      sendJson(res, 400, { ok: false, error: 'id is required' });
      return;
    }
    const cancelled = queue.cancel(id);
    sendJson(res, 200, {
      ok: true,
      gone: !cancelled,
      queue: vestaboardSimQueue(),
      queueRevision: vestaboardSimQueueRevision(),
    });
  }

  function handleVestaboardSimQueueClear(_body, res) {
    const queue = vestaboardSimQueueApi();
    if (!queue) {
      sendJson(res, 404, { ok: false, error: 'Simulator queue is not running' });
      return;
    }
    const dropped = queue.clear?.() || 0;
    sendJson(res, 200, {
      ok: true,
      dropped,
      queue: vestaboardSimQueue(),
      queueRevision: vestaboardSimQueueRevision(),
    });
  }

  function handleVestaboardSimQueueReorder(body, res) {
    const queue = vestaboardSimQueueApi();
    if (!queue) {
      sendJson(res, 404, { ok: false, error: 'Simulator queue is not running' });
      return;
    }
    const ids = Array.isArray(body?.ids) ? body.ids.map((id) => String(id || '').trim()).filter(Boolean) : null;
    if (!ids) {
      sendJson(res, 400, { ok: false, error: 'ids must be an array' });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      queue: queue.reorder(ids),
      queueRevision: vestaboardSimQueueRevision(),
    });
  }

  function handlePhotoDelete(body, res) {
    const tokens = Array.isArray(body?.tokens)
      ? body.tokens
      : (body?.token ? [body.token] : []);
    const cleaned = [...new Set(tokens.map((t) => String(t || '').trim()).filter(Boolean))];
    if (!cleaned.length) {
      sendJson(res, 400, { ok: false, error: 'No photo(s) specified' });
      return;
    }
    const deleted = [];
    const failed = [];
    for (const token of cleaned) {
      if (qrImageCache.delete(token)) {
        deleted.push(token);
      } else {
        failed.push(token);
      }
    }
    log.info('Photo(s) deleted from Slideshow Manager', { deleted: deleted.length, failed: failed.length });
    sendJson(res, 200, { ok: true, deleted, failed });
  }

  function handleSlideshowSettingsGet(res) {
    const settings = slideshowSettings.get();
    sendJson(res, 200, {
      ok: true,
      order: settings.order,
      orders: VALID_ORDERS,
      secondsPerPhoto: settings.secondsPerPhoto,
      secondsPerPhotoMin: MIN_SECONDS_PER_PHOTO,
      secondsPerPhotoMax: MAX_SECONDS_PER_PHOTO,
    });
  }

  function handleSlideshowSettingsUpdate(body, res) {
    const patch = {};
    if (body && Object.prototype.hasOwnProperty.call(body, 'order')) {
      patch.order = body.order;
    }
    if (body && Object.prototype.hasOwnProperty.call(body, 'secondsPerPhoto')) {
      patch.secondsPerPhoto = body.secondsPerPhoto;
    }
    const result = slideshowSettings.update(patch);
    if (!result.ok) {
      sendJson(res, 400, result);
      return;
    }
    log.info('Slideshow settings updated', {
      order: result.order,
      secondsPerPhoto: result.secondsPerPhoto,
    });
    sendJson(res, 200, {
      ok: true,
      order: result.order,
      orders: VALID_ORDERS,
      secondsPerPhoto: result.secondsPerPhoto,
      secondsPerPhotoMin: MIN_SECONDS_PER_PHOTO,
      secondsPerPhotoMax: MAX_SECONDS_PER_PHOTO,
    });
  }

  function handleLibraryTourSettingsGet(res) {
    const settings = libraryTourSettings.get();
    sendJson(res, 200, {
      ok: true,
      steam: settings.steam,
      psn: settings.psn,
      secondsPerGameMin: MIN_SECONDS_PER_GAME,
      secondsPerGameMax: MAX_SECONDS_PER_GAME,
      sorts: VALID_SORTS,
    });
  }

  function handleLibraryTourSettingsUpdate(body, res) {
    const patch = { platform: body?.platform };
    if (body && Object.prototype.hasOwnProperty.call(body, 'secondsPerGame')) {
      patch.secondsPerGame = body.secondsPerGame;
    }
    if (body && Object.prototype.hasOwnProperty.call(body, 'sort')) {
      patch.sort = body.sort;
    }
    const result = libraryTourSettings.update(patch);
    if (!result.ok) {
      sendJson(res, 400, result);
      return;
    }
    log.info('Library tour settings updated', {
      platform: result.platform,
      secondsPerGame: result.secondsPerGame,
      sort: result.sort,
    });
    sendJson(res, 200, {
      ok: true,
      platform: result.platform,
      secondsPerGame: result.secondsPerGame,
      sort: result.sort,
      steam: result.steam,
      psn: result.psn,
      secondsPerGameMin: MIN_SECONDS_PER_GAME,
      secondsPerGameMax: MAX_SECONDS_PER_GAME,
      sorts: VALID_SORTS,
    });
  }

  async function handleSteamLibraryTourPreview(res) {
    const service = steamLibraryTourService();
    if (!service?.preview) {
      sendJson(res, 503, { ok: false, error: 'Steam library tour is not available' });
      return;
    }
    try {
      const result = await service.preview();
      sendJson(res, result.ok ? 200 : 400, { ok: Boolean(result.ok), ...result });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error?.message || String(error) });
    }
  }

  async function handlePsnLibraryTourPreview(res) {
    const service = psnLibraryTourService();
    if (!service?.preview) {
      sendJson(res, 503, { ok: false, error: 'PSN library tour is not available' });
      return;
    }
    try {
      const result = await service.preview();
      sendJson(res, result.ok ? 200 : 400, { ok: Boolean(result.ok), ...result });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error?.message || String(error) });
    }
  }

  async function handleSteamLibraryTourPush(body, res) {
    const service = steamLibraryTourService();
    if (!service?.pushTour) {
      sendJson(res, 503, { ok: false, error: 'Steam library tour is not available' });
      return;
    }
    const targetId = targetIdFrom(body);
    if (typeof displayRegistry?.resolveDelivery === 'function') {
      const delivery = displayRegistry.resolveDelivery(targetId);
      if (delivery.error && !delivery.isAll) {
        sendJson(res, 404, { ok: false, error: delivery.error });
        return;
      }
    }
    try {
      const fromScheduler = body?.triggeredBy === 'scheduler';
      const result = await service.pushTour({
        device: deviceFrom(body),
        secondsPerGame: body?.secondsPerGame,
        sort: body?.sort,
        // Manual Start tour loops; a scheduled airing walks the library once.
        loop: body?.loop != null ? body.loop !== false : !fromScheduler,
        trigger: fromScheduler ? 'steam-library-tour-scheduler' : 'steam-library-tour',
        send: (payload, sendOptions = {}) => {
          if (typeof deliverTargetedPayload === 'function') {
            return deliverTargetedPayload(payload, targetId, sendOptions);
          }
          return sendUdpPayload(payload, sendOptions);
        },
      });
      if (!result?.ok) {
        sendJson(res, 400, { ok: false, error: result?.error || 'Steam library tour failed' });
        return;
      }
      sendJson(res, 200, { ok: true, ...result, targetId });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error?.message || String(error) });
    }
  }

  async function handlePsnLibraryTourPush(body, res) {
    const service = psnLibraryTourService();
    if (!service?.pushTour) {
      sendJson(res, 503, { ok: false, error: 'PSN library tour is not available' });
      return;
    }
    const targetId = targetIdFrom(body);
    if (typeof displayRegistry?.resolveDelivery === 'function') {
      const delivery = displayRegistry.resolveDelivery(targetId);
      if (delivery.error && !delivery.isAll) {
        sendJson(res, 404, { ok: false, error: delivery.error });
        return;
      }
    }
    try {
      const fromScheduler = body?.triggeredBy === 'scheduler';
      const result = await service.pushTour({
        device: deviceFrom(body),
        secondsPerGame: body?.secondsPerGame,
        sort: body?.sort,
        loop: body?.loop != null ? body.loop !== false : !fromScheduler,
        trigger: fromScheduler ? 'psn-library-tour-scheduler' : 'psn-library-tour',
        send: (payload, sendOptions = {}) => {
          if (typeof deliverTargetedPayload === 'function') {
            return deliverTargetedPayload(payload, targetId, sendOptions);
          }
          return sendUdpPayload(payload, sendOptions);
        },
      });
      if (!result?.ok) {
        sendJson(res, 400, { ok: false, error: result?.error || 'PSN library tour failed' });
        return;
      }
      sendJson(res, 200, { ok: true, ...result, targetId });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error?.message || String(error) });
    }
  }

  function handleRollCreditsPush(body, res) {
    const targetId = targetIdFrom(body);
    if (typeof displayRegistry?.resolveDelivery === 'function') {
      const delivery = displayRegistry.resolveDelivery(targetId);
      if (delivery.error && !delivery.isAll) {
        sendJson(res, 404, { ok: false, error: delivery.error });
        return;
      }
    }
    const scheduled = body?.triggeredBy === 'scheduler';
    try {
      const payload = rollCreditsPayload.buildTourStart({
        loop: body?.loop != null ? body.loop !== false : !scheduled,
        secondsPerGame: body?.secondsPerGame,
        dashboardSeconds: body?.dashboardSeconds,
        order: body?.order,
        gameLimit: body?.gameLimit,
      });
      if (!payload) {
        sendJson(res, 400, { ok: false, error: 'Roll Credits has no games to show' });
        return;
      }
      const holdSeconds = payload.loop
        ? 0
        : payload.dashboardSeconds + payload.walkedCount * payload.secondsPerGame + 4;
      if (typeof deliverTargetedPayload === 'function') {
        deliverTargetedPayload(payload, targetId, { holdSeconds, commandId: 'credits.show' });
      } else {
        sendUdpPayload(payload, { holdSeconds, commandId: 'credits.show' });
      }
      sendJson(res, 200, {
        ok: true,
        tourId: payload.tourId,
        count: payload.count,
        walkedCount: payload.walkedCount,
        loop: payload.loop,
        persistent: payload.persistent,
        estimatedDurationSeconds: holdSeconds || null,
        targetId,
      });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error?.message || String(error) });
    }
  }

  function autodartsSend(body) {
    const targetId = targetIdFrom(body);
    return {
      targetId,
      send: (payload, sendOptions = {}) => {
        if (typeof deliverTargetedPayload === 'function') {
          return deliverTargetedPayload(payload, targetId, sendOptions);
        }
        return sendUdpPayload(payload, sendOptions);
      },
    };
  }

  function handleAutodartsNowPush(body, res) {
    try {
      const { targetId, send } = autodartsSend(body);
      const scheduled = body?.triggeredBy === 'scheduler';
      const mode = scheduled
        ? (body?.mode === 'last-match' ? 'last-match' : 'auto')
        : (body?.mode || 'auto');
      // Scheduled last-match must never take over a live match.
      const result = mode === 'last-match'
        ? autodartsInstance.pushLastMatch({ send })
        : autodartsInstance.pushNow({ send, mode });
      if (!result.ok) {
        sendJson(res, 400, result);
        return;
      }
      sendJson(res, 200, { ...result, targetId });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error?.message || String(error) });
    }
  }

  function handleAutodartsLastMatchPush(body, res) {
    try {
      const { targetId, send } = autodartsSend(body);
      const result = autodartsInstance.pushLastMatch({ send });
      if (!result.ok) {
        sendJson(res, 400, result);
        return;
      }
      sendJson(res, 200, { ...result, targetId });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error?.message || String(error) });
    }
  }

  async function handleAutodartsDashboardPush(body, res) {
    try {
      const { targetId, send } = autodartsSend(body);
      const result = await autodartsInstance.pushDashboard({ send });
      if (!result.ok) {
        sendJson(res, 400, result);
        return;
      }
      sendJson(res, 200, { ...result, targetId });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error?.message || String(error) });
    }
  }

  function huupeSend(body) {
    const targetId = targetIdFrom(body);
    return {
      targetId,
      send: (payload, sendOptions = {}) => {
        if (typeof deliverTargetedPayload === 'function') {
          return deliverTargetedPayload(payload, targetId, sendOptions);
        }
        return sendUdpPayload(payload, sendOptions);
      },
    };
  }

  function handleHuupeNowPush(body, res) {
    try {
      const { targetId, send } = huupeSend(body);
      const scheduled = body?.triggeredBy === 'scheduler';
      // A scheduled "last game" must never shove a live session off the wall.
      const mode = scheduled
        ? (body?.mode === 'last-game' ? 'last-game' : 'auto')
        : (body?.mode || 'auto');
      const result = mode === 'last-game'
        ? huupeInstance.pushLastGame({ send })
        : huupeInstance.pushNow({ send, mode });
      if (!result.ok) {
        sendJson(res, 400, result);
        return;
      }
      sendJson(res, 200, { ...result, targetId });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error?.message || String(error) });
    }
  }

  function handleHuupeLastGamePush(body, res) {
    try {
      const { targetId, send } = huupeSend(body);
      const result = huupeInstance.pushLastGame({ send });
      if (!result.ok) {
        sendJson(res, 400, result);
        return;
      }
      sendJson(res, 200, { ...result, targetId });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error?.message || String(error) });
    }
  }

  function handleHuupeDashboardPush(body, res) {
    try {
      const { targetId, send } = huupeSend(body);
      const result = huupeInstance.pushDashboard({ send });
      if (!result.ok) {
        sendJson(res, 400, result);
        return;
      }
      sendJson(res, 200, { ...result, targetId });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error?.message || String(error) });
    }
  }

  async function handleHuupeApi(method, pathname, body, res) {
    const tail = pathname.slice('/api/huupe/'.length);
    try {
      if (method === 'GET') {
        if (tail === 'status') {
          sendJson(res, 200, { ok: true, ...huupeInstance.statusSnapshot() });
          return;
        }
        if (tail === 'settings') {
          sendJson(res, 200, { ok: true, settings: huupeInstance.settings.get() });
          return;
        }
        if (tail === 'log') {
          // Redacted by the parser before it ever reaches this buffer.
          sendJson(res, 200, { ok: true, lines: huupeInstance.logTail() });
          return;
        }
        if (tail === 'games') {
          sendJson(res, 200, { ok: true, games: huupeInstance.archive.latest(20) });
          return;
        }
        sendJson(res, 404, { ok: false, error: 'Not found' });
        return;
      }
      if (method === 'POST') {
        if (tail === 'settings') {
          sendJson(res, 200, huupeInstance.updateSettings(body));
          return;
        }
        if (tail === 'discover') {
          const result = await huupeInstance.discover();
          sendJson(res, result.ok ? 200 : 404, result);
          return;
        }
        if (tail === 'reconnect') {
          sendJson(res, 200, huupeInstance.reconnect());
          return;
        }
        if (tail === 'test') {
          sendJson(res, 200, await huupeInstance.testConnection());
          return;
        }
        if (tail === 'rebuild') {
          sendJson(res, 200, huupeInstance.rebuildAggregates());
          return;
        }
        sendJson(res, 404, { ok: false, error: 'Not found' });
      }
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error?.message || String(error) });
    }
  }

  async function handleAutodartsApi(method, pathname, body, res) {
    const tail = pathname.slice('/api/autodarts/'.length);
    try {
      if (method === 'GET') {
        if (tail === 'status') {
          sendJson(res, 200, { ok: true, ...autodartsInstance.statusSnapshot() });
          return;
        }
        if (tail === 'boards') {
          sendJson(res, 200, await autodartsInstance.listBoards());
          return;
        }
        if (tail === 'settings') {
          sendJson(res, 200, { ok: true, settings: autodartsInstance.settings.get() });
          return;
        }
        sendJson(res, 404, { ok: false, error: 'Not found' });
        return;
      }
      if (method === 'POST') {
        if (tail === 'settings') {
          sendJson(res, 200, autodartsInstance.updateSettings(body));
          return;
        }
        if (tail === 'oauth') {
          const result = autodartsInstance.saveOauthClient(body);
          sendJson(res, result.status === 409 ? 409 : (result.ok ? 200 : 400), result);
          return;
        }
        if (tail === 'oauth/fetch') {
          sendJson(res, 200, await autodartsInstance.fetchCommunityOauth());
          return;
        }
        if (tail === 'link/device') {
          sendJson(res, 200, await autodartsInstance.beginDeviceLink());
          return;
        }
        if (tail === 'link/cancel') {
          sendJson(res, 200, autodartsInstance.stopDevicePoll());
          return;
        }
        if (tail === 'link/password') {
          const result = await autodartsInstance.loginWithPassword(body);
          sendJson(res, result.status === 409 ? 409 : (result.ok ? 200 : 400), result);
          return;
        }
        if (tail === 'unlink') {
          const result = await autodartsInstance.unlink();
          sendJson(res, result.status === 409 ? 409 : (result.ok ? 200 : 400), result);
          return;
        }
        if (tail === 'board') {
          const result = await autodartsInstance.selectBoard(body);
          sendJson(res, result.ok ? 200 : 400, result);
          return;
        }
        if (tail === 'test') {
          sendJson(res, 200, await autodartsInstance.testConnection());
          return;
        }
        if (tail === 'sync') {
          sendJson(res, 202, await autodartsInstance.syncHistory(body));
          return;
        }
        sendJson(res, 404, { ok: false, error: 'Not found' });
      }
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error?.message || String(error) });
    }
  }

  async function handleLibraryTourCard(query, res) {
    const platform = String(query.get('platform') || '').trim().toLowerCase();
    const id = String(query.get('id') || '').trim();
    if (!id) {
      sendJson(res, 400, { ok: false, error: 'id is required' });
      return;
    }
    if (platform !== 'steam' && platform !== 'psn') {
      sendJson(res, 400, { ok: false, error: 'platform must be steam or psn' });
      return;
    }
    try {
      if (platform === 'steam') {
        const service = steamLibraryTourService();
        if (!service?.enrichCard) {
          sendJson(res, 503, { ok: false, error: 'Steam library tour is not available' });
          return;
        }
        const result = await service.enrichCard(id);
        sendJson(res, result.ok ? 200 : 400, result);
        return;
      }
      const service = psnLibraryTourService();
      if (!service?.enrichCard) {
        sendJson(res, 503, { ok: false, error: 'PSN library tour is not available' });
        return;
      }
      const result = await service.enrichCard(id, { name: query.get('name') || null });
      sendJson(res, result.ok ? 200 : 400, result);
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error?.message || String(error) });
    }
  }

  function handleLibraryTourPlaylist(tourId, res) {
    const id = String(tourId || '').trim();
    if (!id) {
      sendJson(res, 400, { ok: false, error: 'tourId is required' });
      return;
    }
    const steam = steamLibraryTourService()?.getPlaylist?.(id);
    const psn = psnLibraryTourService()?.getPlaylist?.(id);
    const session = steam || psn;
    if (!session) {
      sendJson(res, 404, { ok: false, error: 'Unknown or expired library tour' });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      tourId: session.tourId,
      platform: session.platform,
      secondsPerGame: session.secondsPerGame,
      loop: session.loop,
      count: session.games.length,
      games: session.games,
    });
  }

  function handlePhotoSlideshowPush(body, res) {
    // The admin UI sends the list it already has on screen. Every other caller
    // — the scheduler, a bare API call — just means "show the slideshow", so
    // fall back to the shared cache the way the voice path does.
    const photos = Array.isArray(body?.photos) && body.photos.length
      ? body.photos
      : photosToSlideshowEntries(qrImageCache.list(), config);
    const secondsPerPhoto = body?.secondsPerPhoto != null
      ? clampSecondsPerPhoto(body.secondsPerPhoto)
      : slideshowSettings.getSecondsPerPhoto();
    const order = body?.order === 'queued' || body?.order === 'as-is'
      ? 'queued'
      : slideshowSettings.getOrder();
    const payload = buildPhotoSlideshowPayload({
      photos,
      secondsPerPhoto,
      device: deviceFrom(body),
      trigger: 'photo-slideshow-api',
      order,
    });
    if (!payload) {
      // Photos in the cache but no payload means the URLs could not be built,
      // which is a configuration problem and needs a different fix from
      // "nobody has shared a photo yet".
      const stored = qrImageCache.list().length;
      sendJson(res, 400, {
        ok: false,
        error: stored
          ? `${stored} shared photo(s) found but their URLs could not be built — set PROXY_OWN_IP so the display can reach them`
          : 'No shared photos to show — share one via the Slideshow Manager first',
      });
      return;
    }
    log.info('Photo slideshow pushed to display', {
      count: payload.slideshow.photos.length,
      order: slideshowSettings.getOrder(),
      secondsPerPhoto: payload.slideshow.secondsPerPhoto,
      targetId: targetIdFrom(body),
    });
    sendCommandPayload(payload, targetIdFrom(body), res, {
      count: payload.slideshow.photos.length,
    });
  }

  // ---- Tesla OAuth (phone flow) --------------------------------------------

  function teslaCallbackHtml(statusCode, title, message) {
    return {
      statusCode,
      body: `<!DOCTYPE html><html><head><title>${title}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
</head><body style="font-family:-apple-system,sans-serif;background:#0f172a;color:#e2e8f0;padding:2rem;text-align:center">
<h1 style="font-size:1.4rem">${title}</h1><p>${message}</p></body></html>`,
    };
  }

  function clearTeslaAuthPending() {
    if (teslaAuth.timeoutTimer) {
      clearTimeout(teslaAuth.timeoutTimer);
      teslaAuth.timeoutTimer = null;
    }
    teslaAuth.pendingState = null;
    teslaAuth.running = false;
    teslaAuth.authorizeUrl = null;
  }

  function closeTeslaCallbackServer({ force = false } = {}) {
    clearTeslaAuthPending();
    if (teslaAuth.server && (force || !teslaAuth.persistent)) {
      try {
        teslaAuth.server.close();
      } catch {
        // already closed
      }
      teslaAuth.server = null;
      teslaAuth.persistent = false;
    }
  }

  function armTeslaAuthTimeout() {
    if (teslaAuth.timeoutTimer) {
      clearTimeout(teslaAuth.timeoutTimer);
    }
    teslaAuth.timeoutTimer = setTimeout(() => {
      if (teslaAuth.running) {
        teslaAuth.status = 'timeout';
        teslaAuth.error = 'Login was not completed in time';
        log.warn('Tesla OAuth callback timed out waiting for login');
      }
      clearTeslaAuthPending();
    }, TESLA_CALLBACK_TIMEOUT_MS);
  }

  async function handleTeslaCallbackHttp(req, res, fleet, listenInfo) {
    const reqUrl = new URL(
      req.url || '/',
      `${listenInfo.useHttps ? 'https' : 'http'}://${req.headers.host || listenInfo.hostname}`,
    );
    const finish = (statusCode, title, message) => {
      const page = teslaCallbackHtml(statusCode, title, message);
      res.writeHead(page.statusCode, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page.body);
    };

    if (reqUrl.pathname !== listenInfo.pathname) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const oauthError = reqUrl.searchParams.get('error');
    const code = reqUrl.searchParams.get('code');
    const returnedState = reqUrl.searchParams.get('state');

    if (!teslaAuth.pendingState) {
      finish(
        200,
        'No Tesla login in progress',
        'Open Signal → Settings → Authenticate Tesla, then complete login. '
        + 'This callback URL stays ready for the Apache proxy.',
      );
      return;
    }

    if (oauthError) {
      const description = reqUrl.searchParams.get('error_description') || '';
      teslaAuth.status = 'error';
      teslaAuth.error = `${oauthError} ${description}`.trim();
      clearTeslaAuthPending();
      finish(400, 'Tesla login failed', teslaAuth.error);
      return;
    }

    if (!code || returnedState !== teslaAuth.pendingState) {
      teslaAuth.status = 'error';
      teslaAuth.error = !code ? 'Missing authorization code' : 'State mismatch';
      clearTeslaAuthPending();
      finish(400, 'Tesla login failed', teslaAuth.error);
      return;
    }

    try {
      await saveTokensFromCode(fleet, code, log);
      teslaAuth.status = 'success';
      teslaAuth.error = null;
      clearTeslaAuthPending();
      finish(200, 'Tesla login complete', 'You can close this tab and return to Signal.');
    } catch (error) {
      teslaAuth.status = 'error';
      teslaAuth.error = error?.message || String(error);
      log.error('Tesla token exchange failed', teslaAuth.error);
      clearTeslaAuthPending();
      finish(500, 'Tesla login failed', teslaAuth.error);
    }
  }

  function ensureTeslaCallbackListener(fleet) {
    if (teslaAuth.server) {
      return Promise.resolve();
    }

    const listenInfo = resolveCallbackListen(fleet);
    const redirectHost = parseRedirect(fleet.redirectUri).hostname;
    teslaAuth.persistent = !isLoopbackHost(redirectHost);

    return new Promise((resolve, reject) => {
      const { server: callbackServer } = createRedirectCallbackServer(
        fleet,
        (req, res) => {
          handleTeslaCallbackHttp(req, res, fleet, listenInfo).catch((error) => {
            log.error('Tesla callback handler failed', error?.message || error);
            if (!res.headersSent) {
              res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
              res.end('Internal error');
            }
          });
        },
        config,
      );

      callbackServer.on('error', (error) => {
        if (!teslaAuth.server) {
          reject(error);
        } else {
          log.error('Tesla OAuth callback server error', error?.message || error);
        }
      });

      callbackServer.listen(listenInfo.port, listenInfo.listenHost, () => {
        teslaAuth.server = callbackServer;
        log.info(
          `Tesla OAuth callback listening on ${fleet.redirectUri} `
          + `(bind ${listenInfo.listenUri}${listenInfo.useHttps ? ', TLS' : ''}`
          + `${teslaAuth.persistent ? ', persistent' : ''})`,
        );
        resolve();
      });
    });
  }

  async function handleTeslaAuthStart(res) {
    const fleet = config.teslaFleet;
    if (!fleet?.clientId || !fleet?.clientSecret) {
      sendJson(res, 400, {
        ok: false,
        error: 'Tesla Fleet credentials are not configured (TESLA_CLIENT_ID / TESLA_CLIENT_SECRET)',
      });
      return;
    }

    if (teslaAuth.running && teslaAuth.authorizeUrl) {
      sendJson(res, 200, {
        ok: true,
        authorizeUrl: teslaAuth.authorizeUrl,
        redirectUri: teslaAuth.redirectUri,
        alreadyRunning: true,
      });
      return;
    }

    clearTeslaAuthPending();

    const state = crypto.randomBytes(16).toString('hex');
    const authorizeUrl = buildAuthorizeUrl(fleet, state);
    const { hostname, useHttps } = parseRedirect(fleet.redirectUri);
    const listenInfo = resolveCallbackListen(fleet);
    let warning = null;
    if (isLoopbackHost(hostname)) {
      warning = 'Redirect URI is localhost — phone browsers cannot reach it. For phone auth use TESLA_REDIRECT_URI=https://fleetapi.YOURDOMAIN/callback (proxy /callback → NAS :4381) and register that URI in the Tesla developer app';
    } else if (!useHttps) {
      warning = 'Tesla rejects http:// for non-localhost. Use https:// on a public domain with a real cert (e.g. https://fleetapi.YOURDOMAIN/callback) proxied to the NAS';
    } else if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
      warning = 'Tesla rejects LAN IP redirect URIs. Use your Fleet domain (https://fleetapi…/callback) with an Apache/nginx proxy to the NAS :4381 listener';
    } else if (!listenInfo.useHttps && listenInfo.port === 4381) {
      warning = `Ensure Apache proxies ${fleet.redirectUri} → http://<NAS_IP>:4381${listenInfo.pathname}`;
    }

    try {
      await ensureTeslaCallbackListener(fleet);
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: `Could not open OAuth callback port: ${error?.message || error}`,
      });
      return;
    }

    teslaAuth.pendingState = state;
    teslaAuth.running = true;
    teslaAuth.status = 'waiting';
    teslaAuth.error = null;
    teslaAuth.authorizeUrl = authorizeUrl;
    teslaAuth.redirectUri = fleet.redirectUri;
    teslaAuth.startedAt = new Date().toISOString();
    armTeslaAuthTimeout();

    sendJson(res, 200, {
      ok: true,
      authorizeUrl,
      redirectUri: fleet.redirectUri,
      warning,
    });
  }

  // ---- Alexa auth (in-process login proxy) ---------------------------------

  async function handleAlexaAuthStart(req, res) {
    if (alexaAuth.running) {
      sendJson(res, 200, { ok: true, proxyUrl: alexaAuth.proxyUrl, alreadyRunning: true });
      return;
    }

    // The login proxy URL must be reachable from the phone; the address the
    // phone used to reach this page is the NAS LAN address.
    const hostHeader = String(req.headers.host || '').split(':')[0];
    const proxyOwnIp = (config.proxyOwnIp && config.proxyOwnIp !== '127.0.0.1')
      ? config.proxyOwnIp
      : (hostHeader || '127.0.0.1');
    const proxyUrl = `http://${proxyOwnIp}:${config.proxyPort}/`;

    let runAuth;
    try {
      ({ runAuth } = require('./auth'));
    } catch (error) {
      sendJson(res, 500, { ok: false, error: `Auth module unavailable: ${error?.message || error}` });
      return;
    }

    alexaAuth.running = true;
    alexaAuth.status = 'waiting';
    alexaAuth.error = null;
    alexaAuth.proxyUrl = proxyUrl;
    alexaAuth.startedAt = new Date().toISOString();
    log.info('Starting in-process Alexa login proxy from control page', { proxyUrl });

    runAuth({ exitOnComplete: false, overrides: { proxyOwnIp } })
      .then(() => {
        alexaAuth.status = 'success';
        alexaAuth.running = false;
        if (!alexaAuth.restartScheduled) {
          alexaAuth.restartScheduled = true;
          requestRestart();
        }
      })
      .catch((error) => {
        alexaAuth.status = 'error';
        alexaAuth.error = error?.message || String(error);
        alexaAuth.running = false;
        log.error('In-process Alexa auth failed', alexaAuth.error);
      });

    sendJson(res, 200, { ok: true, proxyUrl });
  }

  // ---- Status ---------------------------------------------------------------

  function buildStatus() {
    let alexaStatus = null;
    try {
      alexaStatus = readAuthStatus(config);
    } catch {
      alexaStatus = null;
    }
    let teslaStatus = null;
    try {
      teslaStatus = readTeslaAuthStatus(config.teslaFleet);
    } catch {
      teslaStatus = null;
    }
    let teslaHasSession = false;
    try {
      teslaHasSession = Boolean(loadTeslaSession(config.teslaFleet?.sessionPath));
    } catch {
      teslaHasSession = false;
    }

    const steamLive = (typeof getSteamStatus === 'function' ? getSteamStatus() : null) || {};
    const steamCreds = resolveSteamCredentials(config.steam || {});
    let steamFileStatus = null;
    try {
      steamFileStatus = readSteamAuthStatus(config.steam);
    } catch {
      steamFileStatus = null;
    }

    return {
      ok: true,
      time: new Date().toISOString(),
      uptimeSec: Math.round(process.uptime()),
      alexa: {
        status: alexaStatus?.status || 'ok',
        message: alexaStatus?.message || null,
        updatedAt: alexaStatus?.updatedAt || null,
        auth: {
          running: alexaAuth.running,
          status: alexaAuth.status,
          proxyUrl: alexaAuth.proxyUrl,
          error: alexaAuth.error,
        },
      },
      tesla: {
        configured: isFleetConfigured(config.teslaFleet),
        hasSession: teslaHasSession,
        status: teslaStatus?.status || (teslaHasSession ? 'ok' : 'no_session'),
        message: teslaStatus?.message || null,
        updatedAt: teslaStatus?.updatedAt || null,
        redirectUri: config.teslaFleet?.redirectUri || null,
        auth: {
          running: teslaAuth.running,
          status: teslaAuth.status,
          error: teslaAuth.error,
        },
      },
      steam: {
        enabled: config.steam?.enabled !== false,
        hasApiKey: Boolean(steamCreds.apiKey),
        hasSteamId: Boolean(steamCreds.steamId),
        apiKeySource: steamCreds.apiKeySource || steamLive.apiKeySource || null,
        steamId: steamCreds.steamId || null,
        personaName: steamCreds.personaName || steamLive.personaName || null,
        requirePresence: Boolean(
          steamLive.requirePresence ?? config.steam?.requirePresence,
        ),
        allowedHosts: steamLive.allowedHosts || config.steam?.allowedHosts || [],
        status: steamLive.status || steamFileStatus?.status || (
          !steamCreds.apiKey ? 'missing_api_key'
            : !steamCreds.steamId ? 'not_linked'
              : 'idle'
        ),
        message: steamLive.message || steamFileStatus?.message || null,
        session: steamLive.session || null,
        presence: steamLive.presence || null,
        auth: {
          running: steamAuth.running,
          status: steamAuth.status,
          authorizeUrl: steamAuth.authorizeUrl,
          error: steamAuth.error,
        },
      },
      psn: (() => {
        const psnLive = (typeof getPsnStatus === 'function' ? getPsnStatus() : null) || {};
        const psnCreds = resolvePsnCredentials(config.psn || {});
        let psnFileStatus = null;
        try {
          psnFileStatus = readPsnAuthStatus(config.psn);
        } catch {
          psnFileStatus = null;
        }
        return {
          enabled: config.psn?.enabled !== false,
          configured: Boolean(psnCreds.configured),
          onlineId: psnCreds.onlineId || psnLive.onlineId || null,
          accountId: psnCreds.accountId || psnLive.accountId || null,
          status: psnLive.status || psnFileStatus?.status || (
            !psnCreds.configured ? 'not_linked' : 'idle'
          ),
          message: psnLive.message || psnFileStatus?.message || null,
          session: psnLive.session || null,
        };
      })(),
      youtube: (() => {
        const live = (typeof getYoutubeStatus === 'function' ? getYoutubeStatus() : null)
          || youtubeService()?.statusSnapshot?.()
          || null;
        if (!live) {
          return { enabled: config.youtube?.enabled !== false, configured: false, status: 'idle' };
        }
        return {
          enabled: live.enabled,
          configured: live.configured,
          hasApiKey: live.hasApiKey,
          apiKeySource: live.apiKeySource || config.youtube?.apiKeySource || null,
          playing: live.playing,
          deviceLabel: live.deviceLabel,
          deviceCount: live.devices.length,
          // A revoked link is the one YouTube failure a human has to fix, so
          // it gets its own status rather than hiding inside a message (§8.3).
          status: live.needsRelink.length
            ? 'needs_relink'
            : (!live.configured ? 'not_linked' : (live.playing ? 'playing' : 'idle')),
          message: live.needsRelink.length
            ? `${live.needsRelink.join(', ')} needs re-linking`
            : live.message,
          quotaUsedToday: live.cache?.quotaUsedToday ?? 0,
        };
      })(),
      plex: (() => {
        const live = (typeof getPlexStatus === 'function' ? getPlexStatus() : null)
          || plexService()?.statusSnapshot?.()
          || null;
        if (!live) {
          return { enabled: false, health: 'idle', hasContent: false };
        }
        return {
          enabled: live.enabled,
          health: live.health,
          healthReason: live.healthReason || '',
          playing: Boolean(live.playing),
          hasContent: Boolean(live.hasContent),
          title: live.session?.title || live.lastPlayed?.title || null,
        };
      })(),
      locale: localeSettings.get(),
      displays: {
        count: displayRegistry?.list?.()?.length || 0,
        online: (displayRegistry?.list?.() || []).filter((d) => !d.stale).length,
      },
      web: {
        activeUrl: activeWebPush?.url || null,
        pushedAt: activeWebPush?.pushedAt || null,
      },
    };
  }

  // ---- Static + routing ------------------------------------------------------

  function assetVersionBeside(htmlFilePath, fileName) {
    try {
      return String(fs.statSync(path.join(path.dirname(htmlFilePath), fileName)).mtimeMs);
    } catch {
      return String(Date.now());
    }
  }

  /**
   * The admin's Push grid used to stay empty until `GET /api/commands`
   * answered, so a slow provider probe left the page looking broken. The tile
   * catalog is static data, so it ships inside the HTML instead: same single
   * request, no readiness checks, and the grid paints before app.js runs.
   */
  function inlinePushCatalog(html) {
    if (!html.includes(PUSH_CATALOG_TOKEN)) {
      return html;
    }
    let json = '[]';
    try {
      json = JSON.stringify(commandRegistry.list({ skipContentCheck: true }));
    } catch (error) {
      log?.warn?.(`admin: could not inline push catalog — ${error?.message || error}`);
    }
    // `</script>` inside a JSON island would close the element early.
    return html.replace(PUSH_CATALOG_TOKEN, json.replace(/</g, '\\u003c'));
  }

  function redirectToAdminLogin(res, pathname) {
    const next = encodeURIComponent(pathname || '/admin/');
    res.writeHead(302, {
      Location: `/admin/login.html?next=${next}`,
      'Cache-Control': 'no-store',
    });
    res.end();
  }

  function serveStatic(pathname, res) {
    const filePath = resolveStaticPath(staticRoot, pathname);
    if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    // Never cache the SPA shell / JS / CSS — phones were keeping stale keyboard logic.
    const noStore = ext === '.html' || ext === '.js' || ext === '.css';
    if (ext === '.html') {
      let html = fs.readFileSync(filePath, 'utf8');
      const vApp = assetVersionBeside(filePath, 'app.js');
      const vStyles = assetVersionBeside(filePath, 'styles.css');
      const vBoothJs = assetVersionBeside(filePath, 'booth.js');
      const vBoothCss = assetVersionBeside(filePath, 'booth.css');
      const vGuestJs = assetVersionBeside(filePath, 'guestbook.js');
      const vGuestCss = assetVersionBeside(filePath, 'guestbook.css');
      const vGamesJs = assetVersionBeside(filePath, 'games.js');
      const vGamesCss = assetVersionBeside(filePath, 'games.css');
      const vScrambleJs = assetVersionBeside(filePath, 'scramble.js');
      const vLandingCss = assetVersionBeside(filePath, 'landing.css');
      let vFlap = String(Date.now());
      let vBezel = String(Date.now());
      try {
        vFlap = String(fs.statSync(path.join(staticRoot, 'flap-grid.js')).mtimeMs);
      } catch {
        // optional shared renderer
      }
      try {
        vBezel = String(fs.statSync(path.join(staticRoot, 'vestaboard-bezel.css')).mtimeMs);
      } catch {
        // optional shared Flagship bezel
      }
      html = html
        .replace(/(href="(?:\.\/)?styles\.css)(?:\?[^"]*)?(")/, `$1?v=${vStyles}$2`)
        .replace(/(src="(?:\.\/)?app\.js)(?:\?[^"]*)?(")/, `$1?v=${vApp}$2`)
        .replace(/(href="(?:\.\/)?booth\.css)(?:\?[^"]*)?(")/, `$1?v=${vBoothCss}$2`)
        .replace(/(src="(?:\.\/)?booth\.js)(?:\?[^"]*)?(")/, `$1?v=${vBoothJs}$2`)
        .replace(/(href="(?:\.\/)?guestbook\.css)(?:\?[^"]*)?(")/, `$1?v=${vGuestCss}$2`)
        .replace(/(src="(?:\.\/)?guestbook\.js)(?:\?[^"]*)?(")/, `$1?v=${vGuestJs}$2`)
        .replace(/(href="(?:\.\/)?games\.css)(?:\?[^"]*)?(")/, `$1?v=${vGamesCss}$2`)
        .replace(/(src="(?:\.\/)?games\.js)(?:\?[^"]*)?(")/, `$1?v=${vGamesJs}$2`)
        .replace(/(src="(?:\.\/)?scramble\.js)(?:\?[^"]*)?(")/, `$1?v=${vScrambleJs}$2`)
        .replace(/(href="(?:\.\/)?landing\.css)(?:\?[^"]*)?(")/, `$1?v=${vLandingCss}$2`)
        .replace(/(src="(?:\/)?flap-grid\.js)(?:\?[^"]*)?(")/, `src="/flap-grid.js?v=${vFlap}"`)
        .replace(/(href="(?:\/)?vestaboard-bezel\.css)(?:\?[^"]*)?(")/, `href="/vestaboard-bezel.css?v=${vBezel}"`);
      html = inlinePushCatalog(html);
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(html);
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': noStore ? 'no-store' : 'max-age=300',
    });
    fs.createReadStream(filePath).pipe(res);
  }

  /**
   * Category backgrounds for the trivia panel.
   *
   * Unauthenticated on purpose — the display client is not a browser and holds
   * no admin cookie. An admin-uploaded replacement in `data/trivia-artwork/`
   * shadows the shipped file of the same name, so a custom background needs no
   * code change. Cached for a day rather than forever so a replacement lands
   * without the display holding a stale image indefinitely.
   */
  function handleTriviaArtworkServe(pathname, res) {
    const name = path.basename(decodeURIComponent(pathname));
    if (!/^[a-z0-9_-]+\.(webp|png|jpe?g)$/i.test(name)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const root = config.ROOT || path.resolve(__dirname, '..');
    const overrideDir = path.resolve(root, 'data/trivia-artwork');
    // Prefer admin overrides, then the editable upload pack under `dev assets/`
    // (new PNGs use `{id}_{portrait}.png`), then the shipped JPEG pack that the
    // portable client also bundles. Sibling stems/extensions cover hyphen vs
    // underscore names and .webp/.jpg/.png during transitions.
    const stem = name.replace(/\.(webp|png|jpe?g)$/i, '');
    const stems = triviaArtworkStemVariants(stem);
    const extOrder = [path.extname(name).toLowerCase(), '.png', '.jpg', '.jpeg', '.webp']
      .filter((ext, index, all) => ext && all.indexOf(ext) === index);
    const directories = [
      overrideDir,
      path.join(root, 'dev assets', 'trivia-category-artwork'),
      path.join(root, 'dev-assets', 'trivia-category-artwork'),
      path.join(__dirname, 'web', 'trivia-artwork'),
    ];
    let filePath = null;
    for (const dir of directories) {
      for (const candidateStem of stems) {
        for (const ext of extOrder) {
          const candidate = path.join(dir, `${candidateStem}${ext}`);
          if (fs.existsSync(candidate)) {
            filePath = candidate;
            break;
          }
        }
        if (filePath) {
          break;
        }
      }
      if (filePath) {
        break;
      }
    }
    if (!filePath) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const stat = fs.statSync(filePath);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'image/jpeg',
      'Content-Length': stat.size,
      'Cache-Control': 'public, max-age=86400',
      ETag: `"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`,
    });
    fs.createReadStream(filePath).pipe(res);
  }

  function handleFlightplanArtworkServe(pathname, res) {
    const name = path.basename(decodeURIComponent(pathname));
    if (!/^[a-zA-Z0-9._-]+\.(webp|png|jpe?g)$/i.test(name)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const root = config.ROOT || path.resolve(__dirname, '..');
    const directories = [
      path.resolve(root, 'data', 'flightplan-images'),
      path.join(__dirname, 'web', 'flightplan-artwork'),
    ];
    let filePath = null;
    for (const dir of directories) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) {
        filePath = candidate;
        break;
      }
    }
    if (!filePath) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const stat = fs.statSync(filePath);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'image/jpeg',
      'Content-Length': stat.size,
      'Cache-Control': 'public, max-age=86400',
      ETag: `"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`,
    });
    fs.createReadStream(filePath).pipe(res);
  }

  function handleUpsideNewsArtworkServe(pathname, res) {
    const name = path.basename(decodeURIComponent(pathname));
    if (!/^[a-z0-9_-]+\.(webp|png|jpe?g)$/i.test(name)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const root = config.ROOT || path.resolve(__dirname, '..');
    const stem = name.replace(/\.(webp|png|jpe?g)$/i, '');
    const stems = triviaArtworkStemVariants(stem);
    const extOrder = [path.extname(name).toLowerCase(), '.jpg', '.jpeg', '.png', '.webp']
      .filter((ext, index, all) => ext && all.indexOf(ext) === index);
    const directories = [
      path.resolve(root, 'data/upside-news-artwork'),
      path.join(root, 'dev assets', 'news-topic-artwork'),
      path.join(root, 'dev-assets', 'news-topic-artwork'),
      path.join(__dirname, 'web', 'upside-news-artwork'),
    ];
    let filePath = null;
    for (const dir of directories) {
      for (const candidateStem of stems) {
        for (const ext of extOrder) {
          const candidate = path.join(dir, `${candidateStem}${ext}`);
          if (fs.existsSync(candidate)) {
            filePath = candidate;
            break;
          }
        }
        if (filePath) break;
      }
      if (filePath) break;
    }
    if (!filePath) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const stat = fs.statSync(filePath);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'image/jpeg',
      'Cache-Control': 'public, max-age=86400',
      ETag: `"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`,
    });
    fs.createReadStream(filePath).pipe(res);
  }

  function handleWikiArtworkServe(pathname, res) {
    const name = path.basename(decodeURIComponent(pathname));
    if (!/^[a-z0-9_-]+\.(webp|png|jpe?g)$/i.test(name)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const root = config.ROOT || path.resolve(__dirname, '..');
    const stem = name.replace(/\.(webp|png|jpe?g)$/i, '');
    const stems = triviaArtworkStemVariants(stem);
    const extOrder = [path.extname(name).toLowerCase(), '.jpg', '.jpeg', '.png', '.webp']
      .filter((ext, index, all) => ext && all.indexOf(ext) === index);
    const directories = [
      path.resolve(root, 'data/wiki-common-knowledge-artwork'),
      path.join(__dirname, 'web', 'wiki-common-knowledge-artwork'),
      path.join(__dirname, 'web', 'upside-news-artwork'),
    ];
    let filePath = null;
    for (const dir of directories) {
      for (const candidateStem of stems) {
        for (const ext of extOrder) {
          const candidate = path.join(dir, `${candidateStem}${ext}`);
          if (fs.existsSync(candidate)) {
            filePath = candidate;
            break;
          }
        }
        if (filePath) break;
      }
      if (filePath) break;
    }
    if (!filePath) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const stat = fs.statSync(filePath);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'image/jpeg',
      'Cache-Control': 'public, max-age=86400',
      ETag: `"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`,
    });
    fs.createReadStream(filePath).pipe(res);
  }

  function serveStaticForRequest(req, pathname, res) {
    if (isAdminHtmlPath(pathname) && !adminAuth.assertAuthorized(req).ok) {
      redirectToAdminLogin(res, pathname === '/admin/index.html' ? '/admin/' : pathname);
      return;
    }
    if (isUserHtmlPath(pathname) && !adminAuth.assertUserAuthorized(req).ok) {
      res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    serveStatic(pathname, res);
  }

  async function handleRequest(req, res) {
    const reqUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const { pathname } = reqUrl;

    try {
      if (req.method === 'GET') {
        if (pathname === '/api/auth/steam/callback') {
          await handleSteamAuthCallback(reqUrl, res);
          return;
        }
        if (pathname === '/api/admin/session') {
          handleAdminSession(req, res);
          return;
        }
        if (pathname === '/api/guest/session') {
          handleGuestSession(req, res);
          return;
        }
        if (pathname === '/api/guestbook/status') {
          handleGuestbookStatus(res);
          return;
        }
        if (pathname === '/api/games/session') {
          handleGamesSessionGet(Object.fromEntries(reqUrl.searchParams.entries()), res);
          return;
        }
        if (pathname === '/api/games/events') {
          handleGamesEvents(req, reqUrl, res);
          return;
        }
        if (pathname === '/api/displays') {
          handleDisplaysList(res);
          return;
        }
        if (pathname === '/api/displays/events') {
          handleDisplaysEvents(req, res);
          return;
        }
        if (pathname.startsWith(qrImageCache.routePrefix)) {
          await handleQrImageServe(pathname, res);
          return;
        }
        if (pathname.startsWith(rollCreditsInstance.media.routePrefix)) {
          handleRollCreditsMediaServe(pathname, res, req);
          return;
        }
        if (pathname.startsWith(TRIVIA_ARTWORK_ROUTE_PREFIX)) {
          handleTriviaArtworkServe(pathname, res);
          return;
        }
        if (pathname.startsWith(UPSIDE_NEWS_ARTWORK_ROUTE_PREFIX)) {
          handleUpsideNewsArtworkServe(pathname, res);
          return;
        }
        if (pathname.startsWith(WIKI_ARTWORK_ROUTE_PREFIX)) {
          handleWikiArtworkServe(pathname, res);
          return;
        }
        if (pathname.startsWith(FLIGHTPLAN_ARTWORK_ROUTE_PREFIX)) {
          handleFlightplanArtworkServe(pathname, res);
          return;
        }
        if (pathname.startsWith(YOUTUBE_IMAGE_ROUTE_PREFIX)) {
          handleYoutubeImageServe(pathname, res);
          return;
        }
        if (pathname.startsWith('/user-avatars/')) {
          serveUserAvatar(pathname, res);
          return;
        }
        if (pathname === '/api/user/session') {
          handleAdminSession(req, res);
          return;
        }
        if (pathname === '/api/gmail/callback') {
          const code = reqUrl.searchParams.get('code');
          const err = reqUrl.searchParams.get('error');
          if (err || !code) {
            res.writeHead(302, { Location: '/admin/?gmail=denied', 'Cache-Control': 'no-store' });
            res.end();
            return;
          }
          try {
            await gmailMailer.exchangeCode(code);
            userAudit.append({ action: 'gmail.link', ip: adminAuth.clientIpFromRequest(req) });
            res.writeHead(302, { Location: '/admin/?gmail=ok', 'Cache-Control': 'no-store' });
          } catch (error) {
            log.warn('Gmail OAuth callback failed', error?.message || error);
            res.writeHead(302, { Location: '/admin/?gmail=error', 'Cache-Control': 'no-store' });
          }
          res.end();
          return;
        }
        if (pathname === '/api/user/me') {
          handleUserMe(req, res);
          return;
        }
        if (pathname === '/api/user/games') {
          if (!requireUserSession(req, res)) return;
          handleUserGames(res);
          return;
        }
        if (pathname === '/api/user/commands') {
          if (!requireUserSession(req, res)) return;
          handleUserCommands(res);
          return;
        }
        if (pathname === '/api/house-users') {
          if (!requireAdminSession(req, res)) return;
          handleHouseUsersList(res);
          return;
        }
        if (pathname === '/api/house-users/audit') {
          if (!requireAdminSession(req, res)) return;
          handleUserAudit(reqUrl, res);
          return;
        }
        if (pathname === '/api/gmail/status') {
          if (!requireAdminSession(req, res)) return;
          sendJson(res, 200, { ok: true, ...gmailMailer.status() });
          return;
        }
        // Admin-only JSON APIs
        if (pathname === '/api/status') {
          if (!requireAdminSession(req, res)) return;
          sendJson(res, 200, buildStatus());
          return;
        }
        if (pathname === '/api/commands') {
          if (!requireUserSession(req, res)) return;
          sendJson(res, 200, { ok: true, commands: commandRegistry.list() });
          return;
        }
        if (pathname.startsWith('/api/display-scheduler/')) {
          if (!requireAdminSession(req, res)) return;
          const tail = pathname.slice('/api/display-scheduler/'.length);
          const query = reqUrl.searchParams;
          if (tail === 'settings') {
            sendJson(res, 200, { ok: true, settings: scheduler.settings });
            return;
          }
          if (tail === 'rules') { handleSchedulerRulesGet(res); return; }
          if (tail === 'status') { handleSchedulerStatus(res); return; }
          if (tail === 'activity') { handleSchedulerActivity(query, res); return; }
          if (tail === 'stats') { handleSchedulerStats(query, res); return; }
          if (tail === 'heatmap') { handleSchedulerHeatmap(query, res); return; }
          sendJson(res, 404, { ok: false, error: 'Unknown endpoint' });
          return;
        }
        if (pathname === '/api/trivia/pool/status') {
          if (!requireAdminSession(req, res)) return;
          handleTriviaStatus(res);
          return;
        }
        if (pathname === '/api/trivia/categories') {
          if (!requireAdminSession(req, res)) return;
          handleTriviaCategories(res);
          return;
        }
        if (pathname === '/api/trivia/settings') {
          if (!requireAdminSession(req, res)) return;
          handleTriviaSettingsGet(res);
          return;
        }
        if (pathname === '/api/upside-news/status') {
          if (!requireAdminSession(req, res)) return;
          handleUpsideNewsStatus(res);
          return;
        }
        if (pathname === '/api/upside-news/settings') {
          if (!requireAdminSession(req, res)) return;
          handleUpsideNewsSettingsGet(res);
          return;
        }
        if (pathname === '/api/upside-news/stories') {
          if (!requireAdminSession(req, res)) return;
          handleUpsideNewsStories(reqUrl.searchParams, res);
          return;
        }
        if (pathname === '/api/upside-news/archive/stats') {
          if (!requireAdminSession(req, res)) return;
          handleUpsideNewsStatus(res);
          return;
        }
        if (pathname === '/api/wiki-common-knowledge/status') {
          if (!requireAdminSession(req, res)) return;
          handleWikiStatus(res);
          return;
        }
        if (pathname === '/api/wiki-common-knowledge/settings') {
          if (!requireAdminSession(req, res)) return;
          handleWikiSettingsGet(res);
          return;
        }
        if (pathname === '/api/overhead/status') {
          if (!requireAdminSession(req, res)) return;
          handleOverheadStatus(res);
          return;
        }
        if (pathname === '/api/overhead/settings') {
          if (!requireAdminSession(req, res)) return;
          handleOverheadSettingsGet(res);
          return;
        }
        if (pathname === '/api/plex/status') {
          if (!requireAdminSession(req, res)) return;
          handlePlexStatus(res);
          return;
        }
        if (pathname === '/api/plex/settings') {
          if (!requireAdminSession(req, res)) return;
          handlePlexSettingsGet(res);
          return;
        }
        if (pathname === '/api/plex-top10/settings') {
          if (!requireAdminSession(req, res)) return;
          await handlePlexTop10SettingsGet(res);
          return;
        }
        if (pathname === '/api/locale/settings') {
          if (!requireAdminSession(req, res)) return;
          handleLocaleSettingsGet(res);
          return;
        }
        if (pathname === '/api/public-url/settings') {
          if (!requireAdminSession(req, res)) return;
          handlePublicUrlSettingsGet(res);
          return;
        }
        if (pathname === '/api/tinyurl/settings') {
          if (!requireAdminSession(req, res)) return;
          handleTinyurlSettingsGet(res);
          return;
        }
        if (pathname === '/api/word-scramble/settings') {
          if (!requireAdminSession(req, res)) return;
          handleWordScrambleSettingsGet(res);
          return;
        }
        if (pathname === '/api/game-sessions') {
          if (!requireAdminSession(req, res)) return;
          handleGameSessionsGet(res);
          return;
        }
        if (pathname === '/api/game-sessions/history') {
          if (!requireAdminSession(req, res)) return;
          handleGameSessionsHistory(Object.fromEntries(reqUrl.searchParams.entries()), res);
          return;
        }
        if (pathname === '/api/guest-book/settings') {
          if (!requireAdminSession(req, res)) return;
          handleGuestBookSettingsGet(res);
          return;
        }
        if (pathname === '/api/ring/settings') {
          if (!requireAdminSession(req, res)) return;
          handleRingSettingsGet(res);
          return;
        }
        if (pathname === '/api/guest-snaps/settings') {
          if (!requireAdminSession(req, res)) return;
          handleGuestSnapsSettingsGet(res);
          return;
        }
        if (pathname === '/api/guest-book/book') {
          if (!requireAdminSession(req, res)) return;
          handleGuestBookList(Object.fromEntries(reqUrl.searchParams.entries()), res);
          return;
        }
        if (pathname === '/api/weather-alerts/settings') {
          if (!requireAdminSession(req, res)) return;
          handleWeatherAlertsSettingsGet(res);
          return;
        }
        if (pathname === '/api/stock-market/settings') {
          if (!requireAdminSession(req, res)) return;
          handleStockMarketSettingsGet(res);
          return;
        }
        if (pathname === '/api/currency-rates/settings') {
          if (!requireAdminSession(req, res)) return;
          handleCurrencyRatesSettingsGet(res);
          return;
        }
        if (pathname === '/api/iss-tracker/settings') {
          if (!requireAdminSession(req, res)) return;
          handleIssTrackerSettingsGet(res);
          return;
        }
        if (pathname === '/api/starlink-tracker/settings') {
          if (!requireAdminSession(req, res)) return;
          handleStarlinkTrackerSettingsGet(res);
          return;
        }
        if (pathname === '/api/space-launch-alerts/settings') {
          if (!requireAdminSession(req, res)) return;
          handleSpaceLaunchAlertsSettingsGet(res);
          return;
        }
        if (pathname === '/api/learn-japanese/settings') {
          if (!requireAdminSession(req, res)) return;
          handleLearnJapaneseSettingsGet(res);
          return;
        }
        {
          const learnSettings = pathname.match(/^\/api\/learn-(portuguese|spanish|french|german|italian)\/settings$/);
          if (learnSettings) {
            if (!requireAdminSession(req, res)) return;
            handleLearnLanguageSettingsGet(learnSettings[1], res);
            return;
          }
        }
        if (pathname === '/api/word-riddles/riddles') {
          if (!requireAdminSession(req, res)) return;
          handleWordRiddlesGet(Object.fromEntries(reqUrl.searchParams.entries()), res);
          return;
        }
        if (pathname === '/api/word-riddles/settings') {
          if (!requireAdminSession(req, res)) return;
          handleWordRiddlesGet({}, res);
          return;
        }
        if (pathname === '/api/chuck-norris/facts') {
          if (!requireAdminSession(req, res)) return;
          handleChuckNorrisFactsGet(Object.fromEntries(reqUrl.searchParams.entries()), res);
          return;
        }
        if (pathname === '/api/roast-me/roasts') {
          if (!requireAdminSession(req, res)) return;
          handleRoastMeGet(Object.fromEntries(reqUrl.searchParams.entries()), res);
          return;
        }
        if (pathname === '/api/family-quotes/quotes') {
          if (!requireAdminSession(req, res)) return;
          handleFamilyQuotesGet(Object.fromEntries(reqUrl.searchParams.entries()), res);
          return;
        }
        if (pathname === '/api/warm-fuzzies/fuzzies') {
          if (!requireAdminSession(req, res)) return;
          handleWarmFuzziesGet(Object.fromEntries(reqUrl.searchParams.entries()), res);
          return;
        }
        if (pathname === '/api/daily-bucket-fillers/fillers') {
          if (!requireAdminSession(req, res)) return;
          handleDailyBucketFillersGet(Object.fromEntries(reqUrl.searchParams.entries()), res);
          return;
        }
        if (pathname === '/api/misheard-lyrics/lyrics') {
          if (!requireAdminSession(req, res)) return;
          handleMisheardLyricsGet(Object.fromEntries(reqUrl.searchParams.entries()), res);
          return;
        }
        if (pathname === '/api/periodic-table/settings') {
          if (!requireAdminSession(req, res)) return;
          handlePeriodicTableGet(Object.fromEntries(reqUrl.searchParams.entries()), res);
          return;
        }
        if (pathname === '/api/us-state-facts/settings') {
          if (!requireAdminSession(req, res)) return;
          handleUsStateFactsGet(Object.fromEntries(reqUrl.searchParams.entries()), res);
          return;
        }
        if (pathname === '/api/word-of-the-day/settings') {
          if (!requireAdminSession(req, res)) return;
          handleWordOfTheDayGet(Object.fromEntries(reqUrl.searchParams.entries()), res);
          return;
        }
        if (pathname === '/api/dad-jokes/jokes') {
          if (!requireAdminSession(req, res)) return;
          handleDadJokesGet(Object.fromEntries(reqUrl.searchParams.entries()), res);
          return;
        }
        if (pathname === '/api/us-weather-map/settings') {
          if (!requireAdminSession(req, res)) return;
          handleUsWeatherMapSettingsGet(res);
          return;
        }
        if (pathname === '/api/amazing-facts/facts') {
          if (!requireAdminSession(req, res)) return;
          handleAmazingFactsGet(Object.fromEntries(reqUrl.searchParams.entries()), res);
          return;
        }
        if (pathname === '/api/world-geography-facts/facts') {
          if (!requireAdminSession(req, res)) return;
          handleWorldGeographyFactsGet(Object.fromEntries(reqUrl.searchParams.entries()), res);
          return;
        }
        if (pathname === '/api/conversation-starters/prompts') {
          if (!requireAdminSession(req, res)) return;
          handleConversationStartersGet(Object.fromEntries(reqUrl.searchParams.entries()), res);
          return;
        }
        if (pathname === '/api/stoic-quotes/quotes') {
          if (!requireAdminSession(req, res)) return;
          handleStoicQuotesGet(Object.fromEntries(reqUrl.searchParams.entries()), res);
          return;
        }
        if (pathname === '/api/on-this-day/events') {
          if (!requireAdminSession(req, res)) return;
          handleOnThisDayGet(Object.fromEntries(reqUrl.searchParams.entries()), res);
          return;
        }
        if (pathname === '/api/baking-inspiration/ideas') {
          if (!requireAdminSession(req, res)) return;
          handleBakingInspirationGet(Object.fromEntries(reqUrl.searchParams.entries()), res);
          return;
        }
        if (pathname === '/api/world-population/settings') {
          if (!requireAdminSession(req, res)) return;
          handleWorldPopulationSettingsGet(res);
          return;
        }
        if (pathname === '/api/calendar-clock/settings') {
          if (!requireAdminSession(req, res)) return;
          handleCalendarClockSettingsGet(res);
          return;
        }
        if (pathname === '/api/word-clock/settings') {
          if (!requireAdminSession(req, res)) return;
          handleWordClockSettingsGet(res);
          return;
        }
        if (pathname === '/api/red-letter/settings') {
          if (!requireAdminSession(req, res)) return;
          handleRedLetterSettingsGet(res);
          return;
        }
        if (pathname.startsWith('/api/date-book/')) {
          if (!requirePermission(req, res, 'redLetter')) return;
          handleDateBookApi('GET', pathname, null, res);
          return;
        }
        if (pathname.startsWith('/api/flightplan/')) {
          if (isUserAccessiblePath(pathname)) {
            if (!requirePermission(req, res, 'flightPlan')) return;
          } else if (!requireAdminSession(req, res)) {
            return;
          }
          await handleFlightplanApi('GET', pathname, null, res, reqUrl.searchParams);
          return;
        }
        if (pathname.startsWith('/api/youtube/')) {
          if (!requireAdminSession(req, res)) return;
          const tail = pathname.slice('/api/youtube/'.length);
          const query = reqUrl.searchParams;
          if (tail === 'settings') { handleYoutubeSettingsGet(res); return; }
          if (tail === 'devices') { handleYoutubeDevicesGet(res); return; }
          if (tail === 'now-playing') { handleYoutubeNowPlayingGet(res); return; }
          if (tail === 'history') { handleYoutubeHistory(query, res); return; }
          if (tail === 'cache/stats') { handleYoutubeCacheStats(res); return; }
          const videoMatch = /^videos\/([\w-]{6,20})$/.exec(tail);
          if (videoMatch) { await handleYoutubeVideoGet(videoMatch[1], res); return; }
          const deviceMatch = /^devices\/([^/]+)\/status$/.exec(tail);
          if (deviceMatch) {
            const service = youtubeService();
            const device = service?.store.publicDevices()
              .find((entry) => entry.id === deviceMatch[1]);
            sendJson(res, device ? 200 : 404, device
              ? { ok: true, device }
              : { ok: false, error: 'Unknown device' });
            return;
          }
          sendJson(res, 404, { ok: false, error: 'Unknown endpoint' });
          return;
        }
        if (pathname.startsWith('/api/autodarts/')) {
          if (!requireAdminSession(req, res)) return;
          await handleAutodartsApi('GET', pathname, null, res);
          return;
        }
        if (pathname.startsWith('/api/huupe/')) {
          if (!requireAdminSession(req, res)) return;
          await handleHuupeApi('GET', pathname, null, res);
          return;
        }
        if (pathname === '/api/photos') {
          if (!requirePermission(req, res, 'slideshow')) return;
          handlePhotosList(res);
          return;
        }
        if (pathname.startsWith('/api/roll-credits/')) {
          const publicPlaylist = /^\/api\/roll-credits\/playlist\/([^/]+)$/.exec(pathname);
          if (publicPlaylist) {
            const playlist = rollCreditsPayload.getPlaylist(decodeURIComponent(publicPlaylist[1]));
            sendJson(res, playlist ? 200 : 404, playlist
              ? { ok: true, ...playlist }
              : { ok: false, error: 'Roll Credits tour not found or expired' });
            return;
          }
          if (pathname === '/api/roll-credits/card') {
            const card = rollCreditsPayload.getCard(reqUrl.searchParams.get('id'), {
              baseUrl: reqUrl.searchParams.get('baseUrl') || undefined,
            });
            sendJson(res, card ? 200 : 404, card
              ? { ok: true, card }
              : { ok: false, error: 'Roll Credits game not found' });
            return;
          }
          if (!requireAdminSession(req, res)) return;
          const tail = pathname.slice('/api/roll-credits/'.length);
          if (tail === 'games') {
            sendJson(res, 200, {
              ok: true,
              ...rollCreditsInstance.listGames(rollCreditsListOptions(reqUrl.searchParams)),
            });
            return;
          }
          if (tail === 'jobs') {
            sendJson(res, 200, { ok: true, jobs: rollCreditsInstance.getJobs() });
            return;
          }
          if (tail === 'stats') {
            sendJson(res, 200, { ok: true, stats: rollCreditsInstance.getStats() });
            return;
          }
          if (tail === 'settings') {
            sendJson(res, 200, {
              ok: true,
              settings: rollCreditsInstance.getSettings(),
              credentials: rollCreditsInstance.credentialsStatus(),
              diskUsage: rollCreditsInstance.diskUsage(),
            });
            return;
          }
          if (tail === 'systems') {
            sendJson(res, 200, {
              ok: true,
              systems: rollCreditsInstance.listSystems(),
              usedSystems: rollCreditsInstance.getSystemUsage?.() || [],
            });
            return;
          }
          if (tail === 'events') {
            handleRollCreditsEvents(req, res);
            return;
          }
          const gameMatch = /^games\/([^/]+)$/.exec(tail);
          if (gameMatch) {
            const game = rollCreditsInstance.getGame(decodeURIComponent(gameMatch[1]));
            sendJson(res, game ? 200 : 404, game
              ? { ok: true, game }
              : { ok: false, error: 'Roll Credits game not found' });
            return;
          }
          sendJson(res, 404, { ok: false, error: 'Unknown endpoint' });
          return;
        }
        if (pathname === '/api/photos/events') {
          if (!requirePermission(req, res, 'slideshow')) return;
          handlePhotoEvents(req, res);
          return;
        }
        if (pathname === '/api/slideshow/settings') {
          if (!requireAdminSession(req, res)) return;
          handleSlideshowSettingsGet(res);
          return;
        }
        if (pathname === '/api/vestaboards') {
          if (!requireAdminSession(req, res)) return;
          handleVestaboardsGet(res);
          return;
        }
        if (pathname === '/api/vestaboard-sim') {
          if (!requireUserSession(req, res)) return;
          handleVestaboardSimState(res);
          return;
        }
        if (pathname === '/api/vestaboard-sim/events') {
          if (!requireUserSession(req, res)) return;
          handleVestaboardSimEvents(req, res);
          return;
        }
        // Display clients fetch playlists + rich cards during a tour — no admin
        // session (same trust model as trivia artwork / QR image URLs on the LAN).
        if (pathname === '/api/library-tour/card') {
          await handleLibraryTourCard(reqUrl.searchParams, res);
          return;
        }
        if (pathname.startsWith('/api/library-tour/playlist/')) {
          const tourId = pathname.slice('/api/library-tour/playlist/'.length);
          handleLibraryTourPlaylist(tourId, res);
          return;
        }
        if (pathname === '/api/library-tour/settings') {
          if (!requireAdminSession(req, res)) return;
          handleLibraryTourSettingsGet(res);
          return;
        }
        if (pathname === '/api/library-tour/steam') {
          if (!requireAdminSession(req, res)) return;
          await handleSteamLibraryTourPreview(res);
          return;
        }
        if (pathname === '/api/library-tour/psn') {
          if (!requireAdminSession(req, res)) return;
          await handlePsnLibraryTourPreview(res);
          return;
        }
        // Login page + guest booth + shared logos are public; admin and /user/ shells need a session.
        if (isAdminLoginPath(pathname) || (
          !pathname.startsWith('/admin') && !isUserHtmlPath(pathname)
        )) {
          serveStatic(pathname, res);
          return;
        }
        serveStaticForRequest(req, pathname, res);
        return;
      }

      // Scheduler rules and YouTube devices are the bridge's only REST-shaped
      // collections, so PUT/DELETE are routed here rather than folded into POST.
      if (req.method === 'PUT' || req.method === 'DELETE') {
        if (pathname === '/api/plex/settings' && req.method === 'PUT') {
          if (!requireAdminSession(req, res)) return;
          const body = await readJsonBody(req, MAX_BODY_BYTES);
          handlePlexSettingsPut(body, res);
          return;
        }
        if (pathname === '/api/plex-top10/settings' && req.method === 'PUT') {
          if (!requireAdminSession(req, res)) return;
          const body = await readJsonBody(req, MAX_BODY_BYTES);
          await handlePlexTop10SettingsPut(body, res);
          return;
        }
        if (pathname === '/api/red-letter/settings' && req.method === 'PUT') {
          if (!requireAdminSession(req, res)) return;
          const body = await readJsonBody(req, MAX_BODY_BYTES);
          handleRedLetterSettingsPut(body, res);
          return;
        }
        if (pathname === '/api/public-url/settings' && req.method === 'PUT') {
          if (!requireAdminSession(req, res)) return;
          const body = await readJsonBody(req, MAX_BODY_BYTES);
          await handlePublicUrlSettingsPut(body, res);
          return;
        }
        if (pathname === '/api/tinyurl/settings' && req.method === 'PUT') {
          if (!requireAdminSession(req, res)) return;
          const body = await readJsonBody(req, MAX_BODY_BYTES);
          handleTinyurlSettingsPut(body, res);
          return;
        }
        if (pathname === '/api/word-scramble/settings' && req.method === 'PUT') {
          if (!requireAdminSession(req, res)) return;
          const body = await readJsonBody(req, MAX_BODY_BYTES);
          await handleWordScrambleSettingsPut(body, res);
          return;
        }
        if (pathname === '/api/guest-book/settings' && req.method === 'PUT') {
          if (!requireAdminSession(req, res)) return;
          const body = await readJsonBody(req, MAX_BODY_BYTES);
          await handleGuestBookSettingsPut(body, res);
          return;
        }
        if (pathname === '/api/ring/settings' && req.method === 'PUT') {
          if (!requireAdminSession(req, res)) return;
          const body = await readJsonBody(req, MAX_BODY_BYTES);
          await handleRingSettingsPut(body, res);
          return;
        }
        if (pathname === '/api/guest-snaps/settings' && req.method === 'PUT') {
          if (!requireAdminSession(req, res)) return;
          const body = await readJsonBody(req, MAX_BODY_BYTES);
          await handleGuestSnapsSettingsPut(body, res);
          return;
        }
        if (pathname.startsWith('/api/date-book/')) {
          if (!requirePermission(req, res, 'redLetter')) return;
          const body = req.method === 'PUT' ? await readJsonBody(req, MAX_BODY_BYTES) : {};
          handleDateBookApi(req.method, pathname, body, res);
          return;
        }
        const houseUserPut = /^\/api\/house-users\/([^/]+)$/.exec(pathname);
        if (houseUserPut && req.method === 'PUT') {
          if (!requireAdminSession(req, res)) return;
          const body = await readJsonBody(req, MAX_BODY_BYTES);
          handleHouseUserUpdate(houseUserPut[1], body, req, res);
          return;
        }
        const isScheduler = pathname.startsWith('/api/display-scheduler/');
        const isYoutube = pathname.startsWith('/api/youtube/');
        const isRollCredits = pathname.startsWith('/api/roll-credits/');
        const isFlightplan = pathname.startsWith('/api/flightplan/');
        if (!isScheduler && !isYoutube && !isRollCredits && !isFlightplan) {
          res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Method not allowed');
          return;
        }
        if (isFlightplan && isUserAccessiblePath(pathname)) {
          if (!requirePermission(req, res, 'flightPlan')) return;
        } else if (!requireAdminSession(req, res)) {
          return;
        }
        const isVideoUpload = isRollCredits
          && /\/media\/video-upload$/.test(pathname)
          && req.method === 'PUT';
        const body = req.method === 'PUT' && !isVideoUpload
          ? await readJsonBody(req, MAX_BODY_BYTES)
          : {};
        if (isRollCredits) {
          await handleRollCreditsWrite(req, pathname, body, res);
          return;
        }
        if (isFlightplan) {
          await handleFlightplanApi(req.method, pathname, body, res, reqUrl.searchParams);
          return;
        }
        if (isScheduler) {
          await handleSchedulerWrite(req.method, pathname, body, res);
          return;
        }
        const tail = pathname.slice('/api/youtube/'.length);
        if (tail === 'settings' && req.method === 'PUT') {
          handleYoutubeSettingsPut(body, res);
          return;
        }
        const deviceMatch = /^devices\/([^/]+)$/.exec(tail);
        if (deviceMatch) {
          if (req.method === 'PUT') {
            handleYoutubeDeviceUpdate(deviceMatch[1], body, res);
          } else {
            handleYoutubeDeviceDelete(deviceMatch[1], res);
          }
          return;
        }
        sendJson(res, 404, { ok: false, error: 'Unknown endpoint' });
        return;
      }

      if (req.method === 'POST') {
        // Uploaded photos are the one POST body that can legitimately exceed
        // the default JSON body cap (base64-encoded image data).
        const isRollCreditsImage = /^\/api\/roll-credits\/games\/[^/]+\/media$/.test(pathname);
        const isAvatarUpload = pathname === '/api/user/avatar'
          || /^\/api\/house-users\/[^/]+\/avatar$/.test(pathname);
        const bodyLimit = pathname === '/api/qr/image-upload'
          ? Math.ceil(qrImageCache.maxBytes * QR_IMAGE_BODY_OVERHEAD_FACTOR) + QR_IMAGE_BODY_PADDING_BYTES
          : isAvatarUpload
            ? AVATAR_BODY_LIMIT
          : isRollCreditsImage
            ? Math.ceil(
              rollCreditsInstance.getSettings().limits.maxImageBytes
                * QR_IMAGE_BODY_OVERHEAD_FACTOR,
            ) + QR_IMAGE_BODY_PADDING_BYTES
          : MAX_BODY_BYTES;
        const body = await readJsonBody(req, bodyLimit);

        if (pathname === '/api/admin/login') {
          handleAdminLogin({ ...body, requireAdmin: body?.requireAdmin !== false }, req, res);
          return;
        }
        if (pathname === '/api/user/login') {
          handleAdminLogin(body, req, res);
          return;
        }
        if (pathname === '/api/admin/logout' || pathname === '/api/user/logout') {
          handleAdminLogout(req, res);
          return;
        }
        if (pathname === '/api/user/forgot') {
          await handleForgotPassword(body, req, res);
          return;
        }
        if (pathname === '/api/user/reset') {
          handleResetPassword(body, res);
          return;
        }
        if (pathname === '/api/user/profile') {
          handleUserProfile(body, req, res);
          return;
        }
        if (pathname === '/api/user/password') {
          handleUserPasswordChange(body, req, res);
          return;
        }
        if (pathname === '/api/user/avatar') {
          handleAvatarUpload(body, req, res);
          return;
        }
        if (pathname === '/api/user/guestbook/send') {
          handleUserGuestbookSend(body, req, res);
          return;
        }
        if (pathname === '/api/house-users') {
          if (!requireAdminSession(req, res)) return;
          handleHouseUserCreate(body, req, res);
          return;
        }
        const houseUserPost = /^\/api\/house-users\/([^/]+)$/.exec(pathname);
        if (houseUserPost) {
          if (!requireAdminSession(req, res)) return;
          handleHouseUserUpdate(houseUserPost[1], body, req, res);
          return;
        }
        const housePw = /^\/api\/house-users\/([^/]+)\/password$/.exec(pathname);
        if (housePw) {
          if (!requireAdminSession(req, res)) return;
          handleHouseUserPassword(housePw[1], body, req, res);
          return;
        }
        const houseEmail = /^\/api\/house-users\/([^/]+)\/email-password$/.exec(pathname);
        if (houseEmail) {
          if (!requireAdminSession(req, res)) return;
          await handleHouseUserEmailPassword(houseEmail[1], req, res);
          return;
        }
        const houseAvatar = /^\/api\/house-users\/([^/]+)\/avatar$/.exec(pathname);
        if (houseAvatar) {
          if (!requireAdminSession(req, res)) return;
          handleHouseUserAvatar(houseAvatar[1], body, req, res);
          return;
        }
        if (pathname === '/api/gmail/start') {
          if (!requireAdminSession(req, res)) return;
          sendJson(res, 200, gmailMailer.buildAuthorizeUrl());
          return;
        }
        if (pathname === '/api/gmail/unlink') {
          if (!requireAdminSession(req, res)) return;
          const session = adminAuth.sessionFromRequest(req);
          userAudit.append({
            ip: adminAuth.clientIpFromRequest(req),
            actorUserId: session.userId,
            action: 'gmail.unlink',
          });
          sendJson(res, 200, gmailMailer.unlink());
          return;
        }
        if (pathname === '/api/guest/login') {
          handleGuestLogin(body, req, res);
          return;
        }
        if (pathname === '/api/guest/logout') {
          handleGuestLogout(req, res);
          return;
        }
        if (pathname === '/api/guest/request-pin') {
          handleGuestRequestPin(req, res);
          return;
        }
        if (pathname === '/api/guestbook/preview') {
          handleGuestbookPreview(body, res);
          return;
        }
        if (pathname === '/api/guestbook/unlock') {
          handleGuestbookUnlock(body, req, res);
          return;
        }
        if (pathname === '/api/guestbook/send') {
          handleGuestbookSend(body, req, res);
          return;
        }
        if (pathname === '/api/games/join') {
          handleGamesJoin(body, req, res);
          return;
        }
        if (pathname === '/api/games/submit') {
          handleGamesSubmit(body, req, res);
          return;
        }
        if (pathname === '/api/games/leave') {
          handleGamesLeave(req, res);
          return;
        }
        if (pathname === '/api/qr/image-upload') {
          if (!requireGuestOrAdmin(req, res)) return;
          handleQrImageUpload(body, res);
          return;
        }
        if (pathname === '/api/qr/push') {
          handleQrPush(req, body, res);
          return;
        }
        if (pathname === '/api/steam/presence') {
          handleSteamPresence(req, body, res);
          return;
        }

        // Household users can push, manage the board queue, and use permissioned screens.
        if (isUserAccessiblePath(pathname)) {
          if (!requirePathSession(req, res, pathname)) return;
        } else if (!requireAdminSession(req, res)) {
          return;
        }

        if (pathname.startsWith('/api/display-scheduler/')) {
          await handleSchedulerWrite(req.method, pathname, body, res);
          return;
        }
        if (pathname.startsWith('/api/roll-credits/')) {
          await handleRollCreditsPost(pathname, body, res);
          return;
        }

        if (pathname.startsWith('/api/youtube/')) {
          const tail = pathname.slice('/api/youtube/'.length);
          if (tail === 'devices/discover') { await handleYoutubeDiscover(res); return; }
          if (tail === 'devices/link') { await handleYoutubeLink(body, res); return; }
          if (tail === 'api-key') { await handleYoutubeApiKeySave(body, res); return; }
          if (tail === 'cache/clear') { handleYoutubeCacheClear(reqUrl.searchParams, res); return; }
          const relinkMatch = /^devices\/([^/]+)\/relink$/.exec(tail);
          if (relinkMatch) { await handleYoutubeRelink(relinkMatch[1], res); return; }
          sendJson(res, 404, { ok: false, error: 'Unknown endpoint' });
          return;
        }
        if (pathname.startsWith('/api/autodarts/')) {
          await handleAutodartsApi('POST', pathname, body, res);
          return;
        }
        if (pathname.startsWith('/api/huupe/')) {
          await handleHuupeApi('POST', pathname, body, res);
          return;
        }
        if (pathname.startsWith('/api/flightplan/')) {
          if (isUserAccessiblePath(pathname)) {
            if (!requirePermission(req, res, 'flightPlan')) return;
          } else if (!requireAdminSession(req, res)) {
            return;
          }
          await handleFlightplanApi('POST', pathname, body, res, reqUrl.searchParams);
          return;
        }

        // A human pressed a button.
        // so hold the scheduler off for a full global gap rather than yanking
        // the page away. `airCommand` calls the handlers directly and so never
        // reaches here, which is what keeps scheduled airings out of this.
        if (pathname.startsWith('/api/push/') || pathname === '/api/qr/push') {
          scheduler.noteManualPush();
        }

        switch (pathname) {
          case '/api/push/tesla-dashboard':
            handleTeslaPush('tesla-dashboard', body, res);
            return;
          case '/api/push/tesla-battery':
            handleTeslaPush('tesla-battery', body, res);
            return;
          case '/api/push/weather':
            await handleWeatherForecastPush(body, res);
            return;
          case '/api/push/shopping-list':
            handleVoiceQueryPush('shopping-list', 'show my shopping list', 'shopping-list-show', body, res);
            return;
          case '/api/push/timers':
            handleTimersPush(body, res);
            return;
          case '/api/push/alarms':
            handleAlarmsPush(body, res);
            return;
          case '/api/push/notifications':
            handleNotificationsPush(body, res);
            return;
          case '/api/push/air-quality':
            handleVoiceQueryPush('air-quality', 'show indoor air quality', 'air-quality-query', body, res);
            return;
          case '/api/push/now-playing':
            handleVoiceQueryPush(
              'music',
              "what's playing",
              'music-query',
              body,
              res,
            );
            return;
          case '/api/push/indoor-temperature':
            // Kept for older clients / bookmarks; Quick Push UI uses now-playing.
            handleVoiceQueryPush(
              'indoor-temperature',
              indoorTemperatureQuickPushQuery(config),
              'indoor-temperature-query',
              body,
              res,
            );
            return;
          case '/api/push/photo-slideshow':
            handlePhotoSlideshowPush(body, res);
            return;
          case '/api/push/guest-photobooth':
            handleGuestPhotoboothPush(body, res);
            return;
          case '/api/photos/delete':
            handlePhotoDelete(body, res);
            return;
          case '/api/slideshow/settings':
            handleSlideshowSettingsUpdate(body, res);
            return;
          case '/api/vestaboard-sim/online':
            handleVestaboardSimOnline(body, res);
            return;
          case '/api/vestaboard-sim/queue/cancel':
            handleVestaboardSimQueueCancel(body, res);
            return;
          case '/api/vestaboard-sim/queue/reorder':
            handleVestaboardSimQueueReorder(body, res);
            return;
          case '/api/vestaboard-sim/queue/clear':
            handleVestaboardSimQueueClear(body, res);
            return;
          case '/api/vestaboards':
            handleVestaboardSave(body, res);
            return;
          case '/api/vestaboards/house':
            handleVestaboardHouse(body, res);
            return;
          case '/api/vestaboards/remove':
            handleVestaboardRemove(body, res);
            return;
          case '/api/vestaboards/enable':
            handleVestaboardEnable(body, res);
            return;
          case '/api/vestaboards/test-flip':
            await handleVestaboardTestFlip(body, res);
            return;
          case '/api/vestaboards/release-holds':
            handleVestaboardReleaseHolds(body, res);
            return;
          case '/api/library-tour/settings':
            handleLibraryTourSettingsUpdate(body, res);
            return;
          case '/api/push/steam-library-tour':
            await handleSteamLibraryTourPush(body, res);
            return;
          case '/api/push/psn-library-tour':
            await handlePsnLibraryTourPush(body, res);
            return;
          case '/api/push/roll-credits':
            handleRollCreditsPush(body, res);
            return;
          case '/api/push/autodarts-now':
            handleAutodartsNowPush(body, res);
            return;
          case '/api/push/autodarts-last-match':
            handleAutodartsLastMatchPush(body, res);
            return;
          case '/api/push/autodarts-dashboard':
            handleAutodartsDashboardPush(body, res);
            return;
          case '/api/push/huupe-now':
            handleHuupeNowPush(body, res);
            return;
          case '/api/push/huupe-last-game':
            handleHuupeLastGamePush(body, res);
            return;
          case '/api/push/huupe-dashboard':
            handleHuupeDashboardPush(body, res);
            return;
          case '/api/push/url':
            await handleUrlPush(body, res);
            return;
          case '/api/push/close-browser':
            handleCloseBrowser(body, res);
            return;
          case '/api/system/reboot':
            handleSystemCommand(req, 'reboot', body, res);
            return;
          case '/api/system/poweroff':
            handleSystemCommand(req, 'poweroff', body, res);
            return;
          case '/api/displays/discover':
            await handleDisplaysDiscover(res);
            return;
          case '/api/displays/auth/start':
            handleControlAuthStart(body, res);
            return;
          case '/api/displays/auth/verify':
            handleControlAuthVerify(body, res);
            return;
          case '/api/displays/auth/status':
            handleControlAuthStatus(req, body, res);
            return;
          case '/api/input/pointer':
            handleInputPointer(req, body, res);
            return;
          case '/api/input/key':
            handleInputKey(req, body, res);
            return;
          case '/api/input/text':
            handleInputText(req, body, res);
            return;
          case '/api/auth/tesla/start':
            await handleTeslaAuthStart(res);
            return;
          case '/api/auth/alexa/start':
            await handleAlexaAuthStart(req, res);
            return;
          case '/api/auth/steam/start':
            await handleSteamAuthStart(req, res);
            return;
          case '/api/auth/steam/api-key':
            handleSteamApiKeySave(body, res);
            return;
          case '/api/push/steam-now-playing':
            await handleSteamNowPlayingPush(body, res);
            return;
          case '/api/auth/psn/link':
            await handlePsnAuthLink(body, res);
            return;
          case '/api/auth/psn/clear':
            handlePsnAuthClear(body, res);
            return;
          case '/api/push/psn-now-playing':
            await handlePsnNowPlayingPush(body, res);
            return;
          case '/api/push/youtube-now-playing':
            await handleYoutubeNowPlayingPush(body, res);
            return;
          case '/api/push/plex-now-playing':
            await handlePlexNowPlayingPush(body, res);
            return;
          case '/api/push/plex-top10':
            await handlePlexTop10Push(body, res);
            return;
          case '/api/plex-top10/settings':
            await handlePlexTop10SettingsPut(body, res);
            return;
          case '/api/plex/settings':
            handlePlexSettingsPut(body, res);
            return;
          case '/api/plex/token':
            handlePlexTokenSave(body, res);
            return;
          case '/api/plex/test':
            await handlePlexTest(body, res);
            return;
          case '/api/plex/preview':
            await handlePlexPreview(body, res);
            return;
          case '/api/locale/settings':
            await handleLocaleSettingsPut(body, res);
            return;
          case '/api/public-url/settings':
            await handlePublicUrlSettingsPut(body, res);
            return;
          case '/api/tinyurl/settings':
            handleTinyurlSettingsPut(body, res);
            return;
          case '/api/word-scramble/settings':
            await handleWordScrambleSettingsPut(body, res);
            return;
          case '/api/game-sessions/end':
            handleGameSessionsEnd(body, res);
            return;
          case '/api/game-sessions/history/delete':
            handleGameSessionsForget(body, res);
            return;
          case '/api/push/word-scramble':
            await handleWordScramblePush(body, res);
            return;
          case '/api/guest-book/settings':
            await handleGuestBookSettingsPut(body, res);
            return;
          case '/api/guest-book/check':
            await handleGuestBookCheck(body, res);
            return;
          case '/api/guest-snaps/settings':
            await handleGuestSnapsSettingsPut(body, res);
            return;
          case '/api/guest-snaps/check':
            await handleGuestSnapsCheck(body, res);
            return;
          case '/api/guest-book/replay':
            handleGuestBookReplay(body, res);
            return;
          case '/api/guest-book/release':
            handleGuestBookRelease(body, res);
            return;
          case '/api/guest-book/delete':
            handleGuestBookDelete(body, res);
            return;
          case '/api/push/guest-book-invite':
            handleGuestBookInvitePush(body, res);
            return;
          case '/api/push/ring-doorbell':
            handleRingDoorbellPush(body, res);
            return;
          case '/api/ring/settings':
            await handleRingSettingsPut(body, res);
            return;
          case '/api/ring/preview':
            handleRingPreview(body, res);
            return;
          case '/api/ring/auth/link':
            await handleRingAuthLink(body, res);
            return;
          case '/api/ring/auth/login':
            await handleRingAuthLogin(body, res);
            return;
          case '/api/ring/auth/verify':
            await handleRingAuthVerify(body, res);
            return;
          case '/api/ring/auth/clear':
            await handleRingAuthClear(body, res);
            return;
          case '/api/ring/reconnect':
            await handleRingReconnect(body, res);
            return;
          case '/api/push/weekly-weather':
            await handleWeeklyWeatherPush(body, res);
            return;
          case '/api/push/weather-alerts':
            await handleWeatherAlertsPush(body, res);
            return;
          case '/api/weather-alerts/settings':
            handleWeatherAlertsSettingsPut(body, res);
            return;
          case '/api/push/stock-market':
            await handleStockMarketPush(body, res);
            return;
          case '/api/stock-market/settings':
            handleStockMarketSettingsPut(body, res);
            return;
          case '/api/push/currency-rates':
            await handleCurrencyRatesPush(body, res);
            return;
          case '/api/currency-rates/settings':
            handleCurrencyRatesSettingsPut(body, res);
            return;
          case '/api/push/iss-tracker':
            await handleIssTrackerPush(body, res);
            return;
          case '/api/iss-tracker/settings':
            handleIssTrackerSettingsPut(body, res);
            return;
          case '/api/push/starlink-tracker':
            await handleStarlinkTrackerPush(body, res);
            return;
          case '/api/starlink-tracker/settings':
            handleStarlinkTrackerSettingsPut(body, res);
            return;
          case '/api/push/space-launch-alerts':
            await handleSpaceLaunchAlertsPush(body, res);
            return;
          case '/api/space-launch-alerts/settings':
            await handleSpaceLaunchAlertsSettingsPut(body, res);
            return;
          case '/api/push/learn-japanese':
            handleLearnJapanesePush(body, res);
            return;
          case '/api/push/learn-portuguese':
            handleLearnLanguagePush('portuguese', body, res);
            return;
          case '/api/push/learn-spanish':
            handleLearnLanguagePush('spanish', body, res);
            return;
          case '/api/push/learn-french':
            handleLearnLanguagePush('french', body, res);
            return;
          case '/api/push/learn-german':
            handleLearnLanguagePush('german', body, res);
            return;
          case '/api/push/learn-italian':
            handleLearnLanguagePush('italian', body, res);
            return;
          case '/api/push/word-riddles':
            handleWordRiddlesPush(body, res);
            return;
          case '/api/word-riddles/riddles':
            if (body?.id) {
              handleWordRiddlePut(body, res);
            } else {
              handleWordRiddlePost(body, res);
            }
            return;
          case '/api/word-riddles/settings':
            handleWordRiddlesSettingsPut(body, res);
            return;
          case '/api/push/chuck-norris':
            handleChuckNorrisPush(body, res);
            return;
          case '/api/chuck-norris/facts':
            if (body?.id) {
              handleChuckNorrisFactPut(body, res);
            } else {
              handleChuckNorrisFactPost(body, res);
            }
            return;
          case '/api/push/roast-me':
            handleRoastMePush(body, res);
            return;
          case '/api/roast-me/roasts':
            if (body?.id) {
              handleRoastMePut(body, res);
            } else {
              handleRoastMePost(body, res);
            }
            return;
          case '/api/push/family-quotes':
            handleFamilyQuotesPush(body, res);
            return;
          case '/api/family-quotes/quotes':
            if (body?.id) {
              handleFamilyQuotePut(body, res);
            } else {
              handleFamilyQuotePost(body, res);
            }
            return;
          case '/api/push/warm-fuzzies':
            handleWarmFuzziesPush(body, res);
            return;
          case '/api/warm-fuzzies/fuzzies':
            if (body?.id) {
              handleWarmFuzzyPut(body, res);
            } else {
              handleWarmFuzzyPost(body, res);
            }
            return;
          case '/api/push/daily-bucket-fillers':
            handleDailyBucketFillersPush(body, res);
            return;
          case '/api/daily-bucket-fillers/fillers':
            if (body?.id) {
              handleDailyBucketFillerPut(body, res);
            } else {
              handleDailyBucketFillerPost(body, res);
            }
            return;
          case '/api/push/misheard-lyrics':
            handleMisheardLyricsPush(body, res);
            return;
          case '/api/periodic-table/settings':
            handlePeriodicTableSettingsPost(body, res);
            return;
          case '/api/push/periodic-table':
            handlePeriodicTablePush(body, res);
            return;
          case '/api/us-state-facts/settings':
            handleUsStateFactsSettingsPost(body, res);
            return;
          case '/api/push/us-state-facts':
            handleUsStateFactsPush(body, res);
            return;
          case '/api/word-of-the-day/settings':
            handleWordOfTheDaySettingsPost(body, res);
            return;
          case '/api/push/word-of-the-day':
            handleWordOfTheDayPush(body, res);
            return;
          case '/api/misheard-lyrics/lyrics':
            if (body?.id) {
              handleMisheardLyricPut(body, res);
            } else {
              handleMisheardLyricPost(body, res);
            }
            return;
          case '/api/push/dad-jokes':
            handleDadJokesPush(body, res);
            return;
          case '/api/push/us-weather-map':
            await handleUsWeatherMapPush(body, res);
            return;
          case '/api/us-weather-map/settings':
            handleUsWeatherMapSettingsPut(body, res);
            return;
          case '/api/dad-jokes/jokes':
            if (body?.id) {
              handleDadJokePut(body, res);
            } else {
              handleDadJokePost(body, res);
            }
            return;
          case '/api/push/amazing-facts':
            handleAmazingFactsPush(body, res);
            return;
          case '/api/amazing-facts/facts':
            if (body?.id) {
              handleAmazingFactPut(body, res);
            } else {
              handleAmazingFactPost(body, res);
            }
            return;
          case '/api/push/world-geography-facts':
            handleWorldGeographyFactsPush(body, res);
            return;
          case '/api/world-geography-facts/facts':
            if (body?.id) {
              handleWorldGeographyFactPut(body, res);
            } else {
              handleWorldGeographyFactPost(body, res);
            }
            return;
          case '/api/push/conversation-starters':
            handleConversationStartersPush(body, res);
            return;
          case '/api/conversation-starters/prompts':
            if (body?.id) {
              handleConversationStarterPut(body, res);
            } else {
              handleConversationStarterPost(body, res);
            }
            return;
          case '/api/push/stoic-quotes':
            handleStoicQuotesPush(body, res);
            return;
          case '/api/stoic-quotes/quotes':
            if (body?.id) {
              handleStoicQuotePut(body, res);
            } else {
              handleStoicQuotePost(body, res);
            }
            return;
          case '/api/push/on-this-day':
            handleOnThisDayPush(body, res);
            return;
          case '/api/on-this-day/events':
            if (body?.id) {
              handleOnThisDayPut(body, res);
            } else {
              handleOnThisDayPost(body, res);
            }
            return;
          case '/api/push/baking-inspiration':
            handleBakingInspirationPush(body, res);
            return;
          case '/api/baking-inspiration/ideas':
            if (body?.id) {
              handleBakingInspirationPut(body, res);
            } else {
              handleBakingInspirationPost(body, res);
            }
            return;
          case '/api/push/world-population':
            handleWorldPopulationPush(body, res);
            return;
          case '/api/world-population/settings':
            handleWorldPopulationSettingsPut(body, res);
            return;
          case '/api/push/calendar-clock':
            handleCalendarClockPush(body, res);
            return;
          case '/api/calendar-clock/settings':
            handleCalendarClockSettingsPut(body, res);
            return;
          case '/api/push/word-clock':
            handleWordClockPush(body, res);
            return;
          case '/api/word-clock/settings':
            handleWordClockSettingsPut(body, res);
            return;
          case '/api/push/red-letter':
            handleRedLetterPush(body, res);
            return;
          case '/api/red-letter/settings':
            handleRedLetterSettingsPut(body, res);
            return;
          case '/api/date-book/events':
          case '/api/date-book/preview':
            handleDateBookApi('POST', pathname, body, res);
            return;
          case '/api/push/quiet-hours-reminder':
            handleQuietHoursReminderPush(body, res);
            return;
          case '/api/learn-japanese/settings':
            handleLearnJapaneseSettingsPut(body, res);
            return;
          case '/api/learn-portuguese/settings':
            handleLearnLanguageSettingsPut('portuguese', body, res);
            return;
          case '/api/learn-spanish/settings':
            handleLearnLanguageSettingsPut('spanish', body, res);
            return;
          case '/api/learn-french/settings':
            handleLearnLanguageSettingsPut('french', body, res);
            return;
          case '/api/learn-german/settings':
            handleLearnLanguageSettingsPut('german', body, res);
            return;
          case '/api/learn-italian/settings':
            handleLearnLanguageSettingsPut('italian', body, res);
            return;
          case '/api/push/trivia':
            handleTriviaPush(body, res);
            return;
          case '/api/trivia/settings':
            handleTriviaSettingsPut(body, res);
            return;
          case '/api/trivia/pool/refill':
            handleTriviaRefill(res);
            return;
          case '/api/push/upside-news':
            handleUpsideNewsPush(body, res);
            return;
          case '/api/upside-news/settings':
            handleUpsideNewsSettingsPut(body, res);
            return;
          case '/api/upside-news/api-key':
            await handleUpsideNewsApiKeySave(body, res);
            return;
          case '/api/upside-news/sources/test':
            await handleUpsideNewsApiKeyTest(body, res);
            return;
          case '/api/upside-news/archive/poll':
            await handleUpsideNewsArchivePoll(res);
            return;
          case '/api/push/wiki-common-knowledge':
            handleWikiPush(body, res);
            return;
          case '/api/wiki-common-knowledge/settings':
            handleWikiSettingsPut(body, res);
            return;
          case '/api/wiki-common-knowledge/test':
            await handleWikiTest(res);
            return;
          case '/api/wiki-common-knowledge/cache/poll':
            await handleWikiCachePoll(res);
            return;
          case '/api/wiki-common-knowledge/cache/backfill':
            await handleWikiBackfill(body, res);
            return;
          case '/api/push/overhead':
            handleOverheadPush(body, res);
            return;
          case '/api/push/overhead/close':
            handleOverheadClose(body, res);
            return;
          case '/api/overhead/settings':
            handleOverheadSettingsPut(body, res);
            return;
          case '/api/overhead/provider/test':
            await handleOverheadProviderTest(body, res);
            return;
          case '/api/push/flightplan-next':
            await handleFlightplanPushNext(body, res);
            return;
          case '/api/push/flightplan-board':
            await handleFlightplanPushBoard(body, res);
            return;
          default:
            sendJson(res, 404, { ok: false, error: 'Unknown endpoint' });
            return;
        }
      }

      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Method not allowed');
    } catch (error) {
      log.error('Web server request failed', error?.message || error);
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, error: error?.message || 'Internal error' });
      } else {
        res.end();
      }
    } finally {
      requestActor = null;
    }
  }

  async function start() {
    rollCreditsInstance.start?.();
    // Listener already starts the shared Autodarts instance when injected;
    // only start a locally created fallback (tests / standalone web).
    if (!autodarts) {
      autodartsInstance.start?.();
    }
    if (!huupe) {
      huupeInstance.start?.();
    }
    if (!flightplan) {
      flightplanInstance.start?.();
    }
    if (!settings.enabled) {
      log.info('Control web server disabled via config');
      return null;
    }

    const controlServer = await new Promise((resolve, reject) => {
      const listenHttps = settings.https;
      let tls = null;

      if (listenHttps) {
        try {
          const extraHosts = [];
          if (config.proxyOwnIp && config.proxyOwnIp !== '127.0.0.1') {
            extraHosts.push(config.proxyOwnIp);
          }
          tls = ensureWebTls(config, { hosts: extraHosts });
          if (tls.created) {
            log.info('Generated self-signed TLS cert for control page', {
              certDir: tls.certDir,
            });
          }
        } catch (error) {
          log.error('Failed to prepare TLS cert — falling back to HTTP', error?.message || error);
        }
      }

      const useTls = Boolean(tls?.key && tls?.cert);
      server = useTls
        ? https.createServer({ key: tls.key, cert: tls.cert }, handleRequest)
        : http.createServer(handleRequest);

      server.on('error', (error) => {
        log.error('Control web server failed to start', error?.message || error);
        reject(error);
      });

      server.listen(settings.port, '0.0.0.0', () => {
        const scheme = useTls ? 'https' : 'http';
        log.info(`Control web page available at ${scheme}://<NAS_IP>:${settings.port}/`);
        if (useTls) {
          log.info('First visit on iPhone: accept the self-signed certificate warning (required for camera QR)');
        }

        // Plain HTTP helper that redirects to HTTPS so bookmarks on :47811 still work.
        if (useTls && settings.httpRedirectPort > 0) {
          redirectServer = http.createServer((req, res) => {
            const hostHeader = String(req.headers.host || '').split(':')[0] || 'localhost';
            const location = `https://${hostHeader}:${settings.port}${req.url || '/'}`;
            res.writeHead(302, { Location: location });
            res.end(`Redirecting to ${location}`);
          });
          redirectServer.on('error', (error) => {
            log.warn('HTTP redirect helper failed to start', error?.message || error);
          });
          redirectServer.listen(settings.httpRedirectPort, '0.0.0.0', () => {
            log.info(`HTTP → HTTPS redirect on port ${settings.httpRedirectPort}`);
          });
        }

        resolve(server);
      });
    });

    // Public-domain redirect (Apache → NAS :4381): bind the callback port at
    // startup so the proxy never gets connection refused.
    const fleet = config.teslaFleet;
    if (fleet?.clientId && fleet?.clientSecret && fleet?.redirectUri) {
      const redirectHost = parseRedirect(fleet.redirectUri).hostname;
      if (!isLoopbackHost(redirectHost)) {
        try {
          await ensureTeslaCallbackListener(fleet);
        } catch (error) {
          log.warn(
            'Tesla OAuth callback port could not be opened — phone auth proxy will fail until fixed',
            error?.message || error,
          );
        }
      }
    }

    // The tick loop lives with the web server because every airing goes through
    // the same push handlers the admin UI calls.
    scheduler.start();

    return controlServer;
  }

  function stop() {
    guestBook.stop?.();
    gameSessions.stop?.();
    shortlinks.stop?.();
    scheduler.stop();
    rollCreditsInstance.close?.();
    if (!autodarts) {
      autodartsInstance.close?.();
    }
    if (!huupe) {
      huupeInstance.close?.();
    }
    closeTeslaCallbackServer({ force: true });
    for (const target of [server, redirectServer]) {
      if (!target) {
        continue;
      }
      try {
        target.closeAllConnections?.();
        target.close();
      } catch {
        // already closed
      }
    }
    server = null;
    redirectServer = null;
  }

  return {
    settings,
    start,
    stop,
    buildStatus,
    scheduler,
    airCommand,
    getRollCredits: () => rollCreditsInstance,
    getAutodarts: () => autodartsInstance,
    getHuupe: () => huupeInstance,
  };
}

module.exports = {
  createWebServer,
  indoorTemperatureQuickPushQuery,
  validatePushUrl,
  resolveStaticPath,
  computeWebBasePath,
  checkUrlReachable,
  isAdminHtmlPath,
  isUserHtmlPath,
  isAdminLoginPath,
  triviaArtworkStemVariants,
};
