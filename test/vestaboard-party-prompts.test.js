'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { validate } = require('../src/vestaboard/encoder');
const { formatLayout } = require('../src/vestaboard/notation');
const { formatterFor, typeOf } = require('../src/vestaboard/router');
const pp = require('../src/vestaboard/formatters/party-prompts');

/** Compare a card against a drawing of the whole board, row for row. */
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

const SCORES = [
  { name: 'Nicole', score: 8 },
  { name: 'Ben', score: 5 },
  { name: 'Avery', score: 3 },
  { name: 'Cierra', score: 3 },
  { name: 'Dorrian', score: 2 },
];

test('the invite is the title, the link, and the code', () => {
  assertBoard(pp.inviteRows({ code: '19ut', alias: 'WITTYGAME' }), [
    'vv  PARTY PROMPTS   vv',
    '',
    '  JOIN THE NEXT GAME',
    'TINYURL.COM/WITTYGAME',
    '   GAME CODE: 19UT',
    '',
  ], 'invite');
});

test('the lobby keeps the invite and only fills the two spare rows', () => {
  assertBoard(pp.lobbyRows({ code: '19UT', playerCount: 2, minPlayers: 3 }), [
    'vv  PARTY PROMPTS   vv',
    '      2 PLAYERS',
    '  JOIN THE NEXT GAME',
    'TINYURL.COM/WITTYGAME',
    '   GAME CODE: 19UT',
    '     NEED 1 MORE',
  ], 'lobby short of players');

  assertBoard(pp.lobbyRows({ code: '19UT', playerCount: 4, minPlayers: 3 }), [
    'vv  PARTY PROMPTS   vv',
    '      4 PLAYERS',
    '  JOIN THE NEXT GAME',
    'TINYURL.COM/WITTYGAME',
    '   GAME CODE: 19UT',
    '    STARTING SOON',
  ], 'lobby ready to start');
});

test('the prompt card centres the question and closes on the join line', () => {
  assertBoard(pp.roundRows({
    prompt: 'Least necessary part of a car',
    alias: 'WITTYGAME',
  }), [
    'vv  PARTY PROMPTS   vv',
    '',
    ' LEAST NECESSARY PART',
    '       OF A CAR',
    '',
    'TINYURL.COM/WITTYGAME',
  ], 'round with a two-line prompt');

  // A short alias leaves room for the instruction, which is what a phone
  // across the room actually needs to read.
  assertBoard(pp.roundRows({
    prompt: 'Words you never want to hear from a pilot',
    alias: 'E3BE',
  }), [
    'vv  PARTY PROMPTS   vv',
    '',
    ' WORDS YOU NEVER WANT',
    ' TO HEAR FROM A PILOT',
    '',
    '   TINYURL.COM/E3BE',
  ], 'round with a long prompt');
});

test('the code only takes the row under the title while phones may still join', () => {
  assertBoard(pp.roundRows({
    prompt: 'Least necessary part of a car',
    code: '19UT',
    showCode: true,
  }), [
    'vv  PARTY PROMPTS   vv',
    '      CODE 19UT',
    ' LEAST NECESSARY PART',
    '       OF A CAR',
    '',
    'TINYURL.COM/WITTYGAME',
  ], 'round with the code up');
});

test('voting keeps the prompt up and swaps the footer for the instruction', () => {
  assertBoard(pp.votingRows({ prompt: 'Least necessary part of a car' }), [
    'vv  PARTY PROMPTS   vv',
    '',
    ' LEAST NECESSARY PART',
    '       OF A CAR',
    '',
    '  VOTE ON YOUR PHONE',
  ], 'voting');
});

test('the round winner is the answer, big, with the name under it', () => {
  assertBoard(pp.intermissionRows({
    roundIndex: 1,
    rounds: 3,
    roundWinner: { answer: 'The other passengers', name: 'Nicole', score: 3 },
  }), [
    'vv  ROUND 1 WINNER  vv',
    '',
    '',
    ' THE OTHER PASSENGERS',
    '',
    '   NICOLE - 3 VOTES',
  ], 'round winner');
});

test('the winner title stays short so ROUND 1 OF 3 WINNER cannot overflow', () => {
  assert.equal(pp.roundLabel(2, 3), 'ROUND 2 OF 3');
  assert.equal(pp.roundLabel(2, 3, { short: true }), 'ROUND 2');
  assert.equal(pp.roundLabel(0, 3), '');
});

test('a round nobody voted in says so instead of showing a blank card', () => {
  assertBoard(pp.intermissionRows({ roundIndex: 2, rounds: 3 }), [
    'vv  ROUND 2 WINNER  vv',
    '',
    '',
    ' NO VOTES THIS ROUND',
    '',
    '',
  ], 'round with no votes');
});

test('the scoreboard dots line the numbers up in one column', () => {
  assertBoard(pp.scoresRows({ scores: SCORES }), [
    'vv   HIGH SCORES    vv',
    '     NICOLE....8',
    '     BEN.......5',
    '     AVERY.....3',
    '     CIERRA....3',
    '     DORRIAN...2',
  ], 'high scores');
});

test('the code costs the fifth score, so the final card does without it', () => {
  assertBoard(pp.scoresRows({ scores: SCORES, code: '19UT', showCode: true }), [
    'vv   HIGH SCORES    vv',
    '     NICOLE....8',
    '     BEN.......5',
    '     AVERY.....3',
    '     CIERRA....3',
    '   GAME CODE: 19UT',
  ], 'high scores with the code up');

  assertBoard(pp.scoresRows({ scores: SCORES, final: true }), [
    'vv   FINAL SCORES   vv',
    '     NICOLE....8',
    '     BEN.......5',
    '     AVERY.....3',
    '     CIERRA....3',
    '     DORRIAN...2',
  ], 'final scores');
});

test('a long name widens the block rather than losing its score', () => {
  const { lines } = pp.leaderLines([
    { name: 'Bartholomew', score: 12 },
    { name: 'Jo', score: 1 },
  ]);
  assert.deepEqual(lines, [
    'BARTHOLOME..12',
    'JO...........1',
  ]);
});

test('the best answer of the night carries the same layout as the winner', () => {
  assertBoard(pp.bestRows({
    answer: 'A gentle reminder that gravity is undefeated',
    name: 'Ben',
    votes: 4,
  }), [
    'vv   BEST ANSWER    vv',
    '',
    'A GENTLE REMINDER THAT',
    'GRAVITY IS UNDEFEATED',
    '',
    '    BEN - 4 VOTES',
  ], 'best answer');
});

test('a lobby that never filled says why rather than vanishing', () => {
  assertBoard(pp.shortRows({ minPlayers: 3, playerCount: 2 }), [
    'vv  PARTY PROMPTS   vv',
    '',
    '  NOT ENOUGH PLAYERS',
    '   NEEDS 3 TO START',
    '',
    'ONLY 2 PLAYERS JOINED',
  ], 'not enough players');
});

test('the final card shows the scores and then the line of the night', () => {
  const frames = pp.finalFrames({
    scores: SCORES,
    answer: 'The other passengers',
    name: 'Nicole',
    votes: 3,
    holdSeconds: 20,
  });
  assert.equal(frames.length, 2);
  assert.deepEqual(frames.map((frame) => frame.card), ['final', 'final']);
  assert.ok(frames.every((frame) => frame.holdSeconds === 20));
  assert.match(formatLayout(frames[0].rows || frames[0].layout), /FINAL SCORES/);

  // No answer means no second card — an empty reveal is worse than none.
  assert.equal(pp.finalFrames({ scores: SCORES }).length, 1);
});

test('the phase drives the card, and an unknown phase falls back to the invite', () => {
  const card = (payload) => pp.framesFor(payload)[0].card;
  assert.equal(card({ card: 'invite' }), 'invite');
  assert.equal(card({ phase: 'invited' }), 'invite');
  assert.equal(card({ card: 'lobby' }), 'lobby');
  assert.equal(card({ card: 'round', prompt: 'ANYTHING AT ALL' }), 'round');
  assert.equal(card({ card: 'voting', prompt: 'ANYTHING AT ALL' }), 'voting');
  assert.equal(card({ card: 'intermission' }), 'intermission');
  assert.equal(card({ card: 'short' }), 'short');
  assert.equal(card({ card: 'scores', scores: SCORES }), 'scores');
  assert.equal(card({ card: 'final', scores: SCORES }), 'final');
  assert.equal(card({ phase: 'nonsense' }), 'invite');

  // `card` wins over a `phase` that is still a tick behind.
  assert.equal(card({ card: 'lobby', phase: 'invited' }), 'lobby');
});

test('the router hands party.prompts payloads to this formatter', () => {
  const payload = {
    type: 'party.prompts',
    card: 'round',
    prompt: 'Least necessary part of a car',
    alias: 'WITTYGAME',
  };
  assert.equal(typeOf(payload), 'party.prompts');
  assert.equal(typeOf({}, 'prompts.invite'), 'party.prompts');
  const frames = formatterFor('party.prompts')(payload);
  assert.equal(frames.length, 1);
  assertBoard(frames[0].rows || frames[0].layout, [
    'vv  PARTY PROMPTS   vv',
    '',
    ' LEAST NECESSARY PART',
    '       OF A CAR',
    '',
    'TINYURL.COM/WITTYGAME',
  ], 'routed round card');
});
