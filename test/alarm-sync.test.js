const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  normalizeAlarmNotification,
  isActiveAlarm,
  listActiveAlarms,
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
