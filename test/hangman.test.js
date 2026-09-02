'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadWords: loadDictionary, hasWord } = require('../src/word-scramble');
const {
  loadCategories,
  loadWords,
  wordKey,
  wordFits,
  lettersOf,
  countLetter,
  isFullyRevealed,
  maskWord,
  missesOf,
  createRound,
  suggestWords,
  validateGuess,
  validateSolve,
  validateSetterWord,
  letterScore,
  solveScore,
  setterScore,
  livesLeft,
  LIVES,
  MIN_WORD,
  MAX_WORD,
  SUGGESTIONS,
  SETTER_MAX,
} = require('../src/hangman');

const DECK = [
  { id: 'animals', label: 'ANIMALS', words: ['BADGER', 'OTTER'] },
  { id: 'food', label: 'FOOD AND DRINK', words: ['WAFFLE', 'YOGURT'] },
];

test('the deck is deep enough that a night never repeats itself', () => {
  const words = loadWords();
  assert.ok(words.length >= 1000, `only ${words.length} words shipped`);
  assert.ok(loadCategories().length >= 15, 'the hint needs variety too');
});

test('every shipped word fits one board row and hides behind a category', () => {
  const bad = loadWords().filter((row) => !wordFits(row));
  assert.deepEqual(bad, []);
  const shapes = loadWords().filter((row) => !/^[A-Z]{4,14}$/.test(row.word));
  assert.deepEqual(shapes, []);
  for (const row of loadWords()) {
    assert.ok(row.word.length >= MIN_WORD && row.word.length <= MAX_WORD, row.word);
  }
});

test('no word appears twice, even across categories', () => {
  const words = loadWords().map((row) => row.word);
  assert.equal(new Set(words).size, words.length);
});

/**
 * A phrase with the spaces taken out (MEASURINGCUP) cannot be guessed a
 * letter at a time, and the dictionary is the only honest way to tell those
 * from real compounds. It is the same gate a player's own word passes.
 */
test('every shipped word is in the dictionary a player would be held to', () => {
  const dictionary = loadDictionary();
  assert.ok(dictionary.length, 'the scramble dictionary should load');
  const strays = loadWords()
    .map((row) => row.word)
    .filter((word) => !hasWord(dictionary, word.toLowerCase()));
  assert.deepEqual(strays, []);
});

test('the mask shows what has been called and hides the rest', () => {
  assert.equal(maskWord('CHEESE', ['E']), '__EE_E');
  assert.equal(maskWord('CHEESE', new Set(['C', 'E', 'H', 'S'])), 'CHEESE');
  assert.equal(maskWord('BADGER', []), '______');
  assert.equal(isFullyRevealed('CHEESE', ['C', 'H', 'E', 'S']), true);
  assert.equal(isFullyRevealed('CHEESE', ['C', 'H', 'E']), false);
});

test('a letter pays per flap it turns over', () => {
  assert.equal(countLetter('CHEESE', 'E'), 3);
  assert.equal(countLetter('CHEESE', 'Z'), 0);
  assert.equal(letterScore(3), 30);
  assert.equal(letterScore(0), 0);
  assert.deepEqual([...lettersOf('CHEESE')].sort(), ['C', 'E', 'H', 'S']);
});

test('misses are the called letters that were not there, in order', () => {
  assert.deepEqual(missesOf('BADGER', ['B', 'Z', 'A', 'Q']), ['Z', 'Q']);
  assert.deepEqual(missesOf('BADGER', []), []);
  assert.equal(livesLeft(0), LIVES);
  assert.equal(livesLeft(2), LIVES - 2);
  assert.equal(livesLeft(99), 0);
});

test('solving pays a bonus plus every life still standing', () => {
  assert.equal(solveScore(LIVES), 50 + LIVES * 5);
  assert.equal(solveScore(0), 50);
  assert.equal(solveScore(-3), 50);
});

test('the setter is paid for the misses they forced, and only if it was solved', () => {
  assert.equal(setterScore(4, true), 20);
  assert.equal(setterScore(4, false), 0, 'a word nobody guesses is worth nothing');
  assert.equal(setterScore(99, true), SETTER_MAX, 'and the pay is capped');
  assert.equal(setterScore(0, true), 0);
});

test('a word does not come round again until the deck is spent', () => {
  const first = createRound({ random: () => 0, categories: DECK, used: [] });
  assert.deepEqual(first, { category: 'ANIMALS', word: 'BADGER' });
  const second = createRound({
    random: () => 0,
    categories: DECK,
    used: [wordKey(first)],
  });
  assert.notEqual(second.word, 'BADGER');
  const spent = ['BADGER', 'OTTER', 'WAFFLE', 'YOGURT'];
  const wrapped = createRound({ random: () => 0, categories: DECK, used: spent });
  assert.ok(spent.includes(wrapped.word), 'a spent deck starts over rather than failing');
});

test('one category can be pinned and the rest sit out', () => {
  for (let i = 0; i < 8; i += 1) {
    const round = createRound({ random: () => i / 8, categories: DECK, categoryId: 'food' });
    assert.equal(round.category, 'FOOD AND DRINK');
  }
});

test('the setter menu is three words from three different categories', () => {
  const menu = suggestWords({ random: () => 0 });
  assert.equal(menu.length, SUGGESTIONS);
  assert.equal(new Set(menu.map((row) => row.word)).size, SUGGESTIONS);
  assert.equal(new Set(menu.map((row) => row.category)).size, SUGGESTIONS);
});

/**
 * A menu built by re-rolling one random number can hand back the same word
 * three times; this one walks the deck from a random start instead.
 */
test('the menu still fills up when the deck has fewer categories than seats', () => {
  const menu = suggestWords({ random: () => 0, categories: DECK });
  assert.equal(menu.length, SUGGESTIONS);
  assert.equal(new Set(menu.map((row) => row.word)).size, SUGGESTIONS);
});

test('the menu never offers a word that has already been played', () => {
  const menu = suggestWords({ random: () => 0, categories: DECK, used: ['BADGER', 'WAFFLE'] });
  assert.deepEqual(menu.map((row) => row.word).sort(), ['OTTER', 'YOGURT']);
});

test('a letter has to be a letter, and nobody calls the same one twice', () => {
  assert.deepEqual(validateGuess('e', { called: [] }), { ok: true, letter: 'E' });
  assert.deepEqual(validateGuess('4', { called: [] }), { ok: false, reason: 'empty' });
  assert.deepEqual(validateGuess('', { called: [] }), { ok: false, reason: 'empty' });
  assert.deepEqual(validateGuess('E', { called: ['E'] }), { ok: false, reason: 'called' });
});

test('a solve is the whole word, spacing and case forgiven', () => {
  assert.deepEqual(validateSolve(' badger ', 'BADGER'), { ok: true, word: 'BADGER' });
  assert.deepEqual(validateSolve('badgers', 'BADGER'), { ok: false, reason: 'wrong' });
  assert.deepEqual(validateSolve('  ', 'BADGER'), { ok: false, reason: 'empty' });
});

test('a word a player types has to be real, board-sized, and fresh', () => {
  const words = ['badger', 'ox', 'zzzzz'];
  assert.deepEqual(validateSetterWord('badger', { words }), { ok: true, word: 'BADGER' });
  assert.equal(validateSetterWord('', { words }).reason, 'empty');
  assert.equal(validateSetterWord('cat', { words }).reason, 'short');
  assert.equal(validateSetterWord('BADGERBADGERBADGER', { words }).reason, 'long');
  assert.equal(validateSetterWord('AAAA', { words }).reason, 'thin');
  assert.equal(validateSetterWord('QWJXV', { words }).reason, 'unknown');
  assert.equal(validateSetterWord('badger', { words, used: ['BADGER'] }).reason, 'used');
});

test('a word from the deck is a word the dictionary would also accept', () => {
  const dictionary = loadDictionary();
  const pick = createRound({ random: () => 0 });
  const check = validateSetterWord(pick.word, { words: dictionary });
  assert.equal(check.ok, true, `${pick.word} should pass the setter gate`);
});
