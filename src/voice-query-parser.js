const { getActivityId, getDeviceName } = require('./parser');
const { extractActivityFields } = require('./activity-fields');
const { matchesIndoorQuery } = require('./indoor-temperature');
const { matchesAirQualityQuery } = require('./air-quality');
const { matchesShoppingListQuery, shoppingListTrigger } = require('./shopping-list');
const {
  matchesMusicQuery,
  matchesNowPlayingQuery,
  matchesMusicSkipQuery,
} = require('./music-info');
const { matchesRouteQuery, looksLikeRouteQuery } = require('./route-query');
const { matchesTeslaBatteryQuery } = require('./tesla-battery');
const { matchesTeslaDashboardQuery } = require('./tesla-dashboard');
const {
  matchesGuestPhotoboothQuery,
  matchesGuestSnapsSlideshowQuery,
} = require('./guest-photobooth');
const {
  matchesTriviaQuery,
  matchesSteamLibraryTourQuery,
  matchesPsnLibraryTourQuery,
  matchesSteamNowPlayingQuery,
  matchesPsnNowPlayingQuery,
  matchesYoutubeNowPlayingQuery,
  matchesAutodartsDashboardQuery,
  matchesAutodartsNowQuery,
} = require('./display-voice-commands');
const { matchesVivintAlarmQuery } = require('./vivint-alarm');
const {
  matchesNotificationsQuery,
  matchesPassiveAmazonDeliveryNotification,
  isNotificationDismissal,
} = require('./alexa-notifications');
const {
  matchesShowAlarmsQuery,
  matchesAlarmSetQuery,
  matchesAlarmCancelQuery,
} = require('./alexa-alarms');
const {
  matchesReminderSetQuery,
  matchesReminderCancelQuery,
  matchesReminderFiredSpeech,
  extractReminderLabel,
} = require('./alexa-reminders');
const { parseSmartHomeCommand } = require('./smart-home-command');

const TIME_QUERY_RE = /\b(?:what(?:'s|\s+is|\s+was)?\s+(?:the\s+)?time(?:\s+is\s+it)?|tell\s+me\s+(?:the\s+)?time|do\s+you\s+have\s+(?:the\s+)?time|time\s+please)\b/i;
const WEATHER_QUERY_RE = /\b(?:what(?:'s|\s+is)?\s+(?:the\s+)?(?:weather(?:\s+like)?|temperature|temp|forecast)|how(?:'s|\s+is)\s+(?:the\s+)?(?:weather|temperature|temp)|weather\s+(?:in|for|at|outside|today|tomorrow)|(?:is\s+it|will\s+it)\s+(?:rain|snow|sunny|cloudy|cold|hot|warm)|temperature(?:\s+outside|\s+today|\s+now|\s+in|\s+for|\s+at)?|how\s+(?:hot|cold|warm)\s+is\s+it|tell\s+me\s+(?:the\s+)?(?:weather|temperature|temp)|give\s+me\s+(?:the\s+)?(?:weather|temperature|temp)|what\s+is\s+it\s+like\s+outside)\b/i;
const WEATHER_ANSWER_RE = /\b(?:(?:it's|it is|currently|right now|today|tonight).*(?:\d{1,3}\s+degrees|sunny|cloudy|rain|snow|wind|humidity|fahrenheit|celsius)|(?:\d{1,3}\s+degrees)\s+and\s+(?:sunny|cloudy|rainy|snowy|windy))\b/i;
const SHOW_TIMERS_RE = /\b(?:show|list)\s+(?:me\s+)?(?:all\s+|my\s+)*timers?\b|\bwhat (?:are my timers|timers do i have)\b|\bhow much time is left on(?: my)? timers?\b/i;
const TIMER_SET_RE = /\b(?:set|start|create|add)\b(?:(?!\btime\b).)*\b(?:timer|countdown)\b|\b(?:timer|countdown)\s+(?:for|to)\s+(?:\d|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\b|\b(?:set|start|create|add)\s+(?:a\s+)?(?:(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:hour|minute|second|min|sec|hr)s?\s*)+(?:timer|countdown)\b|\b(?:set|start)\s+(?:a\s+)?(?:timer|countdown)\s+(?:for\s+)?(?:(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:hour|minute|second|min|sec|hr)s?\s*)+|\b(?:set|start|create|add)\s+(?:a\s+)?(?:(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:hour|minute|second|min|sec|hr)s?\s*)+alarm\b/i;
const TIMER_SET_SPOKEN_RE = /\b(?:(?:starting|counting)\s+(?:now|down)|(?:timer|countdown|alarm)\s+(?:is\s+)?(?:set|started|on)|starting\s+(?:a|your)\s+\d|\d\s+(?:minute|min|hour|hr|second|sec)s?\s+(?:timer|countdown|alarm)\s+((?:starting|set)))\b/i;
const TIMER_CANCEL_RE = /\b(?:cancel|stop|delete|clear|remove)(?:\s+(?:the|my|all|a|an))?(?:\s+\S+){0,3}\s+(?:timers?|countdowns?)\b|\bcancel\s+all\b/i;
// Some Alexa activity records leave description.summary empty for bare
// command utterances and only populate the spoken confirmation (e.g.
// "Cancelling your 5 minute timer." / "Your timer has been cancelled.").
// Match either word order so a cancel command isn't silently dropped just
// because the transcript itself never made it into the activity record.
const TIMER_CANCEL_RESPONSE_RE = /\b(?:cancel(?:l?ed|ling)?|stopp?(?:ed|ing)?|clear(?:ed|ing)?|remov(?:ed|ing))\b(?:(?![.!?]).){0,40}\btimers?\b|\btimers?\b(?:(?!\.).){0,40}\b(?:cancel(?:l?ed)?|stopped|cleared|removed)\b/i;

function normalizeText(value) {
  return String(value || '')
    .replace(/[\u2018\u2019\u2032`´]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function matchesWeatherQuery(summary, response) {
  if (matchesIndoorQuery(summary, response)) {
    return false;
  }
  // Indoor AQ answers (and IAQ score lines) must not fall through to outdoor
  // weather — history often delivers them as empty-summary TTS right after
  // "what's the indoor air quality", which would replace the AQ overlay.
  if (matchesAirQualityQuery(summary, response)) {
    return false;
  }
  if (/\b(?:air\s*quality|out\s+of\s+100)\b/i.test(String(response || ''))) {
    return false;
  }

  if (WEATHER_QUERY_RE.test(summary || '')) {
    return true;
  }
  if (WEATHER_QUERY_RE.test(response || '')) {
    return true;
  }
  if (!summary && response && WEATHER_ANSWER_RE.test(response)) {
    return true;
  }
  return false;
}

function createVoiceQueryParser({ routineIndex = null } = {}) {
  const processedIds = new Set();

  function shouldProcess(activityId) {
    if (!activityId || processedIds.has(activityId)) {
      return false;
    }
    return true;
  }

  function markProcessed(activityId) {
    if (activityId) {
      processedIds.add(activityId);
    }
  }

  function eventBase(activity, fields, query) {
    return {
      activityId: getActivityId(activity),
      device: getDeviceName(activity),
      deviceSerial: activity?.deviceSerialNumber || activity?.serialNumber || null,
      timestamp: activity?.creationTimestamp || Date.now(),
      query: query || fields.summary || fields.allText || '',
      spokenResponse: fields.response || null,
    };
  }

  function parse(activity) {
    const fields = extractActivityFields(activity);
    const summary = fields.summary;
    const response = fields.response;
    // Customer/misc phrase for matchers — never the TTS-only allText blob
    // (that would break empty-summary + spoken-answer fallbacks).
    const matchSummary = summary || fields.miscText || '';
    const device = getDeviceName(activity);
    const deviceSerial = activity?.deviceSerialNumber || activity?.serialNumber || null;
    const activityId = getActivityId(activity);
    const timestamp = activity?.creationTimestamp || Date.now();

    if (!summary && !response && !fields.allText) {
      return null;
    }

    if (matchesShoppingListQuery(matchSummary, response)) {
      return {
        kind: 'shopping-list',
        activityId,
        device,
        deviceSerial,
        timestamp,
        query: summary || matchSummary,
        spokenResponse: response || null,
        trigger: shoppingListTrigger(matchSummary, response),
      };
    }

    if (matchesTeslaDashboardQuery(matchSummary, response)) {
      return {
        kind: 'tesla-dashboard',
        activityId,
        device,
        deviceSerial,
        timestamp,
        query: summary || matchSummary,
        spokenResponse: response || null,
        trigger: 'tesla-dashboard-query',
      };
    }

    if (matchesTeslaBatteryQuery(matchSummary, response)) {
      return {
        kind: 'tesla-battery',
        activityId,
        device,
        deviceSerial,
        timestamp,
        query: summary || matchSummary,
        spokenResponse: response || null,
        trigger: 'tesla-battery-query',
      };
    }

    // Slideshow before dual-QR welcome — "open guest snaps slideshow"
    // also contains the "guest snaps" brand phrase.
    if (matchesGuestSnapsSlideshowQuery(matchSummary, response)) {
      return {
        kind: 'photo-slideshow',
        activityId,
        device,
        deviceSerial,
        timestamp,
        query: summary || matchSummary,
        spokenResponse: response || null,
        trigger: 'guest-snaps-slideshow-query',
        // Party slideshow fans out to every known display.
        targetId: '*',
      };
    }

    if (matchesGuestPhotoboothQuery(matchSummary, response)) {
      return {
        kind: 'guest-photobooth',
        activityId,
        device,
        deviceSerial,
        timestamp,
        query: summary || matchSummary,
        spokenResponse: response || null,
        trigger: 'guest-photobooth-query',
        // Always fan out to every known display (party welcome screen).
        targetId: '*',
      };
    }

    // Platform overlays before music "now playing" — "Steam Now Playing" must
    // not fall through to Alexa music.card.
    if (matchesTriviaQuery(matchSummary, response)) {
      return {
        kind: 'trivia',
        activityId,
        device,
        deviceSerial,
        timestamp,
        query: summary || matchSummary,
        spokenResponse: response || null,
        trigger: 'trivia-query',
      };
    }

    if (matchesSteamLibraryTourQuery(matchSummary, response)) {
      return {
        kind: 'steam-library-tour',
        activityId,
        device,
        deviceSerial,
        timestamp,
        query: summary || matchSummary,
        spokenResponse: response || null,
        trigger: 'steam-library-tour-query',
      };
    }

    if (matchesPsnLibraryTourQuery(matchSummary, response)) {
      return {
        kind: 'psn-library-tour',
        activityId,
        device,
        deviceSerial,
        timestamp,
        query: summary || matchSummary,
        spokenResponse: response || null,
        trigger: 'psn-library-tour-query',
      };
    }

    if (matchesSteamNowPlayingQuery(matchSummary, response)) {
      return {
        kind: 'steam-now-playing',
        activityId,
        device,
        deviceSerial,
        timestamp,
        query: summary || matchSummary,
        spokenResponse: response || null,
        trigger: 'steam-now-playing-query',
      };
    }

    if (matchesPsnNowPlayingQuery(matchSummary, response)) {
      return {
        kind: 'psn-now-playing',
        activityId,
        device,
        deviceSerial,
        timestamp,
        query: summary || matchSummary,
        spokenResponse: response || null,
        trigger: 'psn-now-playing-query',
      };
    }

    if (matchesYoutubeNowPlayingQuery(matchSummary, response)) {
      return {
        kind: 'youtube-now-playing',
        activityId,
        device,
        deviceSerial,
        timestamp,
        query: summary || matchSummary,
        spokenResponse: response || null,
        trigger: 'youtube-now-playing-query',
      };
    }

    if (matchesAutodartsDashboardQuery(matchSummary, response)) {
      return {
        kind: 'autodarts-dashboard',
        activityId,
        device,
        deviceSerial,
        timestamp,
        query: summary || matchSummary,
        spokenResponse: response || null,
        trigger: 'autodarts-dashboard-query',
      };
    }

    if (matchesAutodartsNowQuery(matchSummary, response)) {
      return {
        kind: 'autodarts-now',
        activityId,
        device,
        deviceSerial,
        timestamp,
        query: summary || matchSummary,
        spokenResponse: response || null,
        trigger: 'autodarts-now-query',
      };
    }

    if (matchesVivintAlarmQuery(matchSummary, response)) {
      return {
        kind: 'vivint-alarm',
        activityId,
        device,
        deviceSerial,
        timestamp,
        query: summary || matchSummary,
        spokenResponse: response || null,
        trigger: 'vivint-alarm-query',
      };
    }

    if (matchesNotificationsQuery(matchSummary, response)) {
      return {
        kind: 'alexa-notifications',
        activityId,
        device,
        deviceSerial,
        timestamp,
        query: summary || matchSummary,
        spokenResponse: response || null,
        trigger: 'alexa-notifications-query',
      };
    }

    if (matchesPassiveAmazonDeliveryNotification(matchSummary, response)) {
      if (isNotificationDismissal(response)) {
        return null;
      }
      return {
        kind: 'alexa-notifications',
        activityId,
        device,
        deviceSerial,
        timestamp,
        query: response || matchSummary,
        spokenResponse: response || null,
        trigger: 'amazon-delivery-passive',
      };
    }

    const smartHomeCommand = parseSmartHomeCommand(matchSummary);
    if (smartHomeCommand) {
      return {
        kind: 'smart-home',
        activityId,
        device,
        deviceSerial,
        timestamp,
        query: summary || matchSummary,
        spokenResponse: response || null,
        trigger: 'smart-home-command',
        command: smartHomeCommand,
      };
    }

    if (matchesMusicQuery(matchSummary, response)) {
      return {
        kind: 'music',
        activityId,
        device,
        deviceSerial,
        timestamp,
        query: summary || matchSummary,
        spokenResponse: response || null,
        trigger: 'music-play',
      };
    }

    // "next" / "skip" — advance track, then show the new song (listener
    // gates out news/flash-briefing via player-info).
    if (matchesMusicSkipQuery(matchSummary)) {
      return {
        kind: 'music',
        activityId,
        device,
        deviceSerial,
        timestamp,
        query: summary || matchSummary,
        spokenResponse: response || null,
        trigger: 'music-skip',
      };
    }

    // "what song is playing" etc. — music is already playing, just show
    // what's currently on instead of starting anything new.
    if (matchesNowPlayingQuery(matchSummary, response)) {
      return {
        kind: 'music',
        activityId,
        device,
        deviceSerial,
        timestamp,
        query: summary || matchSummary || 'what\'s playing',
        spokenResponse: response || null,
        trigger: 'music-query',
      };
    }

    if (matchesRouteQuery(matchSummary, response) || looksLikeRouteQuery(matchSummary)) {
      return {
        kind: 'route',
        activityId,
        device,
        deviceSerial,
        timestamp,
        // Distance skills often omit ASR (NO_TEXT_OR_AUDIO_STORED) and only
        // leave TTS — keep the spoken answer as the query for logs/extract.
        query: summary || matchSummary || response || 'route query',
        spokenResponse: response || null,
        trigger: 'route-query',
      };
    }

    if (matchesAirQualityQuery(matchSummary, response)) {
      return {
        kind: 'air-quality',
        activityId,
        device,
        timestamp,
        query: summary || matchSummary || 'air quality query',
        spokenResponse: response || null,
        trigger: 'air-quality-query',
      };
    }

    if (matchesIndoorQuery(matchSummary, response)) {
      return {
        kind: 'indoor-temperature',
        activityId,
        device,
        timestamp,
        query: summary || matchSummary || 'indoor temperature query',
        spokenResponse: response || null,
        trigger: 'indoor-temperature-query',
      };
    }

    if (matchesWeatherQuery(matchSummary, response)) {
      return {
        kind: 'weather',
        activityId,
        device,
        timestamp,
        query: summary || matchSummary || 'weather query',
        spokenResponse: response || null,
        trigger: 'weather-query',
      };
    }

    if (SHOW_TIMERS_RE.test(matchSummary)) {
      return {
        kind: 'timer-list',
        activityId,
        device,
        timestamp,
        query: summary || matchSummary,
        spokenResponse: response || null,
        trigger: 'show-timers',
      };
    }

    if (matchesShowAlarmsQuery(matchSummary)) {
      return {
        kind: 'alarm-list',
        activityId,
        device,
        timestamp,
        query: summary || matchSummary,
        spokenResponse: response || null,
        trigger: 'show-alarms',
      };
    }

    if (matchesAlarmCancelQuery(matchSummary)) {
      return {
        kind: 'alarm-hint',
        activityId,
        device,
        timestamp,
        query: summary || matchSummary,
        spokenResponse: response || null,
        trigger: 'alarm-cancel-voice',
      };
    }

    if (matchesReminderCancelQuery(matchSummary, response)) {
      return {
        kind: 'reminder-hint',
        activityId,
        device,
        timestamp,
        query: summary || matchSummary || 'cancel reminder',
        spokenResponse: response || null,
        reminderLabel: extractReminderLabel(summary || response),
        trigger: 'reminder-cancel-voice',
      };
    }

    if (TIMER_CANCEL_RE.test(matchSummary) || TIMER_CANCEL_RESPONSE_RE.test(response)) {
      return {
        kind: 'timer-hint',
        activityId,
        device,
        timestamp,
        query: summary || matchSummary,
        spokenResponse: response || null,
        trigger: 'timer-cancel-voice',
      };
    }

    if (matchesAlarmSetQuery(matchSummary, response)) {
      return {
        kind: 'alarm-hint',
        activityId,
        device,
        timestamp,
        query: summary || matchSummary,
        spokenResponse: response || null,
        trigger: 'alarm-set-voice',
      };
    }

    if (
      TIMER_SET_RE.test(matchSummary)
      || (/\b(?:timer|countdown|alarm)\b/i.test(matchSummary) && TIMER_SET_SPOKEN_RE.test(response))
    ) {
      return {
        kind: 'timer-hint',
        activityId,
        device,
        timestamp,
        query: summary || matchSummary,
        spokenResponse: response || null,
        trigger: 'timer-set-voice',
      };
    }

    if (matchesReminderSetQuery(matchSummary, response)) {
      return {
        kind: 'reminder-hint',
        activityId,
        device,
        timestamp,
        query: summary || matchSummary || 'set reminder',
        spokenResponse: response || null,
        reminderLabel: extractReminderLabel(summary || response),
        trigger: 'reminder-set-voice',
      };
    }

    if (matchesReminderFiredSpeech(matchSummary, response)) {
      const label = extractReminderLabel(response || matchSummary);
      return {
        kind: 'reminder-fired',
        activityId,
        device,
        timestamp,
        query: label || summary || matchSummary || 'reminder',
        spokenResponse: response || null,
        reminderLabel: label,
        trigger: 'reminder-fire-voice',
      };
    }

    if (TIME_QUERY_RE.test(matchSummary)) {
      return {
        kind: 'time',
        activityId,
        device,
        timestamp,
        query: summary || matchSummary,
        spokenResponse: response || null,
        trigger: 'time-query',
      };
    }

    // App-launched routines: match catalog phrases / Sent to Display fallback.
    const routineHit = routineIndex?.resolve?.(fields);
    if (routineHit?.kind) {
      const base = eventBase(activity, fields, routineHit.matchedPhrase || summary);
      const trigger = routineHit.source || 'routine-index';
      if (routineHit.kind === 'photo-slideshow') {
        return { ...base, kind: 'photo-slideshow', trigger, targetId: '*' };
      }
      if (routineHit.kind === 'guest-photobooth') {
        return { ...base, kind: 'guest-photobooth', trigger, targetId: '*' };
      }
      if (routineHit.kind === 'shopping-list') {
        return {
          ...base,
          kind: 'shopping-list',
          trigger: shoppingListTrigger(base.query, response) || trigger,
        };
      }
      return {
        ...base,
        kind: routineHit.kind,
        trigger,
      };
    }

    return null;
  }

  return {
    parse,
    shouldProcess,
    markProcessed,
    TIME_QUERY_RE,
    WEATHER_QUERY_RE,
    SHOW_TIMERS_RE,
    TIMER_SET_RE,
  };
}

module.exports = {
  createVoiceQueryParser,
  TIME_QUERY_RE,
  WEATHER_QUERY_RE,
  WEATHER_ANSWER_RE,
  matchesWeatherQuery,
  SHOW_TIMERS_RE,
  TIMER_SET_RE,
  TIMER_CANCEL_RE,
};
