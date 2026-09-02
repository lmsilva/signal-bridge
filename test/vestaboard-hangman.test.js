'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { validate } = require('../src/vestaboard/encoder');
const { formatLayout } = require('../src/vestaboard/notation');
const { formatterFor, typeOf } = require('../src/vestaboard/router');
const hm = require('../src/vestaboard/formatters/hangman');

function assertBoard(rows, drawing, label) {
  assert.equal(validate(rows).ok, true, `${label} failed validation`);
  const actual = formatLayout(rows);
  const expected = drawing.join('\n');
  if (actual !== expected) {
    assert.fail(
      `${label} does not match the spec drawing\n\n`
      + `--- expected ---\n${expected}\n\n`
      + `--- actual ---\n${actual}\n`,
    );
  }
}

test('the invite is the title, the link, and the code', () => {
  assertBoard(hm.inviteRows({ code: '19ut', alias: 'WITTYGAME' }), [
    'oo     HANGMAN      oo',
    '',
    '  JOIN THE NEXT GAME',
    'TINYURL.COM/WITTYGAME',
    '   GAME CODE: 19UT',
    '',
  ], 'invite');
});

test('the lobby keeps the invite and fills the two spare rows', () => {
  assertBoard(hm.lobbyRows({ code: '19UT', playerCount: 1, minPlayers: 2 }), [
    'oo     HANGMAN      oo',
    '       1 PLAYER',
    '  JOIN THE NEXT GAME',
    'TINYURL.COM/WITTYGAME',
    '   GAME CODE: 19UT',
    '     NEED 1 MORE',
  ], 'lobby');
  assertBoard(hm.lobbyRows({ code: '19UT', playerCount: 2, minPlayers: 1 }), [
    'oo     HANGMAN      oo',
    '      2 PLAYERS',
    '  JOIN THE NEXT GAME',
    'TINYURL.COM/WITTYGAME',
    '   GAME CODE: 19UT',
    '    STARTING SOON',
  ], 'lobby full');
});

/**
 * The live card is the whole game at a glance: the hint, the word with a
 * white chip for every letter still hidden, what has already cost a life,
 * and six chips draining green to red.
 */
test('the round is the hint, the word, the misses, and the lives', () => {
  assertBoard(hm.roundRows({
    category: 'ANIMALS',
    word: 'ALLIGATOR',
    revealed: ['A', 'L'],
    misses: ['B', 'Q'],
    livesLeft: 4,
    turnName: 'ADA',
  }), [
    'oo     HANGMAN      oo',
    '       ANIMALS',
    '  A L L w w A w w w',
    '       MISS B Q',
    '     LIVES ggggrr',
    '     ADA TO GUESS',
  ], 'round');
});

test('a word too long to space out closes up rather than falling off the row', () => {
  assertBoard(hm.roundRows({
    category: 'AROUND THE HOUSE',
    word: 'REFRIGERATOR',
    revealed: ['R', 'E'],
    livesLeft: 6,
    lastEvent: 'E X2 +20',
  }), [
    'oo     HANGMAN      oo',
    '   AROUND THE HOUSE',
    '     REwRwwERwwwR',
    '',
    '     LIVES gggggg',
    '       E X2 +20',
  ], 'round long');
});

test('while a phone is picking there is nothing to mask, so the board says who', () => {
  assertBoard(hm.roundRows({
    step: 'pick',
    setterName: 'Luis',
    code: '19ut',
    showCode: true,
  }), [
    'oo     HANGMAN      oo',
    '',
    '   LUIS IS PICKING',
    '    A WORD FOR YOU',
    '',
    '      CODE 19UT',
  ], 'round pick');
});

test('the reveal names the round, the word, and who got it', () => {
  assertBoard(hm.intermissionRows({
    roundIndex: 1,
    rounds: 3,
    roundWinner: { word: 'ALLIGATOR', name: 'Ada', score: 170, misses: 2 },
  }), [
    'oo   ROUND 1 WORD   oo',
    '',
    '',
    '      ALLIGATOR',
    '',
    '      ADA - 170',
  ], 'intermission');
});

test('a word nobody got still goes up, with the misses it cost', () => {
  assertBoard(hm.intermissionRows({
    roundIndex: 2,
    rounds: 3,
    word: 'ZEPHYR',
    misses: 6,
  }), [
    'oo   ROUND 2 WORD   oo',
    '       6 MISSES',
    '',
    '        ZEPHYR',
    '',
    '    NOBODY GOT IT',
  ], 'intermission unsolved');
});

test('the scores are dotted leaders under the code', () => {
  assertBoard(hm.scoresRows({
    scores: [{ name: 'Ada', score: 170 }, { name: 'Luis', score: 35 }],
    code: '19ut',
    showCode: true,
  }), [
    'oo   HIGH SCORES    oo',
    '     ADA.....170',
    '     LUIS.....35',
    '',
    '',
    '   GAME CODE: 19UT',
  ], 'scores');
});

test('the toughest word of the night is the one that nearly won', () => {
  assertBoard(hm.bestRows({ bestWord: 'ZEPHYR', name: 'Mo', bestMisses: 5 }), [
    'oo  TOUGHEST WORD   oo',
    '',
    '',
    '        ZEPHYR',
    '',
    '    MO - 5 MISSES',
  ], 'best');
  assertBoard(hm.bestRows({}), [
    'oo  TOUGHEST WORD   oo',
    '',
    '',
    '   NOTHING SURVIVED',
    '',
    '',
  ], 'best empty');
});

test('a lobby that never filled says so', () => {
  assertBoard(hm.shortRows({ minPlayers: 2, playerCount: 1 }), [
    'oo     HANGMAN      oo',
    '',
    '  NOT ENOUGH PLAYERS',
    '   NEEDS 2 TO START',
    '',
    ' ONLY 1 PLAYER JOINED',
  ], 'short');
});

test('one life left is one green chip and five red', () => {
  const rows = hm.roundRows({ category: 'ANIMALS', word: 'BADGER', livesLeft: 1 });
  assert.equal(formatLayout(rows).split('\n')[4], '     LIVES grrrrr');
  const none = hm.roundRows({ category: 'ANIMALS', word: 'BADGER', livesLeft: 0 });
  assert.equal(formatLayout(none).split('\n')[4], '     LIVES rrrrrr');
});

test('the mask never runs past the board, however long the word', () => {
  for (const word of ['CATS', 'ALLIGATOR', 'REFRIGERATOR', 'ACCOMPLISHMENT']) {
    const rows = hm.roundRows({ category: 'WORD', word, livesLeft: 3 });
    assert.equal(validate(rows).ok, true, word);
    assert.equal(rows[2].length, 22, word);
  }
});

test('the round card is wired to the board as hangman.game', () => {
  const payload = {
    type: 'hangman.game',
    source: 'hangman.game',
    card: 'round',
    category: 'ANIMALS',
    word: 'BADGER',
    mask: 'B_____',
    misses: ['Z'],
    livesLeft: 5,
    holdSeconds: 25,
  };
  assert.equal(typeOf(payload), 'hangman.game');
  assert.equal(typeOf({}, 'hangman.invite'), 'hangman.game');
  const frames = formatterFor('hangman.game')(payload);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].card, 'round');
  assert.equal(frames[0].holdSeconds, 25);
  assert.equal(validate(frames[0].rows || frames[0].characters).ok, true);
});

test('the final card is the scores, and the toughest word when there was one', () => {
  const scoresOnly = formatterFor('hangman.game')({ card: 'final', scores: [{ name: 'Ada', score: 12 }] });
  assert.equal(scoresOnly.length, 1);
  const withBest = formatterFor('hangman.game')({
    card: 'final',
    scores: [{ name: 'Ada', score: 12 }],
    bestWord: 'ZEPHYR',
    name: 'Ada',
    bestMisses: 4,
  });
  assert.equal(withBest.length, 2);
  assert.ok(withBest.every((frame) => frame.card === 'final'));
});
