const { cleanupLocationPhrase, normalizeText, resolveIndoorLocation } = require('./indoor-locations');
const { parseIndoorReading } = require('./indoor-reading-parse');

const OUTDOOR_MARKERS_RE = /\b(?:outside|outdoors|out\s+there|weather)\b/i;
const INDOOR_TEMPERATURE_PREP_RE = /\b(?:temperature|temp)\s+(?:on|in|at|of|for)\s+(?:the\s+)?/i;
const INDOOR_HUMIDITY_PREP_RE = /\bhumidity\s+(?:on|in|at|of|for)\s+(?:the\s+)?/i;
const INDOOR_LOCATION_PREP_RE = /\b(?:on|in|at)\s+(?:the\s+)?(.+?)(?:\?|[.!]|$)/i;
const INDOOR_SPOKEN_TEMP_RE = /\b(?:oh\s+)?(?:it's|it is|shows?|reads?)\s+\d{1,3}(?:\.\d+)?\s+degrees?\b/i;
const INDOOR_SPOKEN_HUMIDITY_RE = /\bhumidity(?:\s+of|\s+on|\s+in|\s+at|\s+for)?\s+[\w\s']+?\s+is\s+\d{1,3}\s*(?:%|percent)?/i;

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
  return Boolean(extractIndoorLocationPhrase(normalized));
}

function matchesIndoorQuery(summary, response) {
  const normalizedSummary = normalizeText(summary);
  const normalizedResponse = normalizeText(response);

  if (isExplicitOutdoorTemperatureQuery(normalizedSummary)) {
    return false;
  }

  if (isIndoorHumidityQuery(normalizedSummary)) {
    return true;
  }

  if (isIndoorTemperatureQuery(normalizedSummary)) {
    return true;
  }

  const spokenReading = parseIndoorReading(normalizedResponse, {});
  const responseLocation = extractIndoorLocationPhrase(normalizedResponse)
    || spokenReading.locationPhrase
    || extractIndoorLocationPhrase(normalizedSummary);

  if (/\b(?:temperature|temp)\b/i.test(normalizedSummary) && responseLocation) {
    if (!/^(?:outside|outdoors|out\s+there)$/i.test(responseLocation)) {
      return true;
    }
  }

  if (normalizedResponse) {
    if (INDOOR_SPOKEN_HUMIDITY_RE.test(normalizedResponse)) {
      return true;
    }

    if (
      spokenReading.temperatureF != null
      && spokenReading.locationPhrase
      && !/\b(?:sunny|cloudy|rain|snow|wind|forecast|high of|low of)\b/i.test(normalizedResponse)
    ) {
      return true;
    }

    if (
      INDOOR_SPOKEN_TEMP_RE.test(normalizedResponse)
      && spokenReading.locationPhrase
      && !/\b(?:sunny|cloudy|rain|snow|wind|forecast|high of|low of)\b/i.test(normalizedResponse)
    ) {
      return true;
    }
  }

  if (!normalizedSummary && normalizedResponse) {
    if (INDOOR_SPOKEN_HUMIDITY_RE.test(normalizedResponse)) {
      return true;
    }
    if (INDOOR_SPOKEN_TEMP_RE.test(normalizedResponse) && !/\b(?:sunny|cloudy|rain|snow|wind|forecast)\b/i.test(normalizedResponse)) {
      return true;
    }
  }

  return false;
}

function resolveIndoorQueryLocation(query, spoken, config = {}) {
  const spokenReading = parseIndoorReading(spoken, config);
  const queryPhrase = extractIndoorLocationPhrase(query);
  const phrase = queryPhrase || spokenReading.locationPhrase;
  if (!phrase) {
    return resolveIndoorLocation(cleanupLocationPhrase(query), config);
  }
  return resolveIndoorLocation(phrase, config);
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
