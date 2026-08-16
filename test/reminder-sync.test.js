const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  normalizeReminderNotification,
  isActiveReminder,
  createReminderSync,
} = require('../src/reminder-sync');
const { buildReminderFiredPayload } = require('../src/udp-payload');

test('normalizeReminderNotification maps Amazon Reminder rows', () => {
  const triggerTime = Date.now() + 3600000;
  const reminder = normalizeReminderNotification({
    type: 'Reminder',
    notificationIndex: 'rem-1',
    deviceSerialNumber: 'SERIAL123',
    status: 'ON',
    triggerTime,
    reminderLabel: 'check on the corn',
  }, { SERIAL123: 'Kitchen Echo' });

  assert.ok(reminder);
  assert.equal(reminder.amazonId, 'rem-1');
  assert.equal(reminder.device, 'Kitchen Echo');
  assert.equal(reminder.label, 'check on the corn');
  assert.ok(reminder.fireAt);
  assert.ok(reminder.remainingSec >= 3590 && reminder.remainingSec <= 3610);
  assert.equal(isActiveReminder(reminder), true);
});

test('normalizeReminderNotification ignores timers and alarms', () => {
  assert.equal(normalizeReminderNotification({ type: 'Timer', notificationIndex: 't1' }), null);
  assert.equal(normalizeReminderNotification({ type: 'Alarm', notificationIndex: 'a1' }), null);
});

test('buildReminderFiredPayload is a dedicated overlay type', () => {
  const payload = buildReminderFiredPayload({
    reminder: {
      amazonId: 'rem-1',
      label: 'check on the corn',
      device: 'Kitchen Echo',
    },
    device: 'Kitchen Echo',
    trigger: 'fire-verify',
  }, { udpBroadcast: { defaultDisplaySeconds: 20 } });

  assert.equal(payload.type, 'reminder.fired');
  assert.equal(payload.reminder.label, 'check on the corn');
  assert.equal(payload.displaySeconds, 25);
  assert.equal(payload.event.kind, 'fired');
});

test('reminder sync emits fired when a due reminder disappears', async () => {
  const mirrorPath = path.join(os.tmpdir(), `reminder-mirror-fire-${Date.now()}.json`);
  fs.writeFileSync(mirrorPath, JSON.stringify({
    reminders: {
      'rem-1': {
        amazonId: 'rem-1',
        device: 'Kitchen Echo',
        label: 'check on the corn',
        remainingSec: 5,
        fireAt: new Date(Date.now() - 2000).toISOString(),
        status: 'ON',
        updatedAt: new Date().toISOString(),
      },
    },
  }));

  await new Promise((resolve, reject) => {
    const sync = createReminderSync({
      alexa: {
        getNotifications(_all, callback) {
          callback(null, { notifications: [] });
        },
      },
      config: {
        sessionPath: path.join(os.tmpdir(), 'alexa-session-test.json'),
        reminderMirrorPath: mirrorPath,
        reminderSync: { enabled: true, fireVerifySlackMs: 30000 },
      },
      log: { info() {}, warn() {}, debug() {} },
      onFired: (snapshot) => {
        try {
          assert.equal(snapshot.event.kind, 'fired');
          assert.equal(snapshot.reminder.label, 'check on the corn');
          resolve();
        } catch (error) {
          reject(error);
        }
      },
    });

    sync.pollNotifications('fire-verify');
  });

  fs.rmSync(mirrorPath, { force: true });
});
