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
} = require('./udp-payload');
const { resolveGuestPhotoboothSettings } = require('./guest-photobooth');
const { ALL_TARGET_ID } = require('./display-registry');
const { createDisplayControlAuth } = require('./display-control-auth');
const { createQrImageCache } = require('./qr-image-cache');
const { createWebAdminAuth } = require('./web-admin-auth');
const {
  createSlideshowSettings,
  VALID_ORDERS,
  MIN_SECONDS_PER_PHOTO,
  MAX_SECONDS_PER_PHOTO,
  clampSecondsPerPhoto,
} = require('./slideshow-settings');

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
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

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

function createWebServer({
  config,
  log,
  sendUdpPayload,
  recordVoiceEvent,
  displayRegistry = null,
  deliverTargetedPayload = null,
  requestTimerPoll = null,
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
  const qrImageCache = createQrImageCache(config, log);
  const slideshowSettings = createSlideshowSettings(config, log);
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

  function handleAdminLogin(body, req, res) {
    const result = adminAuth.login(body?.password, req);
    if (!result.ok) {
      sendJson(res, result.status || 401, {
        ok: false,
        error: result.error,
        code: result.code,
      });
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

  function handleQrPush(req, body, res) {
    const mode = String(body?.mode || '').trim().toLowerCase();
    // Guests may only push photo QRs; URL/Wi-Fi require an admin session.
    if (mode !== 'photo' && !adminAuth.assertAuthorized(req).ok) {
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

    if (mode === 'url' || mode === 'photo') {
      const validation = validatePushUrl(body?.url);
      if (!validation.ok) {
        sendJson(res, 400, { ok: false, error: validation.error });
        return;
      }
      // 'photo' tells the display to hero the image itself and tuck the QR
      // into the corner (slideshow-style); plain 'url' keeps the classic
      // full-size QR layout for arbitrary links.
      qrType = mode === 'photo' ? 'photo' : 'url';
      content = validation.url;
      label = String(body?.label || '').trim()
        || (mode === 'photo' ? 'Scan to save this photo' : validation.url);
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

  function handleQrImageServe(pathname, res) {
    const routeTail = pathname.slice(qrImageCache.routePrefix.length);
    const entry = qrImageCache.get(routeTail);
    if (!entry) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found or expired');
      return;
    }
    res.writeHead(200, {
      'Content-Type': entry.mimeType,
      // Never cache client/proxy-side: once the token expires the URL must
      // 404 immediately for anyone who still has it.
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(entry.filePath).pipe(res);
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

  function handlePhotoSlideshowPush(body, res) {
    const photos = Array.isArray(body?.photos) ? body.photos : [];
    const secondsPerPhoto = body?.secondsPerPhoto != null
      ? clampSecondsPerPhoto(body.secondsPerPhoto)
      : slideshowSettings.getSecondsPerPhoto();
    const payload = buildPhotoSlideshowPayload({
      photos,
      secondsPerPhoto,
      device: deviceFrom(body),
      trigger: 'photo-slideshow-api',
      order: slideshowSettings.getOrder(),
    });
    if (!payload) {
      sendJson(res, 400, { ok: false, error: 'No shared photos to show — share one via the Slideshow Manager first' });
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
        if (pathname === '/api/admin/session') {
          handleAdminSession(req, res);
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
          handleQrImageServe(pathname, res);
          return;
        }
        // Admin-only JSON APIs
        if (pathname === '/api/status') {
          if (!requireAdminSession(req, res)) return;
          sendJson(res, 200, buildStatus());
          return;
        }
        if (pathname === '/api/photos') {
          if (!requireAdminSession(req, res)) return;
          handlePhotosList(res);
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
        // Login page + guest booth + shared logos are public; admin shell needs a session.
        if (isAdminLoginPath(pathname) || !pathname.startsWith('/admin')) {
          serveStatic(pathname, res);
          return;
        }
        serveStaticForRequest(req, pathname, res);
        return;
      }

      if (req.method === 'POST') {
        // Uploaded photos are the one POST body that can legitimately exceed
        // the default JSON body cap (base64-encoded image data).
        const bodyLimit = pathname === '/api/qr/image-upload'
          ? Math.ceil(qrImageCache.maxBytes * QR_IMAGE_BODY_OVERHEAD_FACTOR) + QR_IMAGE_BODY_PADDING_BYTES
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
        if (pathname === '/api/qr/image-upload') {
          handleQrImageUpload(body, res);
          return;
        }
        if (pathname === '/api/qr/push') {
          handleQrPush(req, body, res);
          return;
        }

        // Everything else requires an admin session.
        if (!requireAdminSession(req, res)) {
          return;
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

    return controlServer;
  }

  function stop() {
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
  };
}

module.exports = {
  createWebServer,
  validatePushUrl,
  resolveStaticPath,
  computeWebBasePath,
  checkUrlReachable,
  isAdminHtmlPath,
  isAdminLoginPath,
};
