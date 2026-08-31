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
  intermissionRows,
  bestRows,
  roundFrames,
  finalFrames,
  roundLabel,
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
  assert.ok(words.length > 150000, `only ${words.length} words shipped`);
  for (let i = 1; i < 200; i += 1) {
    assert.ok(words[i - 1] < words[i], 'list must stay sorted for binary search');
  }
});

test('the list reaches as far as the board can spell', () => {
  const words = loadWords();
  // A path may cross all sixteen cells, so a nine-letter ceiling used to make
  // the best find on a grid impossible to submit.
  const longest = words.reduce((most, word) => Math.max(most, word.length), 0);
  assert.ok(longest >= 15, `longest word is only ${longest} letters`);
  assert.equal(hasWord(words, 'lighthouses'), true);
  assert.equal(hasWord(words, 'considerate'), true);
  // Still no room for anything a 4x4 could never hold.
  assert.equal(words.some((word) => word.length > 16), false);
  assert.equal(words.some((word) => word.length < 3), false);
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

test('every extra letter is worth more than the last', () => {
  assert.equal(scoreWord('no'), 0, 'two letters are too short to score');
  assert.equal(scoreWord('cat'), 1);
  assert.equal(scoreWord('cats'), 2, 'a four is worth more than a three');
  assert.equal(scoreWord('winds'), 4);
  assert.equal(scoreWord('winder'), 6);
  assert.equal(scoreWord('winders'), 9);
  assert.equal(scoreWord('scramble'), 12);
  assert.equal(scoreWord('scrambled'), 15, 'past the ladder each letter adds 3');

  let previous = 0;
  for (let n = 3; n <= 14; n += 1) {
    const points = scoreWord('a'.repeat(n));
    assert.ok(points > previous, `${n} letters must beat ${n - 1}`);
    previous = points;
  }
});

test('everyone scores a shared word; cancel zeroes it', () => {
  const players = [
    { id: 'a', words: ['cat', 'wind'] },
    { id: 'b', words: ['cat', 'leap'] },
  ];
  const everyone = scoreRound(players, { duplicateRule: 'everyone', words: WORDS });
  const byId = Object.fromEntries(everyone.map((row) => [row.id, row.score]));
  assert.equal(byId.a, 3, 'cat (1) + wind (2)');
  assert.equal(byId.b, 3, 'cat (1) + leap (2)');

  const cancel = scoreRound(players, { duplicateRule: 'cancel', words: WORDS });
  const cancelById = Object.fromEntries(cancel.map((row) => [row.id, row.score]));
  assert.equal(cancelById.a, 2, 'the shared cat is worth nothing');
  assert.equal(cancelById.b, 2);
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
  assert.equal(best.points, 15);
});

test('invite frame matches the marketplace drawing, title centred between the chips', () => {
  assertLayout(inviteRows({ code: 'SLNG', alias: 'WITTYGAME' }), [
    'gg  WORD SCRAMBLE   gg',
    '',
    '  JOIN THE NEXT GAME',
    ' TINYURL.COM/WITTYGAME',
    '    GAME CODE: SLNG',
    '',
  ], 'word-scramble invite');
});

test('lobby frame keeps the invite and fills in the player count', () => {
  assertLayout(lobbyRows({ code: 'SLNG', alias: 'WITTYGAME', playerCount: 2 }), [
    'gg  WORD SCRAMBLE   gg',
    '       2 PLAYERS',
    '  JOIN THE NEXT GAME',
    ' TINYURL.COM/WITTYGAME',
    '    GAME CODE: SLNG',
    '',
  ], 'word-scramble lobby');
  assertLayout(lobbyRows({ code: 'SLNG', alias: 'WITTYGAME', playerCount: 1 }), [
    'gg  WORD SCRAMBLE   gg',
    '       1 PLAYER',
    '  JOIN THE NEXT GAME',
    ' TINYURL.COM/WITTYGAME',
    '    GAME CODE: SLNG',
    '',
  ], 'word-scramble lobby solo');
});

test('intermission frame shows the round winner and running total', () => {
  assertLayout(intermissionRows({
    roundIndex: 2,
    rounds: 3,
    roundWinner: { name: 'Luis', score: 3 },
    scores: [{ name: 'Luis', score: 5 }, { name: 'Ada', score: 2 }],
  }), [
    '  ROUND 2 OF 3 WINNER',
    'LUIS ................3',
    '',
    '     RUNNING TOTAL',
    'LUIS ................5',
    'ADA .................2',
  ], 'word-scramble intermission');
});

test('final frame sequences high scores before best word', () => {
  const frames = finalFrames({
    phase: 'final',
    card: 'final',
    scores: [{ name: 'Luis', score: 12 }, { name: 'Ada', score: 9 }],
    word: 'scrambled',
    name: 'Luis',
    points: 15,
    holdSeconds: 10,
  });
  assert.equal(frames.length, 2);
  assert.equal(frames[0].label, 'Final scores');
  assert.equal(frames[1].label, 'Best word');
  assert.equal(frames[0].holdSeconds, 10);
  assert.equal(frames[1].holdSeconds, 10);
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

test('the round card says which round it is, and the code while phones may still join', () => {
  assertLayout(roundRows({
    grid: ['CATE', 'ORWX', 'WIND', 'LEAP'],
    roundIndex: 1,
    rounds: 3,
    code: 'SLNG',
    showCode: true,
  }), [
    'HOW MANY      yyyyyyyy',
    'SCRAMBLED     yyCATEyy',
    'WORDS CAN     yyORWXyy',
    'YOU FIND?     yyWINDyy',
    'ROUND 1 OF 3  yyLEAPyy',
    'CODE SLNG     yyyyyyyy',
  ], 'word-scramble round with round and code');

  // Late joining off: the round still shows, the code does not.
  assertLayout(roundRows({
    grid: ['CATE', 'ORWX', 'WIND', 'LEAP'],
    roundIndex: 2,
    rounds: 3,
    code: 'SLNG',
  }), [
    'HOW MANY      yyyyyyyy',
    'SCRAMBLED     yyCATEyy',
    'WORDS CAN     yyORWXyy',
    'YOU FIND?     yyWINDyy',
    'ROUND 2 OF 3  yyLEAPyy',
    '              yyyyyyyy',
  ], 'word-scramble round without the code');

  assert.equal(roundLabel(1, 3), 'ROUND 1 OF 3');
  assert.equal(roundLabel(1, 1), 'ROUND 1', 'a one-round game does not count to one');
  assert.equal(roundLabel(0, 3), '');
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
  assertLayout(bestRows({ word: 'scrambled', name: 'Luis', points: 15 }), [
    '       BEST WORD',
    '       SCRAMBLED',
    '       FOUND BY',
    '         LUIS',
    '          15',
    '',
  ], 'word-scramble best');
});

test('the scores card trades its fifth row for the code so latecomers can join', () => {
  assertLayout(scoresRows({
    scores: [{ name: 'Luis', score: 12 }, { name: 'Ada', score: 9 }],
    code: 'SLNG',
    showCode: true,
    final: true,
  }), [
    '     FINAL SCORES',
    'LUIS ...............12',
    'ADA .................9',
    '',
    '',
    '    GAME CODE: SLNG',
  ], 'word-scramble final scores with the code');
});

test('a closed game blanks the board rather than leaving the lobby up', () => {
  const { clearedRows, clearFrames, framesFor } = require('../src/vestaboard/formatters/games');
  assertLayout(clearedRows(), ['', '', '', '', '', ''], 'word-scramble clear');
  assert.equal(clearFrames()[0].source, 'word.scramble');
  assert.deepEqual(
    framesFor({ phase: 'closed', card: 'clear' })[0].rows,
    clearedRows(),
  );
});
