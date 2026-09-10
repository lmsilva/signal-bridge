const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  createHuupeParser,
  parseLogLine,
  parseShotMessage,
  parseFamilyMessage,
  parseEndGameMessage,
  parseFocusMessage,
  parseCountdownMessage,
  modeForPackage,
  LOGCAT_TAGS,
  redactSensitive,
  pointsForZone,
  pointsTableForMode,
} = require('../src/huupe-parser');

const FIXTURES = path.join(__dirname, 'fixtures', 'huupe');

function runFixture(name, options = {}) {
  const parser = createHuupeParser({ year: 2026, ...options });
  const events = [];
  const lines = fs
    .readFileSync(path.join(FIXTURES, name), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
  for (const line of lines) {
    const event = parser.parse(line);
    if (event) events.push(event);
  }
  return { parser, events, lineCount: lines.length };
}

function zoneTally(shots) {
  return shots.reduce((tally, shot) => {
    tally[shot.zone] = (tally[shot.zone] || 0) + 1;
    return tally;
  }, {});
}

test('parses both logcat layouts and ignores capture-script banners', () => {
  const timeForm = parseLogLine(
    '08-27 01:25:40.783 I/ShotTracker( 2736): Get EVENT: {"a":1}',
    { year: 2026 },
  );
  assert.equal(timeForm.tag, 'ShotTracker');
  assert.equal(timeForm.pid, 2736);
  assert.equal(timeForm.deviceTime, '2026-08-27T01:25:40.783');
  assert.equal(timeForm.message, 'Get EVENT: {"a":1}');

  // threadtime is logcat's default, so the replay harness has to read it too.
  const threadForm = parseLogLine(
    '08-27 01:19:58.630  1168  1441 I newrelic: Harvester: Sending [0] session attributes.',
    { year: 2026 },
  );
  assert.equal(threadForm.tag, 'newrelic');
  assert.equal(threadForm.pid, 1168);
  assert.equal(threadForm.deviceTime, '2026-08-27T01:19:58.630');

  // A line that already carries its year (production runs with `-v year`).
  assert.equal(
    parseLogLine('2026-08-27 01:25:40.783 I/ShotTracker( 2736): x').deviceTime,
    '2026-08-27T01:25:40.783',
  );

  assert.equal(parseLogLine('=== MONITORING STARTED Wed Aug 26 19:25:32 MDT 2026 ==='), null);
  assert.equal(parseLogLine(''), null);
});

test('the same session captured with different tag filters yields identical shots', () => {
  // live-events.txt carries the HAL plus the app tag; endgame-targeted.txt is
  // the app tag alone. One physical shot is logged by up to three producers, so
  // agreeing on the count is what proves dedupe collapses across all of them.
  const withHal = runFixture('live-events.txt');
  const appOnly = runFixture('endgame-targeted.txt');

  const halShots = withHal.events.filter((event) => event.kind === 'shot');
  const appShots = appOnly.events.filter((event) => event.kind === 'shot');

  assert.equal(halShots.length, 36);
  assert.equal(appShots.length, 36);
  assert.equal(halShots.filter((shot) => shot.made).length, 8);
  assert.equal(appShots.filter((shot) => shot.made).length, 8);
  assert.deepEqual(zoneTally(halShots), { three: 23, one: 5, layup: 1, two: 7 });
  assert.deepEqual(zoneTally(appShots), zoneTally(halShots));
  assert.deepEqual(
    halShots.map((shot) => shot.streamTs),
    appShots.map((shot) => shot.streamTs),
  );

  // The extra producer means strictly more redundant lines to discard.
  assert.equal(withHal.parser.counters().duplicateShots, 72);
  assert.equal(appOnly.parser.counters().duplicateShots, 36);
});

test('free play carries a running session score from the HAL zone names', () => {
  // The HAL never states points, but `three_point_shot` and friends do, so a
  // session score is read off the data rather than invented.
  const { events } = runFixture('live-events.txt');
  const shots = events.filter((event) => event.kind === 'shot');
  const made = shots.filter((shot) => shot.made);

  const score = made.reduce((total, shot) => total + shot.points, 0);
  // 6 threes + 1 two + 1 one, from a real Just Huupe session.
  assert.equal(made.length, 8);
  assert.equal(shots.length, 36);
  assert.equal(score, 21);
  assert.equal(Math.round((100 * made.length) / shots.length), 22);

  // Misses still report what the zone was worth; callers add only on a make.
  const miss = shots.find((shot) => !shot.made && shot.zone === 'three');
  assert.equal(miss.points, 3);
});

test('the rim is worth a point in free play and a tenth in Family Mode', () => {
  // Free play's scoreboard has only 1pt / 2pt / 3pt counters, and a drop-in
  // from under the basket ticks the 1pt one. Scoring it as Family Mode's 0.1
  // left the running total 0.9 short of the hoop for every layup.
  const halLayup = parseShotMessage(
    'TOF: {"stream_ts": 1, "events": ["make_detected"], "shot_zone": "layup", "shot_range": 0.01 }',
  );
  const unityLayup = parseFamilyMessage('Did trashpanda Score From layup SHOT MADE = True');
  assert.equal(halLayup.points, 1);
  assert.equal(unityLayup.points, 0.1);
  // Same zone either way — only what it pays differs.
  assert.equal(halLayup.zone, unityLayup.zone);

  // Everywhere else the two scoreboards agree.
  for (const [halZone, unityZone] of [['one_point_shot', 'lowPost'], ['two_point_shot', 'highPost'], ['three_point_shot', 'topOfTheKey']]) {
    const hal = parseShotMessage(
      `TOF: {"stream_ts": 1, "events": ["make_detected"], "shot_zone": "${halZone}", "shot_range": 3 }`,
    );
    const unity = parseFamilyMessage(`Did trashpanda Score From ${unityZone} SHOT MADE = True`);
    assert.equal(hal.points, unity.points);
  }

  assert.equal(pointsTableForMode('justhuupe').layup, 1);
  assert.equal(pointsTableForMode('family').layup, 0.1);

  // An unrecognised zone declines to guess a value.
  assert.equal(pointsForZone('halfCourt'), null);
  assert.equal(pointsForZone('halfCourt', 'hal'), null);
  assert.equal(pointsForZone(null), null);
});

test('interference reports and steady-state chatter never reach the scoreboard', () => {
  const { parser, events } = runFixture('live-monitor.txt');
  const counters = parser.counters();

  const shots = events.filter((event) => event.kind === 'shot');
  assert.equal(shots.length, 3);
  assert.equal(shots.filter((shot) => shot.made).length, 2);
  assert.deepEqual(zoneTally(shots), { one: 1, three: 1, layup: 1 });

  // Both interference reports are dropped rather than counted as misses.
  assert.equal(counters.interference, 2);
  assert.ok(!events.some((event) => event.kind === 'interference'));

  // Queues/FPS/avc lines are classified as noise, not left to flood the admin
  // troubleshooting tail.
  assert.ok(counters.noise > 20);
  assert.equal(counters.unmatched, 0);
  assert.deepEqual(parser.unmatched(), []);

  assert.equal(events.filter((event) => event.kind === 'sensor-error').length, 2);
});

test('an unfiltered threadtime capture produces no false events', () => {
  const { parser, events } = runFixture('logcat-sample.txt');
  assert.deepEqual(events, []);

  const counters = parser.counters();
  assert.ok(counters.noise > 40);
  // Only the New Relic harvester lines are genuinely unrecognised.
  assert.deepEqual(
    [...new Set(parser.unmatched().map((entry) => entry.tag))],
    ['newrelic'],
  );
});

test('shot dedupe keys on the parsed float, not the printed string', () => {
  const parser = createHuupeParser({ year: 2026 });
  const shot = (streamTs) =>
    `08-27 01:25:47.347 I/ShotTracker( 2736): Get EVENT: {"stream_ts": ${streamTs}, "events": ["make_detected"], "shot_zone": "three_point_shot", "shot_range": 3.153128 }`;

  // The HAL prints six decimals; re-serialised copies drop the trailing zero.
  assert.ok(parser.parse(shot('622.501160')));
  assert.equal(parser.parse(shot('622.50116')), null);
  assert.equal(parser.counters().duplicateShots, 1);
});

test('a HAL restart rewinds stream_ts without swallowing the next session', () => {
  const parser = createHuupeParser({ year: 2026 });
  const shot = (streamTs) =>
    `08-27 01:25:47.347 I/ShotTracker( 2736): Get EVENT: {"stream_ts": ${streamTs}, "events": ["make_detected"], "shot_zone": "layup", "shot_range": 0.01 }`;

  assert.ok(parser.parse(shot('900.0')));
  // Service restarted: the counter starts over, and those are real new shots.
  assert.ok(parser.parse(shot('1.5')));
  assert.ok(parser.parse(shot('900.0')));
  assert.equal(parser.counters().duplicateShots, 0);
});

test('shot payloads normalise zone and drop the -1 range sentinel', () => {
  const made = parseShotMessage(
    'TOF: {"stream_ts": 633.651184, "events": ["make_detected"], "shot_zone": "layup", "shot_range": 0.010000 }',
  );
  assert.equal(made.kind, 'shot');
  assert.equal(made.made, true);
  assert.equal(made.zone, 'layup');
  assert.equal(made.rawZone, 'layup');

  const interference = parseShotMessage(
    'RDM: {"stream_ts": 613.283569, "events": ["signal_interference_detected"], "shot_zone": "", "shot_range": -1.000000 }',
  );
  assert.equal(interference.kind, 'interference');

  assert.equal(parseShotMessage('Get EVENT: not json'), null);
  assert.equal(parseShotMessage('Queues [Usb=2,Rdm=0,Tof=0,Shottracker=0]'), null);
});

test('Family Mode standings are read before the bare scored form', () => {
  // Both lines contain "scored", so ordering decides whether the player name
  // comes out as "trashpanda" or "trashpanda has".
  const standings = parseFamilyMessage('trashpanda has scored 15.1 points and got 1 Position');
  assert.deepEqual(standings, {
    kind: 'standings',
    player: 'trashpanda',
    points: 15.1,
    position: 1,
  });

  const scored = parseFamilyMessage('Player 1 scored 0.1');
  assert.deepEqual(scored, { kind: 'scored', player: 'Player 1', points: 0.1 });

  assert.deepEqual(parseFamilyMessage('startProcessing: started'), {
    kind: 'processing',
    state: 'started',
  });

  assert.deepEqual(parseFamilyMessage('Did Player 2 Score From topOfTheKey SHOT MADE = False'), {
    kind: 'shot-made',
    player: 'Player 2',
    unityZone: 'topOfTheKey',
    zone: 'three',
    points: 3,
    made: false,
  });

  assert.equal(parseFamilyMessage('some unrelated Unity chatter'), null);
});

test('winner is the zero position in a full standings block', () => {
  const rows = [
    'Player 1 has scored 23.1 points and got 0 Position',
    'trashpanda has scored 15.1 points and got 1 Position',
    'Player 2 has scored 13 points and got 2 Position',
  ].map(parseFamilyMessage);

  assert.deepEqual(
    rows.map((row) => row.player),
    ['Player 1', 'trashpanda', 'Player 2'],
  );
  assert.equal(rows.find((row) => row.position === 0).player, 'Player 1');
  assert.equal(rows[2].points, 13);
});

test('the end-of-game blob is extracted from a wrapping log message', () => {
  const blob = {
    uniqueScoreId: '8/27/2026 1:46:19 AMtrashpanda09fe489d-a6fd-4ae6-8de9-8c95267ef9a9',
    combination: {
      gameStateType: 'Offline',
      gameConfiguration: '1v1v1',
      gameTimeType: '1 minute',
      gameModeType: 'Classic',
    },
    stats: { score: 15.1, hasWon: false, longestStreak: 2, threePointersMade: 3 },
  };
  const parsed = parseEndGameMessage(`Uploading stats: ${JSON.stringify(blob)} done`);
  assert.equal(parsed.kind, 'game-end');
  assert.equal(parsed.uniqueScoreId, blob.uniqueScoreId);
  assert.equal(parsed.combination.gameConfiguration, '1v1v1');
  assert.equal(parsed.stats.score, 15.1);

  assert.equal(parseEndGameMessage('no blob here'), null);
  assert.equal(parseEndGameMessage('uniqueScoreId but {broken json'), null);
});

test('focus lines resolve a Huupe package to a mode and ignore everything else', () => {
  const started = parseFocusMessage(
    'START u0 {act=android.intent.action.MAIN cmp=com.game.huupecityroyale/com.unity3d.player.UnityPlayerActivity}',
  );
  assert.equal(started.package, 'com.game.huupecityroyale');
  assert.equal(started.mode, 'family');

  const displayed = parseFocusMessage(
    'Displayed com.huupe.justhuupe/.MainActivity: +1s234ms',
  );
  assert.equal(displayed.mode, 'justhuupe');

  const deepLink = parseFocusMessage(
    'START u0 {dat=unitydl://cityroyale?x=1&gameMode=OfflineMode cmp=com.game.huupecityroyale/.Main}',
  );
  assert.equal(deepLink.deepLink, 'unitydl://cityroyale?x=1&gameMode=OfflineMode');

  assert.equal(parseFocusMessage('START u0 {cmp=com.android.settings/.Settings}'), null);
  assert.equal(modeForPackage('com.example.other'), null);
  assert.equal(modeForPackage('com.huupe.countdown'), 'countdown');
  assert.ok(LOGCAT_TAGS.includes('HuupeCountdown'));
});

test('HuupeCountdown log lines parse start, shot and end', () => {
  const start = parseCountdownMessage(
    '{"v":1,"ev":"start","id":"m1","start":51,"diff":"EXACT","layup":1,"seats":[{"id":"p-luis","name":"Luis","bot":false},{"id":"p-alex","name":"Alex","bot":true}]}',
  );
  assert.equal(start.kind, 'countdown-start');
  assert.equal(start.startScore, 51);
  assert.equal(start.difficulty, 'EXACT');
  assert.equal(start.seats[1].bot, true);

  const shot = parseCountdownMessage(
    '{"v":1,"ev":"shot","id":"m1","seat":0,"name":"Bot Pro","bot":true,"zone":"DEEP","made":true,"pts":3,"left":48,"attempt":1,"bust":false,"win":false}',
  );
  assert.equal(shot.kind, 'countdown-shot');
  assert.equal(shot.zone, 'three');
  assert.equal(shot.left, 48);
  assert.equal(shot.name, 'Bot Pro');
  assert.equal(shot.bot, true);

  const nameless = parseCountdownMessage(
    '{"v":1,"ev":"shot","id":"m1","seat":1,"zone":"SHORT","made":true,"pts":1,"left":20,"attempt":2,"bust":false,"win":false}',
  );
  assert.equal(nameless.name, '');
  assert.equal(nameless.bot, null);

  const bust = parseCountdownMessage(
    '{"v":1,"ev":"shot","id":"m1","seat":0,"zone":"DEEP","made":true,"pts":3,"left":2,"attempt":1,"bust":true,"win":false}',
  );
  assert.equal(bust.bust, true);
  assert.equal(bust.left, 2);

  // A seat with no numbers on the line is unknown, not sitting on zero.
  assert.equal(start.seats[0].left, null);

  const ended = parseCountdownMessage(
    '{"v":1,"ev":"end","id":"m1","winnerId":"p-luis","winner":"Luis","reason":"win","seats":[{"id":"p-luis","name":"Luis","left":0,"scored":51,"made":9,"att":12,"threes":2}]}',
  );
  assert.equal(ended.kind, 'countdown-end');
  assert.equal(ended.seats[0].scored, 51);
  assert.equal(parseCountdownMessage('{"v":1,"ev":"start","id":"m1","start":12,"diff":"EXACT"}'), null);

  // An attempt is addressed by turn and attempt so a later fix can find it.
  const addressed = parseCountdownMessage(
    '{"v":1,"ev":"shot","id":"m1","seat":0,"name":"Luis","bot":false,"zone":"MID","made":true,"pts":2,"left":16,"turn":2,"attempt":3,"bust":false,"win":false,"madeN":4,"att":6}',
  );
  assert.equal(addressed.turn, 2);
  assert.equal(addressed.attempt, 3);
  assert.equal(addressed.madeN, 4);
  assert.equal(addressed.attemptsSoFar, 6);
  // An older APK does not address its attempts, and must not read as turn 0.
  assert.equal(shot.turn, null);
  assert.equal(shot.madeN, null);

  const parser = createHuupeParser({ year: 2026 });
  const line = parser.parse(
    '09-09 18:01:02.120  4321  4321 I HuupeCountdown: {"v":1,"ev":"shot","id":"m1","seat":0,"zone":"SHORT","made":true,"pts":1,"left":20,"attempt":2,"bust":false,"win":false}',
  );
  assert.equal(line.kind, 'countdown-shot');
  assert.equal(line.seat, 0);
  assert.equal(line.zone, 'one');
});

test('a Countdown fix names the attempt it corrects, and an undo deletes it', () => {
  const retake = parseCountdownMessage(
    '{"v":1,"ev":"fix","id":"m1","seat":0,"name":"Luis","bot":false,"how":"retake","turn":3,"attempt":1,"wasZone":"DEEP","wasPts":3,"gone":false,"zone":"MISS","made":false,"pts":0,"left":2,"turnPts":0,"bust":false,"win":false,"madeN":4,"att":8}',
  );
  assert.equal(retake.kind, 'countdown-fix');
  assert.equal(retake.how, 'retake');
  assert.equal(retake.turn, 3);
  assert.equal(retake.attempt, 1);
  assert.equal(retake.wasZone, 'three');
  assert.equal(retake.zone, null);
  assert.equal(retake.gone, false);
  // `bust: false` on a fix hands back a bust an earlier shot line reported.
  assert.equal(retake.bust, false);
  assert.equal(retake.turnPoints, 0);
  assert.equal(retake.madeN, 4);
  assert.equal(retake.attemptsSoFar, 8);

  const undone = parseCountdownMessage(
    '{"v":1,"ev":"fix","id":"m1","seat":0,"name":"Luis","bot":false,"how":"undo","turn":3,"attempt":1,"wasZone":"DEEP","wasPts":3,"gone":true,"zone":"MISS","made":false,"pts":0,"left":2,"turnPts":0,"bust":false,"win":false,"madeN":4,"att":7}',
  );
  assert.equal(undone.gone, true);
  assert.equal(undone.attemptsSoFar, 7);

  // Only the three ways an attempt can change, and only at a real address.
  assert.equal(parseCountdownMessage(
    '{"v":1,"ev":"fix","id":"m1","seat":0,"how":"nudge","turn":1,"attempt":1,"zone":"MISS"}',
  ), null);
  assert.equal(parseCountdownMessage(
    '{"v":1,"ev":"fix","id":"m1","seat":0,"how":"hand","attempt":1,"zone":"MISS"}',
  ), null);
});

test('a Countdown retake brackets the attempt in doubt without scoring it', () => {
  const armed = parseCountdownMessage(
    '{"v":1,"ev":"retake","id":"m1","seat":0,"name":"Luis","bot":false,"state":"armed","turn":3,"attempt":2,"zone":"MISS","pts":0}',
  );
  assert.equal(armed.kind, 'countdown-retake');
  assert.equal(armed.state, 'armed');
  assert.equal(armed.turn, 3);
  assert.equal(armed.attempt, 2);
  assert.equal(armed.zone, null);

  const stoodDown = parseCountdownMessage(
    '{"v":1,"ev":"retake","id":"m1","seat":0,"name":"Luis","bot":false,"state":"cancelled","turn":3,"attempt":2,"zone":"DEEP","pts":3}',
  );
  assert.equal(stoodDown.state, 'cancelled');
  assert.equal(stoodDown.zone, 'three');

  // There is deliberately no `landed`: a retake that lands is reported as a fix.
  assert.equal(parseCountdownMessage(
    '{"v":1,"ev":"retake","id":"m1","seat":0,"state":"landed","turn":3,"attempt":2,"zone":"DEEP","pts":3}',
  ), null);
  // An event nobody knows is skipped, not fatal.
  assert.equal(parseCountdownMessage('{"v":1,"ev":"heartbeat","id":"m1"}'), null);
});

test('a real hoop Countdown shot carries the seat name; HAL stays a HAL shot', () => {
  const parser = createHuupeParser({ year: 2026 });
  const named = parser.parse(
    '09-10 00:32:51.962  3032  3032 I HuupeCountdown: {"v":1,"ev":"shot","id":"bd676b2f-9244-4b34-b674-3de7f7d6f563","seat":0,"name":"TRASHPANDA","bot":false,"zone":"DEEP","made":true,"pts":3,"left":6,"attempt":2,"bust":false,"win":false}',
  );
  assert.equal(named.kind, 'countdown-shot');
  assert.equal(named.name, 'TRASHPANDA');
  assert.equal(named.bot, false);
  assert.equal(named.seat, 0);

  const bot = parser.parse(
    '09-10 00:32:37.480  3032  3032 I HuupeCountdown: {"v":1,"ev":"shot","id":"bd676b2f-9244-4b34-b674-3de7f7d6f563","seat":2,"name":"Bot Pro","bot":true,"zone":"DEEP","made":true,"pts":3,"left":15,"attempt":2,"bust":false,"win":false}',
  );
  assert.equal(bot.name, 'Bot Pro');
  assert.equal(bot.bot, true);

  const hal = parser.parse(
    '09-10 00:32:51.956   339   339 I huupe.hardware.shottracker-tof-service: TOF: {"stream_ts": 2423.831543, "events": ["make_detected"], "shot_zone": "three_point_shot", "shot_range": 5.753076 }',
  );
  assert.equal(hal.kind, 'shot');
  assert.equal(hal.zone, 'three');
  assert.equal(hal.name, undefined);

  const onTracker = parser.parse(
    '09-10 00:32:51.962  2736  2736 I ShotTracker: Get EVENT: {"v":1,"ev":"shot","id":"m1","seat":0,"name":"TRASHPANDA","bot":false,"zone":"DEEP","made":true,"pts":3,"left":6,"attempt":2,"bust":false,"win":false}',
  );
  assert.equal(onTracker, null);
});

test('real ActivityTaskManager lines from the hoop resolve a foreground package', () => {
  // Captured verbatim from the device, so these two shapes are confirmed rather
  // than assumed.
  const parser = createHuupeParser({ year: 2026 });
  const started = parser.parse(
    '08-27 03:05:16.015   491   506 I ActivityTaskManager: START u0 {act=android.intent.action.MAIN cat=[android.intent.category.HOME] flg=0x10000100 cmp=com.acdetorres.huuplauncher/.Screens.MainActivity (has extras)} from uid 0',
  );
  assert.equal(started.kind, 'focus');
  assert.equal(started.package, 'com.acdetorres.huuplauncher');
  assert.equal(started.mode, 'launcher');

  const displayed = parser.parse(
    '08-27 03:05:20.903   491   512 I ActivityTaskManager: Displayed com.acdetorres.huuplauncher/.Screens.MainActivity: +4s818ms',
  );
  assert.equal(displayed.mode, 'launcher');
});

test('profile-dump tags never reach the admin buffer', () => {
  // The launcher logs the whole signed-in profile on every sync. Shape copied
  // from the device; values here are synthetic.
  const parser = createHuupeParser({ year: 2026 });
  const blob =
    '{"basicInformation":{"email":"someone@example.com"},"secretInformation":{"passwordHash":"AAAABBBBCCCC=","passwordSalt":"TestSalt1"}}';

  assert.equal(
    parser.parse(`08-27 03:05:23.689  1027  1304 V OKPRFL_cf19xak_RSB: ${blob}`),
    null,
  );
  assert.equal(parser.parse(`08-27 03:05:23.695  1027  1389 I okhttp.OkHttpClient: ${blob}`), null);

  assert.deepEqual(parser.unmatched(), []);
  assert.equal(parser.counters().redacted, 2);
});

test('anything that does reach the buffer is scrubbed and truncated', () => {
  const parser = createHuupeParser({ year: 2026 });
  parser.parse(
    '08-27 03:05:23.689  1027  1304 I Unity: user someone@example.com token=abc123 from 66.118.45.178 on 192.168.200.216',
  );
  const [entry] = parser.unmatched();

  assert.ok(!entry.message.includes('someone@example.com'));
  assert.ok(!entry.message.includes('abc123'));
  assert.ok(entry.message.includes('[email]'));
  assert.ok(entry.message.includes('[redacted]'));
  // Public address hidden, LAN address kept because it is useful for debugging.
  assert.ok(!entry.message.includes('66.118.45.178'));
  assert.ok(entry.message.includes('192.168.200.216'));

  assert.equal(
    redactSensitive('bearer eyJhbGciOiJIUzI1NiJ9.AAAABBBBCCCC.DDDDEEEEFFFF'),
    'bearer [jwt]',
  );
  assert.ok(redactSensitive('x'.repeat(500)).endsWith('...[truncated]'));
});

// The scoreboard on the hoop at the end of this captured 1v1v1, photographed so
// the parser can be checked against what a human actually saw.
const SCOREBOARD = {
  'Player 2': { position: 0, score: 17.3, threes: 5, fgPct: 43 },
  trashpanda: { position: 1, score: 17.1, threes: 4, fgPct: 47 },
  'Player 1': { position: 2, score: 10.1, threes: 3, fgPct: 24 },
};

test('a real Family Mode game reproduces the on-screen final scoreboard', () => {
  const { events } = runFixture('family-mode-1v1v1.txt');

  const standings = events.filter((event) => event.kind === 'standings');
  assert.equal(standings.length, 3);
  for (const row of standings) {
    const expected = SCOREBOARD[row.player];
    assert.ok(expected, `unexpected player ${row.player}`);
    assert.equal(row.position, expected.position);
    assert.equal(row.score ?? row.points, expected.score);
  }
  assert.equal(standings.find((row) => row.position === 0).player, 'Player 2');

  // Per-player shooting is derived from the Unity per-shot lines, which cover
  // guests too — the stats upload only ever describes the signed-in profile.
  const perPlayer = new Map();
  for (const event of events.filter((entry) => entry.kind === 'shot-made')) {
    const row = perPlayer.get(event.player) || { made: 0, attempts: 0, threes: 0 };
    row.attempts += 1;
    if (event.made) {
      row.made += 1;
      if (event.zone === 'three') row.threes += 1;
    }
    perPlayer.set(event.player, row);
  }

  for (const [player, expected] of Object.entries(SCOREBOARD)) {
    const row = perPlayer.get(player);
    assert.ok(row, `no shots parsed for ${player}`);
    assert.equal(Math.round((100 * row.made) / row.attempts), expected.fgPct, `FG% for ${player}`);
    assert.equal(row.threes, expected.threes, `3-pointers for ${player}`);
  }
});

test('scored totals reconstruct each score on the board', () => {
  const { events } = runFixture('family-mode-1v1v1.txt');
  const totals = new Map();
  for (const event of events.filter((entry) => entry.kind === 'scored')) {
    totals.set(event.player, (totals.get(event.player) || 0) + event.points);
  }
  for (const [player, expected] of Object.entries(SCOREBOARD)) {
    // Float addition of 0.1 layups needs a tolerance.
    assert.ok(
      Math.abs(totals.get(player) - expected.score) < 1e-9,
      `${player}: ${totals.get(player)} != ${expected.score}`,
    );
  }
});

test('turn boundaries survive the trailing period the device writes', () => {
  const { events } = runFixture('family-mode-1v1v1.txt');
  const processing = events.filter((event) => event.kind === 'processing');
  // "startProcessing: started." — an anchored match without the optional period
  // silently drops every turn boundary in the game.
  assert.ok(processing.length >= 8);
  assert.ok(processing.some((event) => event.state === 'started'));
  assert.ok(processing.some((event) => event.state === 'paused'));
  assert.deepEqual(parseFamilyMessage('startProcessing: started.'), {
    kind: 'processing',
    state: 'started',
  });
});

test('the final-scoreboard screen is a reliable end-of-game trigger', () => {
  const { events } = runFixture('family-mode-1v1v1.txt');
  const finals = events.filter((event) => event.kind === 'final-screen');
  assert.ok(finals.length >= 1);
  // It opens before the stats upload, which may never parse.
  const firstFinal = events.indexOf(finals[0]);
  const gameEnd = events.findIndex((event) => event.kind === 'game-end');
  assert.ok(firstFinal < gameEnd || gameEnd === -1);
});

test('a truncated stats upload still yields identity and stats', () => {
  const { events } = runFixture('family-mode-1v1v1.txt');
  const ended = events.find((event) => event.kind === 'game-end');
  assert.ok(ended, 'no game-end parsed');

  // logcat cut the real blob mid-token inside profileId.
  assert.equal(ended.truncated, true);
  assert.match(ended.uniqueScoreId, /trashpanda/);
  assert.equal(ended.combination.gameConfiguration, '1v1v1');
  assert.equal(ended.combination.gameModeType, 'Classic');

  // The stats object closed before the cut, so it is fully recoverable, and it
  // agrees with the signed-in player's line on the board.
  assert.equal(ended.stats.score, SCOREBOARD.trashpanda.score);
  assert.equal(ended.stats.threePointersMade, SCOREBOARD.trashpanda.threes);
  assert.equal(ended.stats.halfPointersMade, 1);
});

test('Unity zones carry the point values the game awarded', () => {
  const layup = parseFamilyMessage('Did trashpanda Score From layup SHOT MADE = True');
  assert.equal(layup.zone, 'layup');
  assert.equal(layup.points, 0.1);

  assert.equal(parseFamilyMessage('Did A Score From lowPost SHOT MADE = True').points, 1);
  assert.equal(parseFamilyMessage('Did A Score From highPost SHOT MADE = True').points, 2);
  assert.equal(parseFamilyMessage('Did A Score From topOfTheKey SHOT MADE = True').points, 3);

  // An unseen zone degrades rather than guessing a score.
  const unknown = parseFamilyMessage('Did A Score From halfCourt SHOT MADE = True');
  assert.equal(unknown.zone, null);
  assert.equal(unknown.points, null);
});

test('a deep link never carries its bearer token onward', () => {
  // City Royale launches with ?userId=...&token=<JWT>.
  const focus = parseFocusMessage(
    'START u0 {dat=unitydl://cityroyale?userId=trashpanda&token=eyJhbGciOiJIUzI1NiJ9.AAAABBBBCCCC.DDDDEEEEFFFF cmp=com.game.huupecityroyale/.Main}',
  );
  assert.equal(focus.mode, 'family');
  assert.ok(!focus.deepLink.includes('eyJhbGciOiJIUzI1NiJ9'));
  assert.ok(focus.deepLink.includes('[redacted]') || focus.deepLink.includes('[jwt]'));
  // The non-secret part stays readable for debugging.
  assert.ok(focus.deepLink.includes('cityroyale'));
});

test('the unmatched buffer is bounded so a chatty tag cannot grow it forever', () => {
  const parser = createHuupeParser({ year: 2026, unmatchedLimit: 5 });
  for (let i = 0; i < 40; i += 1) {
    parser.parse(`08-27 01:25:40.783 I/Unity( 2736): mystery line ${i}`);
  }
  const unmatched = parser.unmatched();
  assert.equal(unmatched.length, 5);
  // Oldest evicted, newest retained.
  assert.equal(unmatched.at(-1).message, 'mystery line 39');
  assert.equal(unmatched[0].message, 'mystery line 35');
  assert.equal(parser.counters().unmatched, 40);
});

test('reset clears counters, dedupe and the unmatched buffer', () => {
  const parser = createHuupeParser({ year: 2026 });
  const shot =
    '08-27 01:25:47.347 I/ShotTracker( 2736): Get EVENT: {"stream_ts": 622.501160, "events": ["make_detected"], "shot_zone": "layup", "shot_range": 0.01 }';
  assert.ok(parser.parse(shot));
  parser.parse('08-27 01:25:40.783 I/Unity( 2736): mystery');
  parser.reset();

  assert.deepEqual(parser.unmatched(), []);
  assert.equal(parser.counters().lines, 0);
  // Dedupe forgot the shot, so the identical line counts again.
  assert.ok(parser.parse(shot));
});
