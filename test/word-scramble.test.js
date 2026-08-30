'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { validate } = require('../src/vestaboard/encoder');
const { parseLayout, formatLayout } = require('../src/vestaboard/notation');
const {
  DICE,
  hasWord,
  hasPrefix,
  rollDice,
  solveGrid,
  scoreWord,
  createRound,
  validateWord,
  scoreRound,
  hardestWord,
  loadWords,
} = require('../src/word-scramble');
const {
  inviteRows,
  lobbyRows,
  roundRows,
  scoresRows,
  bestRows,
  roundFrames,
} = require('../src/vestaboard/formatters/games');

const WORDS = [
  'cat', 'cats', 'car', 'care', 'ear', 'leap', 'pea', 'peal',
  'win', 'wind', 'wine', 'ore', 'row', 'ate', 'tea', 'eat',
  'scramble', 'scrambled',
].sort();

function assertLayout(actual, drawing, label) {
  assert.equal(validate(actual).ok, true, `${label} failed validation`);
  const expected = parseLayout(drawing.join('\n'), { label });
  if (formatLayout(actual) !== formatLayout(expected)) {
    assert.fail(
      `${label} does not match\n\n${formatLayout(actual)}\n\nexpected\n\n${formatLayout(expected)}`,
    );
  }
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('the shipped ENABLE1 list is sorted and long enough for a real game', () => {
  const words = loadWords();
  assert.ok(words.length > 10000);
  for (let i = 1; i < 200; i += 1) {
    assert.ok(words[i - 1] < words[i], 'list must stay sorted for binary search');
  }
});

test('binary search finds words and prefixes', () => {
  assert.equal(hasWord(WORDS, 'cat'), true);
  assert.equal(hasWord(WORDS, 'dog'), false);
  assert.equal(hasPrefix(WORDS, 'scr'), true);
  assert.equal(hasPrefix(WORDS, 'zzz'), false);
});

test('a seeded roll is stable and never prints Q', () => {
  const first = rollDice(mulberry32(42));
  const second = rollDice(mulberry32(42));
  assert.deepEqual(first, second);
  assert.equal(first.length, 4);
  assert.equal(first.join('').length, 16);
  assert.doesNotMatch(first.join(''), /Q/);
  assert.equal(DICE.some((die) => die.includes('Q')), false);
});

test('the solver walks 8-way adjacency and does not reuse a cell', () => {
  const grid = ['CATE', 'ORWX', 'WIND', 'LEAP'];
  const found = solveGrid(grid, WORDS);
  assert.ok(found.includes('cat'));
  assert.ok(found.includes('ate'));
  assert.ok(found.includes('wind'));
  assert.ok(found.includes('leap'));
  assert.equal(found.includes('cccc'), false);
});

test('scoring uses the standard Boggle ladder', () => {
  assert.equal(scoreWord('cat'), 1);
  assert.equal(scoreWord('cats'), 1);
  assert.equal(scoreWord('winds'), 2);
  assert.equal(scoreWord('winder'), 3);
  assert.equal(scoreWord('winders'), 5);
  assert.equal(scoreWord('scrambled'), 11);
  assert.equal(scoreWord('no'), 0);
});

test('everyone scores a shared word; cancel zeroes it', () => {
  const players = [
    { id: 'a', words: ['cat', 'wind'] },
    { id: 'b', words: ['cat', 'leap'] },
  ];
  const everyone = scoreRound(players, { duplicateRule: 'everyone', words: WORDS });
  const byId = Object.fromEntries(everyone.map((row) => [row.id, row.score]));
  assert.equal(byId.a, 2);
  assert.equal(byId.b, 2);

  const cancel = scoreRound(players, { duplicateRule: 'cancel', words: WORDS });
  const cancelById = Object.fromEntries(cancel.map((row) => [row.id, row.score]));
  assert.equal(cancelById.a, 1);
  assert.equal(cancelById.b, 1);
});

test('validateWord rejects words that are not on the board', () => {
  const grid = ['CATE', 'ORWX', 'WIND', 'LEAP'];
  assert.equal(validateWord(grid, 'cat', WORDS).ok, true);
  assert.equal(validateWord(grid, 'zzzz', WORDS).ok, false);
  assert.equal(validateWord(grid, 'scramble', WORDS).reason, 'not-on-board');
});

test('createRound always returns a 4x4 even when the list is thin', () => {
  const round = createRound({
    random: mulberry32(7),
    words: WORDS,
    minSolutions: 2,
    maxRolls: 8,
  });
  assert.equal(round.grid.length, 4);
  assert.equal(round.grid.join('').length, 16);
  assert.ok(Array.isArray(round.solutions));
});

test('hardestWord prefers the longest, then A–Z', () => {
  const best = hardestWord([
    { word: 'wind', playerId: 'a' },
    { word: 'leap', playerId: 'b' },
    { word: 'scrambled', playerId: 'c' },
  ]);
  assert.equal(best.word, 'scrambled');
  assert.equal(best.points, 11);
});

test('invite frame matches the marketplace drawing', () => {
  assertLayout(inviteRows({ code: 'SLNG', alias: 'WITTYGAME' }), [
    'gg WORD SCRAMBLE    gg',
    '',
    '  JOIN THE NEXT GAME',
    ' TINYURL.COM/WITTYGAME',
    '    GAME CODE: SLNG',
    '',
  ], 'word-scramble invite');
});

test('lobby frame shows the player count and code', () => {
  assertLayout(lobbyRows({ code: 'SLNG', playerCount: 2 }), [
    'gg WORD SCRAMBLE    gg',
    '       2 PLAYERS',
    '       GAME CODE',
    '         SLNG',
    '   WAITING TO START',
    '',
  ], 'word-scramble lobby');
});

test('round frame frames the 4x4 in yellow and holds the remaining seconds', () => {
  assertLayout(roundRows({ grid: ['CATE', 'ORWX', 'WIND', 'LEAP'] }), [
    'HOW MANY      yyyyyyyy',
    'SCRAMBLED     yyCATEyy',
    'WORDS CAN     yyORWXyy',
    'YOU FIND?     yyWINDyy',
    '              yyLEAPyy',
    '              yyyyyyyy',
  ], 'word-scramble round');
  const frames = roundFrames({
    grid: ['CATE', 'ORWX', 'WIND', 'LEAP'],
    holdSeconds: 180,
  });
  assert.equal(frames[0].holdSeconds, 180);
  assert.equal(frames[0].priority, 'snapshot');
});

test('scores and best-word frames match the drawings', () => {
  assertLayout(scoresRows({
    scores: [{ name: 'Luis', score: 12 }, { name: 'Ada', score: 9 }],
  }), [
    '      HIGH SCORES',
    'LUIS ...............12',
    'ADA .................9',
    '',
    '',
    '',
  ], 'word-scramble scores');
  assertLayout(bestRows({ word: 'scrambled', name: 'Luis', points: 11 }), [
    '       BEST WORD',
    '       SCRAMBLED',
    '       FOUND BY',
    '         LUIS',
    '          11',
    '',
  ], 'word-scramble best');
});
