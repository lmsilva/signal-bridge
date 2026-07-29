const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('https');
const { EventEmitter } = require('events');

/**
 * Stub https.request for OwnedGames / RecentlyPlayed responses so we can assert
 * rtime_last_played → lastPlayedAt (ms) mapping without hitting Steam.
 */
function withHttpsJson(handler, run) {
  const original = https.request;
  https.request = (options, callback) => {
    const path = `${options.path || ''}`;
    const req = new EventEmitter();
    req.on = EventEmitter.prototype.on;
    req.setTimeout = () => {};
    req.destroy = () => {};
    req.end = () => {
      let body;
      try {
        body = handler(path);
      } catch (error) {
        process.nextTick(() => req.emit('error', error));
        return;
      }
      const res = new EventEmitter();
      res.statusCode = 200;
      process.nextTick(() => {
        callback(res);
        res.emit('data', Buffer.from(JSON.stringify(body)));
        res.emit('end');
      });
    };
    return req;
  };
  return Promise.resolve()
    .then(run)
    .finally(() => {
      https.request = original;
    });
}

test('fetchMostRecentlyPlayedOwnedGames maps rtime_last_played to ms', async () => {
  const { fetchMostRecentlyPlayedOwnedGames } = require('../src/steam-api');
  await withHttpsJson((path) => {
    assert.match(path, /GetOwnedGames/);
    return {
      response: {
        games: [
          { appid: 570, name: 'Dota 2', playtime_forever: 120, rtime_last_played: 1_720_000_000 },
          { appid: 440, name: 'TF2', playtime_forever: 10, rtime_last_played: 1_710_000_000 },
          { appid: 10, name: 'NoRtime', playtime_forever: 1 },
        ],
      },
    };
  }, async () => {
    const games = await fetchMostRecentlyPlayedOwnedGames('key', '7656', { limit: 5 });
    assert.equal(games.length, 2);
    assert.equal(games[0].appId, 570);
    assert.equal(games[0].lastPlayedAt, 1_720_000_000 * 1000);
    assert.equal(games[0].playtimeForeverMin, 120);
    assert.equal(games[1].appId, 440);
  });
});

test('fetchOwnedGamePlaytime falls back to OwnedGames when recent omits rtime', async () => {
  const { fetchOwnedGamePlaytime } = require('../src/steam-api');
  let calls = 0;
  await withHttpsJson((path) => {
    calls += 1;
    if (path.includes('GetRecentlyPlayedGames')) {
      return {
        response: {
          games: [{ appid: 570, playtime_forever: 90, playtime_2weeks: 5 }],
        },
      };
    }
    return {
      response: {
        games: [{ appid: 570, playtime_forever: 90, rtime_last_played: 1_725_000_000 }],
      },
    };
  }, async () => {
    const playtime = await fetchOwnedGamePlaytime('key', '7656', 570);
    assert.equal(playtime.playtimeForeverMin, 90);
    assert.equal(playtime.lastPlayedAt, 1_725_000_000 * 1000);
    assert.ok(calls >= 2);
  });
});
