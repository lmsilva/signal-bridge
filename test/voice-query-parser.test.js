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

test('voice query parser detects weather with curly apostrophe', () => {
  const parser = createVoiceQueryParser();
  const event = parser.parse(activity('what\u2019s the weather', 'It is sunny in Saratoga Springs'));
  assert.equal(event?.kind, 'weather');
  assert.equal(event?.trigger, 'weather-query');
});

test('voice query parser detects tell me the weather', () => {
  const parser = createVoiceQueryParser();
  const event = parser.parse(activity('tell me the weather', 'It is sunny'));
  assert.equal(event?.kind, 'weather');
});

test('voice query parser detects what is the temperature', () => {
  const parser = createVoiceQueryParser();
  const event = parser.parse(activity("what's the temperature", "It's 72 degrees and sunny"));
  assert.equal(event?.kind, 'weather');
  assert.equal(event?.trigger, 'weather-query');
});

test('voice query parser routes generic temperature to weather even when Alexa mentions a room', () => {
  const parser = createVoiceQueryParser();
  const event = parser.parse(activity("what's the temperature", "It'Bedroom 4's room"));
  assert.equal(event?.kind, 'weather');
  assert.equal(event?.trigger, 'weather-query');
});

test('voice query parser detects indoor temperature at a named location', () => {
  const parser = createVoiceQueryParser();
  const event = parser.parse(activity("what's the temperature on top floor", "It's 76 degrees on the top floor"));
  assert.equal(event?.kind, 'indoor-temperature');
  assert.equal(event?.trigger, 'indoor-temperature-query');
});

test('voice query parser detects air quality queries', () => {
  const parser = createVoiceQueryParser();
  const event = parser.parse(activity('what is the air quality', 'Air quality is at 90 out of 100 right now'));
  assert.equal(event?.kind, 'air-quality');
  assert.equal(event?.trigger, 'air-quality-query');
});

test('voice query parser detects weather from spoken response when summary missing', () => {
  const parser = createVoiceQueryParser();
  const event = parser.parse({
    creationTimestamp: Date.now(),
    name: 'Kitchen Echo',
    description: { summary: '' },
    alexaResponse: "Currently it's 72 degrees and sunny in Saratoga Springs",
    data: { recordKey: 'weather-response-only' },
  });
  assert.equal(event?.kind, 'weather');
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

test('voice query parser detects timer cancel hint', () => {
  const parser = createVoiceQueryParser();
  const event = parser.parse(activity('cancel all timers', 'Okay'));
  assert.equal(event.kind, 'timer-hint');
  assert.equal(event.trigger, 'timer-cancel-voice');
});

test('voice query parser detects named timer cancel hint', () => {
  const parser = createVoiceQueryParser();
  const event = parser.parse(activity('cancel the pizza timer', 'Okay'));
  assert.equal(event.kind, 'timer-hint');
  assert.equal(event.trigger, 'timer-cancel-voice');
});

test('voice query parser detects timer cancel from Alexa response when summary is empty', () => {
  // Some Alexa activity records leave description.summary blank for bare
  // command utterances; the cancel confirmation should still be detected.
  const parser = createVoiceQueryParser();
  const event = parser.parse(activity('', 'Cancelling your 5 minute timer.'));
  assert.equal(event?.kind, 'timer-hint');
  assert.equal(event?.trigger, 'timer-cancel-voice');
});

test('voice query parser detects reversed-order timer cancel confirmation', () => {
  const parser = createVoiceQueryParser();
  const event = parser.parse(activity('', 'Your timer has been cancelled.'));
  assert.equal(event?.kind, 'timer-hint');
  assert.equal(event?.trigger, 'timer-cancel-voice');
});

test('voice query parser detects show alarms command', () => {
  const parser = createVoiceQueryParser();
  const event = parser.parse(activity('show my alarms', 'You have 2 alarms'));
  assert.equal(event.kind, 'alarm-list');
  assert.equal(event.trigger, 'show-alarms');
});

test('voice query parser detects set alarm for time command', () => {
  const parser = createVoiceQueryParser();
  const event = parser.parse(activity('set alarm for 7 am tomorrow', 'Alarm set for 7 am'));
  assert.equal(event.kind, 'alarm-hint');
  assert.equal(event.trigger, 'alarm-set-voice');
});

test('voice query parser routes duration alarm requests to timers', () => {
  const parser = createVoiceQueryParser();
  const event = parser.parse(activity('set a 5 minute alarm', 'Five minutes starting now'));
  assert.equal(event.kind, 'timer-hint');
  assert.equal(event.trigger, 'timer-set-voice');
});

test('voice query parser routes temperature inside to indoor panel', () => {
  const parser = createVoiceQueryParser();
  const event = parser.parse(activity("what's the temperature inside", "It's 72 degrees inside"));
  assert.equal(event?.kind, 'indoor-temperature');
});

test('voice query parser detects tesla battery routine', () => {
  const parser = createVoiceQueryParser();
  const event = parser.parse(activity('show tesla battery', 'Your battery is at 78 percent'));
  assert.equal(event?.kind, 'tesla-battery');
  assert.equal(event?.trigger, 'tesla-battery-query');
});

test('voice query parser detects shopping list show command', () => {
  const parser = createVoiceQueryParser();
  const event = parser.parse(activity('show my shopping list', 'You have 3 items'));
  assert.equal(event?.kind, 'shopping-list');
  assert.equal(event?.trigger, 'shopping-list-show');
});

test('voice query parser detects shopping list add command', () => {
  const parser = createVoiceQueryParser();
  const event = parser.parse(activity('add milk to shopping list', 'I added milk'));
  assert.equal(event?.kind, 'shopping-list');
  assert.equal(event?.trigger, 'shopping-list-add');
});

test('voice query parser detects short add milk command', () => {
  const parser = createVoiceQueryParser();
  const event = parser.parse(activity('add milk', "Okay, I've added milk to your shopping list"));
  assert.equal(event?.kind, 'shopping-list');
  assert.equal(event?.trigger, 'shopping-list-add');
});

test('voice query parser detects "what is the distance between X and Y"', () => {
  const parser = createVoiceQueryParser();
  const event = parser.parse(activity(
    'what is the distance between Saratoga Springs and Moab',
    "It's roughly 177 miles from Saratoga Springs to Moab",
  ));
  assert.equal(event?.kind, 'route');
  assert.equal(event?.trigger, 'route-query');
});

test('voice query parser detects "how far is Y from here"', () => {
  const parser = createVoiceQueryParser();
  const event = parser.parse(activity('how far is moab from here', ''));
  assert.equal(event?.kind, 'route');
});

test('voice query parser detects "how long to drive to Y"', () => {
  const parser = createVoiceQueryParser();
  const event = parser.parse(activity('how long would it take to drive to moab', ''));
  assert.equal(event?.kind, 'route');
});

test('voice query parser detects "directions to Y"', () => {
  const parser = createVoiceQueryParser();
  const event = parser.parse(activity('directions to moab', ''));
  assert.equal(event?.kind, 'route');
});

test('voice query parser detects bare "how far is Y"', () => {
  const parser = createVoiceQueryParser();
  const event = parser.parse(activity('how far is moab', ''));
  assert.equal(event?.kind, 'route');
});

test('voice query parser detects music play command', () => {
  const parser = createVoiceQueryParser();
  const event = parser.parse(activity('play bohemian rhapsody', 'Playing Bohemian Rhapsody'));
  assert.equal(event?.kind, 'music');
  assert.equal(event?.trigger, 'music-play');
});

test('voice query parser detects "what song is playing" as a music query', () => {
  const parser = createVoiceQueryParser();
  const event = parser.parse(activity('what song is playing', 'This is Bohemian Rhapsody by Queen'));
  assert.equal(event?.kind, 'music');
  assert.equal(event?.trigger, 'music-query');
});

test('voice query parser detects "which song is playing" and "what is this song"', () => {
  const parser = createVoiceQueryParser();
  const first = parser.parse(activity('which song is playing', 'Bohemian Rhapsody by Queen'));
  assert.equal(first?.kind, 'music');
  assert.equal(first?.trigger, 'music-query');

  const second = parser.parse(activity('what is this song', 'Bohemian Rhapsody by Queen'));
  assert.equal(second?.kind, 'music');
  assert.equal(second?.trigger, 'music-query');
});

test('voice query parser detects smart home command', () => {
  const parser = createVoiceQueryParser();
  const event = parser.parse(activity('alexa lights on', 'Okay'));
  assert.equal(event?.kind, 'smart-home');
  assert.equal(event.command.action, 'on');
});

test('voice query parser deduplicates processed activity ids', () => {
  const parser = createVoiceQueryParser();
  const item = activity('what time is it');
  assert.ok(parser.shouldProcess(item.data.recordKey));
  parser.markProcessed(item.data.recordKey);
  assert.equal(parser.shouldProcess(item.data.recordKey), false);
});
