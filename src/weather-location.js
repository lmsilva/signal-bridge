const LOCAL_SCOPE_RE = /\b(?:outside|here|local|my\s+area|right\s+now|today|tonight|this\s+weekend)\b/i;
const NAMED_LOCATION_PATTERNS = [
  /\bweather(?:\s+like)?\s+(?:in|for|at)\s+([a-z][a-z\s,'-]{1,60})/i,
  /\btemperature(?:\s+outside|\s+today|\s+now|\s+in|\s+for|\s+at)?\s+(?:in|for|at)\s+([a-z][a-z\s,'-]{1,60})/i,
  /\bhow(?:'s|\s+is)\s+(?:the\s+weather\s+)?(?:in|for|at)\s+([a-z][a-z\s,'-]{1,60})/i,
  /\b(?:in|for|at)\s+([a-z][a-z\s,'-]{1,60})\s+(?:weather|temperature|forecast)\b/i,
];
const SPOKEN_LOCATION_PATTERNS = [
  /\b(?:currently|right\s+now)\s+in\s+([a-z][a-z\s,'-]{1,60}?)(?:,|\s+it(?:'s|\s+is|\s+will)|\s+the\s+weather|\s+there|\s*$)/i,
  /\bin\s+([a-z][a-z\s,'-]{1,60}?)(?:,|\s+it(?:'s|\s+is|\s+will)|\s+the\s+weather|\s+right\s+now|\s+there|\s*$)/i,
  /\b(?:it(?:'s|\s+is)|there(?:'s|\s+is))\s+(?:\d{1,3}\s+degrees?(?:\s+fahrenheit|\s+celsius)?(?:\s+and\s+[a-z]+)?\s+)?in\s+([a-z][a-z\s,'-]{1,60})\b/i,
];

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function cleanLocationName(value) {
  return normalizeText(value)
    .replace(/\b(?:right\s+now|today|tonight|tomorrow|this\s+week|please|alexa)\b.*$/i, '')
    .replace(/[?.!,]+$/g, '')
    .trim();
}

function extractNamedLocationFromText(text) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return null;
  }

  for (const pattern of [...NAMED_LOCATION_PATTERNS, ...SPOKEN_LOCATION_PATTERNS]) {
    const match = normalized.match(pattern);
    if (!match?.[1]) {
      continue;
    }

    const name = cleanLocationName(match[1]);
    if (name.length >= 2) {
      return name;
    }
  }

  return null;
}

function extractWeatherLocation(query, defaultLocation = null, spokenResponse = null) {
  for (const text of [query, spokenResponse]) {
    const name = extractNamedLocationFromText(text);
    if (name) {
      return {
        scope: 'named',
        query: name,
        resolvedName: null,
        latitude: null,
        longitude: null,
      };
    }
  }

  const text = normalizeText(query);
  if (!text) {
    return null;
  }

  if (LOCAL_SCOPE_RE.test(text) || !/\b(?:in|for|at)\s+[a-z]/i.test(text)) {
    if (defaultLocation?.latitude != null && defaultLocation?.longitude != null) {
      return {
        scope: 'local',
        query: defaultLocation.name || 'local',
        resolvedName: defaultLocation.name || 'Local',
        latitude: defaultLocation.latitude,
        longitude: defaultLocation.longitude,
      };
    }

    if (defaultLocation?.name) {
      return {
        scope: 'named',
        query: defaultLocation.name,
        resolvedName: defaultLocation.name,
        latitude: null,
        longitude: null,
      };
    }

    return {
      scope: 'local',
      query: 'local',
      resolvedName: null,
      latitude: null,
      longitude: null,
    };
  }

  return {
    scope: 'local',
    query: 'local',
    resolvedName: defaultLocation?.name || null,
    latitude: defaultLocation?.latitude ?? null,
    longitude: defaultLocation?.longitude ?? null,
  };
}

module.exports = {
  extractWeatherLocation,
  extractNamedLocationFromText,
  cleanLocationName,
};
