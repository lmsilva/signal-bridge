const { normalizeText } = require('./indoor-locations');
const {
  parseSpokenAirQuality,
  resolveAirQualityLocationFromTexts,
} = require('./air-quality-parse');

const AIR_QUALITY_QUERY_RE = /\b(?:what(?:'s|\s+is)|tell\s+me|how(?:'s|\s+is))\s+(?:the\s+)?air\s*quality\b/i;
const AIR_QUALITY_SPOKEN_RE = /\bair\s*quality\b.*?(?:\d{1,3}\s*(?:out\s+of\s+100|\/\s*100)|(?:is|at)\s+(?:at\s+)?\d{1,3})/i;

function matchesAirQualityQuery(summary, response) {
  const normalizedSummary = normalizeText(summary);
  const normalizedResponse = normalizeText(response);

  if (AIR_QUALITY_QUERY_RE.test(normalizedSummary)) {
    return true;
  }

  if (/\bair\s*quality\b/i.test(normalizedSummary)) {
    return true;
  }

  if (!normalizedSummary && normalizedResponse && AIR_QUALITY_SPOKEN_RE.test(normalizedResponse)) {
    return true;
  }

  if (normalizedResponse && AIR_QUALITY_SPOKEN_RE.test(normalizedResponse) && /\bair\s*quality\b/i.test(normalizedSummary)) {
    return true;
  }

  return false;
}

function buildAirQualityReading(event, config = {}) {
  return parseSpokenAirQuality(event.spokenResponse, config);
}

function resolveAirQualityQueryLocation(event, config = {}) {
  return resolveAirQualityLocationFromTexts(event.query, event.spokenResponse, config);
}

module.exports = {
  buildAirQualityReading,
  matchesAirQualityQuery,
  resolveAirQualityQueryLocation,
};
