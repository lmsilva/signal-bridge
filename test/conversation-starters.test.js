'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { validate } = require('../src/vestaboard/encoder');
const { parseLayout, formatLayout } = require('../src/vestaboard/notation');
const { conversationStartersFrames } = require('../src/vestaboard/formatters/feeds');
const {
  loadShipped,
  promptRows,
  matchingPrompts,
  pickPrompt,
  listPrompts,
  buildConversationStartersPayload,
  createConversationStarters,
} = require('../src/conversation-starters');
const { sanitiseSettings } = require('../src/conversation-starters-settings');

function assertLayout(actual, drawing, label) {
  assert.equal(validate(actual).ok, true, `${label} failed validation`);
  const expected = parseLayout(drawing.join('\n'), { label });
  if (formatLayout(actual) !== formatLayout(expected)) {
    assert.fail(
      `${label} does not match the spec drawing\n\n`
      + `--- expected ---\n${formatLayout(expected)}\n\n`
      + `--- actual ---\n${formatLayout(actual)}\n`,
    );
  }
}

test('the shipped corpus is board-fit conversation starters', () => {
  const prompts = loadShipped();
  assert.ok(prompts.length > 500);
  for (const prompt of prompts.slice(0, 80)) {
    assert.ok(prompt.id);
    assert.ok(prompt.text);
    const rows = promptRows(prompt.text);
    assert.ok(rows.length >= 1 && rows.length <= 5, prompt.text);
  }
});

test('buildConversationStartersPayload is a vestaboard talk.starters card', () => {
  const payload = buildConversationStartersPayload({
    id: 'demo',
    text: 'What is the best meal you have ever had?',
  });
  assert.equal(payload.type, 'talk.starters');
  assert.equal(payload.prompt.text, 'What is the best meal you have ever had?');
  const frames = conversationStartersFrames(payload);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].source, 'talk.starters');
  assertLayout(frames[0].rows, [
    "vv    LET'S TALK    vv",
    '',
    'WHAT IS THE BEST MEAL',
    'YOU HAVE EVER HAD?',
    '',
    '',
  ], 'conversation starter meal');
});

test('short conversation starters centre the body under the title', () => {
  const frames = conversationStartersFrames({
    prompt: { text: 'What is your favorite weekend trip?' },
  });
  assert.equal(frames.length, 1);
  assertLayout(frames[0].rows, [
    "vv    LET'S TALK    vv",
    '',
    'WHAT IS YOUR FAVORITE',
    'WEEKEND TRIP?',
    '',
    '',
  ], 'weekend trip centred');
});

test('full-height conversation starters stay top-aligned', () => {
  const frames = conversationStartersFrames({
    prompt: {
      text: 'What do you think about when you cannot fall asleep at night and the house is quiet?',
    },
  });
  assert.equal(frames.length, 1);
  const drawing = formatLayout(frames[0].rows).split('\n');
  assert.match(drawing[0], /LET'S TALK/);
  // Five body rows filled — no spare pad room.
  assert.ok(drawing.slice(1).every((line) => line.trim()));
});

test('conversation starters with no prompt renders nothing', () => {
  assert.deepEqual(conversationStartersFrames({ type: 'talk.starters' }), []);
  assert.deepEqual(conversationStartersFrames({}), []);
});

test('pickPrompt skips recently shown ids until the pool is exhausted', () => {
  const pool = matchingPrompts({});
  assert.ok(pool.length > 10);
  const first = pickPrompt({
    recentIds: pool.slice(1).map((row) => row.id),
  });
  assert.equal(first.id, pool[0].id);
});

test('listPrompts searches and pages', () => {
  const page = listPrompts({}, { query: 'favorite', page: 1, pageSize: 5 });
  assert.ok(page.total > 0);
  assert.ok(page.prompts.every((row) => /favorite/i.test(row.text)));
  assert.equal(page.prompts.length <= 5, true);
});

test('createConversationStarters can add hide and restore', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-'));
  const api = createConversationStarters({
    ROOT: root,
    conversationStartersSettingsPath: path.join(root, 'settings.json'),
  });
  const added = api.addPrompt('What board game should we play next?');
  assert.equal(added.ok, true);
  assert.ok(added.customCount >= 1);
  const payload = api.nextPayload({ random: () => 0 });
  assert.equal(payload.type, 'talk.starters');

  const shipped = loadShipped()[0];
  const hidden = api.updatePrompt(shipped.id, { hidden: true });
  assert.equal(hidden.ok, true);
  assert.ok(hidden.hiddenCount >= 1);
});

test('settings keep recent ids when only custom changes', () => {
  const next = sanitiseSettings({ custom: [{ id: 'c1', text: 'Hello?' }] }, {
    recentIds: ['a'],
    hiddenIds: [],
    overrides: {},
    custom: [],
  });
  assert.deepEqual(next.recentIds, ['a']);
  assert.equal(next.custom[0].text, 'Hello?');
});
