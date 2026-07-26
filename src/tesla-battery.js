/** Canonical voice phrase: "show tesla battery" (optional me/my/the). */
const TESLA_BATTERY_QUERY_RE = /\b(?:show|read|tell\s+me|what(?:'s|\s+is))\s+(?:me\s+)?(?:my\s+)?(?:the\s+)?tesla\s+battery\b|\btesla\s+battery\b.*\b(?:show|read|check|status)\b/i;
const YOUR_BATTERY_RE = /\b(?:your|the)\s+battery\s+is\s+(?:at\s+)?(\d{1,3})\s*(?:%|percent)(?:\b|$|[.!,])/i;
const BATTERY_PERCENT_RE = /\b(\d{1,3})\s*(?:%|percent)(?:\b|$|[.!,])/i;
const BATTERY_LEVEL_RE = /\bbattery(?:\s+level)?\s+(?:is\s+)?(?:at\s+)?(\d{1,3})\s*(?:%|percent)(?:\b|$|[.!,])/i;
const BATTERY_CHARGED_RE = /\b(?:charged|charging|level)\s+(?:to\s+)?(?:at\s+)?(\d{1,3})\s*(?:%|percent)(?:\b|$|[.!,])/i;
// App-launched Tesla routines often speak only this (no customer transcript).
const SENT_TO_DISPLAY_RE = /\bsent\s+to\s+(?:your\s+)?display\b/i;

function normalizeText(value) {
  return String(value || '')
    .replace(/[\u2018\u2019\u2032`´]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function clampPercent(value) {
  const numeric = Number(value);
  if (Number.isNaN(numeric)) {
    return null;
  }
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

function matchesTeslaBatteryQuery(summary, response) {
  const text = normalizeText(summary);
  const spoken = normalizeText(response);

  if (TESLA_BATTERY_QUERY_RE.test(text) || TESLA_BATTERY_QUERY_RE.test(spoken)) {
    return true;
  }

  if (/\btesla\b/i.test(text) && /\bbattery\b/i.test(text)) {
    return true;
  }

  if (/\btesla\b/i.test(spoken) && /\bbattery\b/i.test(spoken)) {
    return true;
  }

  if (/\btesla\b/i.test(spoken) && BATTERY_PERCENT_RE.test(spoken)) {
    return true;
  }

  // Empty summary + spoken percent (app/TextClient often omits the utterance).
  if (!text && BATTERY_PERCENT_RE.test(spoken) && /\bbattery\b/i.test(spoken)) {
    return true;
  }

  // Bare "Sent to Display" is resolved by routine-index (battery vs dashboard).
  // Only claim it here when the surrounding text clearly mentions battery.
  if (SENT_TO_DISPLAY_RE.test(spoken) && /\bbattery\b/i.test(`${text} ${spoken}`)) {
    return true;
  }

  return false;
}

function parseBatteryPercentFromSpeech(response) {
  const spoken = normalizeText(response);
  if (!spoken) {
    return null;
  }

  for (const pattern of [YOUR_BATTERY_RE, BATTERY_LEVEL_RE, BATTERY_CHARGED_RE, BATTERY_PERCENT_RE]) {
    const match = spoken.match(pattern);
    if (match) {
      const percent = clampPercent(match[1]);
      if (percent !== null) {
        return percent;
      }
    }
  }

  return null;
}

function buildTeslaBatteryReading(spokenResponse) {
  const percent = parseBatteryPercentFromSpeech(spokenResponse);
  return {
    percent,
    model: 'Model Y',
    label: percent === null ? 'Battery level unknown' : 'Battery',
  };
}

module.exports = {
  TESLA_BATTERY_QUERY_RE,
  matchesTeslaBatteryQuery,
  parseBatteryPercentFromSpeech,
  buildTeslaBatteryReading,
  clampPercent,
};
