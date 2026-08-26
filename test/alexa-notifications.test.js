const test = require('node:test');
const assert = require('node:assert/strict');
const {
  matchesNotificationsQuery,
  parseNotificationsFromSpeech,
  buildNotificationsReading,
  hasNotificationContent,
  isAmazonShoppingSource,
  isNotificationDismissal,
  isDeliveryNotificationText,
  isAmazonShoppingIntroOnly,
  matchesPassiveAmazonDeliveryNotification,
  parseDeliveryNotificationsFromSpeech,
  hasDeliveryNotificationContent,
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
  assert.equal(parsed.summary, '0 notifications');
});

test('parseNotificationsFromSpeech handles no new notifications phrasing', () => {
  const spoken = 'You have no new notifications at the moment.';
  const parsed = parseNotificationsFromSpeech(spoken);
  assert.equal(parsed.empty, true);
  assert.deepEqual(parsed.items, []);
  assert.equal(parsed.summary, '0 notifications');
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

test('isAmazonShoppingSource detects passive Amazon Shopping intro TTS', () => {
  const intro = "You've got one new notification from Amazon Shopping. Let me pull that up for you.";
  assert.equal(isAmazonShoppingSource(intro), true);
  assert.equal(isAmazonShoppingIntroOnly(intro), true);
});

test('isNotificationDismissal detects end-of-session TTS', () => {
  assert.equal(isNotificationDismissal("Alright, no problem. That's all your notifications."), true);
  assert.equal(isNotificationDismissal('Your package was delivered today.'), false);
});

test('matchesPassiveAmazonDeliveryNotification matches TTS-only shopping intro', () => {
  const intro = "You have one new notification from Amazon Shopping.";
  assert.equal(matchesPassiveAmazonDeliveryNotification(null, intro), true);
  assert.equal(matchesPassiveAmazonDeliveryNotification('', intro), true);
  assert.equal(matchesPassiveAmazonDeliveryNotification('show my notifications', intro), false);
});

test('matchesPassiveAmazonDeliveryNotification matches orphan delivery detail TTS', () => {
  const detail = 'Your package containing batteries was delivered today.';
  assert.equal(matchesPassiveAmazonDeliveryNotification(null, detail), true);
});

test('parseDeliveryNotificationsFromSpeech returns empty items for intro-only TTS', () => {
  const intro = "You've got one new notification from Amazon Shopping. Let me pull that up for you.";
  const parsed = parseDeliveryNotificationsFromSpeech(intro);
  assert.deepEqual(parsed.items, []);
  assert.equal(parsed.category, 'delivery');
  assert.equal(parsed.source, 'amazon-shopping');
});

test('parseDeliveryNotificationsFromSpeech extracts delivery detail from TTS', () => {
  const detail = 'Your package was delivered today and left on the porch.';
  const parsed = parseDeliveryNotificationsFromSpeech(detail);
  assert.equal(parsed.items.length, 1);
  assert.match(parsed.items[0], /delivered/i);
  assert.equal(parsed.summary, '1 delivery update');
});

test('parseDeliveryNotificationsFromSpeech filters non-delivery items', () => {
  const spoken =
    'You have 2 notifications. First, your package was delivered. Second, your reminder for tomorrow.';
  const parsed = parseDeliveryNotificationsFromSpeech(spoken);
  assert.equal(parsed.items.length, 1);
  assert.match(parsed.items[0], /package/i);
});

test('hasDeliveryNotificationContent requires actionable delivery text', () => {
  assert.equal(hasDeliveryNotificationContent('You have one new notification from Amazon Shopping.'), false);
  assert.equal(hasDeliveryNotificationContent('Your order has shipped and is on its way.'), true);
});
