const DATE_TIME_HINT_RE = /\b(?:am|pm|a\.m\.|p\.m\.|:\d{1,2}|noon|midnight|tomorrow|today|tonight|every|each|weekday|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|\d{1,2}\/\d{1,2})\b/i;
const DURATION_ONLY_RE = /\b\d+\s*(?:minute|min|hour|hr|second|sec)s?\b/i;

const SHOW_ALARMS_RE = /\b(?:show|list)\s+(?:me\s+)?(?:all\s+|my\s+)*alarms?\b|\bwhat(?:'s|\s+are)\s+my\s+alarms\b|\bwhat alarms do i have\b/i;
const ALARM_SET_RE = /\b(?:set|create|add|schedule)\s+(?:an?\s+)?(?:alarm|wake(?:\s|-)?up\s+alarm)\b/i;
const ALARM_SET_SPOKEN_RE = /\b(?:(?:alarm|wake(?:\s|-)?up\s+alarm)\s+(?:is\s+)?(?:set|scheduled|on)|(?:i'?ve|i have)\s+set\s+(?:an?\s+)?alarm)\b/i;
const ALARM_CANCEL_RE = /\b(?:cancel|stop|delete|clear|remove)(?:\s+(?:the|my|all|a|an))?(?:\s+\S+){0,3}\s+alarms?\b/i;

function isWakeAlarmQuery(summary) {
  const text = String(summary || '').trim();
  if (!text) {
    return false;
  }
  if (/\bvivint\b/i.test(text)) {
    return false;
  }
  if (/\b(?:security\s+system|alarm\s+system)\b/i.test(text) && /\b(?:arm|disarm)\b/i.test(text)) {
    return false;
  }
  return true;
}

function matchesShowAlarmsQuery(summary) {
  return isWakeAlarmQuery(summary) && SHOW_ALARMS_RE.test(summary);
}

function matchesAlarmSetQuery(summary, response) {
  if (!isWakeAlarmQuery(summary)) {
    return false;
  }

  if (ALARM_SET_RE.test(summary)) {
    if (/\b(?:timer|countdown)\b/i.test(summary)) {
      return false;
    }
    if (DURATION_ONLY_RE.test(summary) && !DATE_TIME_HINT_RE.test(summary)) {
      return false;
    }
    return true;
  }

  if (/\b(?:alarm|wake(?:\s|-)?up\s+alarm)\b/i.test(summary) && ALARM_SET_SPOKEN_RE.test(response || '')) {
    return !/\b(?:timer|countdown)\b/i.test(summary);
  }

  return false;
}

function matchesAlarmCancelQuery(summary) {
  return isWakeAlarmQuery(summary) && ALARM_CANCEL_RE.test(summary);
}

module.exports = {
  SHOW_ALARMS_RE,
  ALARM_SET_RE,
  ALARM_SET_SPOKEN_RE,
  ALARM_CANCEL_RE,
  matchesShowAlarmsQuery,
  matchesAlarmSetQuery,
  matchesAlarmCancelQuery,
};
