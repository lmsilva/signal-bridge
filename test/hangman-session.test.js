'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createGameSessions } = require('../src/games/sessions');
const { createGameArchive } = require('../src/games/archive');
const hangmanMode = require('../src/games/modes/hangman');
const { LIVES } = require('../src/hangman');

const SETTINGS = Object.freeze({
  lobbySeconds: 10,
  turnSeconds: 15,
  pickSeconds: 20,
  roundSeconds: 120,
  intermissionSeconds: 5,
  rounds: 2,
  inviteTtlMinutes: 1,
  idleTimeoutSeconds: 120,
  maxPlayers: 8,
  minPlayers: 1,
  allowLateJoin: true,
  wordSetter: true,
  categoryId: 'all',
  preferredAlias: 'WITTYGAME',
});

const DECK = [
  { category: 'ANIMALS', word: 'BADGER' },
  { category: 'FOOD AND DRINK', word: 'WAFFLE' },
  { category: 'NATURE', word: 'CANYON' },
];

/**
 * The real mode with a two-word deck bolted on, so a test can name the
 * letters it is about to call. Everything else — the setter seat, the turn
 * order, the lives — is the shipped code.
 */
function fixedDeckMode(deck = DECK) {
  return {
    ...hangmanMode,
    createRound(args) {
      const state = hangmanMode.createRound(args);
      const used = args.session?.usedRounds || [];
      if (state.word) {
        // Forget the word the shipped deck dealt; the engine records ours.
        const at = used.indexOf(`${state.category}|${state.word}`);
        if (at >= 0) used.splice(at, 1);
      }
      if (state.step === 'pick') {
        state.choices = deck.slice(0, 3).map((row) => ({ ...row }));
        return state;
      }
      const pick = deck.find((row) => !used.includes(`${row.category}|${row.word}`)) || deck[0];
      state.word = pick.word;
      state.category = pick.category;
      return state;
    },
  };
}

function makeApi(overrides = {}, deps = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hangman-'));
  let nowMs = Date.parse('2026-09-02T18:00:00Z');
  const pushes = [];
  const archive = createGameArchive({ ROOT: root, gameArchivePath: path.join(root, 'archive') });
  const api = createGameSessions({ ROOT: root }, { warn() {}, info() {} }, {
    now: () => nowMs,
    random: typeof deps.random === 'function' ? deps.random : () => 0,
    gameSettings: { get: () => ({ ...SETTINGS, ...overrides }) },
    archive,
    gameOf: () => fixedDeckMode(deps.deck),
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

function startedGame(names = ['Luis'], overrides = {}, deps = {}) {
  const harness = makeApi(overrides, deps);
  const invited = harness.api.create({ gameType: 'hangman' });
  const players = names.map((name) => harness.api.join({ code: invited.code, name }).player);
  harness.advance(11);
  return { ...harness, invited, players, sessionId: invited.sessionId };
}

function letter(api, sessionId, playerId, ch) {
  return api.submit({ sessionId, playerId, action: 'letter', payload: { letter: ch } });
}

test('one player and the house is a whole game of Hangman', () => {
  const { api, sessionId, pushes } = startedGame(['Luis']);
  const live = api.getById(sessionId);
  assert.equal(live.phase, 'round', 'nobody waits for a second phone');
  const round = pushes.filter((row) => row.payload.card === 'round').pop();
  assert.equal(round.payload.category, 'ANIMALS');
  assert.equal(round.payload.mask, '______');
  assert.equal(round.payload.livesLeft, LIVES);
  assert.equal(round.payload.source, 'hangman.game');
  assert.equal(round.payload.setterName, '', 'the house does not take a seat');
});

test('alone, the word is hidden from the one phone playing', () => {
  const { api, sessionId, players } = startedGame(['Luis']);
  const view = api.publicSession(api.getById(sessionId), players[0].id);
  assert.equal(view.word, '', 'the answer never rides along in the payload');
  assert.equal(view.mask, '______');
  assert.equal(view.you.yourTurn, true);
  assert.equal(view.you.isSetter, false);
  assert.equal(view.livesLeft, LIVES);
});

test('a right letter keeps the turn and pays per flap', () => {
  const { api, sessionId, players } = startedGame(['Luis', 'Ada'], { wordSetter: false });
  const [luis] = players;
  const hit = letter(api, sessionId, luis.id, 'B');
  assert.equal(hit.ok, true);
  assert.equal(hit.hits, 1);
  assert.equal(hit.points, 10);
  const view = api.publicSession(api.getById(sessionId), luis.id);
  assert.equal(view.you.yourTurn, true, 'a run is the fun of it');
  assert.equal(view.mask, 'B_____');
  assert.equal(view.you.points, 10);
  assert.equal(view.livesLeft, LIVES);
});

test('a miss costs a life and hands the turn on', () => {
  const { api, sessionId, players, pushes } = startedGame(['Luis', 'Ada'], { wordSetter: false });
  const [luis, ada] = players;
  const miss = letter(api, sessionId, luis.id, 'Z');
  assert.equal(miss.ok, true);
  assert.equal(miss.hits, 0);
  assert.equal(miss.livesLeft, LIVES - 1);
  const view = api.publicSession(api.getById(sessionId), ada.id);
  assert.equal(view.you.yourTurn, true);
  assert.deepEqual(view.misses, ['Z']);
  assert.equal(api.publicSession(api.getById(sessionId), luis.id).you.yourTurn, false);
  const board = pushes[pushes.length - 1].payload;
  assert.equal(board.lastEvent, 'NO Z');
  assert.equal(board.livesLeft, LIVES - 1);
});

test('the same letter is never called twice, and only the player up may call', () => {
  const { api, sessionId, players } = startedGame(['Luis', 'Ada'], { wordSetter: false });
  const [luis, ada] = players;
  assert.equal(letter(api, sessionId, ada.id, 'B').ok, false);
  assert.match(letter(api, sessionId, ada.id, 'B').error, /wait your turn/i);
  letter(api, sessionId, luis.id, 'B');
  const again = letter(api, sessionId, luis.id, 'B');
  assert.equal(again.ok, false);
  assert.match(again.error, /already called/i);
});

test('the last letter of the word ends the round and pays the solve bonus', () => {
  const { api, sessionId, players } = startedGame(['Luis'], { wordSetter: false });
  const [luis] = players;
  for (const ch of ['B', 'A', 'D', 'G', 'E']) {
    assert.equal(letter(api, sessionId, luis.id, ch).ok, true);
  }
  const last = letter(api, sessionId, luis.id, 'R');
  assert.equal(last.ok, true);
  const after = api.getById(sessionId);
  assert.equal(after.phase, 'intermission');
  // Six letters at ten a flap, plus fifty and five a life still standing.
  assert.equal(after.players[0].score, 60 + 50 + LIVES * 5);
  assert.equal(after.lastRound.word, 'BADGER');
  assert.equal(after.lastRound.solvedBy, 'Luis');
});

test('saying the whole word wins it; saying the wrong one costs a life', () => {
  const { api, sessionId, players } = startedGame(['Luis', 'Ada'], { wordSetter: false });
  const [luis, ada] = players;
  const wrong = api.submit({ sessionId, playerId: luis.id, action: 'solve', payload: { solve: 'BEAVER' } });
  assert.equal(wrong.ok, true);
  assert.equal(wrong.livesLeft, LIVES - 1);
  assert.equal(api.publicSession(api.getById(sessionId), ada.id).you.yourTurn, true, 'a wild stab is never free');

  const right = api.submit({ sessionId, playerId: ada.id, action: 'solve', payload: { solve: 'badger' } });
  assert.equal(right.ok, true);
  const after = api.getById(sessionId);
  assert.equal(after.phase, 'intermission');
  const adaRow = after.players.find((p) => p.id === ada.id);
  const luisRow = after.players.find((p) => p.id === luis.id);
  assert.equal(adaRow.score, 50 + (LIVES - 1) * 5);
  assert.equal(luisRow.score, 0, 'only the phone that said it banks it');
});

test('six misses ends the round and the board still shows the word', () => {
  const { api, sessionId, players, pushes } = startedGame(['Luis'], { wordSetter: false });
  const [luis] = players;
  for (const ch of ['Z', 'X', 'Q', 'V', 'K', 'J']) {
    assert.equal(letter(api, sessionId, luis.id, ch).ok, true);
  }
  const after = api.getById(sessionId);
  assert.equal(after.phase, 'intermission');
  assert.equal(after.players[0].score, 0);
  assert.equal(after.lastRound.word, 'BADGER');
  assert.equal(after.lastRound.solvedBy, '');
  const card = pushes.filter((row) => row.payload.card === 'intermission').pop();
  assert.equal(card.payload.word, 'BADGER');
  assert.equal(card.payload.roundWinner, null);
});

test('with company, one phone sets the word and only that phone sees the menu', () => {
  const { api, sessionId, players, pushes } = startedGame(['Luis', 'Ada', 'Mo']);
  const [luis, ada] = players;
  const setterView = api.publicSession(api.getById(sessionId), luis.id);
  assert.equal(setterView.you.isSetter, true);
  assert.equal(setterView.you.canPick, true);
  assert.equal(setterView.you.choices.length, 3);
  assert.equal(setterView.step, 'pick');

  const guesserView = api.publicSession(api.getById(sessionId), ada.id);
  assert.equal(guesserView.you.choices.length, 0, 'a guesser reading the menu holds the answers');
  assert.equal(guesserView.category, '', 'even the hint waits for the word');
  assert.equal(guesserView.you.canPick, false);

  const board = pushes[pushes.length - 1].payload;
  assert.equal(board.step, 'pick');
  assert.equal(board.setterName, 'Luis');
  assert.equal(board.mask, '', 'there is nothing to mask yet');

  const early = letter(api, sessionId, ada.id, 'B');
  assert.equal(early.ok, false);
  assert.match(early.error, /still picking/i);
});

test('the word the setter picks starts the turns, and the setter sits them out', () => {
  const { api, sessionId, players } = startedGame(['Luis', 'Ada', 'Mo']);
  const [luis, ada, mo] = players;
  const set = api.submit({ sessionId, playerId: luis.id, action: 'pick', payload: { choice: 0 } });
  assert.equal(set.ok, true);
  assert.equal(set.word, 'BADGER');

  const live = api.publicSession(api.getById(sessionId), ada.id);
  assert.equal(live.step, 'guess');
  assert.equal(live.category, 'ANIMALS');
  assert.equal(live.mask, '______');
  assert.equal(live.turnName, 'Ada', 'the setter is not in the guessing order');
  assert.equal(live.you.yourTurn, true);

  const setterNow = api.publicSession(api.getById(sessionId), luis.id);
  assert.equal(setterNow.word, 'BADGER', 'the one phone that already knows may see it');
  assert.equal(setterNow.you.yourTurn, false);
  const blocked = letter(api, sessionId, luis.id, 'B');
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /you set this word/i);

  letter(api, sessionId, ada.id, 'Z');
  assert.equal(api.publicSession(api.getById(sessionId), mo.id).you.yourTurn, true, 'the turn skips the setter');
});

test('a word of their own has to be real, and their name becomes the hint', () => {
  const { api, sessionId, players } = startedGame(['Luis', 'Ada']);
  const [luis] = players;
  const made_up = api.submit({ sessionId, playerId: luis.id, action: 'pick', payload: { word: 'QWJXVZ' } });
  assert.equal(made_up.ok, false);
  assert.match(made_up.error, /dictionary/i);

  const tooShort = api.submit({ sessionId, playerId: luis.id, action: 'pick', payload: { word: 'CAT' } });
  assert.equal(tooShort.ok, false);

  const own = api.submit({ sessionId, playerId: luis.id, action: 'pick', payload: { word: 'otter' } });
  assert.equal(own.ok, true);
  assert.equal(own.word, 'OTTER');
  const live = api.publicSession(api.getById(sessionId), players[1].id);
  assert.equal(live.category, 'LUIS PICKED IT', 'everybody knows who to blame');
  assert.equal(live.mask, '_____');
});

test('only the setter may set, and nobody sets a second time', () => {
  const { api, sessionId, players } = startedGame(['Luis', 'Ada']);
  const [luis, ada] = players;
  const wrongPhone = api.submit({ sessionId, playerId: ada.id, action: 'pick', payload: { choice: 0 } });
  assert.equal(wrongPhone.ok, false);
  assert.match(wrongPhone.error, /luis/i);

  api.submit({ sessionId, playerId: luis.id, action: 'pick', payload: { choice: 0 } });
  const twice = api.submit({ sessionId, playerId: luis.id, action: 'pick', payload: { choice: 1 } });
  assert.equal(twice.ok, false);
  assert.match(twice.error, /already set/i);
});

test('the setter is paid for the misses they forced, once it is solved', () => {
  const { api, sessionId, players } = startedGame(['Luis', 'Ada']);
  const [luis, ada] = players;
  api.submit({ sessionId, playerId: luis.id, action: 'pick', payload: { choice: 0 } });
  letter(api, sessionId, ada.id, 'Z');
  letter(api, sessionId, ada.id, 'X');
  api.submit({ sessionId, playerId: ada.id, action: 'solve', payload: { solve: 'BADGER' } });
  const after = api.getById(sessionId);
  const luisRow = after.players.find((p) => p.id === luis.id);
  assert.equal(luisRow.score, 10, 'two misses at five a piece');
  assert.equal(after.best.word, 'BADGER');
  assert.equal(after.best.misses, 2);
  assert.equal(after.best.setter, 'Luis');
});

test('a word nobody guesses pays its setter nothing and is not the toughest', () => {
  const { api, sessionId, players } = startedGame(['Luis', 'Ada']);
  const [luis, ada] = players;
  api.submit({ sessionId, playerId: luis.id, action: 'pick', payload: { choice: 0 } });
  for (const ch of ['Z', 'X', 'Q', 'V', 'K', 'J']) letter(api, sessionId, ada.id, ch);
  const after = api.getById(sessionId);
  assert.equal(after.players.find((p) => p.id === luis.id).score, 0);
  assert.equal(after.best, null, 'an unguessable word was just too hard');
});

test('the setter seat rotates, so nobody sets two words running', () => {
  const { api, sessionId, players, advance } = startedGame(['Luis', 'Ada']);
  const [luis, ada] = players;
  assert.equal(api.getById(sessionId).rounds[0].setterName, 'Luis');
  api.submit({ sessionId, playerId: luis.id, action: 'pick', payload: { choice: 0 } });
  api.submit({ sessionId, playerId: ada.id, action: 'solve', payload: { solve: 'BADGER' } });
  advance(6);
  const live = api.getById(sessionId);
  assert.equal(live.phase, 'round');
  assert.equal(live.rounds[1].setterName, 'Ada');
});

test('a pick nobody makes falls to the house rather than a blank board', () => {
  const { api, sessionId, players, advance, pushes } = startedGame(['Luis', 'Ada']);
  advance(21);
  const live = api.getById(sessionId);
  assert.equal(live.phase, 'round', 'the round carries on');
  const view = api.publicSession(live, players[1].id);
  assert.equal(view.step, 'guess');
  assert.ok(view.mask.length >= 4);
  assert.equal(view.you.yourTurn, true, 'the setter still sits the round out');
  const board = pushes[pushes.length - 1].payload;
  assert.equal(board.lastEvent, 'HOUSE PICKS');
});

test('a turn that runs out of clock costs the turn, not a life', () => {
  const { api, sessionId, players, advance } = startedGame(['Luis', 'Ada'], { wordSetter: false });
  const [, ada] = players;
  advance(16);
  const view = api.publicSession(api.getById(sessionId), ada.id);
  assert.equal(view.phase, 'round');
  assert.equal(view.you.yourTurn, true);
  assert.equal(view.livesLeft, LIVES, 'the gallows is for guesses');
  assert.equal(view.lastEvent, 'TIMES UP');
});

test('the whole word has a wall clock, however long the turns take', () => {
  const { api, sessionId, advance } = startedGame(['Luis'], { wordSetter: false, roundSeconds: 40 });
  // Three quiet turns at fifteen seconds outlast a forty-second word.
  for (let i = 0; i < 3; i += 1) advance(15);
  const live = api.getById(sessionId);
  assert.equal(live.phase, 'intermission');
  assert.equal(live.lastRound.word, 'BADGER', 'the answer goes up either way');
});

test('the setter walking off before setting hands the word to the house', () => {
  const { api, sessionId, players, pushes } = startedGame(['Luis', 'Ada']);
  const [luis, ada] = players;
  api.leave({ sessionId, playerId: luis.id });
  const view = api.publicSession(api.getById(sessionId), ada.id);
  assert.equal(view.step, 'guess');
  assert.equal(view.setterName, '');
  assert.equal(view.you.yourTurn, true);
  assert.equal(pushes[pushes.length - 1].payload.lastEvent, 'HOUSE PICKS');
});

test('leaving on your turn hands it to the next phone', () => {
  const { api, sessionId, players } = startedGame(['Luis', 'Ada', 'Mo'], { wordSetter: false });
  const [luis, ada] = players;
  api.leave({ sessionId, playerId: luis.id });
  const view = api.publicSession(api.getById(sessionId), ada.id);
  assert.equal(view.phase, 'round');
  assert.equal(view.you.yourTurn, true);
});

test('a late joiner sits out the word already in play', () => {
  const { api, invited, sessionId } = startedGame(['Luis'], { wordSetter: false });
  const late = api.join({ code: invited.code, name: 'Mo' });
  assert.equal(late.ok, true);
  assert.equal(late.player.seated, false);
  const blocked = letter(api, sessionId, late.player.id, 'B');
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /next round/i);
});

test('an empty lobby ends the game and says why', () => {
  const { api, archive, advance, pushes } = makeApi({ minPlayers: 2 });
  const invited = api.create({ gameType: 'hangman' });
  api.join({ code: invited.code, name: 'Luis' });
  advance(11);
  assert.equal(api.getByCode(invited.code), null);
  const last = pushes[pushes.length - 1];
  assert.equal(last.payload.card, 'short');
  assert.equal(last.payload.minPlayers, 2);
  assert.equal(archive.listAll()[0].reason, 'not-enough-players');
});

test('every live card locks the board as hangman.game', () => {
  const { pushes } = startedGame(['Luis', 'Ada']);
  assert.ok(pushes.length);
  assert.ok(pushes.every((row) => row.payload.source === 'hangman.game'));
  assert.ok(pushes.some((row) => row.options.gameSource === 'hangman.game'));
});

test('a word does not come back later in the same night', () => {
  const { api, sessionId, players, advance } = startedGame(['Luis'], { wordSetter: false });
  const [luis] = players;
  api.submit({ sessionId, playerId: luis.id, action: 'solve', payload: { solve: 'BADGER' } });
  advance(6);
  const live = api.getById(sessionId);
  assert.equal(live.rounds[1].word, 'WAFFLE');
  assert.ok(live.usedRounds.includes('ANIMALS|BADGER'));
});
