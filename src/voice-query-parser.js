const { getActivityId, getDeviceName } = require('./parser');
const { extractSpokenResponse } = require('./activity-response');
const { matchesIndoorQuery } = require('./indoor-temperature');
const { matchesAirQualityQuery } = require('./air-quality');
const { matchesShoppingListQuery, shoppingListTrigger } = require('./shopping-list');
const { matchesMusicQuery } = require('./music-info');
const { matchesTeslaBatteryQuery } = require('./tesla-battery');
const { matchesVivintAlarmQuery } = require('./vivint-alarm');
const { matchesNotificationsQuery } = require('./alexa-notifications');
const {
  matchesShowAlarmsQuery,
  matchesAlarmSetQuery,
  matchesAlarmCancelQuery,
} = require('./alexa-alarms');
const { parseSmartHomeCommand } = require('./smart-home-command');

const TIME_QUERY_RE = /\b(?:what(?:'s|\s+is|\s+was)?\s+(?:the\s+)?time(?:\s+is\s+it)?|tell\s+me\s+(?:the\s+)?time|do\s+you\s+have\s+(?:the\s+)?time|time\s+please)\b/i;
const WEATHER_QUERY_RE = /\b(?:what(?:'s|\s+is)?\s+(?:the\s+)?(?:weather(?:\s+like)?|temperature|temp|forecast)|how(?:'s|\s+is)\s+(?:the\s+)?(?:weather|temperature|temp)|weather\s+(?:in|for|at|outside|today|tomorrow)|(?:is\s+it|will\s+it)\s+(?:rain|snow|sunny|cloudy|cold|hot|warm)|temperature(?:\s+outside|\s+today|\s+now|\s+in|\s+for|\s+at)?|how\s+(?:hot|cold|warm)\s+is\s+it|tell\s+me\s+(?:the\s+)?(?:weather|temperature|temp)|give\s+me\s+(?:the\s+)?(?:weather|temperature|temp)|what\s+is\s+it\s+like\s+outside)\b/i;
const WEATHER_ANSWER_RE = /\b(?:(?:it's|it is|currently|right now|today|tonight).*(?:\d{1,3}\s+degrees|sunny|cloudy|rain|snow|wind|humidity|fahrenheit|celsius)|(?:\d{1,3}\s+degrees)\s+and\s+(?:sunny|cloudy|rainy|snowy|windy))\b/i;
const SHOW_TIMERS_RE = /\b(?:show|list)\s+(?:me\s+)?(?:all\s+|my\s+)*timers?\b|\bwhat (?:are my timers|timers do i have)\b|\bhow much time is left on(?: my)? timers?\b/i;
const TIMER_SET_RE = /\b(?:set|start|create|add)\b(?:(?!\btime\b).)*\b(?:timer|countdown)\b|\b(?:timer|countdown)\s+(?:for|to)\s+(?:\d|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\b|\b(?:set|start|create|add)\s+(?:a\s+)?(?:(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:hour|minute|second|min|sec|hr)s?\s*)+(?:timer|countdown)\b|\b(?:set|start)\s+(?:a\s+)?(?:timer|countdown)\s+(?:for\s+)?(?:(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:hour|minute|second|min|sec|hr)s?\s*)+|\b(?:set|start|create|add)\s+(?:a\s+)?(?:(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:hour|minute|second|min|sec|hr)s?\s*)+alarm\b/i;
const TIMER_SET_SPOKEN_RE = /\b(?:(?:starting|counting)\s+(?:now|down)|(?:timer|countdown|alarm)\s+(?:is\s+)?(?:set|started|on)|starting\s+(?:a|your)\s+\d|\d\s+(?:minute|min|hour|hr|second|sec)s?\s+(?:timer|countdown|alarm)\s+((?:starting|set)))\b/i;
const TIMER_CANCEL_RE = /\b(?:cancel|stop|delete|clear|remove)(?:\s+(?:the|my|all|a|an))?(?:\s+\S+){0,3}\s+(?:timers?|countdowns?)\b|\bcancel\s+all\b/i;

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

function createVoiceQueryParser() {
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

  function parse(activity) {
    const summary = normalizeText(activity?.description?.summary);
    const response = extractSpokenResponse(activity);
    const device = getDeviceName(activity);
    const deviceSerial = activity?.deviceSerialNumber || activity?.serialNumber || null;
    const activityId = getActivityId(activity);
    const timestamp = activity?.creationTimestamp || Date.now();

    if (!summary && !response) {
      return null;
    }

    if (matchesShoppingListQuery(summary, response)) {
      return {
        kind: 'shopping-list',
        activityId,
        device,
        deviceSerial,
        timestamp,
        query: summary,
        spokenResponse: response || null,
        trigger: shoppingListTrigger(summary, response),
      };
    }

    if (matchesTeslaBatteryQuery(summary, response)) {
      return {
        kind: 'tesla-battery',
        activityId,
        device,
        deviceSerial,
        timestamp,
        query: summary,
        spokenResponse: response || null,
        trigger: 'tesla-battery-query',
      };
    }

    if (matchesVivintAlarmQuery(summary, response)) {
      return {
        kind: 'vivint-alarm',
        activityId,
        device,
        deviceSerial,
        timestamp,
        query: summary,
        spokenResponse: response || null,
        trigger: 'vivint-alarm-query',
      };
    }

    if (matchesNotificationsQuery(summary, response)) {
      return {
        kind: 'alexa-notifications',
        activityId,
        device,
        deviceSerial,
        timestamp,
        query: summary,
        spokenResponse: response || null,
        trigger: 'alexa-notifications-query',
      };
    }

    const smartHomeCommand = parseSmartHomeCommand(summary);
    if (smartHomeCommand) {
      return {
        kind: 'smart-home',
        activityId,
        device,
        deviceSerial,
        timestamp,
        query: summary,
        spokenResponse: response || null,
        trigger: 'smart-home-command',
        command: smartHomeCommand,
      };
    }

    if (matchesMusicQuery(summary, response)) {
      return {
        kind: 'music',
        activityId,
        device,
        deviceSerial,
        timestamp,
        query: summary,
        spokenResponse: response || null,
        trigger: 'music-play',
      };
    }

    if (matchesAirQualityQuery(summary, response)) {
      return {
        kind: 'air-quality',
        activityId,
        device,
        timestamp,
        query: summary || 'air quality query',
        spokenResponse: response || null,
        trigger: 'air-quality-query',
      };
    }

    if (matchesIndoorQuery(summary, response)) {
      return {
        kind: 'indoor-temperature',
        activityId,
        device,
        timestamp,
        query: summary || 'indoor temperature query',
        spokenResponse: response || null,
        trigger: 'indoor-temperature-query',
      };
    }

    if (matchesWeatherQuery(summary, response)) {
      return {
        kind: 'weather',
        activityId,
        device,
        timestamp,
        query: summary || 'weather query',
        spokenResponse: response || null,
        trigger: 'weather-query',
      };
    }

    if (SHOW_TIMERS_RE.test(summary)) {
      return {
        kind: 'timer-list',
        activityId,
        device,
        timestamp,
        query: summary,
        spokenResponse: response || null,
        trigger: 'show-timers',
      };
    }

    if (matchesShowAlarmsQuery(summary)) {
      return {
        kind: 'alarm-list',
        activityId,
        device,
        timestamp,
        query: summary,
        spokenResponse: response || null,
        trigger: 'show-alarms',
      };
    }

    if (matchesAlarmCancelQuery(summary)) {
      return {
        kind: 'alarm-hint',
        activityId,
        device,
        timestamp,
        query: summary,
        spokenResponse: response || null,
        trigger: 'alarm-cancel-voice',
      };
    }

    if (TIMER_CANCEL_RE.test(summary)) {
      return {
        kind: 'timer-hint',
        activityId,
        device,
        timestamp,
        query: summary,
        spokenResponse: response || null,
        trigger: 'timer-cancel-voice',
      };
    }

    if (matchesAlarmSetQuery(summary, response)) {
      return {
        kind: 'alarm-hint',
        activityId,
        device,
        timestamp,
        query: summary,
        spokenResponse: response || null,
        trigger: 'alarm-set-voice',
      };
    }

    if (TIMER_SET_RE.test(summary) || (/\b(?:timer|countdown|alarm)\b/i.test(summary) && TIMER_SET_SPOKEN_RE.test(response))) {
      return {
        kind: 'timer-hint',
        activityId,
        device,
        timestamp,
        query: summary,
        spokenResponse: response || null,
        trigger: 'timer-set-voice',
      };
    }

    if (TIME_QUERY_RE.test(summary)) {
      return {
        kind: 'time',
        activityId,
        device,
        timestamp,
        query: summary,
        spokenResponse: response || null,
        trigger: 'time-query',
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
