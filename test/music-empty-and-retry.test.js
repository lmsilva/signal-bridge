const test = require('node:test');
const assert = require('node:assert/strict');
const {
  emptyNowPlaying,
  musicQueryRetryOutcome,
  resolveMusicQueryNowPlaying,
  parseSpokenNowPlaying,
} = require('../src/music-info');
const { buildMusicPayload } = require('../src/udp-payload');
const { shouldSuppressCompanionWeather } = require('../src/air-quality');

test('emptyNowPlaying returns IDLE empty card for a device', () => {
  const card = emptyNowPlaying('Office Echo');
  assert.equal(card.empty, true);
  assert.equal(card.state, 'IDLE');
  assert.equal(card.song, null);
  assert.equal(card.artist, null);
  assert.equal(card.device, 'Office Echo');
});

test('buildMusicPayload carries music.empty for exhausted music-query', () => {
  const payload = buildMusicPayload(
    {
      device: 'Office Echo',
      timestamp: Date.now(),
      trigger: 'music-query',
      query: "what's playing",
    },
    { udpBroadcast: { defaultDisplaySeconds: 45 } },
    { nowPlaying: emptyNowPlaying('Office Echo') },
  );
  assert.equal(payload.type, 'music.playing');
  assert.equal(payload.trigger, 'music-query');
  assert.equal(payload.music.empty, true);
  assert.equal(payload.music.song, null);
});

test('musicQueryRetryOutcome: emit when track found', () => {
  const track = { song: 'Song', artist: 'Artist', state: 'PLAYING' };
  assert.deepEqual(
    musicQueryRetryOutcome({ trigger: 'music-query', attempt: 1, nowPlaying: track }),
    { action: 'emit', nowPlaying: track },
  );
});

test('musicQueryRetryOutcome: retry then emit-empty for music-query', () => {
  assert.equal(
    musicQueryRetryOutcome({ trigger: 'music-query', attempt: 1, nowPlaying: null }).action,
    'retry',
  );
  assert.equal(
    musicQueryRetryOutcome({ trigger: 'music-query', attempt: 2, nowPlaying: null }).action,
    'emit-empty',
  );
});

test('musicQueryRetryOutcome: silent give-up for music-skip', () => {
  assert.equal(
    musicQueryRetryOutcome({ trigger: 'music-skip', attempt: 1, nowPlaying: null }).action,
    'retry',
  );
  assert.equal(
    musicQueryRetryOutcome({ trigger: 'music-skip', attempt: 2, nowPlaying: null }).action,
    'silent',
  );
});

test('resolveMusicQueryNowPlaying returns null when household idle and spoken unparseable', async () => {
  const alexa = {
    getPlayerInfo(_id, cb) {
      cb(null, { playerInfo: { state: 'IDLE' } });
    },
  };
  const result = await resolveMusicQueryNowPlaying(alexa, {
    device: 'Office Echo',
    deviceSerial: 'A',
    spokenResponse: 'The weather is sunny today',
  }, { attempts: 1, delayMs: 1 });
  assert.equal(result, null);
  assert.equal(parseSpokenNowPlaying('The weather is sunny today'), null);
});

test('shouldSuppressCompanionWeather only for weather-query placeholder with pending AQ', () => {
  assert.equal(
    shouldSuppressCompanionWeather(
      { kind: 'weather', query: 'weather query', device: 'Office Echo' },
      true,
    ),
    true,
  );
  assert.equal(
    shouldSuppressCompanionWeather(
      { kind: 'weather', query: "what's the weather outside", device: 'Office Echo' },
      true,
    ),
    false,
  );
  assert.equal(
    shouldSuppressCompanionWeather(
      { kind: 'weather', query: 'weather query', device: 'Office Echo' },
      false,
    ),
    false,
  );
  assert.equal(
    shouldSuppressCompanionWeather(
      { kind: 'air-quality', query: 'weather query', device: 'Office Echo' },
      true,
    ),
    false,
  );
});
