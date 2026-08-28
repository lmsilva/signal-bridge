/**
 * Map Alexa automation routines (name / trigger / custom actions) → voice kinds
 * so app-launched routines can be recognized without a spoken ASR transcript.
 */

const { matchesIndoorQuery } = require('./indoor-temperature');
const { matchesAirQualityQuery } = require('./air-quality');
const { matchesShoppingListQuery } = require('./shopping-list');
const {
  matchesMusicQuery,
  matchesNowPlayingQuery,
} = require('./music-info');
const { matchesRouteQuery } = require('./route-query');
const { matchesTeslaBatteryQuery } = require('./tesla-battery');
const { matchesTeslaDashboardQuery } = require('./tesla-dashboard');
const {
  matchesGuestPhotoboothQuery,
  matchesGuestSnapsSlideshowQuery,
} = require('./guest-photobooth');
const {
  matchesTriviaQuery,
  matchesSteamLibraryTourQuery,
  matchesPsnLibraryTourQuery,
  matchesSteamNowPlayingQuery,
  matchesPsnNowPlayingQuery,
  matchesYoutubeNowPlayingQuery,
  matchesAutodartsDashboardQuery,
  matchesAutodartsNowQuery,
  matchesPlexNowPlayingQuery,
} = require('./display-voice-commands');
const { matchesVivintAlarmQuery } = require('./vivint-alarm');
const { matchesNotificationsQuery } = require('./alexa-notifications');
const {
  matchesShowAlarmsQuery,
  matchesAlarmSetQuery,
  matchesAlarmCancelQuery,
} = require('./alexa-alarms');
const { matchesWeatherQuery, TIME_QUERY_RE, SHOW_TIMERS_RE } = require('./voice-query-parser');
const { normalizeText } = require('./activity-response');
const { isSentToDisplayResponse } = require('./activity-fields');

const REFRESH_MS = 60 * 60 * 1000;

function pushPhrase(list, value) {
  const text = normalizeText(value);
  if (!text || list.includes(text)) {
    return;
  }
  list.push(text);
}

function walkCollectStrings(node, into, depth = 0) {
  if (node == null || depth > 12) {
    return;
  }
  if (typeof node === 'string') {
    pushPhrase(into, node);
    return;
  }
  if (typeof node !== 'object') {
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      walkCollectStrings(item, into, depth + 1);
    }
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (/utterance|text|phrase|message|name|title|command|speech/i.test(key) && typeof value === 'string') {
      pushPhrase(into, value);
    }
    walkCollectStrings(value, into, depth + 1);
  }
}

function collectAutomationPhrases(automation) {
  const phrases = [];
  pushPhrase(phrases, automation?.name);
  pushPhrase(phrases, automation?.automationId);
  walkCollectStrings(automation?.triggers, phrases);
  walkCollectStrings(automation?.sequence, phrases);
  walkCollectStrings(automation?.routine, phrases);
  walkCollectStrings(automation?.action, phrases);
  walkCollectStrings(automation?.actions, phrases);
  return phrases;
}

function classifyPhrase(phrase) {
  const text = normalizeText(phrase);
  if (!text) {
    return null;
  }
  // Empty response arg — matchers that need both still get the phrase as summary.
  if (matchesGuestSnapsSlideshowQuery(text, '')) {
    return 'photo-slideshow';
  }
  if (matchesGuestPhotoboothQuery(text, '')) {
    return 'guest-photobooth';
  }
  if (matchesTeslaDashboardQuery(text, text)) {
    return 'tesla-dashboard';
  }
  if (matchesTeslaBatteryQuery(text, text)) {
    return 'tesla-battery';
  }
  if (matchesTriviaQuery(text, '')) {
    return 'trivia';
  }
  // Library tours before platform now-playing (phrase contains "steam"/"psn").
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
  if (matchesPlexNowPlayingQuery(text, '')) {
    return 'plex-now-playing';
  }
  if (matchesAutodartsDashboardQuery(text, '')) {
    return 'autodarts-dashboard';
  }
  if (matchesAutodartsNowQuery(text, '')) {
    return 'autodarts-now';
  }
  if (matchesShoppingListQuery(text, '')) {
    return 'shopping-list';
  }
  if (matchesVivintAlarmQuery(text, '')) {
    return 'vivint-alarm';
  }
  if (matchesNotificationsQuery(text, '')) {
    return 'alexa-notifications';
  }
  if (matchesNowPlayingQuery(text, '')) {
    return 'music';
  }
  if (matchesMusicQuery(text, '')) {
    return 'music';
  }
  if (matchesRouteQuery(text, '')) {
    return 'route';
  }
  if (matchesAirQualityQuery(text, '')) {
    return 'air-quality';
  }
  if (matchesIndoorQuery(text, '')) {
    return 'indoor-temperature';
  }
  if (matchesWeatherQuery(text, '')) {
    return 'weather';
  }
  if (SHOW_TIMERS_RE.test(text)) {
    return 'timer-list';
  }
  if (matchesShowAlarmsQuery(text)) {
    return 'alarm-list';
  }
  if (matchesAlarmCancelQuery(text)) {
    return 'alarm-hint';
  }
  if (matchesAlarmSetQuery(text, '')) {
    return 'alarm-hint';
  }
  if (TIME_QUERY_RE.test(text)) {
    return 'time';
  }
  return null;
}

function createRoutineIndex({ log, now = () => Date.now() } = {}) {
  /** @type {{ phrase: string, kind: string, name: string|null }[]} */
  let entries = [];
  let lastRefreshAt = 0;
  let refreshTimer = null;
  let refreshing = false;

  function snapshot() {
    return {
      count: entries.length,
      kinds: [...new Set(entries.map((e) => e.kind))],
      lastRefreshAt: lastRefreshAt ? new Date(lastRefreshAt).toISOString() : null,
    };
  }

  function loadFromAutomations(automations) {
    const next = [];
    const list = Array.isArray(automations) ? automations : [];
    for (const automation of list) {
      const name = normalizeText(automation?.name) || null;
      const phrases = collectAutomationPhrases(automation);
      for (const phrase of phrases) {
        const kind = classifyPhrase(phrase);
        if (!kind) {
          continue;
        }
        next.push({ phrase, kind, name });
      }
    }
    entries = next;
    lastRefreshAt = now();
    log?.info?.('Routine index refreshed', {
      automations: list.length,
      mappedPhrases: entries.length,
      kinds: snapshot().kinds,
    });
    return snapshot();
  }

  function resolveFromText(...texts) {
    const haystacks = texts.map((t) => normalizeText(t)).filter(Boolean);
    if (!haystacks.length || !entries.length) {
      return null;
    }
    for (const entry of entries) {
      const phrase = entry.phrase.toLowerCase();
      if (phrase.length < 3) {
        continue;
      }
      for (const hay of haystacks) {
        if (hay.toLowerCase().includes(phrase) || phrase.includes(hay.toLowerCase())) {
          return {
            kind: entry.kind,
            matchedPhrase: entry.phrase,
            routineName: entry.name,
            source: 'routine-index',
          };
        }
      }
    }
    return null;
  }

  /**
   * Resolve "Sent to Display" when summary is empty.
   * Prefer dashboard if any catalog phrase mentions dashboard; battery if battery;
   * otherwise dashboard when either kind is mapped.
   */
  function resolveSentToDisplay(fields = {}) {
    const response = fields.response || '';
    if (!isSentToDisplayResponse(response)) {
      return null;
    }
    const all = normalizeText([fields.summary, fields.allText, response].filter(Boolean).join(' '));
    const fromText = resolveFromText(fields.summary, fields.allText, response);
    if (fromText && (fromText.kind === 'tesla-dashboard' || fromText.kind === 'tesla-battery')) {
      return { ...fromText, source: 'routine-index+sent-to-display' };
    }
    if (/\bdashboard\b/i.test(all)) {
      return {
        kind: 'tesla-dashboard',
        matchedPhrase: 'sent to display',
        routineName: null,
        source: 'sent-to-display-dashboard',
      };
    }
    if (/\bbattery\b/i.test(all)) {
      return {
        kind: 'tesla-battery',
        matchedPhrase: 'sent to display',
        routineName: null,
        source: 'sent-to-display-battery',
      };
    }
    const hasDashboard = entries.some((e) => e.kind === 'tesla-dashboard');
    const hasBattery = entries.some((e) => e.kind === 'tesla-battery');
    if (hasDashboard) {
      return {
        kind: 'tesla-dashboard',
        matchedPhrase: 'sent to display',
        routineName: null,
        source: 'sent-to-display-default-dashboard',
      };
    }
    if (hasBattery) {
      return {
        kind: 'tesla-battery',
        matchedPhrase: 'sent to display',
        routineName: null,
        source: 'sent-to-display-default-battery',
      };
    }
    // Fleet-backed households still benefit: prefer dashboard card.
    return {
      kind: 'tesla-dashboard',
      matchedPhrase: 'sent to display',
      routineName: null,
      source: 'sent-to-display-fallback-dashboard',
    };
  }

  function resolve(fields = {}) {
    const fromPhrases = resolveFromText(fields.summary, fields.allText, fields.response);
    if (fromPhrases) {
      return fromPhrases;
    }
    return resolveSentToDisplay(fields);
  }

  function refresh(alexa) {
    if (!alexa || typeof alexa.getAutomationRoutines !== 'function') {
      return Promise.resolve(snapshot());
    }
    if (refreshing) {
      return Promise.resolve(snapshot());
    }
    refreshing = true;
    return new Promise((resolvePromise) => {
      alexa.getAutomationRoutines((err, result) => {
        refreshing = false;
        if (err) {
          log?.warn?.('Failed to load Alexa automation routines', err?.message || err);
          resolvePromise(snapshot());
          return;
        }
        const list = Array.isArray(result)
          ? result
          : (Array.isArray(result?.automations) ? result.automations : []);
        resolvePromise(loadFromAutomations(list));
      });
    });
  }

  function start(alexa) {
    stop();
    refresh(alexa).catch(() => {});
    refreshTimer = setInterval(() => {
      refresh(alexa).catch(() => {});
    }, REFRESH_MS);
    if (typeof refreshTimer.unref === 'function') {
      refreshTimer.unref();
    }
  }

  function stop() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  return {
    start,
    stop,
    refresh,
    loadFromAutomations,
    resolve,
    resolveSentToDisplay,
    resolveFromText,
    classifyPhrase,
    collectAutomationPhrases,
    snapshot,
    _getEntries: () => entries,
  };
}

module.exports = {
  createRoutineIndex,
  classifyPhrase,
  collectAutomationPhrases,
  REFRESH_MS,
};
