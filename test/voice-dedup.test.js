const test = require('node:test');
const assert = require('node:assert/strict');
const { createVoiceQueryParser } = require('../src/voice-query-parser');

test('marking processed after null parse prevents duplicate voice handling', () => {
  const parser = createVoiceQueryParser();
  const activityId = 'activity-123';

  assert.equal(parser.shouldProcess(activityId), true);
  assert.equal(parser.parse({
    description: { summary: 'what is two plus two' },
    alexaResponse: 'Four',
    name: 'Kitchen Echo',
  }), null);

  parser.markProcessed(activityId);
  assert.equal(parser.shouldProcess(activityId), false);
});
