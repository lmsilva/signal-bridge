'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createGameSessions } = require('../src/games/sessions');
const { createGameArchive } = require('../src/games/archive');
const promptsMode = require('../src/games/modes/prompts');

const SETTINGS = Object.freeze({
  lobbySeconds: 10,
  roundSeconds: 20,
  votingSeconds: 15,
  intermissionSeconds: 5,
  rounds: 2,
  inviteTtlMinutes: 1,
  idleTimeoutSeconds: 120,
  maxPlayers: 12,
  minPlayers: 3,
  allowLateJoin: true,
  preferredAlias: 'WITTYGAME',
});

const DECK = ['ALPHA PROMPT', 'BRAVO PROMPT', 'CHARLIE PROMPT'];

/**
 * The real Party Prompts mode dealing from a fixed deck, so the assertions
 * below describe the game rather than whichever question the corpus rolled.
 */
function fixedDeckMode() {
  return {
    ...promptsMode,
    createRound({ session }) {
      const used = session?.usedRounds || [];
      const prompt = DECK.find((row) => !used.includes(row)) || DECK[0];
      return { prompt, answers: new Map(), votes: new Map(), order: [] };
    },
  };
}

function makeApi(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prompts-'));
  let nowMs = Date.parse('2026-09-01T18:00:00Z');
  const pushes = [];
  const archive = createGameArchive({ ROOT: root, gameArchivePath: path.join(root, 'archive') });
  const api = createGameSessions({ ROOT: root }, { warn() {}, info() {} }, {
    now: () => nowMs,
    random: () => 0,
    gameSettings: { get: () => ({ ...SETTINGS, ...overrides }) },
    archive,
    gameOf: () => fixedDeckMode(),
    getShortlink: () => ({ alias: 'WITTYGAME' }),
    pushBoard: (payload, options) => {
      pushes.push({ payload, options });
      return { boards: [] };
    },
    dropPendingBoard: () => 0,
    setGameLock: () => {},
  });
  return {
    api,
    archive,
    pushes,
    advance(seconds) {
      nowMs += seconds * 1000;
      api.tick(nowMs);
    },
  };
}

/** Open a session with `names` seated and the first prompt on the board. */
function startedGame(names = ['Luis', 'Ada', 'Sam'], overrides) {
  const harness = makeApi(overrides);
  const invited = harness.api.create({ gameType: 'prompts' });
  const players = names.map((name) => harness.api.join({ code: invited.code, name }).player);
  harness.advance(11);
  return { ...harness, invited, players, sessionId: invited.sessionId };
}

const answer = (api, sessionId, playerId, text) => api.submit({
  sessionId,
  playerId,
  action: 'answer',
  payload: { answer: text },
});

test('a lobby that never reaches three players ends and says why', () => {
  const { api, archive, advance, pushes } = makeApi();
  const invited = api.create({ gameType: 'prompts' });
  api.join({ code: invited.code, name: 'Luis' });
  api.join({ code: invited.code, name: 'Ada' });

  advance(11);
  assert.equal(api.getByCode(invited.code), null, 'two people is not a game');
  const last = pushes[pushes.length - 1];
  assert.equal(last.payload.card, 'short');
  assert.equal(last.payload.minPlayers, 3);
  assert.equal(last.payload.playerCount, 2);
  assert.equal(archive.listAll()[0].reason, 'not-enough-players');
});

test('the third player is enough to deal the first prompt', () => {
  const { api, invited, pushes } = startedGame();
  const live = api.getByCode(invited.code);
  assert.equal(live.phase, 'round');
  const round = pushes.filter((row) => row.payload.card === 'round').pop();
  assert.equal(round.payload.prompt, 'ALPHA PROMPT');
  assert.equal(round.payload.source, 'party.prompts');
});

test('the lobby card counts down to the minimum instead of only ticking', () => {
  const { api, pushes } = makeApi();
  const invited = api.create({ gameType: 'prompts' });
  api.join({ code: invited.code, name: 'Luis' });
  const lobby = pushes.filter((row) => row.payload.card === 'lobby').pop();
  assert.equal(lobby.payload.playerCount, 1);
  assert.equal(lobby.payload.minPlayers, 3);

  const seen = api.publicSession(api.getByCode(invited.code));
  assert.equal(seen.needPlayers, 2);
  assert.equal(seen.minPlayers, 3);
});

test('one answer each, and a second one is refused rather than replacing it', () => {
  const { api, sessionId, players } = startedGame();
  const first = answer(api, sessionId, players[0].id, 'The cup holder');
  assert.equal(first.ok, true);
  assert.equal(first.answer, 'THE CUP HOLDER');

  const again = answer(api, sessionId, players[0].id, 'Something else');
  assert.equal(again.ok, false);
  assert.match(again.error, /already/i);
});

test('two people cannot write the same line, however they capitalise it', () => {
  const { api, sessionId, players } = startedGame();
  assert.equal(answer(api, sessionId, players[0].id, 'The cup holder').ok, true);
  const clash = answer(api, sessionId, players[1].id, 'THE   CUP HOLDER');
  assert.equal(clash.ok, false);
  assert.match(clash.error, /already wrote/i);
});

test('an answer that would not fit the winner card is refused on the phone', () => {
  const { api, sessionId, players } = startedGame();
  const long = answer(api, sessionId, players[0].id, 'abcdefghijkl '.repeat(4));
  assert.equal(long.ok, false);
  assert.match(long.error, /too long/i);
});

test('writing then voting: the last locked answer starts the ballot', () => {
  const { api, sessionId, players, pushes } = startedGame();
  assert.equal(answer(api, sessionId, players[0].id, 'ANSWER 0').ok, true);
  assert.equal(api.getById(sessionId).phase, 'round');
  assert.equal(answer(api, sessionId, players[1].id, 'ANSWER 1').ok, true);
  assert.equal(api.getById(sessionId).phase, 'round');
  assert.equal(answer(api, sessionId, players[2].id, 'ANSWER 2').ok, true);
  assert.equal(api.getById(sessionId).phase, 'voting', 'no point waiting out the write clock');
  const voting = pushes.filter((row) => row.payload.card === 'voting').pop();
  assert.equal(voting.payload.prompt, 'ALPHA PROMPT');
  assert.equal(voting.payload.holdSeconds, 15);
});

test('the ballot is anonymous, shuffled, and refuses your own answer', () => {
  const { api, sessionId, players, advance } = startedGame();
  players.forEach((player, index) => answer(api, sessionId, player.id, `ANSWER ${index}`));

  const seen = api.publicSession(api.getById(sessionId), players[0].id);
  assert.equal(seen.phase, 'voting');
  assert.equal(seen.ballot.length, 3);
  for (const row of seen.ballot) {
    assert.equal(Object.prototype.hasOwnProperty.call(row, 'name'), false, 'names spoil the vote');
    assert.match(row.answerId, /^[0-9a-f-]{36}$/);
  }
  assert.equal(seen.ballot.filter((row) => row.mine).length, 1);

  // Every phone is looking at the same list in the same order.
  const other = api.publicSession(api.getById(sessionId), players[1].id);
  assert.deepEqual(
    other.ballot.map((row) => row.answerId),
    seen.ballot.map((row) => row.answerId),
  );

  const mine = seen.ballot.find((row) => row.mine);
  const self = api.submit({
    sessionId,
    playerId: players[0].id,
    action: 'vote',
    payload: { answerId: mine.answerId },
  });
  assert.equal(self.ok, false);
  assert.match(self.error, /yourself/i);
});

test('a vote is a point, and it can be changed until the clock runs out', () => {
  const { api, sessionId, players, advance } = startedGame();
  players.forEach((player, index) => answer(api, sessionId, player.id, `ANSWER ${index}`));

  const ballotFor = (playerId) => api.publicSession(api.getById(sessionId), playerId).ballot;
  const pick = (voter, target) => {
    const row = ballotFor(voter).find((entry) => entry.answer === target);
    return api.submit({ sessionId, playerId: voter, action: 'vote', payload: { answerId: row.answerId } });
  };

  assert.equal(pick(players[1].id, 'ANSWER 0').ok, true);
  assert.equal(pick(players[2].id, 'ANSWER 0').ok, true);
  // A change of heart replaces the vote rather than adding one.
  assert.equal(pick(players[2].id, 'ANSWER 1').ok, true);
  assert.equal(api.publicSession(api.getById(sessionId), players[2].id).you.vote.length, 36);

  advance(16);
  const paused = api.publicSession(api.getById(sessionId), players[0].id);
  assert.equal(paused.phase, 'intermission');
  assert.deepEqual(
    paused.scores.map((row) => [row.name, row.score]),
    [['Ada', 1], ['Luis', 1], ['Sam', 0]],
    'a tie is broken by name, not by who scored first',
  );
});

test('the reveal puts the names back on the answers, best first', () => {
  const { api, sessionId, players, advance, pushes } = startedGame();
  players.forEach((player, index) => answer(api, sessionId, player.id, `ANSWER ${index}`));
  const ballot = api.publicSession(api.getById(sessionId), players[1].id).ballot;
  const target = ballot.find((row) => row.answer === 'ANSWER 0');
  api.submit({ sessionId, playerId: players[1].id, action: 'vote', payload: { answerId: target.answerId } });
  api.submit({ sessionId, playerId: players[2].id, action: 'vote', payload: { answerId: target.answerId } });

  advance(16);
  const paused = api.publicSession(api.getById(sessionId), players[0].id);
  assert.equal(paused.lastRound.index, 1);
  assert.equal(paused.lastRound.prompt, 'ALPHA PROMPT');
  assert.deepEqual(paused.lastRound.answers, [
    { name: 'Luis', answer: 'ANSWER 0', votes: 2 },
    { name: 'Ada', answer: 'ANSWER 1', votes: 0 },
    { name: 'Sam', answer: 'ANSWER 2', votes: 0 },
  ]);

  const winner = pushes.filter((row) => row.payload.card === 'intermission').pop();
  assert.equal(winner.payload.roundWinner.answer, 'ANSWER 0');
  assert.equal(winner.payload.roundWinner.name, 'Luis');
  assert.equal(winner.payload.roundWinner.score, 2);
});

test('a round with nothing to choose between skips the ballot', () => {
  const { api, sessionId, players, advance, pushes } = startedGame();
  answer(api, sessionId, players[0].id, 'THE ONLY ANSWER');

  advance(21);
  assert.equal(api.getById(sessionId).phase, 'intermission', 'one answer cannot win a vote');
  assert.equal(pushes.some((row) => row.payload.card === 'voting'), false);
});

test('the next round deals a new prompt and forgets the last ballot', () => {
  const { api, sessionId, players, advance } = startedGame();
  players.forEach((player, index) => answer(api, sessionId, player.id, `ANSWER ${index}`));
  advance(16);
  advance(6);

  const live = api.publicSession(api.getById(sessionId), players[0].id);
  assert.equal(live.phase, 'round');
  assert.equal(live.prompt, 'BRAVO PROMPT');
  assert.equal(live.you.answer, '');
  assert.equal(live.lastRound, null);
  assert.equal(live.ballot, undefined);
});

test('the night ends on the final scores and the best answer of the game', () => {
  const { api, sessionId, players, archive, advance, pushes } = startedGame();
  const playRound = (winnerIndex) => {
    players.forEach((player, index) => answer(api, sessionId, player.id, `R${api.getById(sessionId).roundIndex} ANSWER ${index}`));
    const ballot = api.publicSession(api.getById(sessionId), players[0].id).ballot;
    const target = ballot.find((row) => row.answer.endsWith(`ANSWER ${winnerIndex}`));
    for (const player of players) {
      if (player.id === players[winnerIndex].id) continue;
      api.submit({ sessionId, playerId: player.id, action: 'vote', payload: { answerId: target.answerId } });
    }
    advance(16);
  };

  playRound(0);
  advance(6);
  playRound(1);

  const final = api.getById(sessionId);
  assert.equal(final.phase, 'final');
  const scores = pushes.filter((row) => row.payload.card === 'final').pop();
  assert.equal(scores.payload.showCode, false, 'the game is over — there is nothing to join');
  assert.equal(scores.payload.answer, 'R1 ANSWER 0', 'the best answer of the night');
  assert.equal(scores.payload.name, 'Luis');

  // The final phase runs long enough to read both cards, not just the scores.
  advance(6);
  assert.equal(api.getById(sessionId).phase, 'final');
  advance(6);
  assert.equal(api.getById(sessionId), null);
  const row = archive.listAll()[0];
  assert.equal(row.gameType, 'prompts');
  assert.equal(row.reason, 'finished');
  assert.equal(row.topAnswer.answer, 'R1 ANSWER 0');
});

test('when the last holdout leaves, the ballot starts', () => {
  const { api, sessionId, players } = startedGame();
  assert.equal(answer(api, sessionId, players[0].id, 'ANSWER 0').ok, true);
  assert.equal(answer(api, sessionId, players[1].id, 'ANSWER 1').ok, true);
  assert.equal(api.getById(sessionId).phase, 'round');
  api.leave({ sessionId, playerId: players[2].id });
  assert.equal(api.getById(sessionId).phase, 'voting');
});

test('a latecomer watches the round out and writes from the next one', () => {
  const { api, invited, sessionId, players, advance } = startedGame();
  const late = api.join({ code: invited.code, name: 'Nico' });
  assert.equal(late.ok, true);
  assert.equal(late.player.seated, false);

  const blocked = answer(api, sessionId, late.player.id, 'TOO LATE');
  assert.equal(blocked.ok, false);

  players.forEach((player, index) => answer(api, sessionId, player.id, `ANSWER ${index}`));
  advance(16);
  advance(6);
  assert.equal(answer(api, sessionId, late.player.id, 'RIGHT ON TIME').ok, true);
});
