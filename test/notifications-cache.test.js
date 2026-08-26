const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  loadNotificationsCache,
  saveNotificationsCache,
  buildReplayPayload,
  hasCachedNotification,
} = require('../src/notifications-cache');

test('saveNotificationsCache stores actionable notification payloads only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notif-cache-'));
  const config = { notificationsCachePath: path.join(dir, 'notifications-cache.json') };

  assert.equal(saveNotificationsCache(config, { type: 'alexa-notifications.query', notifications: { items: [] } }), false);
  assert.equal(saveNotificationsCache(config, {
    type: 'alexa-notifications.query',
    displaySeconds: 30,
    notifications: {
      items: ['Your package was delivered today'],
      summary: '1 delivery update',
      category: 'delivery',
    },
    spokenResponse: 'Your package was delivered today',
    themeAccent: '#FF9900',
  }), true);

  const cached = loadNotificationsCache(config);
  assert.ok(hasCachedNotification(cached));
  assert.equal(cached.payload.notifications.items.length, 1);
});

test('buildReplayPayload refreshes device and trigger', () => {
  const cached = {
    payload: {
      type: 'alexa-notifications.query',
      displaySeconds: 30,
      notifications: { items: ['Package delivered'] },
      themeAccent: '#FF9900',
    },
  };
  const payload = buildReplayPayload(cached, {
    device: 'Signal',
    trigger: 'notifications-push',
    timestamp: Date.parse('2026-08-26T22:00:00.000Z'),
  });
  assert.equal(payload.device, 'Signal');
  assert.equal(payload.trigger, 'notifications-push');
  assert.equal(payload.timestamp, '2026-08-26T22:00:00.000Z');
});

test('buildReplayPayload returns null when cache is empty', () => {
  assert.equal(buildReplayPayload(null), null);
  assert.equal(buildReplayPayload({ payload: { notifications: { items: [] } } }), null);
});
