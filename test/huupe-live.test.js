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

test('a layup is worth a tenth of a point, matching Family Mode', () => {
  const kit = harness();
  kit.live.handleEvent(shot({ zone: 'layup', points: 0.1 }));
  kit.advance(MIN_PUSH_INTERVAL_MS);
  kit.live.handleEvent(shot({ zone: 'layup', points: 0.1 }));
  assert.equal(kit.latest().session.stats.points, 0.2);
  assert.equal(kit.latest().session.stats.pointsLabel, '0.2');
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
  kit.live.handleEvent(shot({ zone: 'layup', points: 0.1 }));
  const ticker = kit.latest().session.recentShots;
  assert.deepEqual(ticker.at(-1), { made: true, zone: 'layup', short: 'LAY' });
  assert.deepEqual(ticker.at(-2), { made: false, zone: 'three', short: '3PT' });
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
    { made: true, zone: 'two', short: '2PT' },
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

test('a failed write still shows the final score on the wall', () => {
  // Losing the history is bad; losing the score of the game people just played,
  // while they are standing in front of the display, is worse.
  const kit = harness({}, { archiveThrows: true });
  openFreePlay(kit);
  kit.live.handleEvent({ kind: 'final-screen' });
  assert.equal(kit.latest().session.status, 'finished');
  assert.equal(kit.archived.length, 0);
});
