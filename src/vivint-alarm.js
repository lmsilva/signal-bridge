const VIVINT_ARM_QUERY_RE =
  /\b(?:ask|tell)\s+vivint\s+to\s+arm\b|\bvivint\s+(?:to\s+)?arm\b|\barm\s+(?:my\s+)?(?:vivint|security\s+system|alarm\s+system)\b/i;
const VIVINT_DISARM_QUERY_RE =
  /\b(?:ask|tell)\s+vivint\s+to\s+disarm\b|\bvivint\s+(?:to\s+)?disarm\b|\bdisarm\s+(?:my\s+)?(?:vivint|security\s+system|alarm\s+system)\b/i;
const VIVINT_QUERY_RE = /\bvivint\b/i;

const ARMED_RESPONSE_RE =
  /\b(?:system|(?:home|house))\s+has\s+been\s+armed\b|\b(?:is\s+)?(?:now\s+)?armed\b|\barming\s+(?:complete|successful)\b/i;
const DISARMED_RESPONSE_RE =
  /\b(?:system|(?:home|house))\s+has\s+been\s+disarmed\b|\b(?:is\s+)?(?:now\s+)?disarmed\b/i;
const ARM_MODE_STAY_RE = /\barm(?:ed)?\s+(?:in\s+)?(?:stay|home)\b|\bstay\s+mode\b|\barmed\s+stay\b/i;
const ARM_MODE_AWAY_RE = /\barm(?:ed)?\s+(?:in\s+)?away\b|\baway\s+mode\b|\barmed\s+away\b/i;

function normalizeText(value) {
  return String(value || '')
    .replace(/[\u2018\u2019\u2032`´]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function isVivintAlarmQuery(summary) {
  const text = normalizeText(summary);
  if (!text) {
    return false;
  }
  if (VIVINT_ARM_QUERY_RE.test(text) || VIVINT_DISARM_QUERY_RE.test(text)) {
    return true;
  }
  return VIVINT_QUERY_RE.test(text) && /\b(?:arm|disarm)\b/i.test(text);
}

function matchesVivintAlarmQuery(summary, response) {
  if (isVivintAlarmQuery(summary)) {
    return true;
  }

  const spoken = normalizeText(response);
  if (!spoken) {
    return false;
  }

  if (ARMED_RESPONSE_RE.test(spoken) || DISARMED_RESPONSE_RE.test(spoken)) {
    return isVivintAlarmQuery(summary) || VIVINT_QUERY_RE.test(summary);
  }

  return false;
}

function parseAlarmStatusFromSpeechOnly(spokenResponse) {
  const spoken = normalizeText(spokenResponse);
  if (!spoken) {
    return null;
  }

  let status = null;
  if (DISARMED_RESPONSE_RE.test(spoken)) {
    status = 'disarmed';
  } else if (ARMED_RESPONSE_RE.test(spoken) || ARM_MODE_STAY_RE.test(spoken) || ARM_MODE_AWAY_RE.test(spoken)) {
    status = 'armed';
  }

  if (!status) {
    return null;
  }

  let mode = null;
  if (ARM_MODE_AWAY_RE.test(spoken)) {
    mode = 'away';
  } else if (ARM_MODE_STAY_RE.test(spoken) || /\bstay\b/i.test(spoken)) {
    mode = 'stay';
  }

  return { status, mode };
}

function parseAlarmStatusFromSpeech(spokenResponse, query) {
  const fromSpeech = parseAlarmStatusFromSpeechOnly(spokenResponse);
  if (fromSpeech) {
    return fromSpeech;
  }

  const spoken = normalizeText(spokenResponse);
  const text = normalizeText(query);
  if (spoken || !text) {
    return null;
  }

  if (VIVINT_DISARM_QUERY_RE.test(text)) {
    return { status: 'disarmed', mode: null };
  }
  if (VIVINT_ARM_QUERY_RE.test(text) || (VIVINT_QUERY_RE.test(text) && /\barm\b/i.test(text))) {
    let mode = null;
    if (/\baway\b/i.test(text)) {
      mode = 'away';
    } else if (/\b(?:stay|home)\b/i.test(text)) {
      mode = 'stay';
    }
    return { status: 'armed', mode };
  }

  return null;
}

function buildAlarmLabel(status, mode) {
  if (status === 'disarmed') {
    return 'Alarm System Disarmed';
  }
  if (status === 'armed') {
    if (mode === 'away') {
      return 'Alarm System Armed — Away';
    }
    if (mode === 'stay') {
      return 'Alarm System Armed — Stay';
    }
    return 'Alarm System Armed';
  }
  return 'Security System Update';
}

function buildModeLabel(mode) {
  if (mode === 'away') {
    return 'Away Mode';
  }
  if (mode === 'stay') {
    return 'Stay Mode';
  }
  return null;
}

function buildVivintAlarmReading(spokenResponse, query) {
  const parsed = parseAlarmStatusFromSpeech(spokenResponse, query);
  const status = parsed?.status || 'unknown';
  const mode = parsed?.mode || null;
  return {
    status,
    mode,
    provider: 'Vivint',
    label: buildAlarmLabel(status, mode),
    modeLabel: buildModeLabel(mode),
  };
}

function hasAlarmStatusInSpeech(spokenResponse) {
  return parseAlarmStatusFromSpeechOnly(spokenResponse) != null;
}

module.exports = {
  VIVINT_ARM_QUERY_RE,
  matchesVivintAlarmQuery,
  parseAlarmStatusFromSpeech,
  buildVivintAlarmReading,
  buildAlarmLabel,
  hasAlarmStatusInSpeech,
};
