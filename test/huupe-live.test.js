/**
 * Session state machine for the Huupe Mini.
 *
 * The hoop never announces a game — it only reports shots — so almost every
 * behaviour worth testing here is an inference: when shooting counts as a
 * session, when silence counts as the end of one, and what happens on the wall
 * when the hoop is switched off mid-game and never says anything again.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createHuupeLive,
  MIN_PUSH_INTERVAL_MS,
  STREAM_LOSS_GRACE_MS,
  STANDINGS_SETTLE_MS,
  SUPPRESS_FALLBACK_MS,
} = require('../src/huupe-live');
const payload = require('../src/huupe-payload');

const SILENT = { info() {}, warn() {}, error() {}, debug() {} };

const LIVE_DEFAULTS = {
  autoPush: true,
  inactivityMinutes: 5,
  finalHoldSeconds: 60,
  minShotsToOpen: 2,
};

function harness(liveOverrides = {}, { displayBusy = null, archiveThrows = false } = {}) {
  let nowMs = Date.UTC(2026, 7, 20, 18, 0, 0);
  const sent = [];
  const archived = [];
  const recomputes = [];

  const live = createHuupeLive({
    displayBusy,
    settings: { get: () => ({ live: { ...LIVE_DEFAULTS, ...liveOverrides } }) },
    archive: {
      append(row) {
        if (archiveThrows) throw new Error('disk full');
        archived.push(row);
        return { ok: true, deduped: false };
      },
      listAll: () => archived.slice(),
    },
    aggregates: { recompute: (rows) => recomputes.push(rows.length) },
    payload,
    sendUdpPayload: (body) => {
      sent.push(body);
      return { ok: true };
    },
    log: SILENT,
    now: () => nowMs,
    setTimer: () => null,
    clearTimer: () => {},
  });

  return {
    live,
    sent,
    archived,
    recomputes,
    advance(ms) {
      nowMs += ms;
      return nowMs;
    },
    sessions: () => sent.filter((body) => body.type === 'huupe.session'),
    closes: () => sent.filter((body) => body.type === 'huupe.session.close'),
    latest: () => sent.filter((body) => body.type === 'huupe.session').at(-1),
  };
}

/** A free-play shot as the HAL reports it: no player, points implied by zone. */
function shot({ made = true, zone = 'two', points = 2 } = {}) {
  return { kind: 'shot', made, zone, points: made ? points : 0, range: 4.2 };
}

/** Family Mode's Unity stream: the only source that knows whose shot it was. */
function shotMade(player, { made = true, zone = 'two', points = 2 } = {}) {
  return { kind: 'shot-made', player, made, zone, points };
}

/** Leaves the clock sitting exactly on the push that opened the session. */
function openFreePlay(kit, { shots = 2 } = {}) {
  for (let index = 0; index < shots; index += 1) {
    if (index) kit.advance(MIN_PUSH_INTERVAL_MS);
    kit.live.handleEvent(shot());
  }
}

test('sustained shooting opens a session and takes the wall', () => {
  const kit = harness();
  openFreePlay(kit);
  const card = kit.latest();
  assert.ok(card, 'expected a session card on the wire');
  assert.equal(card.type, 'huupe.session');
  assert.equal(card.session.status, 'live');
  assert.equal(card.persistent, true);
  assert.equal(card.displaySeconds, 0);
});

test('a single stray bounce is not a session', () => {
  // Someone walking past and tapping the ball should never light up the wall.
  const kit = harness();
  kit.live.handleEvent(shot());
  assert.equal(kit.sessions().length, 0);
  assert.equal(kit.live.currentSession(), null);
});

test('the shot count that opens a session is configurable', () => {
  const kit = harness({ minShotsToOpen: 4 });
  openFreePlay(kit, { shots: 3 });
  assert.equal(kit.sessions().length, 0);
  kit.live.handleEvent(shot());
  assert.equal(kit.sessions().length, 1);
});

test('free play scores the session in front of you, not a career total', () => {
  const kit = harness();
  openFreePlay(kit);
  kit.advance(MIN_PUSH_INTERVAL_MS);
  kit.live.handleEvent(shot({ zone: 'three', points: 3 }));
  const first = kit.latest().session.stats.points;

  kit.live.handleEvent({ kind: 'focus', mode: 'launcher' });
  kit.advance(60_000);
  openFreePlay(kit);
  assert.equal(kit.latest().session.stats.points, 4, 'a new session starts from zero');
  assert.ok(first > 4, 'the first session had banked more than the second');
});

test('free play scores a layup as the one-pointer the hoop counts it as', () => {
  // The hoop's free-play scoreboard has no tenths — a drop-in from under the
  // basket ticks its 1pt counter, so two of them are two points, not 0.2.
  const kit = harness();
  kit.live.handleEvent(shot({ zone: 'layup', points: 1 }));
  kit.advance(MIN_PUSH_INTERVAL_MS);
  kit.live.handleEvent(shot({ zone: 'layup', points: 1 }));
  assert.equal(kit.latest().session.stats.points, 2);
  assert.equal(kit.latest().session.stats.pointsLabel, '2');
});

test('missed shots count against accuracy without adding points', () => {
  const kit = harness();
  kit.live.handleEvent(shot({ made: true, zone: 'two', points: 2 }));
  kit.advance(MIN_PUSH_INTERVAL_MS);
  kit.live.handleEvent(shot({ made: false, zone: 'two' }));
  const stats = kit.latest().session.stats;
  assert.equal(stats.attempts, 2);
  assert.equal(stats.made, 1);
  assert.equal(stats.points, 2);
  assert.equal(stats.fgPct, 50);
});

test('a run of makes is tracked and a miss resets it', () => {
  const kit = harness();
  for (let index = 0; index < 3; index += 1) {
    kit.live.handleEvent(shot());
    kit.advance(MIN_PUSH_INTERVAL_MS);
  }
  assert.equal(kit.latest().session.stats.streak, 3);
  kit.live.handleEvent(shot({ made: false }));
  kit.advance(MIN_PUSH_INTERVAL_MS);
  kit.live.handleEvent(shot());
  const stats = kit.latest().session.stats;
  assert.equal(stats.streak, 1);
  assert.equal(stats.bestStreak, 3);
});

test('the shot ticker keeps the tail of the session, newest last', () => {
  const kit = harness();
  openFreePlay(kit);
  kit.advance(MIN_PUSH_INTERVAL_MS);
  kit.live.handleEvent(shot({ made: false, zone: 'three', points: 3 }));
  kit.advance(MIN_PUSH_INTERVAL_MS);
  kit.live.handleEvent(shot({ zone: 'layup', points: 1 }));
  const ticker = kit.latest().session.recentShots;
  assert.deepEqual(ticker.at(-1), { made: true, zone: 'layup', short: 'LAY', provisional: false });
  assert.deepEqual(ticker.at(-2), { made: false, zone: 'three', short: '3PT', provisional: false });
  assert.equal(ticker.length, 4);

  // A long session cannot grow the payload without bound.
  for (let index = 0; index < 40; index += 1) {
    kit.advance(MIN_PUSH_INTERVAL_MS);
    kit.live.handleEvent(shot());
  }
  assert.equal(kit.latest().session.recentShots.length, 18);
});

test('Unity taking over clears the ticker it is about to replay', () => {
  // The same shots arrive twice in Family Mode; a ticker that kept both would
  // show every basket as two dots.
  const kit = harness();
  openFreePlay(kit);
  assert.equal(kit.latest().session.recentShots.length, 2);
  kit.advance(MIN_PUSH_INTERVAL_MS);
  kit.live.handleEvent(shotMade('Jo'));
  assert.deepEqual(kit.latest().session.recentShots, [
    { made: true, zone: 'two', short: '2PT', provisional: false },
  ]);
});

test('a burst of shots is coalesced into one push rather than a flood', () => {
  const kit = harness();
  openFreePlay(kit);
  const before = kit.sessions().length;
  for (let index = 0; index < 5; index += 1) kit.live.handleEvent(shot());
  assert.equal(kit.sessions().length, before, 'no extra pushes inside the window');
});

test('a coalesced push lands on the next tick', () => {
  const kit = harness();
  openFreePlay(kit);
  const before = kit.sessions().length;
  kit.live.handleEvent(shot());
  kit.advance(MIN_PUSH_INTERVAL_MS);
  kit.live.tick();
  assert.equal(kit.sessions().length, before + 1);
});

test('once Unity takes over, the hardware stream stops scoring', () => {
  // Family Mode reports every shot twice; counting both would double the score.
  const kit = harness();
  kit.live.handleEvent(shotMade('Jo'));
  kit.advance(MIN_PUSH_INTERVAL_MS);
  kit.live.handleEvent(shot());
  kit.advance(MIN_PUSH_INTERVAL_MS);
  kit.live.handleEvent(shotMade('Jo'));
  const stats = kit.latest().session.stats;
  assert.equal(stats.attempts, 2, 'only the Unity shots were counted');
  assert.equal(stats.made, 2);
});

test('Family Mode keeps a line for every player', () => {
  const kit = harness();
  kit.live.handleEvent(shotMade('Jo', { zone: 'three', points: 3 }));
  kit.advance(MIN_PUSH_INTERVAL_MS);
  kit.live.handleEvent(shotMade('Sam', { zone: 'two', points: 2 }));
  const players = kit.latest().session.players;
  assert.deepEqual(players.map((row) => row.name).sort(), ['Jo', 'Sam']);
  assert.equal(players.find((row) => row.name === 'Jo').made, 1);
});

test('a score line from Unity is a running total, not a delta', () => {
  const kit = harness();
  kit.live.handleEvent(shotMade('Jo'));
  kit.advance(MIN_PUSH_INTERVAL_MS);
  kit.live.handleEvent({ kind: 'scored', player: 'Jo', points: 8.1 });
  kit.advance(MIN_PUSH_INTERVAL_MS);
  kit.live.handleEvent({ kind: 'scored', player: 'Jo', points: 11.1 });
  const jo = kit.latest().session.players.find((row) => row.name === 'Jo');
  assert.equal(jo.score, 11.1, 'the later total replaces the earlier one');
});

test('the final screen ends the game and posts a card with a countdown', () => {
  const kit = harness();
  openFreePlay(kit);
  kit.live.handleEvent({ kind: 'final-screen' });
  const card = kit.latest();
  assert.equal(card.session.status, 'finished');
  assert.equal(card.persistent, false);
  assert.equal(card.displaySeconds, LIVE_DEFAULTS.finalHoldSeconds);
});

test('the final card is cleared once its hold has elapsed', () => {
  const kit = harness({ finalHoldSeconds: 30 });
  openFreePlay(kit);
  kit.live.handleEvent({ kind: 'final-screen' });
  kit.live.tick();
  assert.equal(kit.closes().length, 0, 'still inside the hold');
  kit.advance(30_000);
  kit.live.tick();
  assert.equal(kit.closes().length, 1);
});

test('standings settle before the game is called', () => {
  const kit = harness();
  kit.live.handleEvent(shotMade('Jo'));
  kit.advance(MIN_PUSH_INTERVAL_MS);
  kit.live.handleEvent(shotMade('Sam'));
  kit.advance(MIN_PUSH_INTERVAL_MS);
  kit.live.handleEvent({ kind: 'standings', player: 'Jo', points: 17.1, position: 0 });
  kit.live.handleEvent({ kind: 'standings', player: 'Sam', points: 12.9, position: 1 });
  kit.live.tick();
  assert.equal(kit.latest().session.status, 'live', 'more standings may still arrive');

  kit.advance(STANDINGS_SETTLE_MS);
  kit.live.tick();
  const card = kit.latest();
  assert.equal(card.session.status, 'finished');
  assert.equal(card.session.winner, 'Jo');
});

test('the winner is listed first regardless of the order standings arrived', () => {
  const kit = harness();
  kit.live.handleEvent(shotMade('Sam'));
  kit.advance(MIN_PUSH_INTERVAL_MS);
  kit.live.handleEvent(shotMade('Jo'));
  kit.advance(MIN_PUSH_INTERVAL_MS);
  kit.live.handleEvent({ kind: 'standings', player: 'Sam', points: 9, position: 2 });
  kit.live.handleEvent({ kind: 'standings', player: 'Jo', points: 17.1, position: 0 });
  kit.advance(STANDINGS_SETTLE_MS);
  kit.live.tick();
  assert.deepEqual(kit.latest().session.players.map((row) => row.name), ['Jo', 'Sam']);
});

test('a session that goes quiet is finished and archived', () => {
  const kit = harness({ inactivityMinutes: 2 });
  openFreePlay(kit);
  kit.advance(2 * 60_000);
  kit.live.tick();
  assert.equal(kit.archived.length, 1);
  assert.equal(kit.archived[0].endReason, 'inactivity');
  assert.equal(kit.latest().session.status, 'finished');
});

test('an almost-empty session is dropped rather than archived', () => {
  const kit = harness({ inactivityMinutes: 2, minShotsToOpen: 1 });
  kit.live.handleEvent(shot());
  kit.advance(2 * 60_000);
  kit.live.tick();
  assert.equal(kit.archived.length, 0, 'one shot is noise, not a game');
});

test('a hoop switched off mid-game still shows the score before letting go', () => {
  // The hoop dropping off ADB says nothing about whether anyone is still
  // standing in front of the wall, so a game with a result on it gets the same
  // final card a clean end gets — and the hold still frees the display after.
  const kit = harness({ finalHoldSeconds: 30 });
  openFreePlay(kit);
  kit.live.handleStreamState({ connected: true });
  kit.live.handleStreamState({ connected: false, reason: 'device offline' });
  kit.advance(STREAM_LOSS_GRACE_MS);
  kit.live.tick();
  const card = kit.latest();
  assert.equal(card.session.status, 'finished');
  assert.equal(card.persistent, false);
  assert.equal(card.displaySeconds, 30);
  assert.equal(kit.closes().length, 0, 'the wall keeps the result for the hold');
  assert.equal(kit.live.currentSession(), null);
  assert.equal(kit.archived[0].aborted, true);

  kit.advance(30_000);
  kit.live.tick();
  assert.equal(kit.closes().length, 1, 'and is handed back when the hold ends');
});

test('a hoop that goes dark with nothing to show clears the wall at once', () => {
  const kit = harness({ minShotsToOpen: 1 });
  kit.live.handleEvent(shot());
  kit.live.handleStreamState({ connected: true });
  kit.live.handleStreamState({ connected: false, reason: 'device offline' });
  kit.advance(STREAM_LOSS_GRACE_MS);
  kit.live.tick();
  assert.equal(kit.closes().length, 1);
  assert.equal(kit.archived.length, 0, 'one shot is noise, not a game');
});

test('a new game cancels the previous final card\'s pending close', () => {
  // Otherwise the close lands mid-way through the next game and takes the
  // live card down with it.
  const kit = harness({ finalHoldSeconds: 60 });
  openFreePlay(kit);
  kit.live.handleEvent({ kind: 'final-screen' });
  kit.advance(10_000);
  openFreePlay(kit);
  kit.advance(60_000);
  kit.live.tick();
  assert.equal(kit.closes().length, 0);
  assert.equal(kit.latest().session.status, 'live');
});

test('a brief ADB reconnect does not tear the game down', () => {
  const kit = harness();
  openFreePlay(kit);
  kit.live.handleStreamState({ connected: true });
  kit.live.handleStreamState({ connected: false });
  kit.advance(STREAM_LOSS_GRACE_MS / 2);
  kit.live.handleStreamState({ connected: true });
  kit.advance(STREAM_LOSS_GRACE_MS);
  kit.live.tick();
  assert.equal(kit.closes().length, 0);
  assert.ok(kit.live.currentSession(), 'the session survived the blip');
});

test('a hoop that was never reachable does not abort a session it never had', () => {
  const kit = harness();
  kit.live.handleStreamState({ connected: false, reason: 'unconfigured' });
  kit.advance(STREAM_LOSS_GRACE_MS * 3);
  kit.live.tick();
  assert.equal(kit.closes().length, 0);
});

test('walking back to the launcher ends free play immediately', () => {
  const kit = harness();
  openFreePlay(kit);
  kit.live.handleEvent({ kind: 'focus', mode: 'launcher' });
  assert.equal(kit.latest().session.status, 'finished');
  assert.equal(kit.archived[0].endReason, 'left-app');
});

test('Family Mode rides out a trip to the launcher', () => {
  // Family Mode hands off between activities mid-game; treating that as an
  // exit would end the game every time the scoreboard changed screens.
  const kit = harness();
  kit.live.handleEvent(shotMade('Jo'));
  kit.advance(MIN_PUSH_INTERVAL_MS);
  kit.live.handleEvent(shotMade('Jo'));
  kit.live.handleEvent({ kind: 'focus', mode: 'launcher' });
  assert.ok(kit.live.currentSession(), 'the game is still going');
});

test('another page taking the wall stops the pushes but not the scoring', () => {
  const kit = harness();
  openFreePlay(kit);
  const before = kit.sessions().length;
  kit.live.suppressActiveSession('timer');
  kit.live.handleEvent(shot());
  kit.advance(MIN_PUSH_INTERVAL_MS);
  kit.live.handleEvent(shot());
  assert.equal(kit.sessions().length, before, 'nothing new was pushed');
  assert.equal(kit.live.currentSession().stats.attempts, 4, 'but the shots still counted');
});

test('the next basket does not wipe the page that interrupted the game', () => {
  // A timer going off mid-game is exactly the moment someone needs to read it,
  // so shooting again is deliberately not enough to reclaim the display.
  let busy = true;
  const kit = harness({}, {
    displayBusy: { isBusy: () => busy, snapshot: () => ({ type: 'timer.snapshot' }) },
  });
  openFreePlay(kit);
  kit.live.suppressActiveSession('timer');
  const before = kit.sessions().length;
  kit.advance(MIN_PUSH_INTERVAL_MS);
  kit.live.handleEvent(shot());
  kit.live.tick();
  assert.equal(kit.sessions().length, before);
  assert.equal(kit.live.isSuppressed(), true);
});

test('the game takes the wall back once the interrupting page is done', () => {
  let busy = true;
  const kit = harness({}, {
    displayBusy: { isBusy: () => busy, snapshot: () => ({ type: 'timer.snapshot' }) },
  });
  openFreePlay(kit);
  kit.live.suppressActiveSession('timer');
  const before = kit.sessions().length;
  busy = false;
  kit.advance(MIN_PUSH_INTERVAL_MS);
  kit.live.tick();
  assert.ok(kit.sessions().length > before);
  assert.equal(kit.live.isSuppressed(), false);
});

test('with nothing reporting on the display, the game waits out a fallback hold', () => {
  const kit = harness();
  openFreePlay(kit);
  kit.live.suppressActiveSession('timer');
  const before = kit.sessions().length;
  kit.advance(SUPPRESS_FALLBACK_MS - 1_000);
  kit.live.tick();
  assert.equal(kit.sessions().length, before, 'still holding off');

  kit.advance(1_000);
  kit.live.tick();
  assert.ok(kit.sessions().length > before);
});

test('finishing a session refreshes the career stats', () => {
  const kit = harness();
  openFreePlay(kit);
  kit.live.handleEvent({ kind: 'final-screen' });
  assert.deepEqual(kit.recomputes, [1]);
});

test('a late upload backfills the identity of a game that already ended', () => {
  // The score upload routinely lands after the final screen has closed the
  // session, so the archived row would otherwise never learn its own id.
  const kit = harness();
  openFreePlay(kit);
  kit.live.handleEvent({ kind: 'final-screen' });
  kit.live.handleEvent({ kind: 'game-end', uniqueScoreId: 'abc-123' });
  assert.equal(kit.live.lastSession().uniqueScoreId, 'abc-123');
});

test('sensor errors are counted without inventing a session', () => {
  const kit = harness();
  kit.live.handleEvent({ kind: 'sensor-error', message: 'tof timeout' });
  assert.equal(kit.live.currentSession(), null);
  openFreePlay(kit);
  kit.live.handleEvent({ kind: 'sensor-error', message: 'tof timeout' });
  kit.advance(MIN_PUSH_INTERVAL_MS);
  kit.live.handleEvent(shot());
  assert.equal(kit.latest().session.sensorErrors, 1);
});

test('auto-push off keeps the score without ever touching the wall', () => {
  const kit = harness({ autoPush: false });
  openFreePlay(kit);
  kit.live.handleEvent({ kind: 'final-screen' });
  assert.equal(kit.sessions().length, 0);
  assert.equal(kit.archived.length, 1, 'the game was still recorded');
});

test('shutting the bridge down clears any card it left up', () => {
  const kit = harness();
  openFreePlay(kit);
  kit.live.close();
  assert.equal(kit.closes().length, 1);
  assert.equal(kit.live.statusSnapshot().phase, 'idle');
});

test('the status snapshot reports what the integration has been doing', () => {
  const kit = harness();
  openFreePlay(kit);
  kit.live.handleEvent({ kind: 'final-screen' });
  const status = kit.live.statusSnapshot();
  assert.equal(status.phase, 'idle');
  assert.equal(status.counters.opened, 1);
  assert.equal(status.counters.finished, 1);
  assert.ok(status.lastSession, 'the last game is available for a manual push');
  assert.equal(status.session, null);
});

test('a Countdown start opens the wall without waiting for two shots', () => {
  const kit = harness();
  kit.live.handleEvent({
    kind: 'countdown-start',
    id: 'm1',
    startScore: 21,
    difficulty: 'EXACT',
    layupValue: 1,
    seats: [
      { seat: 0, id: 'p-luis', name: 'Luis', bot: false },
      { seat: 1, id: 'p-alex', name: 'Alex', bot: false },
    ],
  });
  const card = kit.latest();
  assert.equal(card.session.mode, 'countdown');
  assert.equal(card.session.scoreKind, 'remaining');
  assert.equal(card.session.players[0].score, 21);
  assert.equal(card.session.headline.secondary, '21 LEFT');
});

test('a Countdown start does not seed idle seats at 0 remaining', () => {
  // The parser sends `left: null` when the APK omitted it. Number(null) is 0,
  // and 0 is finite — that used to park every seat on 0 LEFT, so the player
  // who had not shot yet sorted to the top as if they had already won.
  const kit = harness();
  kit.live.handleEvent({
    kind: 'countdown-start',
    id: 'm-idle',
    startScore: 21,
    difficulty: 'RACE',
    layupValue: 1,
    seats: [
      { seat: 0, id: 'p-trash', name: 'TRASHPANDA', bot: false, left: null },
      { seat: 1, id: 'p-tommy', name: 'TOMMY', bot: false, left: null },
    ],
  });
  kit.advance(MIN_PUSH_INTERVAL_MS);
  kit.live.handleEvent({
    kind: 'countdown-shot',
    id: 'm-idle',
    seat: 0,
    name: 'TRASHPANDA',
    bot: false,
    zone: 'three',
    made: true,
    points: 3,
    left: 18,
    bust: false,
    win: false,
  });

  const card = kit.latest().session;
  const trash = card.players.find((row) => row.name === 'TRASHPANDA');
  const tommy = card.players.find((row) => row.name === 'TOMMY');
  assert.equal(trash.score, 18);
  assert.equal(tommy.score, 21);
  assert.equal(tommy.made, 0);
  assert.equal(tommy.attempts, 0);
  assert.equal(tommy.fgPct, 0, '0-for-0 is not a perfect game');
  assert.equal(card.headline.primary, 'TRASHPANDA');
  assert.equal(card.headline.secondary, '18 LEFT');
  assert.equal(card.stats.fgPct, 100);
});

test('a Countdown shot mid-stream opens the session if start was missed', () => {
  const kit = harness();
  kit.live.handleEvent({
    kind: 'countdown-shot',
    id: 'm2',
    seat: 0,
    zone: 'three',
    made: true,
    points: 3,
    left: 18,
    bust: false,
    win: false,
  });
  const card = kit.latest();
  assert.equal(card.session.mode, 'countdown');
  assert.equal(card.session.players[0].name, 'P1');
  assert.equal(card.session.players[0].score, 18);
  assert.equal(card.session.stats.points, 3);
});

test('a Countdown shot mid-stream uses the name on the shot line', () => {
  const kit = harness();
  kit.live.handleEvent({
    kind: 'countdown-shot',
    id: 'm2b',
    seat: 0,
    name: 'Bot Pro',
    bot: true,
    zone: 'three',
    made: true,
    points: 3,
    left: 48,
    bust: false,
    win: false,
  });
  kit.advance(MIN_PUSH_INTERVAL_MS);
  kit.live.handleEvent({
    kind: 'countdown-shot',
    id: 'm2b',
    seat: 1,
    name: 'Bot Varsity',
    bot: true,
    zone: 'two',
    made: true,
    points: 2,
    left: 49,
    bust: false,
    win: false,
  });
  const card = kit.latest();
  const players = card.session.players;
  assert.equal(players[0].name, 'Bot Pro');
  assert.equal(players[1].name, 'Bot Varsity');
  assert.equal(card.session.lastShot.player, 'Bot Varsity');
});

test('real hoop Countdown shots label seats even when start is skipped', () => {
  const kit = harness();
  kit.live.handleEvent({
    kind: 'countdown-shot',
    id: 'bd676b2f-9244-4b34-b674-3de7f7d6f563',
    seat: 2,
    name: 'Bot Pro',
    bot: true,
    zone: 'three',
    made: true,
    points: 3,
    left: 15,
    bust: false,
    win: false,
  });
  kit.advance(MIN_PUSH_INTERVAL_MS);
  kit.live.handleEvent({
    kind: 'countdown-shot',
    id: 'bd676b2f-9244-4b34-b674-3de7f7d6f563',
    seat: 0,
    name: 'TRASHPANDA',
    bot: false,
    zone: 'three',
    made: true,
    points: 3,
    left: 6,
    bust: false,
    win: false,
  });
  kit.advance(MIN_PUSH_INTERVAL_MS);
  kit.live.handleEvent(shot({ zone: 'three', points: 3 }));
  const names = kit.latest().session.players.map((row) => row.name).sort();
  assert.deepEqual(names, ['Bot Pro', 'TRASHPANDA']);
  assert.equal(kit.latest().session.stats.attempts, 2);
});

test('Family Mode names still come from Unity after a Countdown game ends', () => {
  const kit = harness();
  kit.live.handleEvent({
    kind: 'countdown-start',
    id: 'm-cd',
    startScore: 21,
    difficulty: 'RACE',
    layupValue: 1,
    seats: [{ seat: 0, id: 'bot-1', name: 'Bot Pro', bot: true }],
  });
  kit.advance(MIN_PUSH_INTERVAL_MS);
  kit.live.handleEvent({
    kind: 'countdown-shot',
    id: 'm-cd',
    seat: 0,
    name: 'Bot Pro',
    bot: true,
    zone: 'three',
    made: true,
    points: 3,
    left: 18,
    bust: false,
    win: false,
  });
  kit.advance(MIN_PUSH_INTERVAL_MS);
  kit.live.handleEvent({
    kind: 'countdown-end',
    id: 'm-cd',
    winnerId: 'bot-1',
    winner: 'Bot Pro',
    reason: 'win',
    seats: [{ seat: 0, id: 'bot-1', name: 'Bot Pro', left: 0, scored: 21 }],
  });
  kit.advance(MIN_PUSH_INTERVAL_MS);
  kit.live.handleEvent(shotMade('Jo', { zone: 'three', points: 3 }));
  kit.advance(MIN_PUSH_INTERVAL_MS);
  kit.live.handleEvent(shotMade('Sam', { zone: 'two', points: 2 }));
  const live = kit.latest().session;
  assert.equal(live.mode, 'family');
  assert.deepEqual(live.players.map((row) => row.name).sort(), ['Jo', 'Sam']);
});

test('a later named Countdown shot upgrades a P1 placeholder', () => {
  const kit = harness();
  kit.live.handleEvent({
    kind: 'countdown-shot',
    id: 'm2c',
    seat: 0,
    zone: 'three',
    made: true,
    points: 3,
    left: 18,
    bust: false,
    win: false,
  });
  assert.equal(kit.latest().session.players[0].name, 'P1');
  kit.advance(MIN_PUSH_INTERVAL_MS);
  kit.live.handleEvent({
    kind: 'countdown-shot',
    id: 'm2c',
    seat: 0,
    name: 'Luis',
    bot: false,
    zone: 'two',
    made: true,
    points: 2,
    left: 16,
    bust: false,
    win: false,
  });
  assert.equal(kit.latest().session.players[0].name, 'Luis');
});

test('HAL shots are ignored once Countdown is scoring', () => {
  const kit = harness();
  kit.live.handleEvent({
    kind: 'countdown-start',
    id: 'm3',
    startScore: 21,
    difficulty: 'RACE',
    layupValue: 1,
    seats: [{ seat: 0, id: 'p-luis', name: 'Luis', bot: false }],
  });
  kit.advance(MIN_PUSH_INTERVAL_MS);
  kit.live.handleEvent(shot({ zone: 'three', points: 3 }));
  assert.equal(kit.latest().session.stats.attempts, 0);
  kit.live.handleEvent({
    kind: 'countdown-shot',
    id: 'm3',
    seat: 0,
    zone: 'two',
    made: true,
    points: 2,
    left: 19,
    bust: false,
    win: false,
  });
  assert.equal(kit.latest().session.stats.attempts, 1);
  assert.equal(kit.latest().session.players[0].score, 19);
});

test('a Countdown bust does not add points and restores remaining', () => {
  const kit = harness();
  kit.live.handleEvent({
    kind: 'countdown-start',
    id: 'm4',
    startScore: 21,
    difficulty: 'EXACT',
    layupValue: 1,
    seats: [{ seat: 0, id: 'p-luis', name: 'Luis', bot: false }],
  });
  kit.advance(MIN_PUSH_INTERVAL_MS);
  kit.live.handleEvent({
    kind: 'countdown-shot',
    id: 'm4',
    seat: 0,
    zone: 'two',
    made: true,
    points: 2,
    left: 19,
    turn: 1,
    attempt: 1,
    bust: false,
    win: false,
  });
  kit.advance(MIN_PUSH_INTERVAL_MS);
  // Went in, overshot the target: the hoop hands the whole turn back, so
  // remaining does not move and the three is worth nothing.
  kit.live.handleEvent({
    kind: 'countdown-shot',
    id: 'm4',
    seat: 0,
    zone: 'three',
    made: true,
    points: 3,
    left: 19,
    turn: 1,
    attempt: 2,
    bust: true,
    win: false,
  });
  const session = kit.latest().session;
  assert.equal(session.players[0].score, 19);
  assert.equal(session.stats.points, 2);
  assert.equal(session.stats.threes, 0);
  // The ball still went through the hoop, so it is a make off two attempts —
  // the same way `end` counts busted attempts.
  assert.equal(session.stats.made, 2);
  assert.equal(session.stats.attempts, 2);
  assert.equal(session.stats.fgPct, 100);
});

/** A two-seat Exact 21 already under way, so a correction has something to correct. */
function countdownGame(kit, { id = 'fix1' } = {}) {
  kit.live.handleEvent({
    kind: 'countdown-start',
    id,
    startScore: 21,
    difficulty: 'EXACT',
    layupValue: 1,
    seats: [
      { seat: 0, id: 'p-luis', name: 'Luis', bot: false },
      { seat: 1, id: 'p-alex', name: 'Alex', bot: false },
    ],
  });
  kit.advance(MIN_PUSH_INTERVAL_MS);
  return (event) => {
    kit.live.handleEvent({ kind: 'countdown-shot', id, ...event });
    kit.advance(MIN_PUSH_INTERVAL_MS);
  };
}

function seatNamed(kit, name) {
  return kit.latest().session.players.find((row) => row.name === name);
}

test('a corrected Countdown shot replaces the attempt instead of adding one', () => {
  const kit = harness();
  const shoot = countdownGame(kit);
  shoot({
    seat: 0, name: 'Luis', zone: 'three', made: true, points: 3, left: 18, turn: 1, attempt: 1, madeN: 1, attemptsSoFar: 1,
  });
  shoot({
    seat: 0, name: 'Luis', zone: null, made: false, points: 0, left: 18, turn: 1, attempt: 2, madeN: 1, attemptsSoFar: 2,
  });
  kit.live.handleEvent({
    kind: 'countdown-fix',
    id: 'fix1',
    seat: 0,
    name: 'Luis',
    how: 'hand',
    turn: 1,
    attempt: 2,
    wasZone: null,
    wasPoints: 0,
    gone: false,
    zone: 'one',
    made: true,
    points: 1,
    left: 17,
    turnPoints: 4,
    bust: false,
    win: false,
    madeN: 2,
    attemptsSoFar: 2,
  });

  const luis = seatNamed(kit, 'Luis');
  // The miss became a make; it must not also become a third attempt.
  assert.equal(luis.attempts, 2);
  assert.equal(luis.made, 2);
  assert.equal(luis.fgPct, 100);
  assert.equal(luis.remaining, 17);
  assert.equal(luis.scored, 4);
  assert.equal(luis.byZone.one.made, 1);
  // The correction keeps the slot it corrected rather than jumping the ticker.
  const shots = kit.latest().session.recentShots;
  assert.deepEqual(shots.map((row) => row.zone), ['three', 'one']);
});

test('undoing a Countdown shot takes the attempt back off the board', () => {
  const kit = harness();
  const shoot = countdownGame(kit, { id: 'fix2' });
  shoot({
    seat: 0, name: 'Luis', zone: 'three', made: true, points: 3, left: 18, turn: 1, attempt: 1, madeN: 1, attemptsSoFar: 1,
  });
  shoot({
    seat: 0, name: 'Luis', zone: 'two', made: true, points: 2, left: 16, turn: 1, attempt: 2, madeN: 2, attemptsSoFar: 2,
  });
  kit.live.handleEvent({
    kind: 'countdown-fix',
    id: 'fix2',
    seat: 0,
    name: 'Luis',
    how: 'undo',
    turn: 1,
    attempt: 2,
    wasZone: 'two',
    wasPoints: 2,
    gone: true,
    // Sent as MISS/false/0 purely so the key set never varies.
    zone: null,
    made: false,
    points: 0,
    left: 18,
    turnPoints: 3,
    bust: false,
    win: false,
    madeN: 1,
    attemptsSoFar: 1,
  });

  const luis = seatNamed(kit, 'Luis');
  assert.equal(luis.attempts, 1);
  assert.equal(luis.made, 1);
  assert.equal(luis.remaining, 18);
  assert.equal(luis.scored, 3);
  // The undone shot is gone from the zone strip too, not just from the count.
  assert.equal(luis.byZone.two.attempts, 0);
  assert.deepEqual(kit.latest().session.recentShots.map((row) => row.zone), ['three']);
});

test('a Countdown correction can hand back a bust an earlier shot reported', () => {
  const kit = harness();
  const shoot = countdownGame(kit, { id: 'fix3' });
  shoot({
    seat: 0, name: 'Luis', zone: 'two', made: true, points: 2, left: 2, turn: 3, attempt: 1, madeN: 5, attemptsSoFar: 7,
  });
  shoot({
    seat: 0, name: 'Luis', zone: 'three', made: true, points: 3, left: 2, turn: 3, attempt: 2, bust: true, madeN: 6, attemptsSoFar: 8,
  });
  assert.equal(seatNamed(kit, 'Luis').threes, 0);

  // The hoop called that DEEP a make and Luis disagrees. He shoots it again
  // and this time it is a miss, so the turn was never a bust at all.
  kit.live.handleEvent({
    kind: 'countdown-retake',
    id: 'fix3',
    seat: 0,
    name: 'Luis',
    state: 'armed',
    turn: 3,
    attempt: 2,
    zone: 'three',
    points: 3,
  });
  const armed = seatNamed(kit, 'Luis');
  assert.equal(armed.retaking, true);
  assert.equal(armed.attempts, 8, 'arming a retake is not an attempt');
  assert.equal(kit.latest().session.recentShots.at(-1).provisional, true);
  kit.advance(MIN_PUSH_INTERVAL_MS);

  kit.live.handleEvent({
    kind: 'countdown-fix',
    id: 'fix3',
    seat: 0,
    name: 'Luis',
    how: 'retake',
    turn: 3,
    attempt: 2,
    wasZone: 'three',
    wasPoints: 3,
    gone: false,
    zone: null,
    made: false,
    points: 0,
    left: 2,
    turnPoints: 2,
    bust: false,
    win: false,
    madeN: 5,
    attemptsSoFar: 8,
  });

  const luis = seatNamed(kit, 'Luis');
  assert.equal(luis.retaking, false);
  assert.equal(luis.made, 5, 'one make fewer off the same eight attempts');
  assert.equal(luis.attempts, 8);
  assert.equal(luis.remaining, 2);
  assert.equal(kit.latest().session.recentShots.at(-1).provisional, false);
});

test('a cancelled Countdown retake leaves the disputed shot standing', () => {
  const kit = harness();
  const shoot = countdownGame(kit, { id: 'fix4' });
  shoot({
    seat: 0, name: 'Luis', zone: 'three', made: true, points: 3, left: 18, turn: 1, attempt: 1, madeN: 1, attemptsSoFar: 1,
  });
  for (const state of ['armed', 'cancelled']) {
    kit.live.handleEvent({
      kind: 'countdown-retake', id: 'fix4', seat: 0, name: 'Luis', state, turn: 1, attempt: 1, zone: 'three', points: 3,
    });
    kit.advance(MIN_PUSH_INTERVAL_MS);
  }
  const luis = seatNamed(kit, 'Luis');
  assert.equal(luis.retaking, false);
  assert.equal(luis.made, 1);
  assert.equal(luis.attempts, 1);
  assert.equal(luis.remaining, 18);
  assert.equal(kit.latest().session.recentShots.at(-1).provisional, false);
});

test('a Countdown fix repairs a counter that drifted before the collector joined', () => {
  const kit = harness();
  // No start line and no shots: this collector attached mid-game with `-T 1`.
  kit.live.handleEvent({
    kind: 'countdown-fix',
    id: 'fix5',
    seat: 1,
    name: 'Alex',
    bot: false,
    how: 'hand',
    turn: 4,
    attempt: 3,
    wasZone: null,
    wasPoints: 0,
    gone: false,
    zone: 'three',
    made: true,
    points: 3,
    left: 12,
    turnPoints: 3,
    bust: false,
    win: false,
    madeN: 6,
    attemptsSoFar: 11,
  });
  const alex = seatNamed(kit, 'Alex');
  // Counting the one line we saw would say 1-for-1; the hoop's own totals win.
  assert.equal(alex.made, 6);
  assert.equal(alex.attempts, 11);
  assert.equal(alex.fgPct, 55);
});

test('a Countdown end archives scored points not remaining', () => {
  const kit = harness();
  kit.live.handleEvent({
    kind: 'countdown-start',
    id: 'm5',
    startScore: 21,
    difficulty: 'EXACT',
    layupValue: 1,
    seats: [
      { seat: 0, id: 'p-luis', name: 'Luis', bot: false },
      { seat: 1, id: 'p-alex', name: 'Alex', bot: false },
    ],
  });
  kit.advance(MIN_PUSH_INTERVAL_MS);
  kit.live.handleEvent({
    kind: 'countdown-shot',
    id: 'm5',
    seat: 0,
    zone: 'one',
    made: true,
    points: 1,
    left: 0,
    bust: false,
    win: true,
  });
  kit.advance(MIN_PUSH_INTERVAL_MS);
  kit.live.handleEvent({
    kind: 'countdown-end',
    id: 'm5',
    winnerId: 'p-luis',
    winner: 'Luis',
    reason: 'win',
    seats: [
      { seat: 0, id: 'p-luis', name: 'Luis', left: 0, scored: 21, made: 1, att: 1, threes: 0 },
      { seat: 1, id: 'p-alex', name: 'Alex', left: 18, scored: 3, made: 1, att: 1, threes: 1 },
    ],
  });
  assert.equal(kit.archived.length, 1);
  const row = kit.archived[0];
  assert.equal(row.mode, 'countdown');
  assert.equal(row.endReason, 'countdown-end');
  assert.equal(row.winner, 'Luis');
  const luis = row.players.find((player) => player.name === 'Luis');
  assert.equal(luis.score, 21);
  assert.equal(luis.remaining, 0);
  assert.equal(luis.isWinner, true);
  assert.equal(kit.latest().session.status, 'finished');
  assert.equal(kit.latest().session.headline.secondary, 'WINS');
});

test('a finished Countdown card shows points scored, not what was left', () => {
  // The wall used to call the winner out by name and then print 0 beside it,
  // because a countdown game ends on nothing left rather than on a total.
  const kit = harness();
  kit.live.handleEvent({
    kind: 'countdown-start',
    id: 'm-final',
    startScore: 21,
    difficulty: 'RACE',
    layupValue: 1,
    seats: [
      { seat: 0, id: 'p-trash', name: 'TRASHPANDA', bot: false },
      { seat: 1, id: 'p-tommy', name: 'TOMMY', bot: false },
      { seat: 2, id: 'bot-pro', name: 'Bot Pro', bot: true },
    ],
  });
  kit.advance(MIN_PUSH_INTERVAL_MS);
  kit.live.handleEvent({
    kind: 'countdown-shot',
    id: 'm-final',
    seat: 0,
    name: 'TRASHPANDA',
    bot: false,
    zone: 'three',
    made: true,
    points: 3,
    left: 0,
    bust: false,
    win: true,
  });

  const live = kit.latest().session;
  assert.equal(live.scoreKind, 'remaining', 'the number to beat while the game is on');
  assert.equal(live.players[0].score, 0);

  kit.advance(MIN_PUSH_INTERVAL_MS);
  kit.live.handleEvent({
    kind: 'countdown-end',
    id: 'm-final',
    winnerId: 'p-trash',
    winner: 'TRASHPANDA',
    reason: 'win',
    seats: [
      { seat: 0, id: 'p-trash', name: 'TRASHPANDA', left: 0, scored: 21, made: 7, att: 11, threes: 7 },
      { seat: 1, id: 'p-tommy', name: 'TOMMY', left: 6, scored: 15, made: 6, att: 9, threes: 4 },
      { seat: 2, id: 'bot-pro', name: 'Bot Pro', left: 3, scored: 18, made: 6, att: 9, threes: 6 },
    ],
  });

  const card = kit.latest().session;
  assert.equal(card.status, 'finished');
  assert.equal(card.scoreKind, 'points');
  assert.deepEqual(
    card.players.map((row) => [row.name, row.score, row.remaining]),
    [['TRASHPANDA', 21, 0], ['Bot Pro', 18, 3], ['TOMMY', 15, 6]],
    'the winner leads on points scored, and the order still runs by remaining',
  );
});

test('a Countdown that dies mid-game totals the points it actually saw', () => {
  // No start line means no target to subtract from, so the makes this session
  // watched are the only honest total — never minus whatever is left.
  const kit = harness({ finalHoldSeconds: 30 });
  kit.live.handleEvent({
    kind: 'countdown-shot',
    id: 'm-abort',
    seat: 0,
    name: 'TOMMY',
    bot: false,
    zone: 'three',
    made: true,
    points: 3,
    left: 18,
    bust: false,
    win: false,
  });
  kit.advance(MIN_PUSH_INTERVAL_MS);
  kit.live.handleEvent({
    kind: 'countdown-shot',
    id: 'm-abort',
    seat: 0,
    name: 'TOMMY',
    bot: false,
    zone: 'two',
    made: true,
    points: 2,
    left: 16,
    bust: false,
    win: false,
  });
  assert.equal(kit.latest().session.players[0].score, 16, 'live still counts down');

  kit.live.handleStreamState({ connected: true });
  kit.live.handleStreamState({ connected: false, reason: 'device offline' });
  kit.advance(STREAM_LOSS_GRACE_MS);
  kit.live.tick();

  const card = kit.latest().session;
  assert.equal(card.status, 'finished');
  assert.equal(card.players[0].score, 5);
  assert.equal(card.players[0].remaining, 16);
  assert.equal(kit.archived[0].players[0].score, 5);
});

test('a failed write still shows the final score on the wall', () => {
  // Losing the history is bad; losing the score of the game people just played,
  // while they are standing in front of the display, is worse.
  const kit = harness({}, { archiveThrows: true });
  openFreePlay(kit);
  kit.live.handleEvent({ kind: 'final-screen' });
  assert.equal(kit.latest().session.status, 'finished');
  assert.equal(kit.archived.length, 0);
});
