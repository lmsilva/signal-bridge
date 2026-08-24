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
} = require('./udp-payload');
const {
  resolveGuestPhotoboothSettings,
  photosToSlideshowEntries,
} = require('./guest-photobooth');
const { createGuestSnapsAuth } = require('./guest-snaps-auth');
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
const { createCommandRegistry } = require('./command-registry');
const { createDisplayScheduler } = require('./display-scheduler');
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

const DEFAULT_PORT = 47810;
const DEFAULT_HTTP_REDIRECT_PORT = 47811;
const MAX_BODY_BYTES = 64 * 1024;
// Uploaded photos travel as base64 JSON (~1.4x raw size) — cap the request
// body generously above qrImageCache.maxBytes so legitimate uploads never
// get rejected by the body-size guard before the cache's own size check runs.
const QR_IMAGE_BODY_OVERHEAD_FACTOR = 1.4;
const QR_IMAGE_BODY_PADDING_BYTES = 16 * 1024;
const URL_CHECK_TIMEOUT_MS = 5000;
// Tesla's OAuth callback server is opened on demand and must not hold the
// port forever when the user abandons the login.
const TESLA_CALLBACK_TIMEOUT_MS = 10 * 60 * 1000;
const RESTART_DELAY_MS = 4000;

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
  sendUdpPayload,
  recordVoiceEvent,
  displayRegistry = null,
  deliverTargetedPayload = null,
  requestTimerPoll = null,
  requestAlarmPoll = null,
  recordSteamPresence = null,
  getSteamStatus = null,
  steamNowPlaying = null,
  getPsnStatus = null,
  psnNowPlaying = null,
  getYoutubeStatus = null,
  youtubeNowPlaying = null,
  autodarts = null,
  getAutodartsStatus = null,
  trivia = null,
  getTriviaStatus = null,
  upsideNews = null,
  getUpsideNewsStatus = null,
  wikiCommonKnowledge = null,
  getWikiCommonKnowledgeStatus = null,
  overhead = null,
  getOverheadStatus = null,
  rollCredits = null,
  displayBusy = null,
  libraryTourSettings: libraryTourSettingsInjected = null,
  steamLibraryTour = null,
  psnLibraryTour = null,
  getSteamLibraryCount = null,
  getPsnLibraryCount = null,
  guestSnapsAuth: guestSnapsAuthInjected = null,
  scheduleRestart,
  webRoot,
} = {}) {
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
  const adminAuth = createWebAdminAuth(config, log);
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
    getTriviaStatus: () => getTriviaStatus?.() || triviaService()?.statusSnapshot?.() || null,
    getUpsideNewsStatus: () => getUpsideNewsStatus?.() || upsideNewsService()?.statusSnapshot?.() || null,
    getWikiCommonKnowledgeStatus: () => getWikiCommonKnowledgeStatus?.()
      || wikiCommonKnowledgeService()?.statusSnapshot?.()
      || null,
    getOverheadStatus: () => getOverheadStatus?.()
      || overheadService()?.statusSnapshot?.()
      || null,
    getPhotoCount: () => qrImageCache.list().length,
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
    return handler(service);
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
    withYoutube(res, (service) => {
      const device = service.store.getDevice(id);
      if (!device) {
        sendJson(res, 404, { ok: false, error: 'Unknown device' });
        return;
      }
      // Only the two user-editable fields; tokens are never accepted over HTTP.
      service.store.saveDevice({
        ...device,
        label: body?.label != null ? String(body.label) : device.label,
        enabled: body?.enabled != null ? body.enabled !== false : device.enabled,
      });
      sendJson(res, 200, {
        ok: true,
        device: service.store.publicDevices().find((entry) => entry.id === String(id)),
      });
    });
  }

  function handleYoutubeDeviceDelete(id, res) {
    withYoutube(res, (service) => {
      const removed = service.store.removeDevice(id);
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
  async function airCommand(commandId, params = {}, { device = 'Scheduler' } = {}) {
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
    // Scheduler airings always go to every display: a rule has no notion of a
    // selected target, and "all" is what an ambient page wants anyway.
    const body = { ...(command.body || {}), ...params, device, targetId: '*', triggeredBy: 'scheduler' };

    switch (commandId) {
      case 'tesla.dashboard': handleTeslaPush('tesla-dashboard', body, res); break;
      case 'tesla.battery': handleTeslaPush('tesla-battery', body, res); break;
      case 'alexa.weather':
        handleVoiceQueryPush('weather', 'what is the weather', 'weather-query', body, res); break;
      case 'alexa.shopping-list':
        handleVoiceQueryPush('shopping-list', 'show my shopping list', 'shopping-list-show', body, res); break;
      case 'alexa.timers': handleTimersPush(body, res); break;
      case 'alexa.alarms': handleAlarmsPush(body, res); break;
      case 'alexa.air-quality':
        handleVoiceQueryPush('air-quality', 'show indoor air quality', 'air-quality-query', body, res); break;
      case 'alexa.now-playing':
        handleVoiceQueryPush('music', "what's playing", 'music-query', body, res); break;
      case 'signal.slideshow': handlePhotoSlideshowPush(body, res); break;
      case 'signal.guest-snaps': handleGuestPhotoboothPush(body, res); break;
      case 'steam.now-playing':
        // Push tiles post an empty body (auto). Scheduler rules must not: a
        // "now playing" rule that quietly airs last-played is a different page.
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
      case 'youtube.now-playing':
        await handleYoutubeNowPlayingPush({ ...body, mode: 'now-playing' }, res); break;
      case 'youtube.last-played':
        await handleYoutubeNowPlayingPush({ ...body, mode: 'last-played' }, res); break;
      case 'trivia.show': handleTriviaPush(body, res); break;
      case 'goodnews.show': handleUpsideNewsPush(body, res); break;
      case 'wiki.show': handleWikiPush(body, res); break;
      case 'overhead.show': await handleOverheadPush(body, res); break;
      default:
        throw new Error(`Command "${commandId}" has no scheduler dispatch`);
    }

    if (captured.status >= 400) {
      throw new Error(captured.body?.error || `Push failed (${captured.status})`);
    }
    if (!captured.status) {
      throw new Error(`Command "${commandId}" produced no response`);
    }
    return captured.body;
  }

  const scheduler = createDisplayScheduler({
    config,
    log,
    commandRegistry,
    isBusy: () => Boolean(displayBusy?.isBusy?.()),
    timeZone: config.voiceEvents?.localTimeZone || null,
    air: (rule) => airCommand(rule.commandId, rule.params, { device: 'Scheduler' }),
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
    return true;
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
    const result = adminAuth.login(body?.password, req);
    if (!result.ok) {
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

  function handleAdminLogout(req, res) {
    const result = adminAuth.logout(req);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Set-Cookie': result.setCookie,
    });
    res.end(JSON.stringify({ ok: true }));
  }

  function handleAdminSession(req, res) {
    const session = adminAuth.sessionFromRequest(req);
    if (!session.ok) {
      sendJson(res, 200, {
        ok: true,
        authenticated: false,
        configured: adminAuth.isConfigured(),
        code: session.code,
      });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      authenticated: true,
      configured: true,
      expiresAt: new Date(session.expiresAt).toISOString(),
    });
  }

  function sendCommandPayload(payload, targetId, res, okBody = {}) {
    if (typeof deliverTargetedPayload === 'function') {
      const delivery = deliverTargetedPayload(payload, targetId);
      if (delivery?.error && !delivery.isAll) {
        sendJson(res, 404, { ok: false, error: delivery.error });
        return false;
      }
      sendJson(res, 200, { ok: true, target: delivery.target, ...okBody });
      return true;
    }
    sendUdpPayload(payload);
    sendJson(res, 200, { ok: true, ...okBody });
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
  function handleVoiceQueryPush(kind, query, trigger, body, res) {
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
    };
    recordVoiceEvent(event).catch((error) => {
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

  function handleGuestPhotoboothPush(body, res) {
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
    // Always all displays (same as the Alexa path).
    handleVoiceQueryPush(
      'guest-photobooth',
      'open guest snaps',
      'web-api',
      { ...(body || {}), targetId: '*' },
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

  function handleRollCreditsMediaServe(pathname, res) {
    const tail = pathname.slice(rollCreditsInstance.media.routePrefix.length);
    try {
      const filePath = rollCreditsInstance.media.absolutePath(decodeURIComponent(tail));
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }
      const stat = fs.statSync(filePath);
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()]
          || 'application/octet-stream',
        'Cache-Control': 'public, max-age=31536000, immutable',
        ETag: `"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`,
      });
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
        deliverTargetedPayload(payload, targetId, { holdSeconds });
      } else {
        sendUdpPayload(payload, { holdSeconds });
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
      html = html
        .replace(/(href="(?:\.\/)?styles\.css)(?:\?[^"]*)?(")/, `$1?v=${vStyles}$2`)
        .replace(/(src="(?:\.\/)?app\.js)(?:\?[^"]*)?(")/, `$1?v=${vApp}$2`)
        .replace(/(href="(?:\.\/)?booth\.css)(?:\?[^"]*)?(")/, `$1?v=${vBoothCss}$2`)
        .replace(/(src="(?:\.\/)?booth\.js)(?:\?[^"]*)?(")/, `$1?v=${vBoothJs}$2`);
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
          handleRollCreditsMediaServe(pathname, res);
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
        if (pathname.startsWith(YOUTUBE_IMAGE_ROUTE_PREFIX)) {
          handleYoutubeImageServe(pathname, res);
          return;
        }
        // Admin-only JSON APIs
        if (pathname === '/api/status') {
          if (!requireAdminSession(req, res)) return;
          sendJson(res, 200, buildStatus());
          return;
        }
        if (pathname === '/api/commands') {
          if (!requireAdminSession(req, res)) return;
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
        if (pathname === '/api/photos') {
          if (!requireAdminSession(req, res)) return;
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
          if (!requireAdminSession(req, res)) return;
          handlePhotoEvents(req, res);
          return;
        }
        if (pathname === '/api/slideshow/settings') {
          if (!requireAdminSession(req, res)) return;
          handleSlideshowSettingsGet(res);
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
        // Login page + guest booth + shared logos are public; admin shell needs a session.
        if (isAdminLoginPath(pathname) || !pathname.startsWith('/admin')) {
          serveStatic(pathname, res);
          return;
        }
        serveStaticForRequest(req, pathname, res);
        return;
      }

      // Scheduler rules and YouTube devices are the bridge's only REST-shaped
      // collections, so PUT/DELETE are routed here rather than folded into POST.
      if (req.method === 'PUT' || req.method === 'DELETE') {
        const isScheduler = pathname.startsWith('/api/display-scheduler/');
        const isYoutube = pathname.startsWith('/api/youtube/');
        const isRollCredits = pathname.startsWith('/api/roll-credits/');
        if (!isScheduler && !isYoutube && !isRollCredits) {
          res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Method not allowed');
          return;
        }
        if (!requireAdminSession(req, res)) return;
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
        const bodyLimit = pathname === '/api/qr/image-upload'
          ? Math.ceil(qrImageCache.maxBytes * QR_IMAGE_BODY_OVERHEAD_FACTOR) + QR_IMAGE_BODY_PADDING_BYTES
          : isRollCreditsImage
            ? Math.ceil(
              rollCreditsInstance.getSettings().limits.maxImageBytes
                * QR_IMAGE_BODY_OVERHEAD_FACTOR,
            ) + QR_IMAGE_BODY_PADDING_BYTES
          : MAX_BODY_BYTES;
        const body = await readJsonBody(req, bodyLimit);

        if (pathname === '/api/admin/login') {
          handleAdminLogin(body, req, res);
          return;
        }
        if (pathname === '/api/admin/logout') {
          handleAdminLogout(req, res);
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

        // Everything else requires an admin session.
        if (!requireAdminSession(req, res)) {
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

        // A human pressed a button. Manual is the highest precedence tier (§6),
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
            handleVoiceQueryPush('weather', 'what is the weather', 'weather-query', body, res);
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
    }
  }

  async function start() {
    rollCreditsInstance.start?.();
    // Listener already starts the shared Autodarts instance when injected;
    // only start a locally created fallback (tests / standalone web).
    if (!autodarts) {
      autodartsInstance.start?.();
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
    scheduler.stop();
    rollCreditsInstance.close?.();
    if (!autodarts) {
      autodartsInstance.close?.();
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
  isAdminLoginPath,
  triviaArtworkStemVariants,
};
