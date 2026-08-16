const test = require('node:test');
const assert = require('node:assert/strict');
const {
  matchesReminderSetQuery,
  matchesReminderCancelQuery,
  matchesReminderFiredSpeech,
  matchesReminderOffer,
  extractReminderLabel,
} = require('../src/alexa-reminders');

test('extractReminderLabel reads the corn smoker set confirmation', () => {
  const spoken = "I'll remind you to check on the corn in one hour, at 11:46 AM.";
  assert.equal(extractReminderLabel(spoken), 'check on the corn');
});

test('extractReminderLabel reads a fired reminder', () => {
  assert.equal(
    extractReminderLabel("Here's your reminder to check on the corn."),
    'check on the corn',
  );
  assert.equal(
    extractReminderLabel("Here's your reminder: take the chicken off"),
    'take the chicken off',
  );
});

test('matchesReminderSetQuery accepts the real kitchen TTS-only confirmation', () => {
  assert.equal(
    matchesReminderSetQuery('', "I'll remind you to check on the corn in one hour, at 11:46 AM."),
    true,
  );
  assert.equal(matchesReminderSetQuery('remind me in one hour', 'Okay'), true);
});

test('matchesReminderSetQuery ignores the offer and cooking advice', () => {
  assert.equal(
    matchesReminderOffer(
      'sure',
      'Great! What time would you like me to remind you to check on the corn?',
    ),
    true,
  );
  assert.equal(
    matchesReminderSetQuery(
      'sure',
      'Great! What time would you like me to remind you to check on the corn?',
    ),
    false,
  );
  assert.equal(
    matchesReminderSetQuery(
      '',
      'For corn on the cob in your smoker, you\'ll want to go with 225 to 250 degrees for about 1 to 2 hours.',
    ),
    false,
  );
});

test('matchesReminderFiredSpeech detects Alexa-initiated reminder TTS', () => {
  assert.equal(matchesReminderFiredSpeech('', "Here's your reminder to check on the corn."), true);
  assert.equal(matchesReminderFiredSpeech('', "I'll remind you to check on the corn in one hour."), false);
});

test('matchesReminderCancelQuery covers cancel phrasing', () => {
  assert.equal(matchesReminderCancelQuery('cancel my reminder', 'Okay'), true);
  assert.equal(matchesReminderCancelQuery('', 'Your reminder has been cancelled.'), true);
  assert.equal(matchesReminderCancelQuery('show my timers', ''), false);
});
