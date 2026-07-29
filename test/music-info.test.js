const test = require('node:test');
const assert = require('node:assert/strict');
const {
  matchesMusicQuery,
  matchesNowPlayingQuery,
  matchesMusicSkipQuery,
  isExplicitSongSkipQuery,
  isMusicPlayerContent,
  normalizePlayerInfo,
  fetchNowPlayingAfterSkip,
  fetchNowPlayingHousehold,
  parseSpokenNowPlaying,
  resolveMusicQueryNowPlaying,
} = require('../src/music-info');

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
  // Amazon ASR often drops the apostrophe.
  assert.equal(matchesNowPlayingQuery('whats playing'), true);
  assert.equal(matchesNowPlayingQuery('whats this song'), true);
  assert.equal(matchesNowPlayingQuery('identify this song'), true);
});

test('matchesNowPlayingQuery falls back to spoken now-playing answers when transcript is empty', () => {
  assert.equal(matchesNowPlayingQuery('', 'Currently playing Bohemian Rhapsody by Queen'), true);
  assert.equal(matchesNowPlayingQuery(null, "This is Tennessee by Arrested Development"), true);
  assert.equal(matchesNowPlayingQuery('', 'The weather is sunny'), false);
});

test('matchesNowPlayingQuery ignores unrelated and blocklisted phrases', () => {
  assert.equal(matchesNowPlayingQuery('what time is it'), false);
  assert.equal(matchesNowPlayingQuery('set a 5 minute timer'), false);
  assert.equal(matchesNowPlayingQuery(''), false);
  assert.equal(matchesNowPlayingQuery(null), false);
});

test('matchesMusicSkipQuery detects next/skip and rejects calendar/shopping phrasing', () => {
  assert.equal(matchesMusicSkipQuery('next'), true);
  assert.equal(matchesMusicSkipQuery('alexa next'), true);
  assert.equal(matchesMusicSkipQuery('alexa, next'), true);
  assert.equal(matchesMusicSkipQuery('next song'), true);
  assert.equal(matchesMusicSkipQuery('next track'), true);
  assert.equal(matchesMusicSkipQuery('skip'), true);
  assert.equal(matchesMusicSkipQuery('skip this song'), true);
  assert.equal(matchesMusicSkipQuery('skip the track'), true);
  // History joins wake-word + repeated ASR: "alexa next, next"
  assert.equal(matchesMusicSkipQuery('alexa next, next'), true);
  assert.equal(matchesMusicSkipQuery('next | next'), true);
  assert.equal(matchesMusicSkipQuery('alexa next song, next song'), true);
  assert.equal(matchesMusicSkipQuery("what's next"), false);
  assert.equal(matchesMusicSkipQuery("what's next, next"), false);
  assert.equal(matchesMusicSkipQuery('say next'), false);
  assert.equal(matchesMusicSkipQuery('next on my calendar'), false);
  assert.equal(matchesMusicSkipQuery('set a timer'), false);
  assert.equal(matchesMusicSkipQuery('play next'), false); // handled as music-play
});

test('isExplicitSongSkipQuery only for song/track wording', () => {
  assert.equal(isExplicitSongSkipQuery('next song'), true);
  assert.equal(isExplicitSongSkipQuery('skip this track'), true);
  assert.equal(isExplicitSongSkipQuery('next'), false);
  assert.equal(isExplicitSongSkipQuery('skip'), false);
});

test('isMusicPlayerContent accepts music providers and song-like cards', () => {
  assert.equal(
    isMusicPlayerContent({
      song: 'Song',
      artist: 'Artist',
      provider: 'Amazon Music',
    }),
    true,
  );
  assert.equal(
    isMusicPlayerContent({
      song: 'Song',
      artist: 'Artist',
      provider: 'Spotify',
    }),
    true,
  );
  assert.equal(
    isMusicPlayerContent({
      song: 'Song',
      artist: 'Someone',
      provider: null,
    }),
    true,
  );
});

test('isMusicPlayerContent rejects news/briefing/audible unless explicit song skip', () => {
  const news = {
    song: 'Top headlines',
    artist: null,
    provider: 'Flash Briefing',
  };
  assert.equal(isMusicPlayerContent(news), false);
  assert.equal(isMusicPlayerContent(news, { explicitSongSkip: true }), true);
  assert.equal(
    isMusicPlayerContent({
      song: 'Chapter 3',
      artist: 'Author',
      provider: 'Audible',
    }),
    false,
  );
  assert.equal(
    isMusicPlayerContent({
      song: 'Morning update',
      artist: null,
      provider: 'NPR',
    }),
    false,
  );
  // Title alone without artist/provider is not enough for bare "next".
  assert.equal(isMusicPlayerContent({ song: 'Something', artist: null, provider: null }), false);
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

test('normalizePlayerInfo coerces mediaLength/mediaProgress from milliseconds', () => {
  const { coerceMediaSeconds } = require('../src/music-info');
  assert.equal(coerceMediaSeconds(225000), 225);
  assert.equal(coerceMediaSeconds(225), 225);
  assert.equal(coerceMediaSeconds(null), null);

  const info = normalizePlayerInfo({
    infoText: { title: 'Song', subText1: 'Artist' },
    state: 'PLAYING',
    progress: { mediaLength: 225000, mediaProgress: 45000 },
    provider: { providerDisplayName: 'Amazon Music' },
  }, 'Kitchen');
  assert.equal(info.mediaLengthSec, 225);
  assert.equal(info.mediaProgressSec, 45);
  assert.ok(info.progressAt);
});

test('fetchNowPlayingAfterSkip returns the new title once it changes', async () => {
  const bodies = [
    {
      playerInfo: {
        infoText: { title: 'Old Song', subText1: 'A' },
        state: 'PLAYING',
        provider: { providerDisplayName: 'Amazon Music' },
      },
    },
    {
      playerInfo: {
        infoText: { title: 'Old Song', subText1: 'A' },
        state: 'PLAYING',
        provider: { providerDisplayName: 'Amazon Music' },
      },
    },
    {
      playerInfo: {
        infoText: { title: 'New Song', subText1: 'B' },
        state: 'PLAYING',
        provider: { providerDisplayName: 'Amazon Music' },
      },
    },
  ];
  let i = 0;
  const alexa = {
    getPlayerInfo(_id, cb) {
      cb(null, bodies[Math.min(i, bodies.length - 1)]);
      i += 1;
    },
  };

  const result = await fetchNowPlayingAfterSkip(alexa, 'serial', 'Kitchen', {
    attempts: 5,
    delayMs: 1,
  });
  assert.equal(result.song, 'New Song');
  assert.equal(result.artist, 'B');
});

test('fetchNowPlayingAfterSkip falls back to settled lastSeen when title never changes', async () => {
  const alexa = {
    getPlayerInfo(_id, cb) {
      cb(null, {
        playerInfo: {
          infoText: { title: 'Same Song', subText1: 'Artist' },
          state: 'PLAYING',
          provider: { providerDisplayName: 'Spotify' },
        },
      });
    },
  };
  const result = await fetchNowPlayingAfterSkip(alexa, 'serial', 'Kitchen', {
    attempts: 3,
    delayMs: 1,
  });
  assert.equal(result.song, 'Same Song');
});

test('parseSpokenNowPlaying extracts song and artist from Alexa answers', () => {
  const current = parseSpokenNowPlaying('Currently playing Bohemian Rhapsody by Queen');
  assert.equal(current.song, 'Bohemian Rhapsody');
  assert.equal(current.artist, 'Queen');
  assert.equal(current.source, 'spoken');

  const onDevice = parseSpokenNowPlaying(
    'This is Tennessee by Arrested Development on Office Echo',
    'Basement Echo Dot',
  );
  assert.equal(onDevice.song, 'Tennessee');
  assert.equal(onDevice.artist, 'Arrested Development');
  assert.equal(onDevice.device, 'Office Echo');

  assert.equal(parseSpokenNowPlaying('Nothing is playing right now'), null);
  assert.equal(parseSpokenNowPlaying('The weather is sunny'), null);
});

test('fetchNowPlayingHousehold finds PLAYING music on another Echo', async () => {
  const alexa = {
    serialNumbers: {
      a: { serialNumber: 'idle-serial', accountName: 'Basement Echo Dot' },
      b: { serialNumber: 'office-serial', accountName: 'Office Echo' },
    },
    getPlayerInfo(id, cb) {
      if (id === 'idle-serial' || id === 'Basement Echo Dot') {
        cb(null, { playerInfo: { state: 'IDLE', infoText: {} } });
        return;
      }
      cb(null, {
        playerInfo: {
          infoText: { title: 'Tennessee', subText1: 'Arrested Development' },
          state: 'PLAYING',
          provider: { providerDisplayName: 'Amazon Music' },
        },
      });
    },
  };

  const result = await fetchNowPlayingHousehold(alexa, 'idle-serial', 'Basement Echo Dot', {
    attempts: 1,
    delayMs: 1,
    scanAttempts: 1,
  });
  assert.equal(result.song, 'Tennessee');
  assert.equal(result.device, 'Office Echo');
});

test('resolveMusicQueryNowPlaying falls back to spoken answer when all devices idle', async () => {
  const alexa = {
    serialNumbers: {
      a: { serialNumber: 'idle-serial', accountName: 'Basement Echo Dot' },
    },
    getPlayerInfo(_id, cb) {
      cb(null, { playerInfo: { state: 'IDLE', infoText: {} } });
    },
  };

  const result = await resolveMusicQueryNowPlaying(alexa, {
    device: 'Basement Echo Dot',
    deviceSerial: 'idle-serial',
    spokenResponse: 'Currently playing Tennessee by Arrested Development on Office Echo',
  }, { attempts: 1, delayMs: 1, scanAttempts: 1 });

  assert.equal(result.song, 'Tennessee');
  assert.equal(result.artist, 'Arrested Development');
  assert.equal(result.source, 'spoken');
  assert.equal(result.device, 'Office Echo');
});
