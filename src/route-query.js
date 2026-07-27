const {
  cleanLocationName,
  isPlausibleLocationName,
  resolveDefaultLocation,
} = require('./weather-location');

// "what's the distance between X and Y" / "distance from X to Y"
const DISTANCE_BETWEEN_RE = /\bdistance\s+(?:between|from)\s+([a-z][a-z\s,'-]{1,60}?)\s+(?:and|to)\s+([a-z][a-z\s,'-]{1,60})\b/i;
// "how far is Y from X" / "how far are Y from X"
const HOW_FAR_FROM_RE = /\bhow\s+far\s+(?:is|are)\s+([a-z][a-z\s,'-]{1,60}?)\s+from\s+([a-z][a-z\s,'-]{1,60})\b/i;
// "how long (to/would it take to/will it take to) drive/get/travel to Y (from X)?"
const DRIVE_TIME_RE = /\bhow\s+long\s+(?:(?:would|will|does)\s+it\s+take\s+to\s+|to\s+)?(?:drive|driving|get|travel|road\s*trip)\s+to\s+([a-z][a-z\s,'-]{1,60}?)(?:\s+from\s+([a-z][a-z\s,'-]{1,60}))?\b/i;
// "directions to Y (from X)?"
const DIRECTIONS_RE = /\bdirections?\s+to\s+([a-z][a-z\s,'-]{1,60}?)(?:\s+from\s+([a-z][a-z\s,'-]{1,60}))?\b/i;
// bare "how far is Y" with no "from" clause — origin implied home/local.
// Tried last, and only reached when the more specific patterns above (which
// all require a distinguishing keyword: "distance", "from", "drive/get",
// "directions") don't match, so there's no ordering ambiguity between them.
const HOW_FAR_BARE_RE = /\bhow\s+far\s+(?:is|are)\s+([a-z][a-z\s,'-]{1,60})\b/i;
// Alexa's own spoken answer to a distance question ("It's roughly 177 miles
// from Saratoga Springs to Moab"). Requires a distance-with-units phrase
// ahead of the "from X to Y" so it can't misread an unrelated "from A to B"
// sentence (e.g. "from Monday to Friday") as a route.
const DISTANCE_ANSWER_RE = /\b\d[\d,]*(?:\.\d+)?\s*(?:miles?|mi|kilometers?|km)\b(?:(?!\bfrom\b).){0,40}\bfrom\s+([a-z][a-z\s,'-]{1,60}?)\s+to\s+([a-z][a-z\s,'-]{1,60})\b/i;
// Real Alexa TTS for distance skills (often with empty ASR / NO_TEXT_OR_AUDIO_STORED):
// "Los Angeles is about 564 miles from Saratoga Springs, Utah as the crow flies."
// Groups: [1]=destination, [2]=origin. Origin stops before crow-flies / by-road trailers.
const DISTANCE_ANSWER_PLACE_IS_RE = /\b([a-z][a-z\s,'-]{1,60}?)\s+is\s+(?:(?:about|roughly|approximately|around|nearly|almost|over|under|some)\s+)?\d[\d,]*(?:\.\d+)?\s*(?:miles?|mi|kilometers?|km)\s+from\s+([a-z][a-z\s,'-]{1,80}?)(?=\s+as\s+the\s+crow|\s+by\s+(?:air|car|road|driving)|\s+driving\b|[.!?]|$)/i;
// "It's about 380 miles to Las Vegas (from here / from Saratoga Springs)."
const DISTANCE_ANSWER_TO_PLACE_RE = /\bit(?:'s|\s+is)\s+(?:(?:about|roughly|approximately|around|nearly|almost|over|under|some)\s+)?\d[\d,]*(?:\.\d+)?\s*(?:miles?|mi|kilometers?|km)\s+to\s+([a-z][a-z\s,'-]{1,60}?)(?:\s+from\s+([a-z][a-z\s,'-]{1,60}))?(?=\s+as\s+the\s+crow|\s+by\s+(?:air|car|road)|[.!?]|$)/i;
// Loose spoken-answer detector when the customer transcript is missing.
const DISTANCE_SPOKEN_HINT_RE = /\b\d[\d,]*(?:\.\d+)?\s*(?:miles?|mi|kilometers?|km)\s+from\b|\bas\s+the\s+crow\s+flies\b|\bby\s+road\s+it(?:'s|\s+is)\b/i;

// Words a captured "origin" can be that mean "wherever this bridge lives",
// same convention as weather's "here"/"outside" local-scope handling.
const LOCAL_ORIGIN_RE = /^(?:here|home|my\s+house|our\s+house|this\s+house|my\s+place|your\s+location|your\s+house|there)$/i;

function normalizeRouteText(value) {
  return String(value || '')
    .replace(/[\u2018\u2019\u2032`´]/g, "'")
    .replace(/\bwhats\b/gi, "what's")
    // Amazon ASR very often mishears "distance" as "difference"
    // ("what's the difference from here to Las Vegas").
    .replace(/\bdifference\b/gi, 'distance')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchesRouteQuery(summary, response) {
  const text = normalizeRouteText(summary);
  const spoken = normalizeRouteText(response);
  if (
    DISTANCE_BETWEEN_RE.test(text) || DISTANCE_BETWEEN_RE.test(spoken)
    || HOW_FAR_FROM_RE.test(text) || HOW_FAR_FROM_RE.test(spoken)
    || DRIVE_TIME_RE.test(text) || DRIVE_TIME_RE.test(spoken)
    || DIRECTIONS_RE.test(text) || DIRECTIONS_RE.test(spoken)
    || HOW_FAR_BARE_RE.test(text) || HOW_FAR_BARE_RE.test(spoken)
    || DISTANCE_ANSWER_RE.test(text) || DISTANCE_ANSWER_RE.test(spoken)
    || DISTANCE_ANSWER_PLACE_IS_RE.test(text) || DISTANCE_ANSWER_PLACE_IS_RE.test(spoken)
    || DISTANCE_ANSWER_TO_PLACE_RE.test(text) || DISTANCE_ANSWER_TO_PLACE_RE.test(spoken)
  ) {
    return true;
  }
  // Empty ASR + Alexa already answered with a miles-from line (history often
  // stores only TTS_REPLACEMENT_TEXT for these skills).
  if (!text && spoken && DISTANCE_SPOKEN_HINT_RE.test(spoken)) {
    return true;
  }
  return false;
}

// Incomplete ASR like "what's the distance from Saratoga Springs Utah" (no
// "to …" yet) must still be treated as a route intent so we do NOT mark the
// activity processed before Alexa's miles TTS lands on the same activity id.
function spokenHasRouteAnswer(spoken) {
  const text = normalizeRouteText(spoken);
  if (!text) {
    return false;
  }
  if (DISTANCE_SPOKEN_HINT_RE.test(text)) {
    return true;
  }
  return Boolean(
    DISTANCE_ANSWER_RE.test(text)
    || DISTANCE_ANSWER_PLACE_IS_RE.test(text)
    || DISTANCE_ANSWER_TO_PLACE_RE.test(text)
  );
}

function looksLikeRouteQuery(summary) {
  const text = normalizeRouteText(summary);
  if (!text) {
    return false;
  }
  if (matchesRouteQuery(text, '')) {
    return true;
  }
  return /\b(?:what(?:'s|\s+is)?\s+(?:the\s+)?)?distance\b|\bhow\s+far\b|\bdirections?\b|\bhow\s+long\b.+\b(?:drive|driving|get|travel|road\s*trip)\b/i.test(text);
}

// "here"/"home" need a configured default with real coordinates (or a
// geocodable place name). resolveDefaultLocation() otherwise returns a stub
// with null lat/lon that previously looked like a successful extract and then
// aborted silently in the listener.
function resolveRouteDefaultOrigin(defaultLocation) {
  const resolved = resolveDefaultLocation(defaultLocation);
  if (!resolved) {
    return null;
  }
  if (resolved.latitude != null && resolved.longitude != null) {
    return resolved;
  }
  const query = String(resolved.query || '').trim();
  if (resolved.scope === 'named' && query && !/^(local|here|home)$/i.test(query)) {
    return resolved;
  }
  return null;
}

function cleanRoutePlaceName(rawName) {
  return cleanLocationName(rawName)
    .replace(/\s+as\s+the\s+crow\s+flies.*$/i, '')
    .replace(/\s+by\s+(?:air|car|road|driving).*$/i, '')
    .replace(/[?.!,]+$/g, '')
    .trim();
}

// Builds a location descriptor (same shape `extractWeatherLocation` returns)
// from a captured name — either the configured default (for "here"/"home")
// or a plain named place to be geocoded later.
function buildRouteLocation(rawName, defaultLocation) {
  const cleaned = cleanRoutePlaceName(rawName);
  if (!cleaned) {
    return null;
  }
  if (LOCAL_ORIGIN_RE.test(cleaned)) {
    return resolveRouteDefaultOrigin(defaultLocation);
  }
  if (!isPlausibleLocationName(cleaned)) {
    return null;
  }
  return {
    scope: 'named',
    query: cleaned,
    resolvedName: null,
    latitude: null,
    longitude: null,
  };
}

// Pulls an { origin, destination } pair out of freeform text, trying Alexa's
// spoken response first when present (orphan miles TTS on a later activity id
// beats incomplete ASR on the query activity), then the query transcript.
function extractRouteLocations(query, defaultLocation = null, spokenResponse = null) {
  const texts = [spokenResponse, query]
    .map((value) => (typeof value === 'string' ? normalizeRouteText(value) : ''))
    .filter((value) => value);

  for (const text of texts) {
    let match = text.match(DISTANCE_BETWEEN_RE);
    if (match) {
      const origin = buildRouteLocation(match[1], defaultLocation);
      const destination = buildRouteLocation(match[2], defaultLocation);
      if (origin && destination) {
        return { origin, destination };
      }
    }

    match = text.match(HOW_FAR_FROM_RE);
    if (match) {
      const destination = buildRouteLocation(match[1], defaultLocation);
      const origin = buildRouteLocation(match[2], defaultLocation);
      if (origin && destination) {
        return { origin, destination };
      }
    }

    match = text.match(DRIVE_TIME_RE);
    if (match) {
      const destination = buildRouteLocation(match[1], defaultLocation);
      const origin = match[2]
        ? buildRouteLocation(match[2], defaultLocation)
        : resolveRouteDefaultOrigin(defaultLocation);
      if (origin && destination) {
        return { origin, destination };
      }
    }

    match = text.match(DIRECTIONS_RE);
    if (match) {
      const destination = buildRouteLocation(match[1], defaultLocation);
      const origin = match[2]
        ? buildRouteLocation(match[2], defaultLocation)
        : resolveRouteDefaultOrigin(defaultLocation);
      if (origin && destination) {
        return { origin, destination };
      }
    }

    match = text.match(HOW_FAR_BARE_RE);
    if (match) {
      const destination = buildRouteLocation(match[1], defaultLocation);
      const origin = resolveRouteDefaultOrigin(defaultLocation);
      if (origin && destination) {
        return { origin, destination };
      }
    }

    match = text.match(DISTANCE_ANSWER_RE);
    if (match) {
      const origin = buildRouteLocation(match[1], defaultLocation);
      const destination = buildRouteLocation(match[2], defaultLocation);
      if (origin && destination) {
        return { origin, destination };
      }
    }

    match = text.match(DISTANCE_ANSWER_PLACE_IS_RE);
    if (match) {
      const destination = buildRouteLocation(match[1], defaultLocation);
      const origin = buildRouteLocation(match[2], defaultLocation);
      if (origin && destination) {
        return { origin, destination };
      }
    }

    match = text.match(DISTANCE_ANSWER_TO_PLACE_RE);
    if (match) {
      const destination = buildRouteLocation(match[1], defaultLocation);
      const origin = match[2]
        ? buildRouteLocation(match[2], defaultLocation)
        : resolveRouteDefaultOrigin(defaultLocation);
      if (origin && destination) {
        return { origin, destination };
      }
    }
  }

  return null;
}

module.exports = {
  matchesRouteQuery,
  looksLikeRouteQuery,
  spokenHasRouteAnswer,
  extractRouteLocations,
  resolveRouteDefaultOrigin,
  DISTANCE_BETWEEN_RE,
  HOW_FAR_FROM_RE,
  DRIVE_TIME_RE,
  DIRECTIONS_RE,
  HOW_FAR_BARE_RE,
  DISTANCE_ANSWER_RE,
  DISTANCE_ANSWER_PLACE_IS_RE,
  DISTANCE_ANSWER_TO_PLACE_RE,
  DISTANCE_SPOKEN_HINT_RE,
};
