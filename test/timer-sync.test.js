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

test('shouldEmitSnapshot ignores routine remaining-time updates', () => {
  const events = [{
    kind: 'updated',
    amazonId: 'timer-1',
    timer: { amazonId: 'timer-1', remainingSec: 200 },
  }];
  assert.equal(shouldEmitSnapshot(events, 'scheduled'), false);
  assert.equal(shouldEmitSnapshot(events, 'timer-set-voice'), true);
});

test('shouldEmitSnapshot notifies on timer lifecycle events', () => {
  const events = [{
    kind: 'started',
    amazonId: 'timer-1',
    timer: { amazonId: 'timer-1', remainingSec: 300 },
  }];
  assert.equal(shouldEmitSnapshot(events, 'scheduled'), true);
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
