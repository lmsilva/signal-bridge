const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

const {
  DEFAULT_CONFIRM_SECONDS,
  STOP_GRACE_MS,
  CONFIRM_RETRY_MS,
  createYoutubeLounge,
} = require('../src/youtube-lounge');

/** A stand-in for the Python sidecar: NDJSON in, NDJSON out, no process. */
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdout.setEncoding = () => {};
  child.stderr.setEncoding = () => {};
  child.written = [];
  child.stdin = {
    writable: true,
    write: (line) => {
      child.written.push(JSON.parse(line));
      return true;
    },
  };
  child.kill = () => {
    child.stdin.writable = false;
  };
  child.unref = () => {};
  child.emitEvent = (message) => {
    child.stdout.write(`${JSON.stringify(message)}\n`);
  };
  return child;
}

function harness({ confirmSeconds = DEFAULT_CONFIRM_SECONDS } = {}) {
  const clock = { t: Date.parse('2026-08-02T20:00:00Z') };
  const children = [];
  const timers = [];
  const events = { started: [], stopped: [], observed: [], prefetch: [], progress: [], ready: [], auth: [] };

  const lounge = createYoutubeLounge({
    config: {
      youtube: {
        loungeEnabled: true,
        pythonBin: 'python3',
        agentScript: '/opt/agent.py',
        confirmSeconds,
      },
    },
    now: () => clock.t,
    spawnImpl: () => {
      const child = fakeChild();
      children.push(child);
      return child;
    },
    setTimer: (fn, ms) => {
      const timer = { fn, ms, at: clock.t + ms, cancelled: false, unref: () => {} };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      if (timer) timer.cancelled = true;
    },
  });

  for (const name of Object.keys(events)) {
    lounge.on(name, (payload) => events[name].push(payload));
  }

  return {
    lounge,
    clock,
    events,
    timers,
    children,
    child: () => children.at(-1),
    /** Advance the virtual clock and fire any timer that came due. */
    advance(seconds) {
      clock.t += seconds * 1000;
      for (const timer of [...timers]) {
        if (!timer.cancelled && timer.at <= clock.t) {
          timer.cancelled = true;
          timer.fn();
        }
      }
    },
    /** Feed a raw sidecar event exactly as the NDJSON reader would. */
    feed(message) {
      lounge._handleLine(JSON.stringify(message));
    },
  };
}

function playFor(h, { deviceId = 'tv-1', videoId = 'abc', seconds = 10, duration = 600 } = {}) {
  h.feed({
    event: 'now-playing', deviceId, videoId, position: 0, durationSeconds: duration, state: 'Playing',
  });
  h.advance(seconds);
  h.feed({ event: 'state', deviceId, state: 'Playing', position: seconds, durationSeconds: duration });
}

/** Feed Stopped and wait out the Apple TV flicker grace window. */
function settleStop(h, { deviceId = 'tv-1', position = 0 } = {}) {
  h.feed({ event: 'state', deviceId, state: 'Stopped', position });
  h.advance((STOP_GRACE_MS / 1000) + 0.1);
}

// ----------------------------------------------------------------- process

test('the supervisor spawns the sidecar and parses NDJSON a chunk at a time', () => {
  const h = harness();
  h.lounge.start();

  assert.equal(h.children.length, 1);

  // A single write split across two chunks must still parse as one event.
  const line = `${JSON.stringify({ event: 'ready', loungeAvailable: true })}\n`;
  h.child().stdout.write(line.slice(0, 12));
  h.child().stdout.write(line.slice(12));

  assert.deepEqual(h.events.ready, [{ loungeAvailable: true }]);
  assert.equal(h.lounge.snapshot().ready, true);
  assert.equal(h.lounge.snapshot().loungeAvailable, true);
});

test('two events in one chunk both fire, and garbage does not kill the reader', () => {
  const h = harness();
  h.lounge.start();

  h.child().stdout.write(
    `${JSON.stringify({ event: 'ready', loungeAvailable: true })}\n`
    + 'not json at all\n'
    + `${JSON.stringify({ event: 'auth', deviceId: 'tv-1' })}\n`,
  );

  assert.equal(h.events.ready.length, 1);
  assert.equal(h.events.auth.length, 1);
});

test('a sidecar crash restarts with backoff and does not restart after stop', () => {
  const h = harness();
  h.lounge.start();
  const first = h.child();

  first.emit('exit', 1);
  assert.equal(h.children.length, 1, 'the restart is delayed, not immediate');
  h.advance(1);
  assert.equal(h.children.length, 2);

  h.lounge.stop();
  h.children.at(-1).emit('exit', 1);
  h.advance(60);
  assert.equal(h.children.length, 2, 'a deliberate stop must not resurrect the agent');
});

test('an agent that exits mid-video closes the session rather than stranding it', () => {
  const h = harness();
  h.lounge.start();
  playFor(h, { seconds: 6 });
  assert.equal(h.events.started.length, 1);

  h.child().emit('exit', 0);

  assert.equal(h.events.stopped.length, 1);
  assert.equal(h.events.stopped[0].reason, 'agent-exit');
  assert.deepEqual(h.lounge.activeSessions(), []);
});

test('a deliberate stop flushes the active session before killing the agent', () => {
  // Regression: ./recreate.sh used to kill the container with confirmed
  // sessions still in memory and no stopped event, wiping last-played.
  const h = harness();
  h.lounge.start();
  playFor(h, { seconds: 6 });
  assert.equal(h.events.started.length, 1);

  h.lounge.stop();

  assert.equal(h.events.stopped.length, 1);
  assert.equal(h.events.stopped[0].reason, 'shutdown');
  assert.deepEqual(h.lounge.activeSessions(), []);
});

test('a request answers when the sidecar replies, and reports a dead agent', async () => {
  const h = harness();
  h.lounge.start();

  const promise = h.lounge.pairWithCode('tv-1', '123456789012');
  const sent = h.child().written.at(-1);
  assert.equal(sent.cmd, 'pair-code');
  assert.equal(sent.code, '123456789012');

  h.feed({ event: 'result', id: sent.id, ok: true, screenId: 'screen-abc' });
  assert.deepEqual(await promise, { ok: true, screenId: 'screen-abc' });

  h.child().stdin.writable = false;
  const dead = await h.lounge.discover();
  assert.equal(dead.ok, false);
  assert.match(dead.error, /not running/);
});

// ------------------------------------------------------------- the debounce

test('a video below the confirm window never starts a session', () => {
  const h = harness({ confirmSeconds: 5 });
  h.lounge.start();

  playFor(h, { seconds: 3 });

  assert.deepEqual(h.events.started, [], 'scrolling a playlist must cost nothing');
  assert.deepEqual(h.lounge.activeSessions(), []);
});

test('a video past the confirm window starts exactly one session', () => {
  const h = harness({ confirmSeconds: 5 });
  h.lounge.start();

  playFor(h, { seconds: 6, videoId: 'abc' });

  assert.equal(h.events.started.length, 1);
  assert.equal(h.events.started[0].videoId, 'abc');
  assert.equal(h.events.started[0].deviceId, 'tv-1');

  // Further progress on the same video must not re-announce it.
  h.advance(30);
  h.feed({ event: 'state', deviceId: 'tv-1', state: 'Playing', position: 36, durationSeconds: 600 });
  assert.equal(h.events.started.length, 1);
});

test('surfing five videos then settling on one announces only the sixth', () => {
  const h = harness({ confirmSeconds: 5 });
  h.lounge.start();

  for (let i = 0; i < 5; i += 1) {
    h.feed({
      event: 'now-playing', deviceId: 'tv-1', videoId: `skip-${i}`,
      position: 0, durationSeconds: 300, state: 'Playing',
    });
    h.advance(2);
  }
  playFor(h, { seconds: 6, videoId: 'keeper' });

  assert.equal(h.events.started.length, 1);
  assert.equal(h.events.started[0].videoId, 'keeper');
});

test('a paused video does not confirm, and resuming it does', () => {
  const h = harness({ confirmSeconds: 5 });
  h.lounge.start();

  h.feed({
    event: 'now-playing', deviceId: 'tv-1', videoId: 'abc',
    position: 0, durationSeconds: 600, state: 'Paused',
  });
  h.advance(30);
  h.feed({ event: 'state', deviceId: 'tv-1', state: 'Paused', position: 0 });
  assert.deepEqual(h.events.started, []);

  h.feed({ event: 'state', deviceId: 'tv-1', state: 'Playing', position: 0 });
  assert.equal(h.events.started.length, 1);
});

test('a zero confirm window starts the session on the first event', () => {
  const h = harness({ confirmSeconds: 0 });
  h.lounge.start();

  h.feed({
    event: 'now-playing', deviceId: 'tv-1', videoId: 'abc',
    position: 0, durationSeconds: 600, state: 'Playing',
  });

  assert.equal(h.events.started.length, 1);
});

test('confirm timer starts a session without a later Lounge tick', () => {
  const h = harness({ confirmSeconds: 5 });
  h.lounge.start();

  h.feed({
    event: 'now-playing', deviceId: 'tv-1', videoId: 'abc',
    position: 0, durationSeconds: 600, state: 'Playing',
  });
  assert.deepEqual(h.events.started, []);

  // Apple TV often goes quiet for 60–90s — wall-clock confirm must still fire.
  h.advance(5);
  assert.equal(h.events.started.length, 1);
  assert.equal(h.events.started[0].videoId, 'abc');
});

test('Buffering past the confirm window still starts a session', () => {
  const h = harness({ confirmSeconds: 5 });
  h.lounge.start();

  h.feed({
    event: 'now-playing', deviceId: 'tv-1', videoId: 'abc',
    position: 0, durationSeconds: 600, state: 'Buffering',
  });
  h.advance(5);
  assert.equal(h.events.started.length, 1);
  assert.equal(h.events.started[0].videoId, 'abc');
});

// -------------------------------------------------------- ad suppression

test('an ad before the video restarts the confirm window', () => {
  const h = harness({ confirmSeconds: 5 });
  h.lounge.start();

  h.feed({
    event: 'now-playing', deviceId: 'tv-1', videoId: 'abc',
    position: 0, durationSeconds: 600, state: 'Playing',
  });
  h.advance(4);
  h.feed({ event: 'ad', deviceId: 'tv-1', playing: true });
  h.advance(4);
  h.feed({ event: 'ad', deviceId: 'tv-1', playing: false });
  h.feed({ event: 'state', deviceId: 'tv-1', state: 'Playing', position: 1 });

  assert.deepEqual(h.events.started, [], 'the pre-roll must not count toward the window');

  h.advance(6);
  h.feed({ event: 'state', deviceId: 'tv-1', state: 'Playing', position: 7 });
  assert.equal(h.events.started.length, 1);
});

test('a mid-roll ad holds the card instead of ending the session', () => {
  const h = harness({ confirmSeconds: 5 });
  h.lounge.start();
  playFor(h, { seconds: 6 });
  assert.equal(h.events.started.length, 1);

  h.feed({ event: 'state', deviceId: 'tv-1', state: 'Advertisement', position: 120 });

  assert.equal(h.events.stopped.length, 0, 'an ad is not the end of the video');
  assert.equal(h.lounge.snapshot().devices[0].adPlaying, true);

  h.feed({ event: 'state', deviceId: 'tv-1', state: 'Playing', position: 120 });
  assert.equal(h.lounge.snapshot().devices[0].adPlaying, false);
  assert.equal(h.events.started.length, 1, 'the same video must not restart after the ad');
});

test('a session never starts while an ad is on screen', () => {
  const h = harness({ confirmSeconds: 5 });
  h.lounge.start();

  h.feed({
    event: 'now-playing', deviceId: 'tv-1', videoId: 'abc',
    position: 0, durationSeconds: 600, state: 'Playing',
  });
  h.feed({ event: 'ad', deviceId: 'tv-1', playing: true });
  h.advance(20);
  h.feed({ event: 'state', deviceId: 'tv-1', state: 'Playing', position: 1 });

  assert.deepEqual(h.events.started, []);
});

test('content scrubber advancing clears a stuck ad flag', () => {
  const h = harness({ confirmSeconds: 5 });
  h.lounge.start();

  h.feed({
    event: 'now-playing', deviceId: 'tv-1', videoId: 'abc',
    position: 0, durationSeconds: 600, state: 'Playing',
  });
  h.feed({ event: 'ad', deviceId: 'tv-1', playing: true });
  h.advance(6);
  // Agent never sent ad:false, but content has clearly started.
  h.feed({ event: 'state', deviceId: 'tv-1', state: 'Playing', position: 8 });

  assert.equal(h.events.started.length, 1);
  assert.equal(h.lounge.snapshot().devices[0].adPlaying, false);
});

test('an ad flag left set by a silent agent does not wedge the next video', () => {
  const h = harness({ confirmSeconds: 5 });
  h.lounge.start();

  h.feed({
    event: 'now-playing', deviceId: 'tv-1', videoId: 'abc',
    position: 0, durationSeconds: 600, state: 'Playing',
  });
  // The agent reports an ad and then never reports it ending.
  h.feed({ event: 'ad', deviceId: 'tv-1', playing: true });
  h.feed({ event: 'state', deviceId: 'tv-1', state: 'Stopped', position: 0 });

  h.feed({
    event: 'now-playing', deviceId: 'tv-1', videoId: 'def',
    position: 0, durationSeconds: 600, state: 'Playing',
  });
  h.advance(6);
  h.feed({ event: 'state', deviceId: 'tv-1', state: 'Playing', position: 6 });

  assert.equal(h.events.started.length, 1);
  assert.equal(h.events.started[0].videoId, 'def');
});

// ------------------------------------------------------- watched seconds

test('watched time comes from position deltas, so pausing cannot inflate it', () => {
  const h = harness({ confirmSeconds: 5 });
  h.lounge.start();
  playFor(h, { seconds: 6, duration: 600 });

  h.advance(10);
  h.feed({ event: 'state', deviceId: 'tv-1', state: 'Playing', position: 16 });
  h.feed({ event: 'state', deviceId: 'tv-1', state: 'Paused', position: 16 });

  // Ten minutes of real time pass with the video paused.
  h.advance(600);
  h.feed({ event: 'state', deviceId: 'tv-1', state: 'Playing', position: 16 });
  h.advance(5);
  h.feed({ event: 'state', deviceId: 'tv-1', state: 'Playing', position: 21 });
  settleStop(h, { position: 21 });

  const [stopped] = h.events.stopped;
  assert.equal(stopped.watchedSeconds, 15, 'only played seconds count');
  assert.ok(stopped.watchedSeconds < 600);
});

test('a seek forward is not counted as watched time', () => {
  const h = harness({ confirmSeconds: 5 });
  h.lounge.start();
  playFor(h, { seconds: 6, duration: 3600 });

  h.feed({ event: 'state', deviceId: 'tv-1', state: 'Playing', position: 10 });
  // Jump half an hour ahead: a delta of 1800s is a scrub, not viewing.
  h.feed({ event: 'state', deviceId: 'tv-1', state: 'Playing', position: 1810 });
  h.feed({ event: 'state', deviceId: 'tv-1', state: 'Playing', position: 1815 });
  settleStop(h, { position: 1815 });

  // Scrubs do not inflate the delta total; the scrubber position is stored
  // separately so the last-played card can still say how far into the video.
  assert.equal(h.events.stopped[0].watchedSeconds, 9);
  assert.equal(h.events.stopped[0].positionSeconds, 1815);
});

test('slow Lounge ticks still accumulate watched time', () => {
  const h = harness({ confirmSeconds: 5 });
  h.lounge.start();
  playFor(h, { seconds: 6, duration: 3600 });

  // Apple TV often spaces state events 60–90s apart; the old 60s ceiling
  // discarded every real tick and left last-played at "Watched 0:00 of …".
  h.feed({ event: 'state', deviceId: 'tv-1', state: 'Playing', position: 10 });
  h.feed({ event: 'state', deviceId: 'tv-1', state: 'Playing', position: 100 });
  h.feed({ event: 'state', deviceId: 'tv-1', state: 'Playing', position: 190 });
  settleStop(h, { position: 190 });

  assert.equal(h.events.stopped[0].watchedSeconds, 184);
  assert.equal(h.events.stopped[0].positionSeconds, 190);
});

test('a sparse stream that only reports the final position still records watch time', () => {
  const h = harness({ confirmSeconds: 5 });
  h.lounge.start();
  playFor(h, { seconds: 6, duration: 600 });

  // One Stopped sample at 4 minutes — no intermediate Playing ticks after confirm.
  settleStop(h, { position: 240 });

  assert.equal(h.events.stopped[0].positionSeconds, 240);
  assert.equal(h.events.stopped[0].watchedSeconds, 240);
});

test('a seek backwards does not drive watched time negative', () => {
  const h = harness({ confirmSeconds: 5 });
  h.lounge.start();
  playFor(h, { seconds: 6, duration: 600 });

  h.feed({ event: 'state', deviceId: 'tv-1', state: 'Playing', position: 20 });
  h.feed({ event: 'state', deviceId: 'tv-1', state: 'Playing', position: 5 });
  settleStop(h, { position: 5 });

  assert.ok(h.events.stopped[0].watchedSeconds >= 0);
  assert.equal(h.events.stopped[0].watchedSeconds, 14);
});

test('watching to the end marks the session complete', () => {
  const h = harness({ confirmSeconds: 5 });
  h.lounge.start();
  playFor(h, { seconds: 6, duration: 100 });

  for (let position = 10; position <= 100; position += 10) {
    h.feed({ event: 'state', deviceId: 'tv-1', state: 'Playing', position });
  }
  settleStop(h, { position: 100 });

  const [stopped] = h.events.stopped;
  assert.equal(stopped.completed, true);
  assert.equal(stopped.durationSeconds, 100);
});

test('abandoning a video early does not mark it complete', () => {
  const h = harness({ confirmSeconds: 5 });
  h.lounge.start();
  playFor(h, { seconds: 6, duration: 600 });

  h.feed({ event: 'state', deviceId: 'tv-1', state: 'Playing', position: 30 });
  settleStop(h, { position: 30 });

  assert.equal(h.events.stopped[0].completed, false);
});

test('a brief Stopped flicker does not end the session', () => {
  const h = harness({ confirmSeconds: 5 });
  h.lounge.start();
  playFor(h, { seconds: 6 });

  h.feed({ event: 'state', deviceId: 'tv-1', state: 'Stopped', position: 20 });
  assert.equal(h.events.stopped.length, 0, 'grace window must absorb the flicker');

  h.feed({ event: 'state', deviceId: 'tv-1', state: 'Playing', position: 22 });
  h.advance(2);
  assert.equal(h.events.stopped.length, 0);
  assert.equal(h.lounge.activeSessions().length, 1);
});

test('Apple TV sparse Stopped ticks do not clear provisional before confirm', () => {
  const h = harness({ confirmSeconds: 5 });
  h.lounge.start();

  h.feed({
    event: 'now-playing', deviceId: 'tv-1', videoId: 'live-id',
    position: 0, durationSeconds: 600, state: 'Playing',
  });
  // Typical Apple TV pattern: one Playing sample, then Stopped for ~60s.
  h.feed({ event: 'state', deviceId: 'tv-1', state: 'Stopped', position: 1 });
  h.advance(30);
  assert.deepEqual(h.events.started, [], 'confirm needs Playing, not just elapsed wall time');
  assert.equal(h.lounge.currentPlayback()[0]?.videoId, 'live-id');

  h.feed({ event: 'state', deviceId: 'tv-1', state: 'Playing', position: 30 });
  h.advance(CONFIRM_RETRY_MS / 1000);
  assert.equal(h.events.started.length, 1);
  assert.equal(h.events.started[0].videoId, 'live-id');
});

test('Apple TV Stopped watches are observed into history without a live card', () => {
  const h = harness({ confirmSeconds: 5 });
  h.lounge.start();

  h.feed({
    event: 'now-playing', deviceId: 'tv-1', videoId: 'today-id',
    position: 40, durationSeconds: 600, state: 'Stopped',
  });
  assert.deepEqual(h.events.started, []);
  assert.deepEqual(h.events.observed, []);

  h.advance(5);
  assert.deepEqual(h.events.started, [], 'Stopped must not air a now-playing card');
  assert.equal(h.events.observed.length, 1);
  assert.equal(h.events.observed[0].videoId, 'today-id');
  assert.equal(h.events.observed[0].positionSeconds, 40);
});

test('currentPlayback keeps a Stopped provisional during the stop grace', () => {
  const h = harness({ confirmSeconds: 5 });
  h.lounge.start();

  h.feed({
    event: 'now-playing', deviceId: 'tv-1', videoId: 'live-id',
    position: 12, durationSeconds: 600, state: 'Playing',
  });
  h.feed({ event: 'state', deviceId: 'tv-1', state: 'Stopped', position: 12 });

  const current = h.lounge.currentPlayback();
  assert.equal(current.length, 1);
  assert.equal(current[0].videoId, 'live-id');
  assert.equal(current[0].provisional, true);
});

test('an ad contentVideoId seeds provisional before now-playing', () => {
  const h = harness({ confirmSeconds: 5 });
  h.lounge.start();

  h.feed({
    event: 'ad', deviceId: 'tv-1', playing: true, contentVideoId: 'content-1',
  });
  assert.equal(h.lounge.currentPlayback()[0]?.videoId, 'content-1');

  h.feed({ event: 'ad', deviceId: 'tv-1', playing: false, contentVideoId: 'content-1' });
  h.feed({
    event: 'now-playing', deviceId: 'tv-1', videoId: 'content-1',
    position: 0, durationSeconds: 600, state: 'Playing',
  });
  h.advance(6);
  assert.equal(h.events.started.length, 1);
  assert.equal(h.events.started[0].videoId, 'content-1');
});

// ------------------------------------------------------ session boundaries

test('switching videos closes the first session and opens the second', () => {
  const h = harness({ confirmSeconds: 5 });
  h.lounge.start();
  playFor(h, { seconds: 6, videoId: 'first' });

  h.feed({
    event: 'now-playing', deviceId: 'tv-1', videoId: 'second',
    position: 0, durationSeconds: 400, state: 'Playing',
  });

  assert.equal(h.events.stopped.length, 1);
  assert.equal(h.events.stopped[0].videoId, 'first');
  assert.equal(h.events.stopped[0].reason, 'changed');

  h.advance(6);
  h.feed({ event: 'state', deviceId: 'tv-1', state: 'Playing', position: 6 });
  assert.equal(h.events.started.length, 2);
  assert.equal(h.events.started[1].videoId, 'second');
});

test('a disconnect ends the session and clears the active list', () => {
  const h = harness({ confirmSeconds: 5 });
  h.lounge.start();
  playFor(h, { seconds: 6 });

  h.feed({ event: 'disconnected', deviceId: 'tv-1' });

  assert.equal(h.events.stopped.length, 1);
  assert.equal(h.events.stopped[0].reason, 'disconnected');
  assert.deepEqual(h.lounge.activeSessions(), []);
  assert.equal(h.lounge.snapshot().devices[0].connected, false);
});

test('stopping twice emits one stop, not two', () => {
  const h = harness({ confirmSeconds: 5 });
  h.lounge.start();
  playFor(h, { seconds: 6 });

  h.feed({ event: 'state', deviceId: 'tv-1', state: 'Stopped', position: 30 });
  h.feed({ event: 'state', deviceId: 'tv-1', state: 'Stopped', position: 30 });
  h.advance((STOP_GRACE_MS / 1000) + 0.1);
  h.feed({ event: 'disconnected', deviceId: 'tv-1' });

  assert.equal(h.events.stopped.length, 1);
});

test('currentPlayback exposes provisional video before confirm', () => {
  const h = harness({ confirmSeconds: 5 });
  h.lounge.start();

  h.feed({
    event: 'now-playing', deviceId: 'tv-1', videoId: 'live-id',
    position: 0, durationSeconds: 600, state: 'Playing',
  });

  const current = h.lounge.currentPlayback();
  assert.equal(current.length, 1);
  assert.equal(current[0].videoId, 'live-id');
  assert.equal(current[0].provisional, true);
  assert.deepEqual(h.lounge.activeSessions(), []);
});

// ------------------------------------------------------------ active list

test('a paused session is not reported as playing', () => {
  const h = harness({ confirmSeconds: 5 });
  h.lounge.start();
  playFor(h, { seconds: 6 });
  assert.equal(h.lounge.activeSessions().length, 1);

  h.feed({ event: 'state', deviceId: 'tv-1', state: 'Paused', position: 20 });
  assert.deepEqual(h.lounge.activeSessions(), [], 'paused is not "what I am watching"');

  h.feed({ event: 'state', deviceId: 'tv-1', state: 'Playing', position: 20 });
  assert.equal(h.lounge.activeSessions().length, 1);
});

test('two TVs playing at once list most-recent first', () => {
  const h = harness({ confirmSeconds: 5 });
  h.lounge.start();

  playFor(h, { deviceId: 'living-room', videoId: 'older', seconds: 6 });
  h.advance(120);
  playFor(h, { deviceId: 'theater', videoId: 'newer', seconds: 6 });

  const sessions = h.lounge.activeSessions();
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].deviceId, 'theater');
  assert.equal(sessions[1].deviceId, 'living-room');
});

// -------------------------------------------------------------- prefetch

test('the autoplay queue is prefetched only during real playback', () => {
  const h = harness({ confirmSeconds: 5 });
  h.lounge.start();

  // Before any session exists there is nothing worth warming.
  h.feed({ event: 'up-next', deviceId: 'tv-1', videoId: 'next-1' });
  assert.deepEqual(h.events.prefetch, []);

  playFor(h, { seconds: 6 });
  h.feed({ event: 'up-next', deviceId: 'tv-1', videoId: 'next-2' });

  assert.deepEqual(h.events.prefetch, [{ deviceId: 'tv-1', videoId: 'next-2' }]);
});

test('a cleared autoplay queue prefetches nothing', () => {
  const h = harness({ confirmSeconds: 5 });
  h.lounge.start();
  playFor(h, { seconds: 6 });

  h.feed({ event: 'up-next', deviceId: 'tv-1', videoId: null });
  assert.deepEqual(h.events.prefetch, []);
});

// ------------------------------------------------------------- snapshot

test('the snapshot reports a missing pyytlounge rather than pretending to work', () => {
  const h = harness();
  h.lounge.start();
  h.feed({ event: 'ready', loungeAvailable: false });

  const snapshot = h.lounge.snapshot();
  assert.equal(snapshot.ready, true);
  assert.equal(snapshot.loungeAvailable, false);
  assert.equal(snapshot.running, true);
});

test('an unusable pyytlounge says which import failed, not just "missing"', () => {
  const h = harness();
  h.lounge.start();
  // The 2.x → 3.x break looked exactly like an absent package from the admin
  // page, which sent the fix in the wrong direction for a whole session.
  h.feed({
    event: 'ready',
    loungeAvailable: false,
    error: "ImportError: cannot import name 'State' from 'pyytlounge.wrapper'",
  });

  const reason = h.lounge.unavailableReason();
  assert.match(reason, /pyytlounge/);
  assert.match(reason, /cannot import name 'State'/);
  assert.equal(h.lounge.snapshot().unavailableReason, reason);
});

test('a healthy agent has nothing to explain', () => {
  const h = harness();
  h.lounge.start();
  h.feed({ event: 'ready', loungeAvailable: true });

  assert.equal(h.lounge.unavailableReason(), null);
  assert.equal(h.lounge.snapshot().unavailableReason, null);
});

test('the lounge stays dormant when it is switched off', () => {
  const clock = { t: Date.now() };
  const spawned = [];
  const lounge = createYoutubeLounge({
    config: { youtube: { loungeEnabled: false } },
    now: () => clock.t,
    spawnImpl: () => {
      spawned.push(1);
      return fakeChild();
    },
  });

  lounge.start();
  assert.equal(spawned.length, 0);
  assert.equal(lounge.snapshot().running, false);
});
