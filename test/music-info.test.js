const test = require('node:test');
const assert = require('node:assert/strict');
const { matchesMusicQuery, matchesNowPlayingQuery, normalizePlayerInfo } = require('../src/music-info');

test('matchesMusicQuery detects play commands', () => {
  assert.equal(matchesMusicQuery('play bohemian rhapsody', 'Playing Bohemian Rhapsody'), true);
  assert.equal(matchesMusicQuery('alexa, play some music', 'Playing music'), true);
  assert.equal(matchesMusicQuery('set a 5 minute timer', 'Starting now'), false);
});

test('matchesNowPlayingQuery detects "what song is playing" style queries', () => {
  assert.equal(matchesNowPlayingQuery('what song is playing'), true);
  assert.equal(matchesNowPlayingQuery('which song is playing'), true);
  assert.equal(matchesNowPlayingQuery('what is this song'), true);
  assert.equal(matchesNowPlayingQuery("what's this song"), true);
  assert.equal(matchesNowPlayingQuery('what song is this'), true);
  assert.equal(matchesNowPlayingQuery("what's playing"), true);
  assert.equal(matchesNowPlayingQuery('name this song'), true);
});

test('matchesNowPlayingQuery ignores unrelated and blocklisted phrases', () => {
  assert.equal(matchesNowPlayingQuery('what time is it'), false);
  assert.equal(matchesNowPlayingQuery('set a 5 minute timer'), false);
  assert.equal(matchesNowPlayingQuery(''), false);
  assert.equal(matchesNowPlayingQuery(null), false);
});

test('normalizePlayerInfo extracts song artist album and art', () => {
  const info = normalizePlayerInfo({
    infoText: { title: 'Song', subText1: 'Artist', subText2: 'Album' },
    mainArt: { url: 'https://example.com/cover.jpg' },
    state: 'PLAYING',
    provider: { providerDisplayName: 'Amazon Music' },
  }, 'Kitchen Echo');

  assert.equal(info.song, 'Song');
  assert.equal(info.artist, 'Artist');
  assert.equal(info.album, 'Album');
  assert.equal(info.artUrl, 'https://example.com/cover.jpg');
  assert.equal(info.device, 'Kitchen Echo');
});
