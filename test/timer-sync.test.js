const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeTimerNotification,
  diffTimerSnapshots,
  isActiveTimer,
  mergeTimerMaps,
  parseRemainingSeconds,
  parseDurationSeconds,
  shouldEmitSnapshot,
  VOICE_HINT_FOLLOWUP_DELAYS_MS,
  DEFAULTS,
} = require('../src/timer-sync');

test('normalizeTimerNotification maps Amazon timer notification', () => {
  const timer = normalizeTimerNotification({
    type: 'Timer',
    notificationIndex: 'timer-1',
    deviceSerialNumber: 'SERIAL123',
    status: 'ON',
    remainingTime: 240,
    timerLabel: 'Pizza',
    createdDate: Date.now() - 60000,
    triggerTime: Date.now() + 240000,
  }, { SERIAL123: 'Kitchen Echo' });

  assert.ok(timer);
  assert.equal(timer.amazonId, 'timer-1');
  assert.equal(timer.device, 'Kitchen Echo');
  assert.equal(timer.remainingSec, 240);
  assert.equal(timer.label, 'Pizza');
});

test('parseRemainingSeconds prefers triggerTime over stale remainingTime', () => {
  const remainingSec = parseRemainingSeconds({
    remainingTime: 56335,
    originalDurationInMillis: 3600000,
    createdDate: Date.now() - 60000,
    triggerTime: Date.now() + 3600000,
  });

  assert.ok(remainingSec >= 3590 && remainingSec <= 3610);
});

test('parseDurationSeconds uses originalDurationInMillis', () => {
  const durationSec = parseDurationSeconds({
    originalDurationInMillis: 3600000,
    remainingTime: 3600000,
  });

  assert.equal(durationSec, 3600);
});

test('parseRemainingSeconds converts millisecond remainingTime when needed', () => {
  const remainingSec = parseRemainingSeconds({
    remainingTime: 1800000,
    originalDurationInMillis: 1800000,
  });

  assert.equal(remainingSec, 1800);
});

test('mergeTimerMaps keeps recently seen timers missing from partial poll', () => {
  const previous = {
    old: {
      amazonId: 'old',
      device: 'Kitchen Echo',
      remainingSec: 120,
      fireAt: new Date(Date.now() + 120000).toISOString(),
      status: 'ON',
      updatedAt: new Date().toISOString(),
    },
  };
  const current = {
    new: {
      amazonId: 'new',
      device: 'Bedroom Echo',
      remainingSec: 300,
      fireAt: new Date(Date.now() + 300000).toISOString(),
      status: 'ON',
      updatedAt: new Date().toISOString(),
    },
  };

  const merged = mergeTimerMaps(previous, current);
  assert.equal(Object.keys(merged).length, 2);
  assert.ok(merged.old);
  assert.ok(merged.new);
});

test('diffTimerSnapshots detects started and cancelled timers', () => {
  const previous = {
    old: {
      amazonId: 'old',
      device: 'Kitchen Echo',
      remainingSec: 120,
      fireAt: new Date(Date.now() + 120000).toISOString(),
      status: 'ON',
    },
  };
  const current = {
    new: {
      amazonId: 'new',
      device: 'Kitchen Echo',
      remainingSec: 300,
      fireAt: new Date(Date.now() + 300000).toISOString(),
      status: 'ON',
    },
  };

  const events = diffTimerSnapshots(previous, current, { fireVerifySlackMs: 30000 });
  assert.ok(events.some((event) => event.kind === 'started' && event.amazonId === 'new'));
  assert.ok(events.some((event) => event.kind === 'cancelled' && event.amazonId === 'old'));
});

test('isActiveTimer ignores OFF timers', () => {
  assert.equal(isActiveTimer({ status: 'OFF', remainingSec: 0 }), false);
  assert.equal(isActiveTimer({ status: 'ON', remainingSec: 10 }), true);
  assert.equal(isActiveTimer({ status: 'ON', remainingSec: 0, durationSec: 300 }), true);
});

test('applySnapshot emits when active timer count increases', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { createTimerSync } = require('../src/timer-sync');
  const mirrorPath = path.join(os.tmpdir(), `timer-mirror-test-${Date.now()}.json`);

  await new Promise((resolve, reject) => {
    const sync = createTimerSync({
      alexa: {
        getNotifications(_all, callback) {
          callback(null, {
            notifications: [{
              type: 'Timer',
              notificationIndex: 'timer-test-1',
              deviceSerialNumber: 'SERIAL123',
              status: 'ON',
              remainingTime: 300,
              originalDurationInMillis: 300000,
              triggerTime: Date.now() + 300000,
            }],
          });
        },
      },
      config: {
        sessionPath: path.join(os.tmpdir(), 'alexa-session-test.json'),
        timerMirrorPath: mirrorPath,
        timerSync: { enabled: true, mirrorFile: mirrorPath },
      },
      log: { info() {}, warn() {}, debug() {} },
      onSnapshot: (snapshot) => {
        try {
          assert.equal(snapshot.event.kind, 'started');
          assert.equal(snapshot.timers.length, 1);
          resolve();
        } catch (error) {
          reject(error);
        }
      },
      getDeviceNameMap: () => ({ SERIAL123: 'Kitchen Echo' }),
    });

    sync.pollNotifications('scheduled');
  });

  fs.rmSync(mirrorPath, { force: true });
});

test('applySnapshot emits updated list when a timer is cancelled', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { createTimerSync } = require('../src/timer-sync');
  const mirrorPath = path.join(os.tmpdir(), `timer-mirror-partial-cancel-${Date.now()}.json`);
  const fireAt = new Date(Date.now() + 300000).toISOString();

  fs.writeFileSync(mirrorPath, JSON.stringify({
    timers: {
      'timer-1': {
        amazonId: 'timer-1',
        device: 'Kitchen Echo',
        remainingSec: 300,
        fireAt,
        status: 'ON',
        updatedAt: new Date().toISOString(),
      },
      'timer-2': {
        amazonId: 'timer-2',
        device: 'Bedroom Echo',
        remainingSec: 600,
        fireAt: new Date(Date.now() + 600000).toISOString(),
        status: 'ON',
        updatedAt: new Date().toISOString(),
      },
    },
  }));

  await new Promise((resolve, reject) => {
    const sync = createTimerSync({
      alexa: {
        getNotifications(_all, callback) {
          callback(null, {
            notifications: [{
              type: 'Timer',
              notificationIndex: 'timer-2',
              deviceSerialNumber: 'SERIAL456',
              status: 'ON',
              remainingTime: 600,
              originalDurationInMillis: 600000,
              triggerTime: Date.now() + 600000,
            }],
          });
        },
      },
      config: {
        sessionPath: path.join(os.tmpdir(), 'alexa-session-test.json'),
        timerMirrorPath: mirrorPath,
        timerSync: { enabled: true },
      },
      log: { info() {}, warn() {}, debug() {} },
      onSnapshot: (snapshot) => {
        try {
          assert.equal(snapshot.event.kind, 'cancelled');
          assert.equal(snapshot.timers.length, 1);
          assert.equal(snapshot.timers[0].amazonId, 'timer-2');
          resolve();
        } catch (error) {
          reject(error);
        }
      },
      getDeviceNameMap: () => ({ SERIAL456: 'Bedroom Echo' }),
    });

    sync.pollNotifications('timer-cancel-voice');
  });

  fs.rmSync(mirrorPath, { force: true });
});

test('applySnapshot emits empty list when all timers cancelled', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { createTimerSync } = require('../src/timer-sync');
  const mirrorPath = path.join(os.tmpdir(), `timer-mirror-cancel-all-${Date.now()}.json`);

  fs.writeFileSync(mirrorPath, JSON.stringify({
    timers: {
      'timer-1': {
        amazonId: 'timer-1',
        device: 'Kitchen Echo',
        remainingSec: 120,
        fireAt: new Date(Date.now() + 120000).toISOString(),
        status: 'ON',
        updatedAt: new Date().toISOString(),
      },
    },
  }));

  await new Promise((resolve, reject) => {
    const sync = createTimerSync({
      alexa: {
        getNotifications(_all, callback) {
          callback(null, { notifications: [] });
        },
      },
      config: {
        sessionPath: path.join(os.tmpdir(), 'alexa-session-test.json'),
        timerMirrorPath: mirrorPath,
        timerSync: { enabled: true },
      },
      log: { info() {}, warn() {}, debug() {} },
      onSnapshot: (snapshot) => {
        try {
          assert.equal(snapshot.event.kind, 'cancelled');
          assert.equal(snapshot.timers.length, 0);
          resolve();
        } catch (error) {
          reject(error);
        }
      },
    });

    sync.pollNotifications('timer-cancel-voice');
  });

  fs.rmSync(mirrorPath, { force: true });
});

test('shouldEmitSnapshot ignores routine remaining-time updates', () => {
  const events = [{
    kind: 'updated',
    amazonId: 'timer-1',
    timer: { amazonId: 'timer-1', remainingSec: 200 },
  }];
  assert.equal(shouldEmitSnapshot(events, 'scheduled'), false);
  assert.equal(shouldEmitSnapshot(events, 'timer-set-voice'), true);
});

test('shouldEmitSnapshot does not re-emit unchanged lists on followup polls', () => {
  // Followups after "show my timers" used to push the same list again and
  // steal later overlays (Shared Photo Slideshow).
  assert.equal(shouldEmitSnapshot([], 'show-timers'), true);
  assert.equal(shouldEmitSnapshot([], 'show-timers-followup-2000ms'), false);
  assert.equal(shouldEmitSnapshot([], 'timer-set-voice-followup-5000ms'), false);
});

test('shouldEmitSnapshot notifies on timer lifecycle events', () => {
  const events = [{
    kind: 'started',
    amazonId: 'timer-1',
    timer: { amazonId: 'timer-1', remainingSec: 300 },
  }];
  assert.equal(shouldEmitSnapshot(events, 'scheduled'), true);
  assert.equal(shouldEmitSnapshot(events, 'show-timers-followup-2000ms'), true);
});

test('pickPrimaryTimerEvent prefers cancelled on cancel-voice trigger', () => {
  const { pickPrimaryTimerEvent } = require('../src/timer-sync');
  const events = [
    { kind: 'cancelled', amazonId: 'timer-1', timer: { amazonId: 'timer-1' } },
  ];
  const event = pickPrimaryTimerEvent(events, 'timer-cancel-voice');
  assert.equal(event.kind, 'cancelled');
});

test('pickPrimaryTimerEvent prefers fired over started on sync polls', () => {
  const { pickPrimaryTimerEvent } = require('../src/timer-sync');
  const events = [
    { kind: 'started', amazonId: 'timer-2', timer: { amazonId: 'timer-2' } },
    { kind: 'fired', amazonId: 'timer-1', timer: { amazonId: 'timer-1' } },
  ];
  const event = pickPrimaryTimerEvent(events, 'fire-verify');
  assert.equal(event.kind, 'fired');
});

test('mergeTimerMaps drops expired ghost timers', () => {
  const previous = {
    old: {
      amazonId: 'old',
      device: 'Kitchen Echo',
      remainingSec: 10,
      fireAt: new Date(Date.now() - 5000).toISOString(),
      status: 'ON',
      updatedAt: new Date(Date.now() - 1000).toISOString(),
    },
  };

  const merged = mergeTimerMaps(previous, {});
  assert.equal(Object.keys(merged).length, 0);
});

test('voice-hint followup delays keep polling until close to the next background poll', () => {
  // A slow-to-propagate Amazon cancellation should not have to wait for the
  // 30s background poll loop before the display catches up.
  assert.ok(VOICE_HINT_FOLLOWUP_DELAYS_MS.length >= 5);
  const last = VOICE_HINT_FOLLOWUP_DELAYS_MS[VOICE_HINT_FOLLOWUP_DELAYS_MS.length - 1];
  assert.ok(last >= 20000 && last < DEFAULTS.pollIntervalMs);
  for (let i = 1; i < VOICE_HINT_FOLLOWUP_DELAYS_MS.length; i += 1) {
    assert.ok(VOICE_HINT_FOLLOWUP_DELAYS_MS[i] > VOICE_HINT_FOLLOWUP_DELAYS_MS[i - 1]);
  }
});

test('requestImmediatePoll schedules a followup poll for every configured delay on cancel', () => {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const { createTimerSync } = require('../src/timer-sync');
  const mirrorPath = path.join(os.tmpdir(), `timer-mirror-followups-${Date.now()}.json`);
  const scheduledDelays = [];

  const originalSetTimeout = global.setTimeout;
  global.setTimeout = (fn, delayMs, ...args) => {
    scheduledDelays.push(delayMs);
    // Run the callback synchronously so we can assert on total poll count
    // without waiting for real (or mocked) timers to elapse.
    fn(...args);
    return 0;
  };

  let callCount = 0;
  try {
    const sync = createTimerSync({
      alexa: {
        getNotifications(_all, callback) {
          callCount += 1;
          callback(null, { notifications: [] });
        },
      },
      config: {
        sessionPath: path.join(os.tmpdir(), 'alexa-session-test.json'),
        timerMirrorPath: mirrorPath,
        timerSync: { enabled: true },
      },
      log: { info() {}, warn() {}, debug() {} },
      onSnapshot: () => {},
    });

    sync.requestImmediatePoll('timer-cancel-voice');
  } finally {
    global.setTimeout = originalSetTimeout;
    fs.rmSync(mirrorPath, { force: true });
  }

  assert.deepEqual(scheduledDelays, VOICE_HINT_FOLLOWUP_DELAYS_MS);
  // Immediate poll + one per configured followup delay.
  assert.equal(callCount, VOICE_HINT_FOLLOWUP_DELAYS_MS.length + 1);
});
