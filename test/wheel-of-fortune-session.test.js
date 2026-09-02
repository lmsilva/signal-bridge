'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createGameSessions } = require('../src/games/sessions');
const { createGameArchive } = require('../src/games/archive');
const wheelMode = require('../src/games/modes/wheel');

const SETTINGS = Object.freeze({
  lobbySeconds: 10,
  turnSeconds: 15,
  roundSeconds: 120,
  intermissionSeconds: 5,
  rounds: 2,
  inviteTtlMinutes: 1,
  idleTimeoutSeconds: 120,
  maxPlayers: 8,
  minPlayers: 2,
  allowLateJoin: true,
  preferredAlias: 'WITTYGAME',
});

const DECK = [
  { category: 'PHRASE', puzzle: 'HAVE A NICE DAY' },
  { category: 'PLACE', puzzle: 'GRAND CANYON' },
];

function fixedDeckMode() {
  return {
    ...wheelMode,
    createRound({ session }) {
      const used = session?.usedRounds || [];
      const pick = DECK.find((row) => !used.includes(`${row.category}|${row.puzzle}`)) || DECK[0];
      return {
        puzzle: pick.puzzle,
        category: pick.category,
        revealed: new Set(),
        called: new Set(),
        banks: new Map(),
        freeSpins: new Map(),
        order: [],
        currentPlayerId: '',
        step: 'spin',
        wedge: null,
        spin: null,
        spins: 0,
        lastEvent: '',
        solvedBy: null,
        startedAt: 0,
      };
    },
  };
}

function makeApi(overrides = {}, deps = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wheel-'));
  let nowMs = Date.parse('2026-09-01T18:00:00Z');
  const pushes = [];
  const archive = createGameArchive({ ROOT: root, gameArchivePath: path.join(root, 'archive') });
  const api = createGameSessions({ ROOT: root }, { warn() {}, info() {} }, {
    now: () => nowMs,
    random: typeof deps.random === 'function' ? deps.random : () => 0,
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

function startedGame(names = ['Luis', 'Ada']) {
  const harness = makeApi();
  const invited = harness.api.create({ gameType: 'wheel' });
  const players = names.map((name) => harness.api.join({ code: invited.code, name }).player);
  harness.advance(11);
  return { ...harness, invited, players, sessionId: invited.sessionId };
}

test('a lobby that never reaches two players ends and says why', () => {
  const { api, archive, advance, pushes } = makeApi();
  const invited = api.create({ gameType: 'wheel' });
  api.join({ code: invited.code, name: 'Luis' });
  advance(11);
  assert.equal(api.getByCode(invited.code), null, 'one person is not a game');
  const last = pushes[pushes.length - 1];
  assert.equal(last.payload.card, 'short');
  assert.equal(last.payload.minPlayers, 2);
  assert.equal(archive.listAll()[0].reason, 'not-enough-players');
});

test('the second player is enough to deal the first puzzle', () => {
  const { api, invited, pushes } = startedGame();
  const live = api.getByCode(invited.code);
  assert.equal(live.phase, 'round');
  const round = pushes.filter((row) => row.payload.card === 'round').pop();
  assert.equal(round.payload.puzzle, 'HAVE A NICE DAY');
  assert.equal(round.payload.category, 'PHRASE');
  assert.equal(round.payload.source, 'wheel.fortune');
});

test('a spin of 500 then an R that is not there passes the turn', () => {
  const { api, sessionId, players, pushes } = startedGame();
  const [luis, ada] = players;
  const spin = api.submit({ sessionId, playerId: luis.id, action: 'spin' });
  assert.equal(spin.ok, true);
  assert.equal(spin.wedge.value, 500);
  const miss = api.submit({
    sessionId,
    playerId: luis.id,
    action: 'letter',
    payload: { letter: 'R' },
  });
  assert.equal(miss.ok, true);
  assert.equal(miss.hits, 0);
  const live = api.publicSession(api.getById(sessionId), ada.id);
  assert.equal(live.you.yourTurn, true, 'Ada is up after a miss');
  const board = pushes[pushes.length - 1].payload;
  assert.match(board.lastEvent, /NO R/);
});

test('a hit pays the wedge times the count and only the solver banks', () => {
  const { api, sessionId, players } = startedGame();
  const [luis] = players;
  api.submit({ sessionId, playerId: luis.id, action: 'spin' });
  const hit = api.submit({
    sessionId,
    playerId: luis.id,
    action: 'letter',
    payload: { letter: 'N' },
  });
  assert.equal(hit.ok, true);
  assert.equal(hit.hits, 1);
  const live = api.publicSession(api.getById(sessionId), luis.id);
  assert.equal(live.you.bank, 500);
  assert.equal(live.you.canSpin, true);
  assert.equal(live.you.canVowel, true);

  const solved = api.submit({
    sessionId,
    playerId: luis.id,
    action: 'solve',
    payload: { solve: 'HAVE A NICE DAY' },
  });
  assert.equal(solved.ok, true);
  const after = api.getById(sessionId);
  assert.equal(after.phase, 'intermission');
  const luisRow = after.players.find((p) => p.id === luis.id);
  assert.equal(luisRow.score, 1000);
  const adaRow = after.players.find((p) => p.id !== luis.id);
  assert.equal(adaRow.score, 0);
});

test('a turn timeout passes the wheel without ending the puzzle', () => {
  const { api, sessionId, players, advance } = startedGame();
  const [, ada] = players;
  advance(16);
  const live = api.publicSession(api.getById(sessionId), ada.id);
  assert.equal(live.phase, 'round');
  assert.equal(live.you.yourTurn, true);
  assert.equal(live.puzzle || live.mask.includes('_'), true);
});

test('the board lock source is wheel.fortune for every live card', () => {
  const { pushes } = startedGame();
  assert.ok(pushes.every((row) => row.payload.source === 'wheel.fortune'));
  assert.ok(pushes.some((row) => row.options.gameSource === 'wheel.fortune'));
});

test('a late joiner sits out the current puzzle', () => {
  const { api, invited, sessionId } = startedGame();
  const late = api.join({ code: invited.code, name: 'Mo' });
  assert.equal(late.ok, true);
  assert.equal(late.player.seated, false);
  const blocked = api.submit({ sessionId, playerId: late.player.id, action: 'spin' });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /next round/i);
});

test('bankrupt zeros the round bank and passes the turn', () => {
  const harness = makeApi({}, { random: () => 0.8 });
  const invited = harness.api.create({ gameType: 'wheel' });
  const luis = harness.api.join({ code: invited.code, name: 'Luis' }).player;
  const ada = harness.api.join({ code: invited.code, name: 'Ada' }).player;
  harness.advance(11);
  const spin = harness.api.submit({ sessionId: invited.sessionId, playerId: luis.id, action: 'spin' });
  assert.equal(spin.ok, true);
  assert.equal(spin.session.lastEvent.includes('BANKRUPT'), true);
  const live = harness.api.publicSession(harness.api.getById(invited.sessionId), ada.id);
  assert.equal(live.you.yourTurn, true);
  const luisView = harness.api.publicSession(harness.api.getById(invited.sessionId), luis.id);
  assert.equal(luisView.you.bank, 0);
});

test('one wheel, one thrower: the player who is not up cannot spin', () => {
  const { api, sessionId, players } = startedGame();
  const [luis, ada] = players;
  const before = api.publicSession(api.getById(sessionId), ada.id);
  assert.equal(before.you.canSpin, false, 'the phone that is not up gets no button');

  const blocked = api.submit({ sessionId, playerId: ada.id, action: 'spin' });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /wait your turn/i);
  assert.equal(api.publicSession(api.getById(sessionId), ada.id).spin, null, 'a refused spin never moves the wheel');

  // The turn ends the moment the throw resolves, not when the clock runs out.
  api.submit({ sessionId, playerId: luis.id, action: 'spin' });
  api.submit({ sessionId, playerId: luis.id, action: 'letter', payload: { letter: 'R' } });
  const now = api.publicSession(api.getById(sessionId), luis.id);
  assert.equal(now.turnPlayerId, ada.id);
  assert.equal(now.you.canSpin, false, 'the player who just missed is done');
  const refused = api.submit({ sessionId, playerId: luis.id, action: 'spin' });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /wait your turn/i);
});

test('the wheel travels to every phone with the wedge it landed on', () => {
  const { api, sessionId, players } = startedGame();
  const [luis, ada] = players;
  const idle = api.publicSession(api.getById(sessionId), ada.id);
  assert.equal(idle.wheel.length, 20, 'the painted wheel is the wheel we spin');
  assert.equal(idle.wheel[0].label, '500');
  assert.ok(idle.wheel.some((wedge) => wedge.type === 'bankrupt'));

  api.submit({ sessionId, playerId: luis.id, action: 'spin' });
  const watcher = api.publicSession(api.getById(sessionId), ada.id);
  assert.equal(watcher.spin.id, 1);
  assert.equal(watcher.spin.index, 0, 'the phone animates to the wedge the server chose');
  assert.equal(watcher.wheel[watcher.spin.index].value, 500);

  // A repaint is not a new throw, so the wheel does not spin twice.
  assert.equal(api.publicSession(api.getById(sessionId), ada.id).spin.id, 1);
  api.submit({ sessionId, playerId: luis.id, action: 'letter', payload: { letter: 'R' } });
  api.submit({ sessionId, playerId: ada.id, action: 'spin' });
  assert.equal(api.publicSession(api.getById(sessionId), luis.id).spin.id, 2);
});

test('leaving on your turn hands the wheel to the next player', () => {
  const { api, sessionId, players } = startedGame();
  const [luis, ada] = players;
  api.leave({ sessionId, playerId: luis.id });
  const live = api.publicSession(api.getById(sessionId), ada.id);
  assert.equal(live.you.yourTurn, true);
  assert.equal(live.phase, 'round');
});
