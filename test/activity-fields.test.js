const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractActivityFields,
  isSentToDisplayResponse,
} = require('../src/activity-fields');

test('extractActivityFields harvests customer, alexa, and misc item types', () => {
  const fields = extractActivityFields({
    description: { summary: '' },
    alexaResponse: '',
    conversionDetails: {
      CUSTOMER_TRANSCRIPT: [],
      ALEXA_RESPONSE: [{ transcriptText: 'Sent to your display' }],
      SOME_CARD_TEXT: [{ transcriptText: 'show tesla battery' }],
    },
    data: { utteranceType: 'SERVICE' },
  });
  assert.equal(fields.response, 'Sent to your display');
  assert.match(fields.allText, /show tesla battery/i);
  assert.match(fields.allText, /Sent to your display/i);
  assert.ok(fields.itemTypes.includes('SOME_CARD_TEXT'));
  assert.equal(fields.utteranceType, 'SERVICE');
});

test('extractActivityFields prefers library summary when present', () => {
  const fields = extractActivityFields({
    description: { summary: 'open guest snaps' },
    alexaResponse: 'Okay',
  });
  assert.equal(fields.summary, 'open guest snaps');
  assert.equal(fields.response, 'Okay');
});

test('isSentToDisplayResponse matches common Alexa confirmations', () => {
  assert.equal(isSentToDisplayResponse('Sent to Display'), true);
  assert.equal(isSentToDisplayResponse('Sent to your display.'), true);
  assert.equal(isSentToDisplayResponse('Okay'), false);
});
