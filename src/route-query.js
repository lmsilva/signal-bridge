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
const DISTANCE_ANSWER_RE = /\b\d+(?:\.\d+)?\s*(?:miles?|mi|kilometers?|km)\b(?:(?!\bfrom\b).){0,40}\bfrom\s+([a-z][a-z\s,'-]{1,60}?)\s+to\s+([a-z][a-z\s,'-]{1,60})\b/i;

// Words a captured "origin" can be that mean "wherever this bridge lives",
// same convention as weather's "here"/"outside" local-scope handling.
const LOCAL_ORIGIN_RE = /^(?:here|home|my\s+house|our\s+house|this\s+house|my\s+place)$/i;

function matchesRouteQuery(summary, response) {
  const text = summary || '';
  const spoken = response || '';
  return (
    DISTANCE_BETWEEN_RE.test(text) || DISTANCE_BETWEEN_RE.test(spoken)
    || HOW_FAR_FROM_RE.test(text) || HOW_FAR_FROM_RE.test(spoken)
    || DRIVE_TIME_RE.test(text) || DRIVE_TIME_RE.test(spoken)
    || DIRECTIONS_RE.test(text) || DIRECTIONS_RE.test(spoken)
    || HOW_FAR_BARE_RE.test(text) || HOW_FAR_BARE_RE.test(spoken)
    || DISTANCE_ANSWER_RE.test(text) || DISTANCE_ANSWER_RE.test(spoken)
  );
}

// Builds a location descriptor (same shape `extractWeatherLocation` returns)
// from a captured name — either the configured default (for "here"/"home")
// or a plain named place to be geocoded later.
function buildRouteLocation(rawName, defaultLocation) {
  const cleaned = cleanLocationName(rawName);
  if (!cleaned) {
    return null;
  }
  if (LOCAL_ORIGIN_RE.test(cleaned)) {
    return resolveDefaultLocation(defaultLocation);
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

// Pulls an { origin, destination } pair out of freeform text, trying the
// query transcript first and Alexa's spoken response second (a push activity
// can leave the transcript blank while the spoken answer still says e.g.
// "it's roughly 177 miles from Saratoga Springs to Moab").
function extractRouteLocations(query, defaultLocation = null, spokenResponse = null) {
  const texts = [query, spokenResponse].filter((value) => typeof value === 'string' && value.trim());

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
      const origin = match[2] ? buildRouteLocation(match[2], defaultLocation) : resolveDefaultLocation(defaultLocation);
      if (origin && destination) {
        return { origin, destination };
      }
    }

    match = text.match(DIRECTIONS_RE);
    if (match) {
      const destination = buildRouteLocation(match[1], defaultLocation);
      const origin = match[2] ? buildRouteLocation(match[2], defaultLocation) : resolveDefaultLocation(defaultLocation);
      if (origin && destination) {
        return { origin, destination };
      }
    }

    match = text.match(HOW_FAR_BARE_RE);
    if (match) {
      const destination = buildRouteLocation(match[1], defaultLocation);
      const origin = resolveDefaultLocation(defaultLocation);
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
  }

  return null;
}

module.exports = {
  matchesRouteQuery,
  extractRouteLocations,
  DISTANCE_BETWEEN_RE,
  HOW_FAR_FROM_RE,
  DRIVE_TIME_RE,
  DIRECTIONS_RE,
  HOW_FAR_BARE_RE,
  DISTANCE_ANSWER_RE,
};
