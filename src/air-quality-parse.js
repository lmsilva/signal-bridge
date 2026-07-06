const { normalizeText } = require('./indoor-locations');
const {
  cleanupAirQualityPhrase,
  getAirQualityMonitors,
  isValidLocationPhrase,
  resolveAirQualityLocation,
} = require('./air-quality-locations');

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function iaqBand(score, { goodMin = 80, fairMin = 60, moderateMin = 40 } = {}) {
  if (score == null || Number.isNaN(score)) {
    return 'unknown';
  }
  if (score >= goodMin) {
    return 'good';
  }
  if (score >= fairMin) {
    return 'fair';
  }
  if (score >= moderateMin) {
    return 'moderate';
  }
  return 'poor';
}

function parseNumeric(value) {
  if (value == null || value === '') {
    return null;
  }
  const parsed = Number.parseFloat(String(value).replace(/[^\d.-]/g, ''));
  return Number.isNaN(parsed) ? null : parsed;
}

const QUALITATIVE_BANDS = [
  [/\b(?:very|pretty|really)\s+(?:good|great)\b|\bexcellent\b/i, 'good'],
  [/\b(?:very|pretty|really)\s+(?:bad|poor)\b/i, 'poor'],
  [/\bair\s*quality(?:'s| is)\s+(?:pretty\s+)?good\b/i, 'good'],
  [/\b(?:is|are|looks|sounds)\s+(?:pretty\s+)?good\b|\bfine\b|\bhealthy\b|\bclean\b/i, 'good'],
  [/\bfair\b|\bacceptable\b/i, 'fair'],
  [/\bmoderate\b/i, 'moderate'],
  [/\bpoor\b|\bbad\b|\bunhealthy\b/i, 'poor'],
];

function parseQualitativeBand(text, config = {}) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return null;
  }

  for (const [pattern, band] of QUALITATIVE_BANDS) {
    if (pattern.test(normalized)) {
      return band;
    }
  }

  if (/\bgood\b/i.test(normalized) && !/\b(?:not|isn't|aren't)\s+good\b/i.test(normalized)) {
    return 'good';
  }

  return null;
}

function findMonitorPhraseInText(text, config = {}) {
  const normalized = normalizeText(text).toLowerCase();
  if (!normalized) {
    return null;
  }

  const monitors = getAirQualityMonitors(config);
  let bestAlias = null;

  for (const monitor of monitors) {
    const aliases = [...new Set([monitor.label, monitor.id, ...(monitor.aliases || [])])]
      .map((value) => normalizeText(value))
      .filter(Boolean)
      .sort((left, right) => right.length - left.length);

    for (const alias of aliases) {
      const pattern = new RegExp(`\\b${escapeRegExp(alias)}\\b`, 'i');
      if (pattern.test(normalized) && (!bestAlias || alias.length > bestAlias.length)) {
        bestAlias = alias;
      }
    }
  }

  if (!bestAlias) {
    return null;
  }

  return resolveAirQualityLocation(bestAlias, config);
}

function parseMonitorSummaries(text, config = {}) {
  const sentences = normalizeText(text).split(/(?<=[.!?])\s+/).filter(Boolean);
  if (!sentences.length) {
    return [];
  }

  const monitors = getAirQualityMonitors(config);
  const found = [];
  const seen = new Set();

  for (const sentence of sentences) {
    for (const monitor of monitors) {
      if (seen.has(monitor.id)) {
        continue;
      }

      const aliases = [...new Set([monitor.label, monitor.id, ...(monitor.aliases || [])])]
        .map((value) => normalizeText(value))
        .filter(Boolean)
        .sort((left, right) => right.length - left.length);

      const matchedAlias = aliases.find((alias) => new RegExp(`\\b${escapeRegExp(alias)}\\b`, 'i').test(sentence));
      if (!matchedAlias) {
        continue;
      }

      const scoreMatch = sentence.match(/(\d{1,3})\s*(?:out\s+of\s+100|\/\s*100)\b/i)
        || sentence.match(/\b(?:is|at|are|'s)\s+(?:at\s+)?(\d{1,3})\b/i);
      const iaqScore = scoreMatch ? Number.parseInt(scoreMatch[1], 10) : null;
      const band = iaqScore != null ? iaqBand(iaqScore, config) : (parseQualitativeBand(sentence, config) || 'unknown');

      found.push({
        id: monitor.id,
        label: monitor.label,
        iaqScore,
        band,
        summary: sentence.trim(),
      });
      seen.add(monitor.id);
      break;
    }
  }

  return found;
}

function isGenericAirQualityQuery(query) {
  const normalized = normalizeText(query);
  if (!normalized || !/\bair\s*quality\b/i.test(normalized)) {
    return false;
  }

  if (extractAirQualityLocationPhrase(normalized)) {
    return false;
  }

  if (/\b(?:on|in|at|for)\s+(?:the\s+)?[\w\s'-]+\s+air\s*quality\b/i.test(normalized)) {
    return false;
  }

  return /\b(?:show|read|list|check|what(?:'s|\s+is)|tell\s+me|how(?:'s|\s+is))\b/i.test(normalized)
    || /\bindoor\b/i.test(normalized);
}

function parseSpokenAirQuality(spoken, config = {}) {
  const text = normalizeText(spoken);
  const reading = {
    iaqScore: null,
    iaqMax: 100,
    band: 'unknown',
    temperatureF: null,
    humidity: null,
    pm25: null,
    co: null,
    voc: null,
    summary: text || null,
    locationPhrase: null,
    monitors: [],
  };

  if (!text) {
    return reading;
  }

  const scoreMatch = text.match(/(\d{1,3})\s*(?:out\s+of\s+100|\/\s*100)\b/i)
    || text.match(/\bair\s*quality(?:\s+(?:on|in|at|for))?\s+(?:the\s+)?[\w\s']+?\s+(?:is|at)\s+(?:at\s+)?(\d{1,3})\b/i)
    || text.match(/\bair\s*quality\s+(?:is\s+)?(?:at\s+)?(\d{1,3})\b/i);

  if (scoreMatch) {
    reading.iaqScore = Number.parseInt(scoreMatch[1], 10);
    reading.band = iaqBand(reading.iaqScore, config);
  } else {
    const qualitative = parseQualitativeBand(text, config);
    if (qualitative) {
      reading.band = qualitative;
    }
  }

  const monitorLocation = findMonitorPhraseInText(text, config);
  if (monitorLocation?.matched) {
    reading.locationPhrase = cleanupAirQualityPhrase(monitorLocation.query || monitorLocation.label) || monitorLocation.query || monitorLocation.label;
  }

  reading.monitors = parseMonitorSummaries(text, config);

  const tempMatch = text.match(/(-?\d{1,3})\s+degrees?\b/i);
  if (tempMatch) {
    reading.temperatureF = Number.parseInt(tempMatch[1], 10);
  }

  const humidityMatch = text.match(/\b(\d{1,3})\s*(?:%|percent)\s+humidity\b/i)
    || text.match(/\bhumidity\s+(?:is\s+)?(\d{1,3})\s*(?:%|percent)?\b/i);
  if (humidityMatch) {
    reading.humidity = Number.parseInt(humidityMatch[1], 10);
  }

  const pmMatch = text.match(/\bpm\s*2\.?\s*5?(?:\s+is|\s+at|\s+of)?\s+(\d+(?:\.\d+)?)/i)
    || text.match(/\bparticulate(?:\s+matter)?\s+(?:is\s+)?(\d+(?:\.\d+)?)/i);
  if (pmMatch) {
    reading.pm25 = parseNumeric(pmMatch[1]);
  }

  const coMatch = text.match(/\b(?:co|carbon monoxide)\s+(?:is\s+)?(\d+(?:\.\d+)?)/i);
  if (coMatch) {
    reading.co = parseNumeric(coMatch[1]);
  }

  const vocMatch = text.match(/\bvoc\s+(?:is\s+)?(\d+(?:\.\d+)?)/i)
    || text.match(/\bvolatile organic compounds\s+(?:are\s+)?(\d+(?:\.\d+)?)/i);
  if (vocMatch) {
    reading.voc = parseNumeric(vocMatch[1]);
  }

  const firstSentence = text.split(/(?<=[.!?])\s+/)[0]?.trim();
  if (firstSentence) {
    reading.summary = firstSentence;
  }

  return reading;
}

function mergeAirQualityReadings(primary, secondary) {
  const merged = { ...(primary || {}) };
  for (const [key, value] of Object.entries(secondary || {})) {
    if (value == null || value === '') {
      continue;
    }
    if (key === 'monitors') {
      continue;
    }
    if (merged[key] == null || merged[key] === '') {
      merged[key] = value;
    }
  }
  if (merged.iaqScore != null && (!merged.band || merged.band === 'unknown')) {
    merged.band = iaqBand(merged.iaqScore);
  }
  return merged;
}

function mergeMonitorLists(primary = [], secondary = []) {
  const byId = new Map();

  for (const entry of [...primary, ...secondary]) {
    if (!entry?.id) {
      continue;
    }
    const existing = byId.get(entry.id);
    if (!existing) {
      byId.set(entry.id, { ...entry });
      continue;
    }
    byId.set(entry.id, {
      ...existing,
      ...entry,
      iaqScore: entry.iaqScore ?? existing.iaqScore ?? null,
      band: entry.band && entry.band !== 'unknown' ? entry.band : existing.band,
      summary: entry.summary || existing.summary || null,
      reading: { ...(existing.reading || {}), ...(entry.reading || {}) },
    });
  }

  return [...byId.values()];
}

function summarizeMonitorReadings(monitors = [], config = {}) {
  const scores = monitors.map((entry) => entry.iaqScore ?? entry.reading?.iaqScore).filter((value) => value != null);
  const summary = {
    iaqScore: null,
    iaqMax: 100,
    band: 'unknown',
  };

  if (scores.length) {
    summary.iaqScore = Math.round(scores.reduce((total, value) => total + value, 0) / scores.length);
    summary.band = iaqBand(summary.iaqScore, config);
    return summary;
  }

  const bands = monitors.map((entry) => entry.band).filter((band) => band && band !== 'unknown');
  if (bands.includes('poor')) {
    summary.band = 'poor';
  } else if (bands.includes('moderate')) {
    summary.band = 'moderate';
  } else if (bands.includes('fair')) {
    summary.band = 'fair';
  } else if (bands.includes('good')) {
    summary.band = 'good';
  }

  return summary;
}

function resolveAirQualityLocationFromTexts(query, spoken, config = {}) {
  const queryPhrase = extractAirQualityLocationPhrase(query);
  if (queryPhrase && isValidLocationPhrase(queryPhrase)) {
    return resolveAirQualityLocation(queryPhrase, config);
  }

  if (/\bindoor\b/i.test(normalizeText(query))) {
    return {
      query: null,
      label: 'Indoor Air Quality',
      entity: null,
      scope: 'indoor-air-quality',
      matched: false,
      multiMonitor: true,
    };
  }

  const monitorFromSpoken = findMonitorPhraseInText(spoken, config);
  const spokenMonitors = parseMonitorSummaries(spoken, config);
  if (monitorFromSpoken?.matched && spokenMonitors.length <= 1) {
    return monitorFromSpoken;
  }

  if (spokenMonitors.length > 1) {
    return {
      query: null,
      label: 'Indoor Air Quality',
      entity: null,
      scope: 'indoor-air-quality',
      matched: false,
      multiMonitor: true,
    };
  }

  const fallback = config.defaultMonitor || config.defaultLocation;
  if (fallback) {
    return resolveAirQualityLocation(fallback, config);
  }

  return {
    query: null,
    label: 'Indoor Air Quality',
    entity: null,
    scope: 'indoor-air-quality',
    matched: false,
    multiMonitor: true,
  };
}

function extractAirQualityLocationPhrase(text) {
  const normalized = normalizeText(text);
  if (!normalized || !/\bair\s*quality\b/i.test(normalized)) {
    return null;
  }

  const prepMatch = normalized.match(/\bair\s*quality\s+(?:on|in|at|of|for)\s+(?:the\s+)?(.+?)(?:\?|[.!]|$)/i);
  if (prepMatch) {
    return cleanupAirQualityPhrase(prepMatch[1]);
  }

  const trailingMatch = normalized.match(/\b(?:on|in|at)\s+(?:the\s+)?(.+?)\s+air\s*quality\b/i);
  if (trailingMatch) {
    return cleanupAirQualityPhrase(trailingMatch[1]);
  }

  return null;
}

module.exports = {
  extractAirQualityLocationPhrase,
  findMonitorPhraseInText,
  iaqBand,
  isGenericAirQualityQuery,
  mergeAirQualityReadings,
  mergeMonitorLists,
  parseMonitorSummaries,
  parseQualitativeBand,
  parseSpokenAirQuality,
  resolveAirQualityLocationFromTexts,
  summarizeMonitorReadings,
};
