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
  return String(value || '')
    .replace(/[\u2018\u2019\u2032`´]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// Words that never appear in a real place name but do show up in the middle of
// Alexa weather answers ("a warning is in effect until Tuesday morning", "it's
// 90 degrees and sunny"). A naive "in <place>" pattern would otherwise capture
// phrases like "effect until Tuesday morning" as a location.
const LOCATION_STOPWORD_RE = /\b(?:effect|warning|warnings|advisory|advisories|watch|watches|alert|alerts|until|through|degrees?|fahrenheit|celsius|humidity|wind|winds|windy|rain|rainy|snow|snowy|sunny|cloudy|cloud|clouds|overcast|storm|storms|thunderstorm|fog|forecast|expect|expected|chance|precipitation|monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|afternoon|evening|tonight|tomorrow|overnight|weekend|mph)\b/i;

function cleanLocationName(value) {
  return normalizeText(value)
    .replace(/\b(?:right\s+now|today|tonight|tomorrow|this\s+week|please|alexa)\b.*$/i, '')
    .replace(/[?.!,]+$/g, '')
    .trim();
}

function isPlausibleLocationName(name) {
  return Boolean(name) && name.length >= 2 && !LOCATION_STOPWORD_RE.test(name);
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
    if (isPlausibleLocationName(name)) {
      return name;
    }
  }

  return null;
}

function resolveDefaultLocation(defaultLocation) {
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

function extractWeatherLocation(query, defaultLocation = null, spokenResponse = null) {
  const text = normalizeText(query);

  // 1. An explicit named location in the query always wins ("weather in Denver").
  const queryNamed = extractNamedLocationFromText(text);
  if (queryNamed) {
    return {
      scope: 'named',
      query: queryNamed,
      resolvedName: null,
      latitude: null,
      longitude: null,
    };
  }

  // 2. A query that asks for local weather ("outside", "here", "my area", …)
  //    resolves to the configured default. We deliberately do NOT mine the
  //    spoken response for a city here — Alexa's answer frequently contains
  //    idioms like "a warning is in effect until Tuesday morning" that a
  //    location pattern would misread. This is the case that caused the bug.
  const hasLocalMarker = LOCAL_SCOPE_RE.test(text);

  // 3. Only for a truly generic query with no local marker (e.g. a bare
  //    "what's the weather", or a push activity with no transcript) do we trust
  //    the spoken response's named city.
  if (!hasLocalMarker) {
    const spokenNamed = extractNamedLocationFromText(spokenResponse);
    if (spokenNamed) {
      return {
        scope: 'named',
        query: spokenNamed,
        resolvedName: null,
        latitude: null,
        longitude: null,
      };
    }
  }

  if (!text) {
    return null;
  }

  return resolveDefaultLocation(defaultLocation);
}

module.exports = {
  extractWeatherLocation,
  extractNamedLocationFromText,
  cleanLocationName,
  isPlausibleLocationName,
};
