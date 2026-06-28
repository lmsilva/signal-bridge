const test = require('node:test');
const assert = require('node:assert/strict');
const { createVoiceQueryParser } = require('../src/voice-query-parser');

function activity(summary, response = '') {
  return {
    creationTimestamp: Date.now(),
    name: 'Kitchen Echo',
    description: { summary },
    alexaResponse: response,
    data: { recordKey: `vq-${summary}` },
  };
}

test('voice query parser detects time questions', () => {
  const parser = createVoiceQueryParser();
  const event = parser.parse(activity('what time is it', "It's 3:45 PM"));
  assert.equal(event.kind, 'time');
  assert.equal(event.trigger, 'time-query');
});

test('voice query parser detects weather questions', () => {
  const parser = createVoiceQueryParser();
  const event = parser.parse(activity('what is the weather like outside', 'It is sunny'));
  assert.equal(event.kind, 'weather');
});

test('voice query parser detects show timers command', () => {
  const parser = createVoiceQueryParser();
  const event = parser.parse(activity('show my timers', 'You have 2 timers'));
  assert.equal(event.kind, 'timer-list');
  assert.equal(event.trigger, 'show-timers');
});

test('voice query parser detects timer set hint', () => {
  const parser = createVoiceQueryParser();
  const event = parser.parse(activity('set a 5 minute timer', 'Five minutes starting now'));
  assert.equal(event.kind, 'timer-hint');
  assert.equal(event.trigger, 'timer-set-voice');
});

test('voice query parser detects timer set from Alexa response', () => {
  const parser = createVoiceQueryParser();
  const event = parser.parse(activity('5 minute timer', 'Five minutes starting now'));
  assert.equal(event.kind, 'timer-hint');
});

test('voice query parser detects named timer set phrases', () => {
  const parser = createVoiceQueryParser();
  const event = parser.parse(activity('set a timer called pizza for 5 minutes', 'Five minutes starting now'));
  assert.equal(event.kind, 'timer-hint');
});

test('voice query parser deduplicates processed activity ids', () => {
  const parser = createVoiceQueryParser();
  const item = activity('what time is it');
  assert.ok(parser.shouldProcess(item.data.recordKey));
  parser.markProcessed(item.data.recordKey);
  assert.equal(parser.shouldProcess(item.data.recordKey), false);
});
