const { normalizeText } = require('./indoor-locations');
const { cleanupAirQualityPhrase, resolveAirQualityLocation } = require('./air-quality-locations');

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
  }

  const locationMatch = text.match(/\b(?:the\s+)?(.+?)\s+air\s*quality\b/i)
    || text.match(/\bair\s*quality\s+(?:on|in|at|for)\s+(?:the\s+)?(.+?)(?:\s+is|\s+at|\?|$)/i);
  if (locationMatch) {
    reading.locationPhrase = cleanupAirQualityPhrase(locationMatch[1]);
  }

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
    if (merged[key] == null || merged[key] === '') {
      merged[key] = value;
    }
  }
  if (merged.iaqScore != null && (!merged.band || merged.band === 'unknown')) {
    merged.band = iaqBand(merged.iaqScore);
  }
  return merged;
}

function resolveAirQualityLocationFromTexts(query, spoken, config = {}) {
  const spokenReading = parseSpokenAirQuality(spoken, config);
  const queryPhrase = extractAirQualityLocationPhrase(query);
  const phrase = queryPhrase || spokenReading.locationPhrase;
  if (!phrase) {
    const fallback = config.defaultMonitor || config.defaultLocation;
    if (fallback) {
      return resolveAirQualityLocation(fallback, config);
    }
    return {
      query: null,
      label: null,
      entity: null,
      scope: 'indoor-air-quality',
      matched: false,
    };
  }
  return resolveAirQualityLocation(phrase, config);
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
  iaqBand,
  mergeAirQualityReadings,
  parseSpokenAirQuality,
  resolveAirQualityLocationFromTexts,
};
