/**
 * Alexa voice / custom-routine matchers for display-only overlays:
 * trivia, Steam/PSN library tours, and Steam/PSN/YouTube now-or-last-played.
 *
 * These do not need Alexa's spoken answer — the bridge fetches the card itself
 * (same pattern as Tesla / Guest Snaps). Prefer platform-qualified phrases so
 * bare "now playing" still maps to Alexa music.
 */

function normalizeText(value) {
  return String(value || '')
    .replace(/[\u2018\u2019\u2032`´']/g, "'")
    .replace(/\byou\s*tube\b/gi, 'youtube')
    .replace(/\bplay\s*-?\s*station\b/gi, 'playstation')
    .replace(/\s+/g, ' ')
    .trim();
}

// "Trivia", "show trivia", "run trivia", "start trivia round"
const TRIVIA_RE = /\b(?:(?:show|start|run|open|play|launch|display)\s+(?:a\s+|the\s+)?)?trivia(?:\s+round)?\b/i;

// Must win over steam now-playing ("steam library" contains "steam").
const STEAM_LIBRARY_TOUR_RE = /\b(?:(?:show|start|run|open|play|launch|display)\s+(?:the\s+)?)?steam\s+library(?:\s+tour)?\b/i;

const PSN_LIBRARY_TOUR_RE = /\b(?:(?:show|start|run|open|play|launch|display)\s+(?:the\s+)?)?(?:psn|playstation)\s+library(?:\s+tour)?\b/i;

// Require "now playing" or "last played" so bare "steam"/"youtube" do not steal other intents.
// Both phrase forms use requestedMode auto on the bridge (live if playing, else last played).
const STEAM_NOW_PLAYING_RE = /\b(?:(?:show|start|run|open|play|launch|display)\s+(?:the\s+)?)?steam\s+(?:now\s+playing|last\s+played)\b/i;

const PSN_NOW_PLAYING_RE = /\b(?:(?:show|start|run|open|play|launch|display)\s+(?:the\s+)?)?(?:psn|playstation)\s+(?:now\s+playing|last\s+played)\b/i;

const YOUTUBE_NOW_PLAYING_RE = /\b(?:(?:show|start|run|open|play|launch|display)\s+(?:the\s+)?)?youtube\s+(?:now\s+playing|last\s+played)\b/i;

// "show darts", "show autodarts", "darts dashboard"
const AUTODARTS_DASHBOARD_RE = /\b(?:(?:show|start|run|open|play|launch|display)\s+(?:the\s+)?)?(?:auto\s*)?darts\s+dashboard\b/i;
const AUTODARTS_NOW_RE = /\b(?:(?:show|start|run|open|play|launch|display)\s+(?:the\s+)?)?(?:auto\s*)?darts(?:\s+(?:now|match|live))?\b/i;

function textMatches(re, summary, response) {
  const text = normalizeText(summary);
  const spoken = normalizeText(response);
  return (!!text && re.test(text)) || (!!spoken && re.test(spoken));
}

function matchesTriviaQuery(summary, response) {
  return textMatches(TRIVIA_RE, summary, response);
}

function matchesSteamLibraryTourQuery(summary, response) {
  return textMatches(STEAM_LIBRARY_TOUR_RE, summary, response);
}

function matchesPsnLibraryTourQuery(summary, response) {
  return textMatches(PSN_LIBRARY_TOUR_RE, summary, response);
}

function matchesSteamNowPlayingQuery(summary, response) {
  if (matchesSteamLibraryTourQuery(summary, response)) {
    return false;
  }
  return textMatches(STEAM_NOW_PLAYING_RE, summary, response);
}

function matchesPsnNowPlayingQuery(summary, response) {
  if (matchesPsnLibraryTourQuery(summary, response)) {
    return false;
  }
  return textMatches(PSN_NOW_PLAYING_RE, summary, response);
}

function matchesYoutubeNowPlayingQuery(summary, response) {
  return textMatches(YOUTUBE_NOW_PLAYING_RE, summary, response);
}

function matchesAutodartsDashboardQuery(summary, response) {
  return textMatches(AUTODARTS_DASHBOARD_RE, summary, response);
}

function matchesAutodartsNowQuery(summary, response) {
  if (matchesAutodartsDashboardQuery(summary, response)) {
    return false;
  }
  return textMatches(AUTODARTS_NOW_RE, summary, response);
}

/** Classify a routine name / utterance into a voice kind, or null. */
function classifyDisplayVoicePhrase(phrase) {
  const text = normalizeText(phrase);
  if (!text) {
    return null;
  }
  if (matchesTriviaQuery(text, '')) {
    return 'trivia';
  }
  if (matchesSteamLibraryTourQuery(text, '')) {
    return 'steam-library-tour';
  }
  if (matchesPsnLibraryTourQuery(text, '')) {
    return 'psn-library-tour';
  }
  if (matchesSteamNowPlayingQuery(text, '')) {
    return 'steam-now-playing';
  }
  if (matchesPsnNowPlayingQuery(text, '')) {
    return 'psn-now-playing';
  }
  if (matchesYoutubeNowPlayingQuery(text, '')) {
    return 'youtube-now-playing';
  }
  if (matchesAutodartsDashboardQuery(text, '')) {
    return 'autodarts-dashboard';
  }
  if (matchesAutodartsNowQuery(text, '')) {
    return 'autodarts-now';
  }
  return null;
}

module.exports = {
  normalizeText,
  matchesTriviaQuery,
  matchesSteamLibraryTourQuery,
  matchesPsnLibraryTourQuery,
  matchesSteamNowPlayingQuery,
  matchesPsnNowPlayingQuery,
  matchesYoutubeNowPlayingQuery,
  matchesAutodartsDashboardQuery,
  matchesAutodartsNowQuery,
  classifyDisplayVoicePhrase,
};
