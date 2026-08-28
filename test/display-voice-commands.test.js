const test = require('node:test');
const assert = require('node:assert/strict');
const {
  matchesTriviaQuery,
  matchesSteamLibraryTourQuery,
  matchesPsnLibraryTourQuery,
  matchesSteamNowPlayingQuery,
  matchesPsnNowPlayingQuery,
  matchesYoutubeNowPlayingQuery,
  matchesPlexNowPlayingQuery,
  classifyDisplayVoicePhrase,
} = require('../src/display-voice-commands');
const { classifyPhrase } = require('../src/routine-index');
const { createVoiceQueryParser } = require('../src/voice-query-parser');

test('matchesTriviaQuery accepts routine-style phrases', () => {
  assert.equal(matchesTriviaQuery('Trivia'), true);
  assert.equal(matchesTriviaQuery('run trivia'), true);
  assert.equal(matchesTriviaQuery('show trivia round'), true);
  assert.equal(matchesTriviaQuery('what is the weather'), false);
});

test('library tour matchers win over platform now-playing', () => {
  assert.equal(matchesSteamLibraryTourQuery('Steam Library Tour'), true);
  assert.equal(matchesSteamNowPlayingQuery('Steam Library Tour'), false);
  assert.equal(matchesPsnLibraryTourQuery('PSN Library Tour'), true);
  assert.equal(matchesPsnLibraryTourQuery('PlayStation library'), true);
  assert.equal(matchesPsnNowPlayingQuery('PSN Library Tour'), false);
});

test('platform now-playing matchers accept NP and LP routine names', () => {
  assert.equal(matchesSteamNowPlayingQuery('Steam Now Playing'), true);
  assert.equal(matchesSteamNowPlayingQuery('Steam Last Played'), true);
  assert.equal(matchesSteamNowPlayingQuery('steam'), false);
  assert.equal(matchesPsnNowPlayingQuery('PSN Now Playing'), true);
  assert.equal(matchesPsnNowPlayingQuery('PSN Last Played'), true);
  assert.equal(matchesYoutubeNowPlayingQuery('Youtube Now Playing'), true);
  assert.equal(matchesYoutubeNowPlayingQuery('YouTube Last Played'), true);
  assert.equal(matchesYoutubeNowPlayingQuery('you tube now playing'), true);
  assert.equal(matchesPlexNowPlayingQuery('Feature Presentation'), true);
  assert.equal(matchesPlexNowPlayingQuery('Plex Now Playing'), true);
  assert.equal(matchesPlexNowPlayingQuery('Plex Last Played'), true);
  assert.equal(matchesPlexNowPlayingQuery("what's playing in the theater"), true);
  assert.equal(matchesPlexNowPlayingQuery("what's playing"), false);
});

test('classifyDisplayVoicePhrase maps Alexa routine names', () => {
  assert.equal(classifyDisplayVoicePhrase('Trivia'), 'trivia');
  assert.equal(classifyDisplayVoicePhrase('Steam Library Tour'), 'steam-library-tour');
  assert.equal(classifyDisplayVoicePhrase('PSN Library Tour'), 'psn-library-tour');
  assert.equal(classifyDisplayVoicePhrase('Steam Now Playing'), 'steam-now-playing');
  assert.equal(classifyDisplayVoicePhrase('Steam Last Played'), 'steam-now-playing');
  assert.equal(classifyDisplayVoicePhrase('PSN Now Playing'), 'psn-now-playing');
  assert.equal(classifyDisplayVoicePhrase('Youtube Last Played'), 'youtube-now-playing');
  assert.equal(classifyDisplayVoicePhrase('Feature Presentation'), 'plex-now-playing');
  assert.equal(classifyDisplayVoicePhrase('Movie Now Playing'), 'plex-now-playing');
});

test('routine-index classifyPhrase includes display overlays before music', () => {
  assert.equal(classifyPhrase('Trivia'), 'trivia');
  assert.equal(classifyPhrase('Steam Library Tour'), 'steam-library-tour');
  assert.equal(classifyPhrase('PSN Library Tour'), 'psn-library-tour');
  assert.equal(classifyPhrase('Steam Now Playing'), 'steam-now-playing');
  assert.equal(classifyPhrase('Steam Last Played'), 'steam-now-playing');
  assert.equal(classifyPhrase('PSN Last Played'), 'psn-now-playing');
  assert.equal(classifyPhrase('Youtube Now Playing'), 'youtube-now-playing');
  assert.equal(classifyPhrase('Feature Presentation'), 'plex-now-playing');
  // Bare music now-playing still maps to music.
  assert.equal(classifyPhrase("what's playing"), 'music');
});

test('voice-query-parser emits display overlay kinds before music', () => {
  const parser = createVoiceQueryParser();
  const mk = (summary) => ({
    creationTimestamp: Date.now(),
    name: 'Theater Echo',
    description: { summary },
    alexaResponse: '',
    data: { recordKey: `display-voice-${summary}` },
  });

  assert.equal(parser.parse(mk('Trivia'))?.kind, 'trivia');
  assert.equal(parser.parse(mk('Steam Library Tour'))?.kind, 'steam-library-tour');
  assert.equal(parser.parse(mk('PSN Library Tour'))?.kind, 'psn-library-tour');
  assert.equal(parser.parse(mk('Steam Now Playing'))?.kind, 'steam-now-playing');
  assert.equal(parser.parse(mk('PSN Last Played'))?.kind, 'psn-now-playing');
  assert.equal(parser.parse(mk('Youtube Now Playing'))?.kind, 'youtube-now-playing');
  assert.equal(parser.parse(mk('Feature Presentation'))?.kind, 'plex-now-playing');
  assert.equal(parser.parse(mk("what's playing"))?.kind, 'music');
});
