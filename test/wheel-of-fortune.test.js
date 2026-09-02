'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  loadPuzzles,
  puzzleFits,
  maskPuzzle,
  spinWheel,
  wedgeLabel,
  wheelLayout,
  countLetter,
  isVowel,
  isFullyRevealed,
  createRound,
  validateLetter,
  validateSolve,
  winAmount,
  VOWEL_COST,
  SOLVE_FLOOR,
  PUZZLE_ROWS,
} = require('../src/wheel-of-fortune');

test('every shipped puzzle fits three board rows', () => {
  const deck = loadPuzzles();
  assert.ok(deck.length >= 200, 'the living room needs a deep deck');
  const bad = deck.filter((row) => !puzzleFits(row));
  assert.deepEqual(bad, []);
});

test('a puzzle never repeats until the deck is spent', () => {
  const deck = [
    { category: 'PHRASE', puzzle: 'HAVE A NICE DAY' },
    { category: 'PLACE', puzzle: 'GRAND CANYON' },
  ];
  const first = createRound({ random: () => 0, puzzles: deck, used: [] });
  assert.equal(first.puzzle, 'HAVE A NICE DAY');
  const second = createRound({
    random: () => 0,
    puzzles: deck,
    used: [`${first.category}|${first.puzzle}`],
  });
  assert.equal(second.puzzle, 'GRAND CANYON');
});

test('hidden letters become underscores and spaces stay spaces', () => {
  assert.equal(maskPuzzle('HAVE A NICE DAY', ['A', 'E']), '_A_E A ___E _A_');
});

test('Y is a consonant and a vowel costs two hundred fifty', () => {
  assert.equal(isVowel('Y'), false);
  assert.equal(isVowel('A'), true);
  assert.equal(VOWEL_COST, 250);
  const ok = validateLetter('Y', { vowel: false });
  assert.equal(ok.ok, true);
  assert.equal(validateLetter('A', { vowel: false }).reason, 'not-consonant');
});

test('an already-called letter is refused', () => {
  assert.equal(validateLetter('R', { called: ['R'] }).reason, 'called');
});

test('solving matches letters only, so spacing cannot cheat', () => {
  assert.equal(validateSolve('have a nice day', 'HAVE A NICE DAY').ok, true);
  assert.equal(validateSolve('HAVEANICEDAY', 'HAVE A NICE DAY').ok, true);
  assert.equal(validateSolve('HAVE A BAD DAY', 'HAVE A NICE DAY').reason, 'wrong');
});

test('a solve with an empty bank still pays the floor', () => {
  assert.equal(winAmount(0), SOLVE_FLOOR);
  assert.equal(winAmount(2400), 2400);
});

test('a wedge knows its seat on the wheel so a phone can animate to it', () => {
  assert.equal(spinWheel(() => 0).index, 0);
  assert.equal(spinWheel(() => 0.999).index, 19);
  const layout = wheelLayout();
  assert.equal(layout.length, 20);
  assert.deepEqual(layout.map((wedge) => wedge.index), layout.map((_, i) => i));
  assert.equal(layout[0].label, '500');
  assert.ok(layout.some((wedge) => wedge.label === 'BANKRUPT'));
  assert.ok(layout.some((wedge) => wedge.label === 'FREE SPIN'));
});

test('the first wedge is cash so a zero roll is predictable', () => {
  const wedge = spinWheel(() => 0);
  assert.equal(wedge.type, 'cash');
  assert.equal(wedge.value, 500);
  assert.equal(wedgeLabel(wedge), '500');
  assert.equal(countLetter('HAVE A NICE DAY', 'A'), 3);
  assert.equal(isFullyRevealed('HI', ['H', 'I']), true);
  assert.equal(PUZZLE_ROWS, 3);
});
