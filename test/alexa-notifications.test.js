const test = require('node:test');
const assert = require('node:assert/strict');
const {
  matchesNotificationsQuery,
  parseNotificationsFromSpeech,
  buildNotificationsReading,
  hasNotificationContent,
} = require('../src/alexa-notifications');

test('matchesNotificationsQuery detects show my notifications', () => {
  assert.equal(matchesNotificationsQuery('show my notifications'), true);
  assert.equal(matchesNotificationsQuery('what are my notifications'), true);
  assert.equal(matchesNotificationsQuery('show my timers'), false);
});

test('parseNotificationsFromSpeech handles empty notifications', () => {
  const parsed = parseNotificationsFromSpeech('You have no notifications');
  assert.equal(parsed.empty, true);
  assert.deepEqual(parsed.items, []);
  assert.equal(parsed.summary, 'No notifications');
});

test('parseNotificationsFromSpeech splits numbered notifications', () => {
  const spoken =
    'You have 2 notifications. First, your package was delivered. Second, your reminder for tomorrow.';
  const parsed = parseNotificationsFromSpeech(spoken);
  assert.equal(parsed.items.length, 2);
  assert.match(parsed.items[0], /package/i);
  assert.match(parsed.items[1], /reminder/i);
});

test('buildNotificationsReading preserves body fallback', () => {
  const reading = buildNotificationsReading('You have one notification about your delivery.');
  assert.equal(reading.body, 'You have one notification about your delivery.');
});

test('hasNotificationContent accepts intro and empty states', () => {
  assert.equal(hasNotificationContent('You have no notifications'), true);
  assert.equal(hasNotificationContent('You have 1 notification from Amazon.'), true);
  assert.equal(hasNotificationContent(''), false);
});
