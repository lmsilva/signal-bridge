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
};

function buildProcessingAckPayload(event, config) {
  const info = SLOW_REQUEST_INFO[event.kind];
  if (!info) {
    return null;
  }

  return {
    version: 2,
    type: 'request.processing',
    device: event.device,
    timestamp: new Date(event.timestamp || Date.now()).toISOString(),
    // Ceiling covers the timeout plus ~15s for the failure state to be read
    // before the overlay dismisses itself; the real payload replaces this
    // placeholder long before then in the normal case.
    displaySeconds: PROCESSING_ACK_TIMEOUT_SEC + 15,
    trigger: 'processing-ack',
    kind: event.kind,
    query: event.query,
    request: {
      title: info.title,
      source: info.source,
      timeoutSeconds: PROCESSING_ACK_TIMEOUT_SEC,
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

function buildInputKeyPayload({
  key,
  modifiers = [],
  action = 'press',
  device,
  timestamp,
  trigger,
} = {}) {
  const normalizedKey = String(key || '').trim();
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

const QR_TYPES = new Set(['url', 'wifi']);

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

// Shared photo slideshow: cycles the photos currently in the QR image cache
// (anything uploaded through "QR Code → Photo" in the last qrImage.cacheDays,
// 7 by default) at `secondsPerPhoto` each. displaySeconds spans the whole
// pass through the list so the overlay does not auto-dismiss partway
// through — a fresh UDP payload (any type) still interrupts it immediately,
// same as every other overlay.
function buildPhotoSlideshowPayload({
  photos,
  secondsPerPhoto = 5,
  device,
  timestamp,
  trigger,
} = {}) {
  const list = (Array.isArray(photos) ? photos : [])
    .map((url) => String(url || '').trim())
    .filter(Boolean);
  if (!list.length) {
    return null;
  }
  const perPhoto = Math.max(1, Number(secondsPerPhoto) || 5);

  return {
    version: 2,
    type: 'photo.slideshow',
    device: device || 'Signal',
    timestamp: new Date(timestamp || Date.now()).toISOString(),
    displaySeconds: list.length * perPhoto,
    trigger: trigger || 'photo-slideshow-api',
    slideshow: {
      photos: list,
      secondsPerPhoto: perPhoto,
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

module.exports = {
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
  buildTimerSnapshotPayload,
  buildAlarmSnapshotPayload,
  buildQrDisplayPayload,
  buildWifiQrContent,
  displaySeconds,
  timerDisplaySeconds,
  alarmDisplaySeconds,
};
