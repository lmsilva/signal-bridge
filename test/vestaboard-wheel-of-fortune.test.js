'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { validate } = require('../src/vestaboard/encoder');
const { formatLayout } = require('../src/vestaboard/notation');
const { formatterFor, typeOf } = require('../src/vestaboard/router');
const wf = require('../src/vestaboard/formatters/wheel-of-fortune');

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
  assertBoard(wf.inviteRows({ code: '19ut', alias: 'WITTYGAME' }), [
    'yy WHEEL OF FORTUNE yy',
    '',
    '  JOIN THE NEXT GAME',
    'TINYURL.COM/WITTYGAME',
    '   GAME CODE: 19UT',
    '',
  ], 'invite');
});

test('the lobby keeps the invite and only fills the two spare rows', () => {
  assertBoard(wf.lobbyRows({ code: '19UT', playerCount: 1, minPlayers: 2 }), [
    'yy WHEEL OF FORTUNE yy',
    '       1 PLAYER',
    '  JOIN THE NEXT GAME',
    'TINYURL.COM/WITTYGAME',
    '   GAME CODE: 19UT',
    '     NEED 1 MORE',
  ], 'lobby short of players');

  assertBoard(wf.lobbyRows({ code: '19UT', playerCount: 3, minPlayers: 2 }), [
    'yy WHEEL OF FORTUNE yy',
    '      3 PLAYERS',
    '  JOIN THE NEXT GAME',
    'TINYURL.COM/WITTYGAME',
    '   GAME CODE: 19UT',
    '    STARTING SOON',
  ], 'lobby ready to start');
});

test('the puzzle card paints hidden letters as white chips', () => {
  assertBoard(wf.roundRows({
    category: 'PHRASE',
    puzzle: 'HAVE A NICE DAY',
    revealed: ['A', 'E'],
    lastEvent: 'LUIS SPINS 500',
  }), [
    'yy WHEEL OF FORTUNE yy',
    '        PHRASE',
    '',
    '   wAwE A wwwE wAw',
    '',
    '    LUIS SPINS 500',
  ], 'round with a partly revealed phrase');
});

test('the winner card centres the solved puzzle', () => {
  assertBoard(wf.intermissionRows({
    roundIndex: 1,
    rounds: 3,
    roundWinner: { name: 'Luis', score: 1000, puzzle: 'HAVE A NICE DAY' },
  }), [
    'yy  ROUND 1 WINNER  yy',
    '',
    '',
    '   HAVE A NICE DAY',
    '',
    '     LUIS - 1000',
  ], 'round winner');
});

test('final scores line the dollars up', () => {
  assertBoard(wf.scoresRows({
    scores: [
      { name: 'Luis', score: 3500 },
      { name: 'Ada', score: 1000 },
    ],
    final: true,
  }), [
    'yy   FINAL SCORES   yy',
    '     LUIS...3500',
    '     ADA....1000',
    '',
    '',
    '',
  ], 'final scores');
});

test('a thin lobby says why the game ended', () => {
  assertBoard(wf.shortRows({ minPlayers: 2, playerCount: 1 }), [
    'yy WHEEL OF FORTUNE yy',
    '',
    '  NOT ENOUGH PLAYERS',
    '   NEEDS 2 TO START',
    '',
    ' ONLY 1 PLAYER JOINED',
  ], 'short');
});

test('the router hands wheel.fortune payloads to this formatter', () => {
  const payload = {
    type: 'wheel.fortune',
    card: 'invite',
    code: 'ABCD',
    alias: 'WITTYGAME',
  };
  assert.equal(typeOf(payload), 'wheel.fortune');
  assert.equal(typeOf({}, 'wheel.invite'), 'wheel.fortune');
  const frames = formatterFor('wheel.fortune')(payload);
  assert.equal(frames.length, 1);
  assert.equal(validate(frames[0].rows).ok, true);
});
