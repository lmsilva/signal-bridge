const { getActivityId, getDeviceName } = require('./parser');

const TIME_QUERY_RE = /\b(?:what(?:'s|\s+is|\s+was)?\s+(?:the\s+)?time(?:\s+is\s+it)?|tell\s+me\s+(?:the\s+)?time|do\s+you\s+have\s+(?:the\s+)?time|time\s+please)\b/i;
const WEATHER_QUERY_RE = /\b(?:what(?:'s|\s+is)?\s+(?:the\s+)?weather(?:\s+like)?|how(?:'s|\s+is)\s+(?:the\s+)?weather|weather\s+(?:in|for|at|outside|today|tomorrow)|(?:is\s+it|will\s+it)\s+(?:rain|snow|sunny|cloudy|cold|hot|warm)|temperature(?:\s+outside|\s+today|\s+now|\s+in|\s+for|\s+at)?|how\s+(?:hot|cold|warm)\s+is\s+it|tell\s+me\s+(?:the\s+)?weather|give\s+me\s+(?:the\s+)?weather)\b/i;
const SHOW_TIMERS_RE = /\b(?:show|list)\s+(?:all\s+|my\s+)?timers\b|\bwhat are my timers\b|\bhow much time is left on(?: my)? timers?\b/i;
const TIMER_SET_RE = /\b(?:set|start|create|add)\b(?:(?!\btime\b).)*\b(?:timer|countdown|alarm)\b|\b(?:timer|countdown|alarm)\s+(?:for|to)\s+(?:\d|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\b|\b(?:set|start|create|add)\s+(?:a\s+)?(?:(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:hour|minute|second|min|sec|hr)s?\s*)+(?:timer|countdown|alarm)\b|\b(?:set|start)\s+(?:a\s+)?(?:timer|countdown|alarm)\s+(?:for\s+)?(?:(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:hour|minute|second|min|sec|hr)s?\s*)+/i;
const TIMER_SET_SPOKEN_RE = /\b(?:(?:starting|counting)\s+(?:now|down)|(?:timer|countdown|alarm)\s+(?:is\s+)?(?:set|started|on)|starting\s+(?:a|your)\s+\d|\d\s+(?:minute|min|hour|hr|second|sec)s?\s+(?:timer|countdown|alarm)\s+(?:starting|set))\b/i;
const TIMER_CANCEL_RE = /\b(?:cancel|stop|delete|clear|remove)(?:\s+(?:the|my|all|a|an))?(?:\s+\S+){0,3}\s+(?:timers?|countdowns?|alarms?)\b|\bcancel\s+all\b/i;

function normalizeText(value) {
  return String(value || '')
    .replace(/[\u2018\u2019\u2032`´]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
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
    const response = normalizeText(activity?.alexaResponse);
    const device = getDeviceName(activity);
    const activityId = getActivityId(activity);
    const timestamp = activity?.creationTimestamp || Date.now();

    if (!summary) {
      return null;
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

    if (WEATHER_QUERY_RE.test(summary)) {
      return {
        kind: 'weather',
        activityId,
        device,
        timestamp,
        query: summary,
        spokenResponse: response || null,
        trigger: 'weather-query',
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
  SHOW_TIMERS_RE,
  TIMER_SET_RE,
  TIMER_CANCEL_RE,
};
