const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createRoutineIndex,
  classifyPhrase,
  collectAutomationPhrases,
} = require('../src/routine-index');

test('classifyPhrase maps known overlay phrases to kinds', () => {
  assert.equal(classifyPhrase('show tesla battery'), 'tesla-battery');
  assert.equal(classifyPhrase('show tesla dashboard'), 'tesla-dashboard');
  assert.equal(classifyPhrase('open guest snaps'), 'guest-photobooth');
  assert.equal(classifyPhrase('open guest snaps slideshow'), 'photo-slideshow');
  assert.equal(classifyPhrase('what is the weather'), 'weather');
  assert.equal(classifyPhrase('turn on the lights'), null);
});

test('collectAutomationPhrases walks triggers and sequence strings', () => {
  const phrases = collectAutomationPhrases({
    name: 'Tesla Battery',
    triggers: [{ type: 'CustomUtterance', payload: { utterance: 'show tesla battery' } }],
    sequence: {
      nodes: [{ type: 'Alexa.Speak', payload: { text: 'Sent to Display' } }],
    },
  });
  assert.ok(phrases.some((p) => /tesla battery/i.test(p)));
  assert.ok(phrases.some((p) => /Tesla Battery/i.test(p)));
  assert.ok(phrases.some((p) => /Sent to Display/i.test(p)));
});

test('routine index resolves catalog phrases and Sent to Display defaults', () => {
  const index = createRoutineIndex({ log: { info() {}, warn() {} } });
  index.loadFromAutomations([
    {
      name: 'Show Tesla Battery',
      triggers: [{ payload: { utterance: 'show tesla battery' } }],
      sequence: { payload: { text: 'Sent to Display' } },
    },
    {
      name: 'Guest Snaps',
      triggers: [{ payload: { utterance: 'open guest snaps' } }],
    },
  ]);

  assert.equal(
    index.resolve({ summary: 'show tesla battery', response: '', allText: 'show tesla battery' })?.kind,
    'tesla-battery',
  );
  assert.equal(
    index.resolve({ summary: '', response: '', allText: 'open guest snaps' })?.kind,
    'guest-photobooth',
  );

  const sent = index.resolveSentToDisplay({
    summary: '',
    response: 'Sent to your display',
    allText: 'Sent to your display',
  });
  assert.equal(sent?.kind, 'tesla-battery');
  assert.match(sent.source, /sent-to-display/);
});

test('Sent to Display prefers dashboard when both kinds are mapped and text is bare', () => {
  const index = createRoutineIndex({ log: { info() {}, warn() {} } });
  index.loadFromAutomations([
    { name: 'Battery', triggers: [{ payload: { utterance: 'show tesla battery' } }] },
    { name: 'Dash', triggers: [{ payload: { utterance: 'show tesla dashboard' } }] },
  ]);
  const sent = index.resolveSentToDisplay({
    summary: '',
    response: 'Sent to Display',
    allText: 'Sent to Display',
  });
  assert.equal(sent?.kind, 'tesla-dashboard');
});
