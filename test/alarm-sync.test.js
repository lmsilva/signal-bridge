const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  normalizeAlarmNotification,
  isActiveAlarm,
  listActiveAlarms,
  shouldEmitAlarmSnapshot,
  reclassifyAlarmEvents,
  recurringAlarmFires,
} = require('../src/alarm-sync');
const { buildAlarmSnapshotPayload } = require('../src/udp-payload');
const { createAlarmSync } = require('../src/alarm-sync');

test('normalizeAlarmNotification maps Amazon alarm notification', () => {
  const triggerTime = Date.now() + 3600000;
  const alarm = normalizeAlarmNotification({
    type: 'Alarm',
    notificationIndex: 'alarm-1',
    deviceSerialNumber: 'SERIAL123',
    status: 'ON',
    triggerTime,
    alarmLabel: 'Wake up',
  }, { SERIAL123: 'Bedroom Echo' });

  assert.ok(alarm);
  assert.equal(alarm.amazonId, 'alarm-1');
  assert.equal(alarm.device, 'Bedroom Echo');
  assert.equal(alarm.label, 'Wake up');
  assert.ok(alarm.remainingSec >= 3590 && alarm.remainingSec <= 3610);
});

test('normalizeAlarmNotification reads originalDate and originalTime when triggerTime is zero', () => {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const date = tomorrow.toISOString().slice(0, 10);
  const alarm = normalizeAlarmNotification({
    type: 'Alarm',
    notificationIndex: 'alarm-original',
    deviceSerialNumber: 'SERIAL123',
    status: 'ON',
    triggerTime: 0,
    alarmTime: 0,
    originalDate: date,
    originalTime: '07:30:00.000',
    deviceName: 'Bedroom Echo',
  }, {}, { localTimeZone: 'America/Denver' });

  assert.ok(alarm);
  assert.equal(alarm.device, 'Bedroom Echo');
  assert.ok(alarm.triggerTime);
  assert.ok(alarm.remainingSec != null && alarm.remainingSec > 0);

  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Denver',
    hour: 'numeric',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(alarm.triggerTime));
  assert.match(formatted, /7:30/);
});

test('normalizeAlarmNotification keeps 8am local instead of shifting to 2am', () => {
  const alarm = normalizeAlarmNotification({
    type: 'Alarm',
    notificationIndex: 'alarm-8am',
    deviceSerialNumber: 'SERIAL123',
    status: 'ON',
    triggerTime: 0,
    originalDate: '2026-07-09',
    originalTime: '08:00:00.000',
    deviceName: 'Bedroom Echo',
  }, {}, { localTimeZone: 'America/Denver' });

  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Denver',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(alarm.triggerTime));
  assert.match(formatted, /8:00/);
});

test('normalizeAlarmNotification falls back to remainingTime when schedule fields missing', () => {
  const alarm = normalizeAlarmNotification({
    type: 'Alarm',
    notificationIndex: 'alarm-remaining',
    deviceSerialNumber: 'SERIAL123',
    status: 'ON',
    triggerTime: 0,
    remainingTime: 5400000,
  }, { SERIAL123: 'Kitchen Echo' });

  assert.ok(alarm);
  assert.ok(alarm.triggerTime);
  assert.ok(alarm.remainingSec >= 5390 && alarm.remainingSec <= 5410);
});

test('normalizeAlarmNotification accepts MusicAlarm type', () => {
  const alarm = normalizeAlarmNotification({
    type: 'MusicAlarm',
    notificationIndex: 'music-alarm-1',
    deviceSerialNumber: 'SERIAL123',
    status: 'ON',
    triggerTime: Date.now() + 7200000,
  }, { SERIAL123: 'Kitchen Echo' });

  assert.equal(alarm.alarmType, 'music');
});

test('isActiveAlarm ignores OFF alarms without recurrence', () => {
  assert.equal(isActiveAlarm({ status: 'OFF', remainingSec: 0 }), false);
  assert.equal(isActiveAlarm({ status: 'ON', remainingSec: 120 }), true);
  assert.equal(isActiveAlarm({ status: 'ON', recurrence: 'daily' }), true);
});

test('buildAlarmSnapshotPayload marks highlighted alarm as new', () => {
  const payload = buildAlarmSnapshotPayload({
    alarms: [
      { amazonId: 'alarm-1', device: 'Kitchen Echo', triggerTime: new Date().toISOString() },
      { amazonId: 'alarm-2', device: 'Bedroom Echo', triggerTime: new Date().toISOString() },
    ],
    trigger: 'alarm-set-voice',
    event: { kind: 'started', amazonId: 'alarm-2' },
    highlightAmazonId: 'alarm-2',
  }, { udpBroadcast: { defaultDisplaySeconds: 60 } });

  assert.equal(payload.type, 'alarm.snapshot');
  assert.equal(payload.alarms[0].isNew, false);
  assert.equal(payload.alarms[1].isNew, true);
});

test('createAlarmSync emits show-alarms snapshot with empty list', async () => {
  const mirrorPath = path.join(os.tmpdir(), `alarm-mirror-test-${Date.now()}.json`);

  await new Promise((resolve, reject) => {
    const sync = createAlarmSync({
      alexa: {
        getNotifications(_all, callback) {
          callback(null, { notifications: [] });
        },
      },
      config: {
        sessionPath: path.join(os.tmpdir(), 'alexa-session-test.json'),
        alarmMirrorPath: mirrorPath,
        alarmSync: { enabled: true, mirrorFile: mirrorPath },
      },
      log: { info() {}, warn() {}, debug() {} },
      onSnapshot: (snapshot) => {
        try {
          assert.equal(snapshot.trigger, 'show-alarms');
          assert.deepEqual(snapshot.alarms, []);
          resolve();
        } catch (error) {
          reject(error);
        }
      },
    });

    sync.requestImmediatePoll('show-alarms', 'Kitchen Echo');
  }).finally(() => {
    if (fs.existsSync(mirrorPath)) {
      fs.unlinkSync(mirrorPath);
    }
  });
});

test('listActiveAlarms sorts by trigger time', () => {
  const alarms = listActiveAlarms({
    later: {
      amazonId: 'later',
      status: 'ON',
      triggerTime: new Date(Date.now() + 7200000).toISOString(),
      remainingSec: 7200,
    },
    sooner: {
      amazonId: 'sooner',
      status: 'ON',
      triggerTime: new Date(Date.now() + 3600000).toISOString(),
      remainingSec: 3600,
    },
  });

  assert.equal(alarms[0].amazonId, 'sooner');
  assert.equal(alarms[1].amazonId, 'later');
});

test('a removal near the alarm time is a fire, an early removal stays a cancel', () => {
  const ringing = reclassifyAlarmEvents([{
    kind: 'removed',
    timer: { triggerTime: new Date(Date.now() - 10 * 60 * 1000).toISOString(), device: 'Bedroom Echo' },
  }]);
  assert.equal(ringing[0].kind, 'fired');

  const early = reclassifyAlarmEvents([{
    kind: 'cancelled',
    timer: { fireAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString() },
  }]);
  assert.equal(early[0].kind, 'cancelled');
});

test('a recurring alarm that rolls to the next day is a fire of the occurrence that passed', () => {
  const previous = {
    amazonId: 'daily',
    device: 'Bedroom Echo',
    status: 'ON',
    triggerTime: new Date(Date.now() - 30 * 1000).toISOString(),
    fireAt: new Date(Date.now() - 30 * 1000).toISOString(),
  };
  const events = recurringAlarmFires(
    { daily: previous },
    {
      daily: {
        ...previous,
        triggerTime: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        fireAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      },
    },
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'fired');
  assert.equal(events[0].timer.device, 'Bedroom Echo');
});

test('createAlarmSync reports a due alarm as fired when Amazon drops it', async () => {
  const mirrorPath = path.join(os.tmpdir(), `alarm-mirror-fire-${Date.now()}.json`);
  const trigger = new Date(Date.now() - 20 * 1000).toISOString();
  fs.writeFileSync(mirrorPath, JSON.stringify({
    alarms: {
      a1: {
        amazonId: 'a1',
        device: 'Bedroom Echo',
        label: null,
        status: 'ON',
        triggerTime: trigger,
        remainingSec: 20,
        updatedAt: new Date().toISOString(),
      },
    },
  }));

  let sync;
  try {
    const snapshot = await new Promise((resolve, reject) => {
      sync = createAlarmSync({
        alexa: {
          getNotifications(_all, callback) {
            callback(null, { notifications: [] });
          },
        },
        config: {
          sessionPath: path.join(os.tmpdir(), 'alexa-session-test.json'),
          alarmMirrorPath: mirrorPath,
          alarmSync: { enabled: true },
        },
        log: { info() {}, warn() {}, debug() {} },
        onSnapshot: (shot) => {
          try {
            resolve(shot);
          } catch (error) {
            reject(error);
          }
        },
      });
      sync.requestImmediatePoll('notification-change', 'Bedroom Echo');
    });
    assert.equal(snapshot.event.kind, 'fired');
    assert.equal(snapshot.event.alarm.device, 'Bedroom Echo');
    assert.equal(snapshot.event.alarm.triggerTime, trigger);
  } finally {
    sync?.stop();
    if (fs.existsSync(mirrorPath)) {
      fs.unlinkSync(mirrorPath);
    }
  }
});

test('shouldEmitAlarmSnapshot does not re-emit unchanged lists on followup polls', () => {
  assert.equal(shouldEmitAlarmSnapshot([], 'show-alarms'), true);
  assert.equal(shouldEmitAlarmSnapshot([], 'show-alarms-followup-2000ms'), false);
  assert.equal(shouldEmitAlarmSnapshot([], 'alarm-set-voice-followup-5000ms'), false);
  assert.equal(
    shouldEmitAlarmSnapshot(
      [{ kind: 'started', amazonId: 'a1', alarm: { amazonId: 'a1' } }],
      'show-alarms-followup-2000ms',
    ),
    true,
  );
});
