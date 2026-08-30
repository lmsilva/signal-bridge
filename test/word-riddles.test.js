'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { validate } = require('../src/vestaboard/encoder');
const { parseLayout, formatLayout } = require('../src/vestaboard/notation');
const { wordRiddlesFrames } = require('../src/vestaboard/formatters/feeds');
const {
  loadShipped,
  riddleLines,
  matchingRiddles,
  pickRiddle,
  listRiddles,
  fitsBoard,
  estimateRoundSeconds,
  buildWordRiddlesPayload,
  createWordRiddles,
} = require('../src/word-riddles');
const { sanitiseSettings, REVEAL_DEFAULT } = require('../src/word-riddles-settings');

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

const ODD_NUMBER = {
  id: 'demo-seven',
  riddle: 'I am an odd number. Take away a letter and I become even. What number am I?',
  answer: 'Seven',
};

test('the shipped corpus is hundreds of board-fit riddles', () => {
  const riddles = loadShipped();
  assert.ok(riddles.length >= 400, `expected hundreds of riddles, got ${riddles.length}`);
  for (const item of riddles.slice(0, 80)) {
    assert.ok(item.id);
    assert.ok(item.riddle);
    assert.ok(item.answer);
    assert.equal(fitsBoard(item.riddle, item.answer), true, item.riddle);
    assert.ok(riddleLines(item.riddle).length <= 4, item.riddle);
  }
});

test('word riddle frames match the marketplace intro, riddle, and answer', () => {
  const payload = buildWordRiddlesPayload(ODD_NUMBER, {
    revealDelaySeconds: 30,
    showIntro: true,
  });
  assert.equal(payload.type, 'word.riddles');
  assert.equal(payload.riddle.answer, 'Seven');
  const frames = wordRiddlesFrames(payload);
  assert.equal(frames.length, 3);
  assert.equal(frames[0].dwellSeconds, 8);
  assert.equal(frames[1].dwellSeconds, 30);
  assert.equal(frames[2].dwellSeconds, 20);
  assertLayout(frames[0].rows, [
    'gggggggggggbbbbbbbbbbb',
    '',
    '      RIDDLE ME',
    '       THIS...',
    '',
    'bbbbbbbbbbbggggggggggg',
  ], 'word riddles intro');
  assertLayout(frames[1].rows, [
    'I  AM  AN  ODD NUMBER.',
    'TAKE AWAY A LETTER AND',
    'I  BECOME  EVEN.  WHAT',
    'NUMBER  AM  I?',
    '',
    '      VESTABOARD',
  ], 'word riddle body');
  assert.equal(validate(frames[2].rows).ok, true, 'word riddle answer failed validation');
  assert.equal(
    formatLayout(frames[2].rows),
    ['', '', '      S E V E N', '', '', '      VESTABOARD'].join('\n'),
    'word riddle answer',
  );
});

test('hiding the intro drops that frame and shortens the round', () => {
  const payload = buildWordRiddlesPayload(ODD_NUMBER, { showIntro: false, revealDelaySeconds: 45 });
  const frames = wordRiddlesFrames(payload);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].dwellSeconds, 45);
  assert.equal(estimateRoundSeconds({ showIntro: false, revealDelaySeconds: 45 }), 65);
});

test('an empty riddle does not flip the board', () => {
  assert.equal(buildWordRiddlesPayload({ riddle: '', answer: 'Seven' }), null);
  assert.deepEqual(wordRiddlesFrames({ type: 'word.riddles' }), []);
});

test('pickRiddle skips recently shown ids until the pool is exhausted', () => {
  const pool = matchingRiddles();
  const first = pickRiddle({
    recentIds: pool.slice(1).map((item) => item.id),
  });
  assert.equal(first.id, pool[0].id);

  const again = pickRiddle({
    recentIds: pool.map((item) => item.id),
  }, { random: () => 0 });
  assert.ok(again.id);
});

test('sanitiseSettings clamps reveal delay and keeps custom riddle/answer pairs', () => {
  const next = sanitiseSettings({
    revealDelaySeconds: 999,
    showIntro: false,
    custom: [{ id: 'custom-1', riddle: 'What has keys but cannot open locks?', answer: 'A piano' }],
  });
  assert.equal(next.revealDelaySeconds, 180);
  assert.equal(next.showIntro, false);
  assert.equal(next.custom[0].answer, 'A piano');
  assert.equal(sanitiseSettings({ revealDelaySeconds: 3 }).revealDelaySeconds, 10);
  assert.equal(sanitiseSettings({}).revealDelaySeconds, REVEAL_DEFAULT);
});

test('house edits persist hide, override, and custom riddles', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'word-riddles-'));
  const api = createWordRiddles({
    wordRiddlesSettingsPath: path.join(root, 'word-riddles-settings.json'),
  }, console);
  const shipped = loadShipped()[0];
  assert.ok(shipped);

  const added = api.addRiddle('What has hands but cannot clap?', 'A clock');
  assert.equal(added.ok, true);
  assert.ok(added.customCount >= 1);

  const hidden = api.updateRiddle(shipped.id, { hidden: true });
  assert.equal(hidden.ok, true);
  assert.ok(hidden.hiddenCount >= 1);

  const listed = listRiddles(api.getSettings(), { hidden: true, query: shipped.riddle.slice(0, 12) });
  assert.ok(listed.riddles.some((row) => row.id === shipped.id && row.hidden));

  api.updateSettings({ revealDelaySeconds: 60, showIntro: false });
  const payload = api.nextPayload();
  assert.equal(payload.type, 'word.riddles');
  assert.equal(payload.showIntro, false);
  assert.equal(payload.revealDelaySeconds, 60);
});
