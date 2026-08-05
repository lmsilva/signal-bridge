const { parseMessageDetails } = require('./message-details');
const { parseSpokenTime } = require('./time-parse');
const { extractWeatherLocation } = require('./weather-location');
const {
  buildIndoorReading,
  indoorMetric,
  resolveIndoorQueryLocation,
} = require('./indoor-temperature');
const {
  buildAirQualityReading,
  resolveAirQualityQueryLocation,
} = require('./air-quality');
const { getCategory: getTriviaCategory } = require('./trivia-categories');
const { resolveTopic } = require('./upside-news-categories');

function displaySeconds(config, override) {
  const value = Number(override);
  if (!Number.isNaN(value) && value > 0) {
    return value;
  }
  return Number(config.udpBroadcast?.defaultDisplaySeconds) || 120;
}

function buildBroadcastPayload(record, config) {
  const details = parseMessageDetails(record);

  return {
    version: 2,
    type: 'broadcast',
    message: details.message,
    sender: details.sender,
    destination: details.destination,
    timestamp: new Date(record.timestamp || Date.now()).toISOString(),
    displaySeconds: displaySeconds(config, record.displaySeconds),
    trigger: record.trigger || 'unknown',
  };
}

function buildTimeQueryPayload(event, config) {
  const timeZone = config.voiceEvents?.localTimeZone
    || config.alarmSync?.localTimeZone
    || 'America/Denver';
  const parsedTime = parseSpokenTime(
    event.spokenResponse,
    new Date(event.timestamp),
    { timeZone },
  );

  return {
    version: 2,
    type: 'time.query',
    device: event.device,
    timestamp: new Date(event.timestamp || Date.now()).toISOString(),
    displaySeconds: displaySeconds(config),
    trigger: event.trigger || 'time-query',
    query: event.query,
    spokenResponse: event.spokenResponse || null,
    parsedTime,
  };
}

function buildWeatherQueryPayload(event, config, { location, weather } = {}) {
  const resolvedLocation = location || extractWeatherLocation(
    event.query,
    config.voiceEvents?.defaultLocation,
    event.spokenResponse,
  );

  return {
    version: 2,
    type: 'weather.query',
    device: event.device,
    timestamp: new Date(event.timestamp || Date.now()).toISOString(),
    displaySeconds: displaySeconds(config),
    trigger: event.trigger || 'weather-query',
    query: event.query,
    spokenResponse: event.spokenResponse || null,
    location: resolvedLocation,
    weather: weather || null,
  };
}

function timerDisplaySeconds(timers, config, event = null) {
  const base = displaySeconds(config);

  if (event?.kind === 'fired') {
    return Math.max(25, base);
  }

  const active = (timers || []).filter((timer) => {
    if (timer?.status === 'OFF') {
      return false;
    }
    return timer?.remainingSec == null || timer.remainingSec > 0;
  });

  if (!active.length) {
    return base;
  }

  const shortestRemaining = Math.min(
    ...active
      .map((timer) => Number(timer.remainingSec))
      .filter((value) => !Number.isNaN(value) && value > 0),
  );

  if (Number.isNaN(shortestRemaining)) {
    return base;
  }

  if (shortestRemaining < base) {
    return Math.max(1, Math.round(shortestRemaining));
  }

  return base;
}

function buildAirQualityPayload(event, config, { location, reading, monitors } = {}) {
  const airQualityConfig = config.airQuality || {};
  const resolvedLocation = location || resolveAirQualityQueryLocation(event, airQualityConfig);
  const resolvedReading = reading || buildAirQualityReading(event, airQualityConfig);
  const monitorList = Array.isArray(monitors) ? monitors : (resolvedReading.monitors || []);
  const extraSeconds = Math.max(0, monitorList.length - 1) * 10;

  return {
    version: 2,
    type: 'air-quality.query',
    device: event.device,
    timestamp: new Date(event.timestamp || Date.now()).toISOString(),
    displaySeconds: Math.max(displaySeconds(config, airQualityConfig.displaySeconds), 30 + extraSeconds),
    trigger: event.trigger || 'air-quality-query',
    query: event.query,
    spokenResponse: event.spokenResponse || null,
    location: resolvedLocation,
    reading: resolvedReading,
    monitors: monitorList,
  };
}

function buildIndoorTemperaturePayload(event, config, { location, reading } = {}) {
  const indoorConfig = config.indoorTemperature || {};
  const resolvedLocation = location || resolveIndoorQueryLocation(
    event.query,
    event.spokenResponse,
    indoorConfig,
  );
  const resolvedReading = reading || buildIndoorReading(event, indoorConfig);

  return {
    version: 2,
    type: 'indoor-temperature.query',
    device: event.device,
    timestamp: new Date(event.timestamp || Date.now()).toISOString(),
    displaySeconds: displaySeconds(config, indoorConfig.displaySeconds),
    trigger: event.trigger || 'indoor-temperature-query',
    query: event.query,
    spokenResponse: event.spokenResponse || null,
    metric: indoorMetric(event.query),
    location: resolvedLocation,
    reading: resolvedReading,
  };
}

function buildShoppingListPayload(event, config, { list } = {}) {
  const items = list?.items || [];
  // Client pages roughly 8 items per screen and rotates pages every 15s.
  const pages = Math.max(1, Math.ceil(items.length / 8));

  return {
    version: 2,
    type: 'shopping-list.snapshot',
    device: event.device,
    timestamp: new Date(event.timestamp || Date.now()).toISOString(),
    displaySeconds: Math.max(displaySeconds(config), pages * 15 + 5),
    trigger: event.trigger || 'shopping-list-show',
    query: event.query,
    spokenResponse: event.spokenResponse || null,
    listName: list?.name || 'Shopping List',
    items,
    addedItem: event.addedItem || null,
  };
}

function buildMusicPayload(event, config, { nowPlaying } = {}) {
  return {
    version: 2,
    type: 'music.playing',
    device: event.device,
    timestamp: new Date(event.timestamp || Date.now()).toISOString(),
    displaySeconds: displaySeconds(config),
    trigger: event.trigger || 'music-play',
    query: event.query,
    spokenResponse: event.spokenResponse || null,
    music: nowPlaying || null,
  };
}

function buildTeslaBatteryPayload(event, config, { battery } = {}) {
  return {
    version: 2,
    type: 'tesla-battery.query',
    device: event.device,
    timestamp: new Date(event.timestamp || Date.now()).toISOString(),
    displaySeconds: displaySeconds(config),
    trigger: event.trigger || 'tesla-battery-query',
    query: event.query,
    spokenResponse: event.spokenResponse || null,
    battery: battery || null,
  };
}

function teslaDashboardDisplaySeconds(config) {
  return Math.max(displaySeconds(config), 120);
}

function buildTeslaDashboardPayload(event, config, { dashboard } = {}) {
  return {
    version: 2,
    type: 'tesla-dashboard.query',
    device: event.device,
    timestamp: new Date(event.timestamp || Date.now()).toISOString(),
    displaySeconds: teslaDashboardDisplaySeconds(config),
    trigger: event.trigger || 'tesla-dashboard-query',
    query: event.query,
    spokenResponse: event.spokenResponse || null,
    dashboard: dashboard || null,
  };
}

function buildVivintAlarmPayload(event, config, { alarm } = {}) {
  return {
    version: 2,
    type: 'vivint-alarm.query',
    device: event.device,
    timestamp: new Date(event.timestamp || Date.now()).toISOString(),
    displaySeconds: displaySeconds(config),
    trigger: event.trigger || 'vivint-alarm-query',
    query: event.query,
    spokenResponse: event.spokenResponse || null,
    alarm: alarm || null,
  };
}

function buildNotificationsPayload(event, config, { notifications } = {}) {
  const items = notifications?.items || [];
  const extraSeconds = Math.max(0, items.length - 1) * 8;

  return {
    version: 2,
    type: 'alexa-notifications.query',
    device: event.device,
    timestamp: new Date(event.timestamp || Date.now()).toISOString(),
    displaySeconds: Math.max(displaySeconds(config), 20 + extraSeconds),
    trigger: event.trigger || 'alexa-notifications-query',
    query: event.query,
    spokenResponse: event.spokenResponse || null,
    notifications: notifications || null,
    themeAccent: '#FF9900',
  };
}

// Immediate "we got your request" acks are only worth showing for commands
// that routinely take >3s (UX guidance: loading states for short operations
// feel slower, not faster). Tesla Fleet calls can take 10-30s when the
// vehicle has to wake, so those get a placeholder with staged reassurance
// messages timed around the ~10s attention threshold.
const PROCESSING_ACK_TIMEOUT_SEC = 45;

const SLOW_REQUEST_INFO = {
  'tesla-battery': {
    title: 'Tesla Battery',
    source: 'Tesla Fleet API',
    stages: [
      { afterSec: 0, message: 'Request received — contacting your Tesla…' },
      { afterSec: 5, message: 'Fetching battery status from your vehicle…' },
      { afterSec: 12, message: 'Still working — your Tesla may be waking up…' },
      { afterSec: 25, message: 'Hang tight — waking a sleeping vehicle can take up to 30 seconds…' },
    ],
  },
  'tesla-dashboard': {
    title: 'Tesla Dashboard',
    source: 'Tesla Fleet API',
    stages: [
      { afterSec: 0, message: 'Request received — contacting your Tesla…' },
      { afterSec: 5, message: 'Fetching live vehicle data…' },
      { afterSec: 12, message: 'Still working — your Tesla may be waking up…' },
      { afterSec: 25, message: 'Hang tight — waking a sleeping vehicle can take up to 30 seconds…' },
    ],
  },
  route: {
    title: 'Route Planner',
    source: 'Maps',
    // Prefer progressive route-planner.query skeletons over this ack; kept for
    // any leftover callers. Long window so a hung geocode does not flash fail.
    timeoutSeconds: 90,
    stages: [
      { afterSec: 0, message: 'Request received — looking up places…' },
      { afterSec: 3, message: 'Geocoding origin and destination…' },
      { afterSec: 8, message: 'Calculating distance and drive time…' },
      { afterSec: 25, message: 'Still working — map services can be slow…' },
    ],
  },
  music: {
    title: 'Now Playing',
    source: 'Alexa players',
    stages: [
      { afterSec: 0, message: 'Looking up what’s playing…' },
      { afterSec: 4, message: 'Checking Echo devices in your household…' },
      { afterSec: 10, message: 'Still checking player status…' },
    ],
  },
};

function buildProcessingAckPayload(event, config) {
  const info = SLOW_REQUEST_INFO[event.kind];
  if (!info) {
    return null;
  }

  const timeoutSeconds = Number(info.timeoutSeconds) > 0
    ? Number(info.timeoutSeconds)
    : PROCESSING_ACK_TIMEOUT_SEC;

  return {
    version: 2,
    type: 'request.processing',
    device: event.device,
    timestamp: new Date(event.timestamp || Date.now()).toISOString(),
    // Ceiling covers the timeout plus ~15s for the failure state to be read
    // before the overlay dismisses itself; the real payload replaces this
    // placeholder long before then in the normal case.
    displaySeconds: timeoutSeconds + 15,
    trigger: 'processing-ack',
    kind: event.kind,
    query: event.query,
    request: {
      title: info.title,
      source: info.source,
      timeoutSeconds,
      stages: info.stages,
    },
  };
}

// Web browser display: the client keeps the page open until an explicit
// web.close arrives, so web.open carries persistent: true and no meaningful
// displaySeconds. These payloads originate from the control web page, not
// from voice events.
function buildWebOpenPayload({ url, device, timestamp, trigger } = {}, config) {
  const normalizedUrl = String(url || '').trim();
  if (!/^https?:\/\//i.test(normalizedUrl)) {
    return null;
  }

  return {
    version: 2,
    type: 'web.open',
    device: device || 'Signal',
    timestamp: new Date(timestamp || Date.now()).toISOString(),
    displaySeconds: 0,
    persistent: true,
    trigger: trigger || 'web-api',
    web: {
      url: normalizedUrl,
      // Fallback display window for the friendly error message when the
      // client cannot load the page (standard dismiss sequence applies).
      errorDisplaySeconds: Math.min(30, displaySeconds(config)),
    },
  };
}

function buildWebClosePayload({ device, timestamp, trigger } = {}, config) {
  return {
    version: 2,
    type: 'web.close',
    device: device || 'Signal',
    timestamp: new Date(timestamp || Date.now()).toISOString(),
    displaySeconds: 0,
    trigger: trigger || 'web-api',
  };
}

const SYSTEM_COMMAND_ACTIONS = new Set(['reboot', 'poweroff']);

function buildSystemCommandPayload({ action, device, timestamp, trigger } = {}, config) {
  const normalizedAction = String(action || '').trim().toLowerCase();
  if (!SYSTEM_COMMAND_ACTIONS.has(normalizedAction)) {
    return null;
  }

  return {
    version: 2,
    type: 'system.command',
    device: device || 'Signal',
    timestamp: new Date(timestamp || Date.now()).toISOString(),
    displaySeconds: 0,
    trigger: trigger || 'web-api',
    system: {
      action: normalizedAction,
    },
  };
}

function buildDisplayDiscoverPayload({ trigger, discoveryPort } = {}, config) {
  const port = Number(
    discoveryPort
      ?? config?.udpBroadcast?.discoveryPort
      ?? 47833,
  );
  return {
    version: 2,
    type: 'display.discover',
    timestamp: new Date().toISOString(),
    trigger: trigger || 'web-api',
    discovery: {
      port,
    },
  };
}

function buildDisplayAuthPinPayload({ pin, displaySeconds, device, trigger } = {}, config) {
  const code = String(pin || '').replace(/\D/g, '');
  if (code.length < 4) {
    return null;
  }
  const seconds = Number(displaySeconds)
    || Number(config?.udpBroadcast?.defaultDisplaySeconds)
    || 120;
  return {
    version: 2,
    type: 'display.auth',
    device: device || 'Signal',
    timestamp: new Date().toISOString(),
    displaySeconds: Math.max(10, seconds),
    trigger: trigger || 'web-api',
    auth: {
      pin: code,
    },
  };
}

/** Brief success flash after a valid control PIN — replaces the PIN overlay. */
function buildDisplayAuthOkPayload({ displaySeconds = 1, device, trigger } = {}) {
  const seconds = Number(displaySeconds);
  return {
    version: 2,
    type: 'display.auth',
    device: device || 'Signal',
    timestamp: new Date().toISOString(),
    displaySeconds: Number.isFinite(seconds) && seconds > 0 ? Math.max(1, Math.round(seconds)) : 1,
    trigger: trigger || 'web-api',
    auth: {
      status: 'ok',
    },
  };
}

function buildInputPointerPayload({
  dx = 0,
  dy = 0,
  buttons = null,
  wheel = 0,
  device,
  timestamp,
  trigger,
} = {}) {
  const pointer = {
    dx: Number(dx) || 0,
    dy: Number(dy) || 0,
  };
  if (buttons && typeof buttons === 'object') {
    pointer.buttons = buttons;
  }
  const wheelVal = Number(wheel) || 0;
  if (wheelVal) {
    pointer.wheel = wheelVal;
  }

  return {
    version: 2,
    type: 'input.pointer',
    device: device || 'Signal',
    timestamp: new Date(timestamp || Date.now()).toISOString(),
    displaySeconds: 0,
    trigger: trigger || 'web-api',
    pointer,
  };
}

const INPUT_KEY_ACTIONS = new Set(['press', 'down', 'up']);
const INPUT_MODIFIERS = new Set(['ctrl', 'alt', 'shift', 'meta', 'win']);

function normalizeInputKeyName(key) {
  // A literal space character is a valid key — do not trim() it to empty
  // (admin keyboard used to send ' ' and the bridge replied "Missing key").
  if (typeof key === 'string' && key.length > 0 && /^\s+$/.test(key)) {
    return 'Space';
  }
  const normalized = String(key ?? '').trim();
  if (!normalized) {
    return '';
  }
  if (normalized.toLowerCase() === 'space') {
    return 'Space';
  }
  return normalized;
}

function buildInputKeyPayload({
  key,
  modifiers = [],
  action = 'press',
  device,
  timestamp,
  trigger,
} = {}) {
  const normalizedKey = normalizeInputKeyName(key);
  if (!normalizedKey) {
    return null;
  }
  const normalizedAction = INPUT_KEY_ACTIONS.has(String(action || '').toLowerCase())
    ? String(action).toLowerCase()
    : 'press';
  const mods = (Array.isArray(modifiers) ? modifiers : [])
    .map((m) => String(m || '').toLowerCase())
    .map((m) => (m === 'win' || m === 'cmd' || m === 'super' ? 'meta' : m))
    .filter((m) => INPUT_MODIFIERS.has(m));

  return {
    version: 2,
    type: 'input.key',
    device: device || 'Signal',
    timestamp: new Date(timestamp || Date.now()).toISOString(),
    displaySeconds: 0,
    trigger: trigger || 'web-api',
    key: {
      key: normalizedKey,
      modifiers: [...new Set(mods)],
      action: normalizedAction,
    },
  };
}

// Full-string keyboard entry: the client types the whole value in one shot
// (pynput Controller.type, which injects Unicode keystrokes directly) instead
// of the phone sending one input.key payload per character.
function buildInputTextPayload({
  value,
  pressEnter = false,
  device,
  timestamp,
  trigger,
} = {}) {
  const normalizedValue = String(value ?? '');
  if (!normalizedValue) {
    return null;
  }

  return {
    version: 2,
    type: 'input.text',
    device: device || 'Signal',
    timestamp: new Date(timestamp || Date.now()).toISOString(),
    displaySeconds: 0,
    trigger: trigger || 'web-api',
    text: {
      value: normalizedValue,
      pressEnter: Boolean(pressEnter),
    },
  };
}

// Escapes the special characters reserved by the Wi-Fi QR payload format
// (RFC-ish convention used by iOS/Android QR scanners): backslash, semicolon,
// comma and colon must be backslash-escaped inside each field.
function escapeWifiField(value) {
  return String(value ?? '').replace(/([\\;,:])/g, '\\$1');
}

// Builds the standard "WIFI:T:<type>;S:<ssid>;P:<password>;H:<hidden>;;"
// QR payload string that iOS/Android camera apps recognize as a network
// join prompt. `security` is 'WPA' (covers WPA/WPA2/WPA3 personal) or
// 'nopass' for open networks (password omitted).
function buildWifiQrContent({ ssid, password, security = 'WPA', hidden = false } = {}) {
  const normalizedSsid = String(ssid || '').trim();
  if (!normalizedSsid) {
    return null;
  }
  const isOpen = String(security).toLowerCase() === 'nopass';
  const type = isOpen ? 'nopass' : 'WPA';
  const parts = [`WIFI:T:${type}`, `S:${escapeWifiField(normalizedSsid)}`];
  if (!isOpen) {
    parts.push(`P:${escapeWifiField(password || '')}`);
  }
  if (hidden) {
    parts.push('H:true');
  }
  return `${parts.join(';')};;`;
}

// 'photo' = shared image URL (client shows the photo large + a corner QR);
// 'url' / 'wifi' = classic full-size QR code layouts.
const QR_TYPES = new Set(['url', 'wifi', 'photo']);

// Bridge never renders the QR bitmap itself — the display client generates
// it locally from this content string, so the UDP payload stays a small
// piece of text regardless of QR density.
function buildQrDisplayPayload({
  qrType,
  content,
  label,
  device,
  timestamp,
  trigger,
  displaySeconds: displaySecondsOverride,
} = {}, config) {
  const normalizedType = String(qrType || '').trim().toLowerCase();
  const normalizedContent = String(content || '').trim();
  if (!QR_TYPES.has(normalizedType) || !normalizedContent) {
    return null;
  }

  const seconds = Number(displaySecondsOverride)
    || Number(config?.qrImage?.defaultDisplaySeconds)
    || 60;

  return {
    version: 2,
    type: 'qr.display',
    device: device || 'Signal',
    timestamp: new Date(timestamp || Date.now()).toISOString(),
    displaySeconds: Math.max(15, seconds),
    trigger: trigger || 'qr-api',
    qr: {
      qrType: normalizedType,
      content: normalizedContent,
      label: label || null,
    },
  };
}

/**
 * Dual-QR guest welcome page: Wi-Fi join + public photo booth URL.
 * Client renders both codes; bridge only ships content strings.
 */
function buildGuestPhotoboothPayload(event, config, settings) {
  const wifiContent = buildWifiQrContent({
    ssid: settings?.ssid,
    password: settings?.password,
    security: settings?.security,
    hidden: settings?.hidden,
  });
  const boothUrl = String(settings?.boothUrl || '').trim();
  if (!wifiContent || !boothUrl) {
    return null;
  }

  const seconds = Number(settings?.displaySeconds)
    || Number(config?.guestPhotobooth?.defaultDisplaySeconds)
    || 180;

  const accessPin = String(settings?.accessPin || '').replace(/\D/g, '');
  const accessPinHint = String(settings?.accessPinHint || '').trim()
    || (accessPin ? 'Enter this PIN on your phone' : '');

  return {
    version: 2,
    type: 'guest.photobooth',
    device: event?.device || 'Signal',
    timestamp: new Date(event?.timestamp || Date.now()).toISOString(),
    displaySeconds: Math.max(30, seconds),
    trigger: event?.trigger || 'guest-photobooth-query',
    query: event?.query || null,
    guestPhotobooth: {
      title: 'Guest Snaps',
      subtitle: 'Two quick scans to share a photo',
      ...(accessPin ? { accessPin, accessPinHint } : {}),
      wifi: {
        content: wifiContent,
        ssid: String(settings.ssid || '').trim(),
        stepLabel: '1',
        heading: 'Join Wi‑Fi',
        hint: 'Scan to connect',
      },
      booth: {
        content: boothUrl,
        stepLabel: '2',
        heading: 'Open Guest Snaps',
        hint: 'Already on Wi‑Fi? Scan here',
      },
    },
  };
}

function buildSmartHomePayload(event, config, { deviceType, matchedName } = {}) {
  const spokenTarget = event.command?.target || null;
  return {
    version: 2,
    type: 'smart-home.command',
    device: event.device,
    timestamp: new Date(event.timestamp || Date.now()).toISOString(),
    displaySeconds: Math.min(15, displaySeconds(config)),
    trigger: event.trigger || 'smart-home-command',
    query: event.query,
    spokenResponse: event.spokenResponse || null,
    command: {
      action: event.command?.action || null,
      target: spokenTarget || matchedName || null,
      spokenTarget,
      matchedName: matchedName || null,
      deviceType: deviceType || 'device',
    },
  };
}

function alarmDisplaySeconds(alarms, config) {
  const base = displaySeconds(config);
  const count = (alarms || []).length;
  if (count <= 1) {
    return base;
  }
  return Math.max(base, Math.min(180, base + (count - 1) * 8));
}

function buildAlarmSnapshotPayload({
  alarms,
  device,
  timestamp,
  trigger,
  event,
  highlightAmazonId,
}, config) {
  const highlightId = highlightAmazonId || null;
  const enrichedAlarms = (alarms || []).map((alarm) => ({
    ...alarm,
    isNew: highlightId != null && alarm.amazonId === highlightId,
  }));

  return {
    version: 2,
    type: 'alarm.snapshot',
    device: device || null,
    timestamp: new Date(timestamp || Date.now()).toISOString(),
    displaySeconds: alarmDisplaySeconds(enrichedAlarms, config),
    trigger: trigger || 'alarm-sync',
    alarms: enrichedAlarms,
    event: event || { kind: 'list' },
    highlightAmazonId: highlightId,
  };
}

// Sorts normalized {url, uploadedAt} photos per the Slideshow Manager's
// persisted order setting. Ties (equal/missing uploadedAt) keep their
// incoming relative order — Array#sort is a stable sort in Node, so callers
// that don't have real timestamps yet (e.g. tests) still see a predictable
// order rather than one that looks shuffled.
function applySlideshowOrder(photos, order) {
  const key = (photo) => Date.parse(photo.uploadedAt) || 0;
  if (order === 'oldest') {
    return [...photos].sort((a, b) => key(a) - key(b));
  }
  if (order === 'random') {
    const shuffled = [...photos];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }
  // 'recent' (default): newest first.
  return [...photos].sort((a, b) => key(b) - key(a));
}

// Shared photo slideshow: cycles every photo currently in the QR image cache
// (anything shared via "QR Code → Photo" or the Slideshow Manager — photos
// no longer expire on their own, see qr-image-cache.js) at `secondsPerPhoto`
// each, ordered per the Slideshow Manager's persisted `order` setting
// ('recent' | 'oldest' | 'random'). displaySeconds spans the whole pass
// through the list so the overlay does not auto-dismiss partway through — a
// fresh UDP payload (any type) still interrupts it immediately, same as
// every other overlay.
function buildPhotoSlideshowPayload({
  photos,
  secondsPerPhoto = 5,
  device,
  timestamp,
  trigger,
  order,
} = {}) {
  const normalized = (Array.isArray(photos) ? photos : [])
    .map((entry) => {
      if (entry && typeof entry === 'object') {
        return { url: String(entry.url || '').trim(), uploadedAt: entry.uploadedAt || null };
      }
      return { url: String(entry || '').trim(), uploadedAt: null };
    })
    .filter((photo) => photo.url);
  if (!normalized.length) {
    return null;
  }
  const perPhoto = Math.max(1, Number(secondsPerPhoto) || 5);
  const ordered = applySlideshowOrder(normalized, order);

  return {
    version: 2,
    type: 'photo.slideshow',
    device: device || 'Signal',
    timestamp: new Date(timestamp || Date.now()).toISOString(),
    displaySeconds: ordered.length * perPhoto,
    trigger: trigger || 'photo-slideshow-api',
    slideshow: {
      photos: ordered,
      secondsPerPhoto: perPhoto,
    },
  };
}

// "Route Planner" — bridge may send progressive updates: first a skeleton with
// place names (`status: "loading"`), then coords, then distance/route
// (`status: "ready"`). The display client paints what it has and fills tiles
// as later UDP updates arrive. Map tiles / place facts / weather still fetch
// client-side once coordinates exist.
//
// Dismiss window is separate from the standard overlay duration: default
// **2×** `udpBroadcast.defaultDisplaySeconds` (min 180s). Override with
// `routePlanner.displaySeconds`.
function routePlannerDisplaySeconds(config) {
  const override = Number(config?.routePlanner?.displaySeconds);
  if (Number.isFinite(override) && override > 0) {
    return Math.max(60, Math.round(override));
  }
  const base = displaySeconds(config);
  return Math.max(180, base * 2);
}

function routePlaceFields(place) {
  if (!place || typeof place !== 'object') {
    return null;
  }
  const name = place.resolvedName || place.query || place.name || null;
  if (!name && place.latitude == null && place.longitude == null) {
    return null;
  }
  return {
    name: name || 'Unknown',
    latitude: place.latitude != null ? Number(place.latitude) : null,
    longitude: place.longitude != null ? Number(place.longitude) : null,
  };
}

function buildRoutePlannerPayload(event, config, {
  origin,
  destination,
  route = null,
  mode = 'driving',
  status = null,
  error = null,
} = {}) {
  const originFields = routePlaceFields(origin);
  const destinationFields = routePlaceFields(destination);
  if (!originFields || !destinationFields) {
    return null;
  }

  const hasRoute = Boolean(route)
    && (route.distanceMiles != null || (Array.isArray(route.geometry) && route.geometry.length >= 2));
  let resolvedStatus = status;
  if (!resolvedStatus) {
    resolvedStatus = hasRoute ? 'ready' : 'loading';
  }
  if (resolvedStatus === 'failed') {
    resolvedStatus = 'failed';
  } else if (hasRoute) {
    resolvedStatus = 'ready';
  }

  return {
    version: 2,
    type: 'route-planner.query',
    device: event.device,
    timestamp: new Date(event.timestamp || Date.now()).toISOString(),
    displaySeconds: routePlannerDisplaySeconds(config),
    trigger: event.trigger || 'route-query',
    query: event.query,
    spokenResponse: event.spokenResponse || null,
    status: resolvedStatus,
    error: error ? String(error).slice(0, 160) : null,
    mode: mode === 'flight' ? 'flight' : 'driving',
    origin: originFields,
    destination: destinationFields,
    distanceMiles: route?.distanceMiles ?? null,
    durationMin: route?.durationMin ?? null,
    route: {
      geometry: Array.isArray(route?.geometry) ? route.geometry : [],
    },
  };
}

function buildTimerSnapshotPayload({
  timers,
  device,
  timestamp,
  trigger,
  event,
}, config) {
  return {
    version: 2,
    type: 'timer.snapshot',
    device: device || null,
    timestamp: new Date(timestamp || Date.now()).toISOString(),
    displaySeconds: timerDisplaySeconds(timers, config, event),
    trigger: trigger || 'timer-sync',
    timers,
    event: event || { kind: 'list' },
  };
}

function thinLibraryTourGame(game) {
  // Keep UDP / seed rows tiny — no poster URL lists (those blow past MTU at
  // library scale). The client builds Steam CDN candidates from appId; PSN
  // gets a single imageUrl when we have one.
  const id = String(game?.id || game?.appId || game?.titleId || '').trim();
  const name = String(game?.name || '').trim();
  if (!id || !name) {
    return null;
  }
  const imageUrl = game.imageUrl
    || (Array.isArray(game.posterCandidates) ? game.posterCandidates[0] : null)
    || null;
  return {
    id,
    name,
    playtimeLabel: game.playtimeLabel || null,
    playtimeForeverMin: Number.isFinite(Number(game.playtimeForeverMin))
      ? Number(game.playtimeForeverMin)
      : null,
    lastPlayedAt: game.lastPlayedAt || null,
    imageUrl: imageUrl || null,
  };
}

/**
 * Start a library tour.
 *
 * Prefer session mode (`tourId` + `count`): UDP stays a few hundred bytes and
 * the display pulls the playlist over HTTP. Inline `games` is only for tiny
 * smoke tests / legacy callers — never ship a 700-game list on the wire.
 */
function buildGameLibraryTourPayload({
  platform = 'steam',
  games,
  seedGames,
  tourId = '',
  count = null,
  secondsPerGame = 60,
  device = 'Signal',
  trigger = 'library-tour',
  timestamp = Date.now(),
  loop = true,
  cardBaseUrl = '',
} = {}) {
  const sessionId = String(tourId || '').trim();
  const seed = (Array.isArray(seedGames) ? seedGames : [])
    .map(thinLibraryTourGame)
    .filter(Boolean)
    .slice(0, 1);
  const inline = (Array.isArray(games) ? games : [])
    .map(thinLibraryTourGame)
    .filter(Boolean);
  const total = Number.isFinite(Number(count)) && Number(count) > 0
    ? Math.round(Number(count))
    : (sessionId ? Math.max(seed.length, inline.length) : inline.length);
  if (!sessionId && !inline.length) {
    return null;
  }
  if (sessionId && total <= 0 && !seed.length) {
    return null;
  }
  const perGame = Math.max(5, Math.min(300, Math.round(Number(secondsPerGame) || 60)));
  const looping = loop !== false;
  const gameCount = sessionId ? Math.max(total, seed.length) : inline.length;
  // One scheduled pass has a real end; a manual tour loops until interrupted.
  const passSeconds = gameCount * perGame;
  const base = String(cardBaseUrl || '').replace(/\/+$/, '');
  return {
    version: 2,
    type: 'game.library-tour',
    device,
    timestamp: new Date(timestamp).toISOString(),
    displaySeconds: looping ? 0 : passSeconds,
    persistent: looping,
    trigger,
    gameTour: {
      platform: platform === 'psn' ? 'psn' : 'steam',
      secondsPerGame: perGame,
      loop: looping,
      cardBaseUrl: base,
      tourId: sessionId || null,
      count: gameCount,
      playlistPath: sessionId ? `/api/library-tour/playlist/${sessionId}` : null,
      // Seed = first title for immediate paint while the playlist HTTP lands.
      // Inline full list only when there is no session (tests / tiny libraries).
      games: sessionId ? seed : inline,
    },
  };
}

function buildSteamNowPlayingPayload(reading, config, {
  device = 'Signal',
  trigger = 'steam-now-playing',
  timestamp = Date.now(),
  mode = 'playing',
  dismissible = false,
} = {}) {
  if (!reading?.appId || !reading?.name) {
    return null;
  }
  const achievements = reading.achievements || {};
  const playMode = mode === 'last-played' || mode === 'library-tour'
    ? mode
    : 'playing';
  const isDismissible = Boolean(dismissible)
    || playMode === 'last-played'
    || playMode === 'library-tour';
  const startedMs = reading.startedAt
    || reading.lastPlayedAt
    || timestamp;
  return {
    version: 2,
    type: 'steam.now-playing',
    device,
    timestamp: new Date(timestamp).toISOString(),
    // Auto sessions stay until game ends / interrupt. Manual preview + last-played auto-dismiss.
    displaySeconds: isDismissible ? displaySeconds(config) : 0,
    persistent: !isDismissible,
    trigger,
    steam: {
      appId: Number(reading.appId),
      name: reading.name,
      mode: playMode,
      shortDescription: reading.shortDescription || '',
      developers: reading.developers || [],
      publishers: reading.publishers || [],
      releaseYear: reading.releaseYear || null,
      tags: Array.isArray(reading.tags) ? reading.tags.slice(0, 6) : [],
      posterCandidates: Array.isArray(reading.posterCandidates)
        ? reading.posterCandidates.slice(0, 12)
        : [],
      headerImage: reading.headerImage || null,
      screenshots: Array.isArray(reading.screenshots) ? reading.screenshots.slice(0, 3) : [],
      playtimeLabel: reading.playtimeLabel || null,
      playtimeForeverMin: reading.playtimeForeverMin ?? null,
      achievements: {
        earned: achievements.earned ?? null,
        total: achievements.total ?? null,
        available: Boolean(achievements.available),
      },
      currentPlayers: reading.currentPlayers ?? null,
      host: reading.host || null,
      startedAt: new Date(startedMs).toISOString(),
      // Never invent "now" as lastPlayedAt — that made AGO read "just now"
      // when Steam omitted rtime_last_played on the recently-played list.
      lastPlayedAt: reading.lastPlayedAt
        ? new Date(reading.lastPlayedAt).toISOString()
        : null,
      elapsedSec: Number(reading.elapsedSec) || 0,
      personaName: reading.personaName || null,
    },
  };
}

function buildSteamNowPlayingClosePayload({
  device = 'Signal',
  trigger = 'steam-now-playing-close',
  timestamp = Date.now(),
} = {}, _config) {
  return {
    version: 2,
    type: 'steam.now-playing.close',
    device,
    timestamp: new Date(timestamp).toISOString(),
    displaySeconds: 0,
    trigger,
  };
}

function buildPsnNowPlayingPayload(reading, config, {
  device = 'Signal',
  trigger = 'psn-now-playing',
  timestamp = Date.now(),
  mode = 'playing',
  dismissible = false,
} = {}) {
  if (!reading?.name) {
    return null;
  }
  const trophies = reading.trophies || reading.achievements || {};
  const playMode = mode === 'last-played' || mode === 'library-tour'
    ? mode
    : 'playing';
  const isDismissible = Boolean(dismissible)
    || playMode === 'last-played'
    || playMode === 'library-tour';
  const startedMs = reading.startedAt
    || reading.lastPlayedAt
    || timestamp;
  return {
    version: 2,
    type: 'psn.now-playing',
    device,
    timestamp: new Date(timestamp).toISOString(),
    displaySeconds: isDismissible ? displaySeconds(config) : 0,
    persistent: !isDismissible,
    trigger,
    psn: {
      titleId: reading.titleId || null,
      name: reading.name,
      mode: playMode,
      platform: reading.platform || null,
      // Prefer statusLine on the client — PSN has no Steam store description.
      shortDescription: reading.shortDescription || '',
      statusLine: reading.statusLine || '',
      developers: reading.developers || [],
      publishers: reading.publishers || [],
      releaseYear: reading.releaseYear || null,
      tags: Array.isArray(reading.tags) ? reading.tags.slice(0, 6) : [],
      posterCandidates: Array.isArray(reading.posterCandidates)
        ? reading.posterCandidates.slice(0, 12)
        : [],
      headerImage: reading.headerImage || null,
      screenshots: Array.isArray(reading.screenshots) ? reading.screenshots.slice(0, 3) : [],
      playtimeLabel: reading.playtimeLabel || null,
      playtimeForeverMin: reading.playtimeForeverMin ?? null,
      playCount: reading.playCount ?? null,
      progressLabel: reading.progressLabel || null,
      starRating: reading.starRating ?? null,
      starRatingCount: reading.starRatingCount ?? null,
      contentRating: reading.contentRating || null,
      storeProductId: reading.storeProductId || null,
      trophies: {
        earned: trophies.earned ?? null,
        total: trophies.total ?? null,
        available: Boolean(trophies.available),
        progress: trophies.progress ?? null,
      },
      achievements: {
        earned: trophies.earned ?? null,
        total: trophies.total ?? null,
        available: Boolean(trophies.available),
      },
      startedAt: new Date(startedMs).toISOString(),
      lastPlayedAt: reading.lastPlayedAt
        ? new Date(reading.lastPlayedAt).toISOString()
        : null,
      firstPlayedAt: reading.firstPlayedAt
        ? new Date(reading.firstPlayedAt).toISOString()
        : null,
      elapsedSec: Number(reading.elapsedSec) || 0,
      onlineId: reading.onlineId || null,
    },
  };
}

function buildPsnNowPlayingClosePayload({
  device = 'Signal',
  trigger = 'psn-now-playing-close',
  timestamp = Date.now(),
} = {}, _config) {
  return {
    version: 2,
    type: 'psn.now-playing.close',
    device,
    timestamp: new Date(timestamp).toISOString(),
    displaySeconds: 0,
    trigger,
  };
}

/**
 * A whole trivia round in one packet (trivia.md §6.1).
 *
 * The client sequences intro → Q1 → A1 → … → summary locally rather than
 * waiting on a packet per card: UDP is unreliable and one dropped mid-round
 * datagram would freeze the display on a question with no answer. Everything
 * needed to render every card — including per-question artwork URLs and accent
 * colours — travels up front.
 *
 * `artworkBaseUrl` is the bridge's own origin so the display can fetch the
 * category backgrounds over HTTP and disk-cache them; the payload itself stays
 * a few kilobytes.
 */
function buildTriviaRoundPayload({
  questions = [],
  settings = {},
  overrides = {},
  artworkBaseUrl = '',
  device = 'Signal',
  timestamp = Date.now(),
  trigger = 'trivia-api',
  triggeredBy = 'manual',
  sessionId = null,
  attribution = [],
  durationSeconds = null,
} = {}, config = {}) {
  if (!Array.isArray(questions) || !questions.length) {
    return null;
  }

  const questionSeconds = Number(overrides.questionSeconds) || settings.questionSeconds || 15;
  const answerSeconds = Number(overrides.answerSeconds) || settings.answerSeconds || 7;
  const count = questions.length;
  // A single-question round has no progress to show and nothing to summarise.
  const showIntro = settings.showIntroCard !== false;
  const showSummary = settings.showSummaryCard !== false && count > 1;
  const introSeconds = showIntro ? (Number(settings.introSeconds) || 4) : 0;
  const summarySeconds = showSummary ? (Number(settings.summarySeconds) || 6) : 0;
  const total = Number(durationSeconds)
    || Math.round(introSeconds + count * (questionSeconds + answerSeconds) + summarySeconds);

  const base = String(artworkBaseUrl || '').replace(/\/+$/, '');
  const cards = questions.map((question, index) => {
    const category = getTriviaCategory(question.categoryId) || {};
    const answers = shuffleAnswers(question);
    return {
      index,
      id: question.id,
      categoryId: question.categoryId,
      categoryLabel: question.categoryLabel || category.label || question.categoryId,
      difficulty: question.difficulty,
      type: question.type,
      text: question.text,
      answers,
      correctIndex: answers.indexOf(question.correctAnswer),
      funFact: question.funFact || null,
      accent: category.accent || '#8BB7FF',
      background: category.background || '#101820',
      artwork: category.artwork
        ? {
          portrait: base + category.artwork.portrait,
          landscape: base + category.artwork.landscape,
        }
        : null,
      provider: question.provider,
    };
  });

  return {
    version: 2,
    type: 'trivia.round',
    device,
    timestamp: new Date(timestamp).toISOString(),
    // The overlay must persist for the whole sequence, not one card.
    displaySeconds: total,
    trigger,
    trivia: {
      sessionId: sessionId || `trivia-${new Date(timestamp).getTime()}`,
      triggeredBy,
      questionCount: count,
      questionSeconds,
      answerSeconds,
      showIntro,
      showSummary,
      introSeconds,
      summarySeconds,
      totalDurationSeconds: total,
      // Licence condition, not a courtesy (trivia.md §2.5).
      attribution: attribution.length
        ? attribution
        : [...new Set(questions.map((question) => question.provider))],
      questions: cards,
    },
  };
}

const UPSIDE_COUNT_WORDS = {
  3: 'three', 4: 'four', 5: 'five', 6: 'six', 7: 'seven', 8: 'eight',
};

function upsideNewsIndexTitle(period, count) {
  const word = UPSIDE_COUNT_WORDS[count] || String(count);
  if (period === 'weekly') {
    return `This week's ${word}`;
  }
  if (period === 'monthly') {
    return "This month's picks";
  }
  if (period === 'yearly') {
    return "This year's highlights";
  }
  return `Today's ${word}`;
}

/**
 * The Upside News — index page + one story page per item (goodnews.md §5).
 * One UDP packet for the whole cycle; the client pages locally like Trivia.
 */
function buildUpsideNewsRoundPayload({
  stories = [],
  settings = {},
  indexSeconds = 12,
  storySeconds = 15,
  loops = 'once',
  loopCount = 1,
  artworkBaseUrl = '',
  device = 'Signal',
  timestamp = Date.now(),
  trigger = 'upside-news',
  triggeredBy = 'manual',
  sessionId = null,
  durationSeconds = null,
} = {}, config = {}) {
  if (!Array.isArray(stories) || !stories.length) {
    return null;
  }
  const count = Math.min(8, stories.length);
  const cards = stories.slice(0, count).map((story, index) => {
    const topic = resolveTopic(story.sectionId);
    return {
      index,
      id: story.id,
      headline: story.headline,
      standfirst: story.standfirst || '',
      sectionId: topic.id,
      sectionName: story.sectionName || topic.label,
      accent: story.accent || topic.accent,
      background: story.background || topic.background,
      publishedAt: story.publishedAt || null,
      publishedLabel: story.publishedLabel || '',
      readingMinutes: story.readingMinutes ?? null,
      byline: story.byline || '',
      sourceLabel: story.sourceLabel || 'News',
      url: story.url || story.webUrl || null,
      keywords: Array.isArray(story.keywords) ? story.keywords.slice(0, 3) : [],
      artwork: story.artwork || null,
    };
  });

  const indexSec = Math.max(6, Number(indexSeconds) || 12);
  const storySec = Math.max(8, Number(storySeconds) || 15);
  const oneCycle = indexSec + (count * storySec);
  const total = Number(durationSeconds) > 0 ? Number(durationSeconds) : oneCycle;
  const general = resolveTopic('general');
  const base = String(artworkBaseUrl || '').replace(/\/+$/, '');

  return {
    version: 2,
    type: 'upside-news.round',
    device,
    timestamp: new Date(timestamp).toISOString(),
    displaySeconds: total,
    trigger,
    upsideNews: {
      sessionId: sessionId || `upside-${new Date(timestamp).getTime()}`,
      triggeredBy,
      title: 'The Upside News',
      indexTitle: upsideNewsIndexTitle(settings.period || 'daily', count),
      period: settings.period || 'daily',
      storyCount: count,
      indexSeconds: indexSec,
      storySeconds: storySec,
      loops: loops || 'once',
      loopCount: loopCount == null ? 1 : loopCount,
      cycleSeconds: oneCycle,
      totalDurationSeconds: total,
      showQr: settings.showQr !== false,
      showReadingTime: settings.showReadingTime !== false,
      showTopicTags: settings.showTopicTags === true,
      attribution: 'Guardian Open Platform · positive news RSS',
      indexArtwork: base
        ? {
          portrait: `${base}/upside-news-artwork/${general.files.portrait}`,
          landscape: `${base}/upside-news-artwork/${general.files.landscape}`,
        }
        : null,
      indexAccent: general.accent,
      indexBackground: general.background,
      stories: cards,
    },
  };
}

const WIKI_COUNT_WORDS = {
  3: 'three', 4: 'four', 5: 'five', 6: 'six', 7: 'seven', 8: 'eight',
};

function wikiCommonKnowledgeIndexTitle(period, count) {
  const word = WIKI_COUNT_WORDS[count] || String(count);
  if (period === 'weekly') return `This week's ${word}`;
  if (period === 'monthly') return "This month's most-read";
  if (period === 'yearly') return "This year's most-read";
  return `What the world looked up — ${word}`;
}

/**
 * Wiki Common Knowledge — index page + one article page per item.
 * One UDP packet for the whole cycle; the client pages locally like Upside News.
 */
function buildWikiCommonKnowledgeRoundPayload({
  stories = [],
  settings = {},
  indexSeconds = 12,
  articleSeconds = 15,
  loops = 'once',
  loopCount = 1,
  artworkBaseUrl = '',
  device = 'Signal',
  timestamp = Date.now(),
  trigger = 'wiki-common-knowledge',
  triggeredBy = 'manual',
  sessionId = null,
  durationSeconds = null,
} = {}, config = {}) {
  if (!Array.isArray(stories) || !stories.length) {
    return null;
  }
  const count = Math.min(8, stories.length);
  const cards = stories.slice(0, count).map((story, index) => ({
    index,
    id: story.id,
    rank: story.rank || index + 1,
    title: story.title,
    description: story.description || '',
    extract: story.extract || '',
    categoryId: story.categoryId || 'misc',
    categoryName: story.categoryName || 'General',
    accent: story.accent || '#E897FF',
    background: story.background || '#7A2396',
    thumbnailUrl: story.thumbnailUrl || '',
    imageUrl: story.imageUrl || story.thumbnailUrl || '',
    contentUrl: story.contentUrl || null,
    views: story.views || 0,
    viewsDelta: story.viewsDelta || 0,
    viewsDeltaPct: story.viewsDeltaPct,
    history: Array.isArray(story.history) ? story.history.slice(-30) : [],
    artwork: story.artwork || null,
  }));

  const indexSec = Math.max(6, Number(indexSeconds) || 12);
  const articleSec = Math.max(8, Number(articleSeconds) || 15);
  const oneCycle = indexSec + (count * articleSec);
  const total = Number(durationSeconds) > 0 ? Number(durationSeconds) : oneCycle;
  const base = String(artworkBaseUrl || '').replace(/\/+$/, '');

  return {
    version: 2,
    type: 'wiki-common-knowledge.round',
    device,
    timestamp: new Date(timestamp).toISOString(),
    displaySeconds: total,
    trigger,
    wikiCommonKnowledge: {
      sessionId: sessionId || `wiki-${new Date(timestamp).getTime()}`,
      triggeredBy,
      title: 'Common Knowledge',
      indexTitle: wikiCommonKnowledgeIndexTitle(settings.period || 'daily', count),
      dateline: 'Wikipedia · most-read',
      period: settings.period || 'daily',
      storyCount: count,
      indexSeconds: indexSec,
      articleSeconds: articleSec,
      loops: loops || 'once',
      loopCount: loopCount == null ? 1 : loopCount,
      cycleSeconds: oneCycle,
      totalDurationSeconds: total,
      showQr: settings.showQr !== false,
      showSparkline: settings.showSparkline !== false,
      attribution: 'Wikipedia · Wikimedia pageviews',
      indexArtwork: base
        ? {
          topic: `${base}/wiki-common-knowledge-artwork/misc.jpg`,
          fallback: `${base}/wiki-common-knowledge-artwork/misc.jpg`,
        }
        : null,
      indexAccent: '#E897FF',
      indexBackground: '#7A2396',
      stories: cards,
    },
  };
}

/**
 * Deterministic-per-call answer order. Booleans keep True/False order so the
 * two-tile layout always reads the same way; multiple choice is shuffled so the
 * correct answer is not always in the same slot.
 */
function shuffleAnswers(question) {
  const incorrect = (question.incorrectAnswers || []).map(String);
  if (question.type === 'boolean') {
    return ['True', 'False'];
  }
  const all = [String(question.correctAnswer), ...incorrect];
  for (let i = all.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  return all;
}

/**
 * A YouTube now-playing / last-played card (youtube.md §4).
 *
 * Thumbnails and channel avatars are served from the bridge rather than
 * `i.ytimg.com`: hotlinking at render time breaks offline, adds latency to
 * every paint, and hammers Google for no reason (§6.5). The payload carries
 * only the cached filename plus the origin to fetch it from.
 */
function buildYoutubeNowPlayingPayload(video, config, {
  device = 'Signal',
  trigger = 'youtube-now-playing',
  timestamp = Date.now(),
  mode = 'playing',
  dismissible = false,
  deviceLabel = null,
  imageBaseUrl = '',
  settings = {},
  session = null,
} = {}) {
  if (!video?.videoId) {
    return null;
  }
  const playMode = mode === 'last-played' ? 'last-played' : 'playing';
  const isDismissible = Boolean(dismissible) || playMode === 'last-played';
  const base = String(imageBaseUrl || '').replace(/\/+$/, '');
  const imageUrl = (file) => (file && base ? `${base}/youtube-images/${file}` : null);
  const isLive = video.liveBroadcastContent === 'live' || video.liveBroadcastContent === 'upcoming';

  const seconds = Number(settings.dismissSeconds) > 0
    ? Math.round(Number(settings.dismissSeconds))
    : displaySeconds(config);

  return {
    version: 2,
    type: 'youtube.now-playing',
    device,
    timestamp: new Date(timestamp).toISOString(),
    displaySeconds: isDismissible ? seconds : 0,
    persistent: !isDismissible,
    trigger,
    youtube: {
      videoId: video.videoId,
      mode: playMode,
      title: video.title || 'YouTube',
      // Already cleaned and cached by the API client; the client only clamps.
      description: settings.showDescription === false ? '' : (video.descriptionClean || ''),
      descriptionLines: Number(settings.descriptionLines) || 3,
      channelTitle: video.channelTitle || '',
      // Hidden counts are omitted entirely rather than shown as zero (§4.5).
      subscriberCount: settings.showSubscribers === false || video.hiddenSubscriberCount
        ? null
        : (video.subscriberCount ?? null),
      viewCount: video.viewCount ?? null,
      likeCount: video.likeCount ?? null,
      dislikeCount: settings.showDislikes === false ? null : (video.dislikeCount ?? null),
      // RYD is archived data plus extrapolation — never present it as hard.
      dislikeEstimated: video.dislikeCount != null,
      publishedAt: video.publishedAt || null,
      durationSeconds: Math.round(Number(video.durationSeconds) || 0),
      live: isLive,
      liveBroadcastContent: video.liveBroadcastContent || 'none',
      concurrentViewers: isLive ? (video.concurrentViewers ?? null) : null,
      metadataMissing: Boolean(video.missing),
      thumbnailUrl: imageUrl(video.thumbnailFile),
      thumbnailWidth: video.thumbnailWidth || null,
      thumbnailHeight: video.thumbnailHeight || null,
      avatarUrl: imageUrl(video.avatarFile),
      deviceLabel: deviceLabel || null,
      positionSeconds: playMode === 'playing'
        ? Math.round(Number(session?.positionSeconds) || 0)
        : Math.round(Number(session?.positionSeconds) || 0) || null,
      // Last-played mockup is "Watched 24:10 of 28:31" — that is scrubber
      // progress through the video, not the pause-aware attention total.
      watchedSeconds: playMode === 'last-played'
        ? Math.round(
          Number(session?.positionSeconds)
            || Number(session?.watchedSeconds)
            || 0,
        )
        : null,
      completed: playMode === 'last-played' ? Boolean(session?.completed) : null,
      startedAt: session?.startedAt || new Date(timestamp).toISOString(),
      endedAt: session?.endedAt || null,
    },
  };
}

function buildYoutubeNowPlayingClosePayload({
  device = 'Signal',
  trigger = 'youtube-now-playing-close',
  timestamp = Date.now(),
} = {}, _config) {
  return {
    version: 2,
    type: 'youtube.now-playing.close',
    device,
    timestamp: new Date(timestamp).toISOString(),
    displaySeconds: 0,
    trigger,
  };
}

/**
 * Overhead flight radar — initial round with settings + aircraft list.
 */
function buildOverheadRoundPayload({
  settings = {},
  home = {},
  aircraft = [],
  routes = {},
  sessionId = null,
  loops = 'once',
  loopCount = 1,
  cycleSeconds = null,
  durationSeconds = null,
  geoBaseUrl = '',
  device = 'Signal',
  timestamp = Date.now(),
  trigger = 'overhead',
  triggeredBy = 'manual',
} = {}, config = {}) {
  const list = Array.isArray(aircraft) ? aircraft : [];
  const total = Number(durationSeconds) > 0
    ? Number(durationSeconds)
    : displaySeconds(config);
  const base = String(geoBaseUrl || '').replace(/\/+$/, '');

  return {
    version: 2,
    type: 'overhead.round',
    device,
    timestamp: new Date(timestamp).toISOString(),
    displaySeconds: total,
    trigger,
    overhead: {
      sessionId: sessionId || `overhead-${new Date(timestamp).getTime()}`,
      triggeredBy,
      title: 'Overhead',
      clearSkies: list.length === 0,
      aircraftCount: list.length,
      home: {
        lat: home.lat,
        lon: home.lon,
        name: home.name || 'Home',
      },
      radiusNm: Number(settings.radiusNm) || 40,
      pageSeconds: Number(settings.pageSeconds) || 8,
      rowsPerPage: settings.rowsPerPage || 'auto',
      maxPages: Number(settings.maxPages) || 6,
      loops: loops || 'once',
      loopCount: loopCount == null ? 1 : loopCount,
      cycleSeconds: Number(cycleSeconds) > 0 ? Number(cycleSeconds) : total,
      totalDurationSeconds: total,
      sort: settings.sort || 'nearest',
      showRoutes: settings.showRoutes !== false,
      mapStyle: settings.mapStyle || 'scope',
      provider: settings.provider || 'airplanes-live',
      refreshSeconds: Number(settings.refreshSeconds) || 5,
      settings: {
        radiusNm: Number(settings.radiusNm) || 40,
        refreshSeconds: Number(settings.refreshSeconds) || 5,
        rowsPerPage: settings.rowsPerPage || 'auto',
        pageSeconds: Number(settings.pageSeconds) || 8,
        maxPages: Number(settings.maxPages) || 6,
        loops: settings.loops || 'once',
        sort: settings.sort || 'nearest',
        altitudeFloorFt: Number(settings.altitudeFloorFt) || 0,
        includeGround: settings.includeGround === true,
        showRoutes: settings.showRoutes !== false,
        mapStyle: settings.mapStyle || 'scope',
      },
      aircraft: list,
      routes: routes || {},
      geo: base
        ? {
          homeArea: `${base}/overhead-geo/home-area.json`,
          airports: `${base}/overhead-geo/airports.json`,
        }
        : null,
    },
  };
}

function buildOverheadUpdatePayload({
  sessionId,
  aircraft = [],
  routes = {},
  device = 'Signal',
  timestamp = Date.now(),
  trigger = 'overhead-update',
} = {}, _config) {
  if (!sessionId) return null;
  return {
    version: 2,
    type: 'overhead.update',
    device,
    timestamp: new Date(timestamp).toISOString(),
    displaySeconds: 0,
    persistent: true,
    trigger,
    overhead: {
      sessionId,
      aircraft: Array.isArray(aircraft) ? aircraft : [],
      routes: routes || {},
    },
  };
}

function buildOverheadClosePayload({
  sessionId,
  device = 'Signal',
  timestamp = Date.now(),
  trigger = 'overhead-close',
} = {}, _config) {
  if (!sessionId) return null;
  return {
    version: 2,
    type: 'overhead.close',
    device,
    timestamp: new Date(timestamp).toISOString(),
    displaySeconds: 0,
    trigger,
    overhead: {
      sessionId,
    },
  };
}

module.exports = {
  buildTriviaRoundPayload,
  buildUpsideNewsRoundPayload,
  buildWikiCommonKnowledgeRoundPayload,
  buildOverheadRoundPayload,
  buildOverheadUpdatePayload,
  buildOverheadClosePayload,
  buildYoutubeNowPlayingPayload,
  buildYoutubeNowPlayingClosePayload,
  buildBroadcastPayload,
  buildTimeQueryPayload,
  buildWeatherQueryPayload,
  buildIndoorTemperaturePayload,
  buildAirQualityPayload,
  buildShoppingListPayload,
  buildMusicPayload,
  buildTeslaBatteryPayload,
  buildTeslaDashboardPayload,
  buildVivintAlarmPayload,
  buildNotificationsPayload,
  buildSmartHomePayload,
  buildProcessingAckPayload,
  buildWebOpenPayload,
  buildWebClosePayload,
  buildSystemCommandPayload,
  buildDisplayDiscoverPayload,
  buildDisplayAuthPinPayload,
  buildDisplayAuthOkPayload,
  buildInputPointerPayload,
  buildInputKeyPayload,
  buildInputTextPayload,
  buildPhotoSlideshowPayload,
  buildGameLibraryTourPayload,
  thinLibraryTourGame,
  buildRoutePlannerPayload,
  buildTimerSnapshotPayload,
  buildAlarmSnapshotPayload,
  buildQrDisplayPayload,
  buildGuestPhotoboothPayload,
  buildSteamNowPlayingPayload,
  buildSteamNowPlayingClosePayload,
  buildPsnNowPlayingPayload,
  buildPsnNowPlayingClosePayload,
  buildWifiQrContent,
  displaySeconds,
  timerDisplaySeconds,
  alarmDisplaySeconds,
};
