'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { COLS } = require('../src/vestaboard/encoder');
const {
  PROMPT_ROWS,
  ANSWER_ROWS,
  loadPrompts,
  promptFits,
  answerFits,
  normaliseAnswer,
  answerKey,
  createRound,
  validateAnswer,
  scoreRound,
} = require('../src/party-prompts');
const { wrap, fold } = require('../src/vestaboard/encoder');

test('every shipped prompt fits the three body rows of the card', () => {
  const prompts = loadPrompts();
  assert.ok(prompts.length >= 300, `only ${prompts.length} prompts shipped`);

  const seen = new Set();
  for (const prompt of prompts) {
    const lines = wrap(fold(prompt), COLS);
    assert.ok(
      lines.length <= PROMPT_ROWS,
      `"${prompt}" needs ${lines.length} rows`,
    );
    for (const line of lines) {
      assert.ok(line.length <= COLS, `"${prompt}" overflows a row`);
    }
    // Two prompts that read the same on the board are one prompt.
    const key = fold(prompt);
    assert.equal(seen.has(key), false, `duplicate prompt ${prompt}`);
    seen.add(key);
  }
});

test('prompts are open questions, never a yes/no or a fill-in-the-letter', () => {
  for (const prompt of loadPrompts()) {
    assert.doesNotMatch(prompt, /^(is|are|do|does|did|can|will|would|should|have|has)\b/i, prompt);
    assert.doesNotMatch(prompt, /\?$/, `${prompt} — the board asks, it does not punctuate`);
  }
});

test('the board gate refuses text that would need a fourth row', () => {
  assert.equal(promptFits('Least necessary part of a car'), true);
  assert.equal(answerFits('The other passengers'), true);
  assert.equal(
    answerFits('a '.repeat(60)),
    false,
    'sixty two-letter words cannot land in three rows',
  );
  assert.equal(promptFits(''), false);
  assert.equal(promptFits('   '), false);
});

test('answers fold to the board alphabet, so casing is not a second answer', () => {
  assert.equal(normaliseAnswer('  Cup holder  '), 'CUP HOLDER');
  assert.equal(answerKey('Cup Holder'), answerKey('cup   holder!'));
  assert.notEqual(answerKey('cup holder'), answerKey('cop holder'));
});

test('createRound never repeats a prompt the table has already seen', () => {
  const prompts = ['ALPHA ONE', 'BRAVO TWO', 'CHARLIE THREE'];
  const used = [];
  for (let i = 0; i < prompts.length; i += 1) {
    const round = createRound({ random: () => 0, used, prompts });
    assert.equal(used.includes(round.prompt), false, round.prompt);
    used.push(round.prompt);
  }
  assert.deepEqual(used.slice().sort(), prompts.slice().sort());

  // Once the deck is spent the game keeps going rather than stopping dead.
  const wrapped = createRound({ random: () => 0, used, prompts });
  assert.ok(prompts.includes(wrapped.prompt));
});

test('createRound refuses to deal from an empty deck', () => {
  assert.throws(() => createRound({ prompts: [] }), /No Party Prompts questions/);
});

test('an answer is refused when it is blank, too long, or already written', () => {
  assert.deepEqual(validateAnswer('The other passengers'), {
    ok: true,
    answer: 'THE OTHER PASSENGERS',
  });
  assert.equal(validateAnswer('   ').ok, false);
  assert.equal(validateAnswer('   ').reason, 'empty');
  assert.equal(validateAnswer('!!! ???').reason, 'empty');
  // Four twelve-letter words are inside the character cap but no two of them
  // share a row, so the answer would need a fourth.
  assert.equal(validateAnswer('abcdefghijkl '.repeat(4)).reason, 'too-long');
  assert.equal(
    validateAnswer('cup holder', { taken: ['CUP HOLDER'] }).reason,
    'duplicate',
    'the ballot has to stay unambiguous',
  );
});

test('one vote is one point, and a self-vote is worth nothing', () => {
  const answers = [
    { playerId: 'a', answer: 'ONE' },
    { playerId: 'b', answer: 'TWO' },
    { playerId: 'c', answer: 'THREE' },
  ];
  const scored = scoreRound(answers, [
    { voterId: 'b', answerPlayerId: 'a' },
    { voterId: 'c', answerPlayerId: 'a' },
    { voterId: 'a', answerPlayerId: 'a' },
    { voterId: 'a', answerPlayerId: 'b' },
  ]);
  assert.deepEqual(scored, [
    { id: 'a', score: 2 },
    { id: 'b', score: 1 },
    { id: 'c', score: 0 },
  ]);
});

test('a second vote from the same phone does not stack', () => {
  const answers = [{ playerId: 'a', answer: 'ONE' }, { playerId: 'b', answer: 'TWO' }];
  const scored = scoreRound(answers, [
    { voterId: 'b', answerPlayerId: 'a' },
    { voterId: 'b', answerPlayerId: 'a' },
  ]);
  assert.deepEqual(scored, [{ id: 'a', score: 1 }, { id: 'b', score: 0 }]);
});

test('everyone who wrote is on the sheet, even with no votes at all', () => {
  const scored = scoreRound([{ playerId: 'a', answer: 'ONE' }], []);
  assert.deepEqual(scored, [{ id: 'a', score: 0 }]);
  assert.equal(ANSWER_ROWS, 3);
});
