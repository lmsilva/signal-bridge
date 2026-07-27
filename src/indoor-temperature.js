const { cleanupLocationPhrase, normalizeText, resolveIndoorLocation } = require('./indoor-locations');
const { parseIndoorReading } = require('./indoor-reading-parse');

const OUTDOOR_MARKERS_RE = /\b(?:outside|outdoors|out\s+there|weather)\b/i;
const INDOOR_MARKERS_RE = /\b(?:inside|indoors|indoor|in\s+here|in\s+the\s+house)\b/i;
const INDOOR_TEMPERATURE_PREP_RE = /\b(?:temperature|temp)\s+(?:on|in|at|of|for)\s+(?:the\s+)?/i;
const INDOOR_HUMIDITY_PREP_RE = /\bhumidity\s+(?:on|in|at|of|for)\s+(?:the\s+)?/i;
const INDOOR_LOCATION_PREP_RE = /\b(?:on|in|at)\s+(?:the\s+)?(.+?)(?:\?|[.!]|$)/i;

function extractIndoorLocationPhrase(text) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return null;
  }

  if (OUTDOOR_MARKERS_RE.test(normalized) && !INDOOR_TEMPERATURE_PREP_RE.test(normalized) && !INDOOR_HUMIDITY_PREP_RE.test(normalized)) {
    return null;
  }

  const humidityPrep = normalized.match(/\bhumidity\s+(?:on|in|at|of|for)\s+(?:the\s+)?(.+?)(?:\?|[.!]|$)/i);
  if (humidityPrep) {
    const phrase = cleanupLocationPhrase(humidityPrep[1]);
    if (phrase && !/^(?:outside|outdoors|out\s+there)$/i.test(phrase)) {
      return phrase;
    }
  }

  const tempPrep = normalized.match(/\b(?:temperature|temp)\s+(?:on|in|at|of|for)\s+(?:the\s+)?(.+?)(?:\?|[.!]|$)/i);
  if (tempPrep) {
    const phrase = cleanupLocationPhrase(tempPrep[1]);
    if (phrase && !/^(?:outside|outdoors|out\s+there)$/i.test(phrase)) {
      return phrase;
    }
  }

  // "what's the main floor temperature" / "tell me the living room humidity"
  // (location before the metric — common Alexa phrasing). Require "the" so
  // bare "what's the temperature" does not treat "the" as a room name.
  const locationBeforeMetric = normalized.match(
    /\b(?:what(?:'s|\s+is)|tell\s+me|how(?:'s|\s+is)|check)\s+the\s+(.+?)\s+(?:temperature|temp|humidity)\b/i,
  );
  if (locationBeforeMetric) {
    const phrase = cleanupLocationPhrase(locationBeforeMetric[1]);
    if (
      phrase
      && !/^(?:the|a|an|outside|outdoors|out\s+there|indoor|inside|indoors)$/i.test(phrase)
    ) {
      return phrase;
    }
  }

  if (/\b(?:temperature|temp|humidity)\b/i.test(normalized)) {
    const trailing = normalized.match(INDOOR_LOCATION_PREP_RE);
    if (trailing) {
      const phrase = cleanupLocationPhrase(trailing[1]);
      if (phrase && !/^(?:outside|outdoors|out\s+there)$/i.test(phrase)) {
        return phrase;
      }
    }
  }

  return null;
}

function isExplicitOutdoorTemperatureQuery(text) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return false;
  }
  if (/\b(?:temperature|temp)\s+(?:outside|outdoors|out\s+there)\b/i.test(normalized)) {
    return true;
  }
  if (/\b(?:outside|outdoors|out\s+there)\b/i.test(normalized) && /\b(?:temperature|temp|weather)\b/i.test(normalized)) {
    return true;
  }
  if (/\bweather\b/i.test(normalized)) {
    return true;
  }
  return false;
}

function isIndoorHumidityQuery(summary) {
  const normalized = normalizeText(summary);
  if (!normalized || !/\bhumidity\b/i.test(normalized)) {
    return false;
  }
  if (/\bhumidity\s+(?:outside|outdoors|out\s+there)\b/i.test(normalized)) {
    return false;
  }
  return Boolean(extractIndoorLocationPhrase(normalized));
}

function isIndoorTemperatureQuery(summary) {
  const normalized = normalizeText(summary);
  if (!normalized) {
    return false;
  }
  if (!/\b(?:temperature|temp)\b/i.test(normalized)) {
    return false;
  }
  if (/\b(?:temperature|temp)\s+(?:outside|outdoors|out\s+there)\b/i.test(normalized)) {
    return false;
  }
  if (OUTDOOR_MARKERS_RE.test(normalized) && !INDOOR_TEMPERATURE_PREP_RE.test(normalized)) {
    return false;
  }
  if (INDOOR_MARKERS_RE.test(normalized)) {
    return true;
  }
  return Boolean(extractIndoorLocationPhrase(normalized));
}

// Routing contract: a generic "what's the temperature" ALWAYS means outdoor.
// Indoor only when the user says "inside"/"indoors" or names a location
// ("temperature in Room 16's bedroom"). The spoken response is only consulted
// when there is no query summary at all (push activity without transcript).
function matchesIndoorQuery(summary, response) {
  const normalizedSummary = normalizeText(summary);
  void response;

  if (isExplicitOutdoorTemperatureQuery(normalizedSummary)) {
    return false;
  }

  if (isIndoorHumidityQuery(normalizedSummary)) {
    return true;
  }

  if (isIndoorTemperatureQuery(normalizedSummary)) {
    return true;
  }

  return false;
}

function resolveIndoorQueryLocation(query, spoken, config = {}) {
  const spokenReading = parseIndoorReading(spoken, config);
  const queryPhrase = extractIndoorLocationPhrase(query);
  const spokenPhrase = spokenReading.locationPhrase;

  // A phrase that maps to a configured sensor always wins; an unmatched query
  // phrase (often a misheard transcript) yields to a matched spoken location.
  const fromQuery = queryPhrase ? resolveIndoorLocation(queryPhrase, config) : null;
  if (fromQuery?.matched) {
    return fromQuery;
  }
  const fromSpoken = spokenPhrase ? resolveIndoorLocation(spokenPhrase, config) : null;
  if (fromSpoken?.matched) {
    return fromSpoken;
  }
  if (fromQuery) {
    return fromQuery;
  }
  if (fromSpoken) {
    return fromSpoken;
  }
  return resolveIndoorLocation(cleanupLocationPhrase(query), config);
}

function buildIndoorReading(event, config = {}) {
  return parseIndoorReading(event.spokenResponse, config);
}

function indoorMetric(query) {
  return /\bhumidity\b/i.test(query || '') ? 'humidity' : 'temperature';
}

module.exports = {
  extractIndoorLocationPhrase,
  isExplicitOutdoorTemperatureQuery,
  isIndoorHumidityQuery,
  isIndoorTemperatureQuery,
  matchesIndoorQuery,
  resolveIndoorQueryLocation,
  buildIndoorReading,
  indoorMetric,
};
