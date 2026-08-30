'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createGameSessions, CODE_ALPHABET } = require('../src/games/sessions');
const { createGameArchive } = require('../src/games/archive');

const SETTINGS = Object.freeze({
  lobbySeconds: 10,
  roundSeconds: 20,
  intermissionSeconds: 5,
  rounds: 3,
  inviteTtlMinutes: 1,
  idleTimeoutSeconds: 15,
  maxPlayers: 12,
  minSolutions: 1,
  duplicateRule: 'everyone',
  preferredAlias: 'WITTYGAME',
});

function fakeGame() {
  return {
    id: 'scramble',
    title: 'Word Scramble',
    source: 'word.scramble',
    createRound: () => ({
      grid: ['CATE', 'ORWX', 'WIND', 'LEAP'],
      solutions: ['cat', 'wind', 'leap'],
    }),
    validateAction: (_round, action, payload) => {
      const word = String(payload?.word || '').toLowerCase();
      if (action !== 'word') return { ok: false, reason: 'unknown-action' };
      if (['cat', 'wind', 'leap', 'scrambled'].includes(word)) {
        return { ok: true, word, points: 1 };
      }
      return { ok: false, reason: 'not-a-word' };
    },
    scoreRound: (players) => players.map((player) => ({
      id: player.id,
      score: (player.words || []).length,
      words: player.words || [],
    })),
  };
}

function makeApi(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'games-'));
  let nowMs = Date.parse('2026-08-30T18:00:00Z');
  const pushes = [];
  const archive = createGameArchive({ ROOT: root, gameArchivePath: path.join(root, 'archive') });
  const api = createGameSessions({ ROOT: root }, { warn() {}, info() {} }, {
    now: () => nowMs,
    random: (() => {
      let i = 0;
      return () => {
        i += 1;
        return (i % 17) / 17;
      };
    })(),
    gameSettings: { get: () => ({ ...SETTINGS, ...overrides }) },
    archive,
    gameOf: () => fakeGame(),
    getShortlink: () => ({ alias: 'WITTYGAME' }),
    pushBoard: (payload, options) => {
      pushes.push({ payload, options });
      return { boards: [] };
    },
  });
  return {
    api,
    archive,
    pushes,
    advance(seconds) {
      nowMs += seconds * 1000;
      api.tick(nowMs);
    },
    now: () => nowMs,
  };
}

test('codes are unique 4-letter pins from the unambiguous alphabet', () => {
  const { api } = makeApi();
  const first = api.create();
  const second = api.create();
  assert.equal(first.code.length, 4);
  assert.equal(second.code.length, 4);
  assert.notEqual(first.code, second.code);
  assert.match(first.code, new RegExp(`^[${CODE_ALPHABET}]{4}$`));
  assert.doesNotMatch(first.code, /[IO01]/);
});

test('join starts the lobby and a late arrival sits out the current round', () => {
  const { api, advance } = makeApi();
  const invited = api.create();
  const luis = api.join({ code: invited.code, name: 'Luis' });
  assert.equal(luis.ok, true);
  assert.equal(luis.session.phase, 'lobby');
  assert.equal(luis.player.seated, true);

  advance(11);
  const live = api.getByCode(invited.code);
  assert.equal(live.phase, 'round');

  const ada = api.join({ code: invited.code, name: 'Ada' });
  assert.equal(ada.ok, true);
  assert.equal(ada.player.seated, false);
  const blocked = api.submit({
    sessionId: live.id,
    playerId: ada.player.id,
    payload: { word: 'cat' },
  });
  assert.equal(blocked.ok, false);

  const word = api.submit({
    sessionId: live.id,
    playerId: luis.player.id,
    payload: { word: 'cat' },
  });
  assert.equal(word.ok, true);
  assert.equal(word.word, 'cat');
});

test('the phase machine walks lobby, three rounds, intermission, final, then archives', () => {
  const { api, archive, advance, pushes } = makeApi();
  const invited = api.create();
  assert.equal(pushes[0].options.breakHold, true);
  assert.equal(pushes[0].options.explicit, true);
  assert.equal(pushes[0].options.replaceSource, 'word.scramble');

  api.join({ code: invited.code, name: 'Luis' });
  const sink = { write() {}, end() {} };
  api.subscribe(invited.sessionId, sink);
  advance(11);
  assert.equal(api.getByCode(invited.code).phase, 'round');
  assert.ok(pushes.some((row) => row.payload.card === 'round' && row.payload.holdSeconds === 20));

  advance(21);
  assert.equal(api.getByCode(invited.code).phase, 'intermission');
  advance(6);
  assert.equal(api.getByCode(invited.code).phase, 'round');
  advance(21);
  assert.equal(api.getByCode(invited.code).phase, 'intermission');
  advance(6);
  assert.equal(api.getByCode(invited.code).phase, 'round');
  advance(21);
  const final = api.getByCode(invited.code);
  assert.equal(final.phase, 'final');
  advance(6);
  assert.equal(api.getByCode(invited.code), null);
  assert.equal(archive.count(), 1);
  const row = archive.listAll()[0];
  assert.equal(row.abandoned, false);
  assert.equal(row.reason, 'finished');
  assert.equal(row.rounds, 3);
});

test('idle timeout closes a started game and archives it as abandoned', () => {
  const { api, archive, advance } = makeApi();
  const invited = api.create();
  api.join({ code: invited.code, name: 'Luis' });
  advance(16);
  assert.equal(api.getByCode(invited.code), null);
  const row = archive.listAll()[0];
  assert.equal(row.abandoned, true);
  assert.equal(row.reason, 'idle');
});

test('an untouched invite expires without counting as a played game heartbeat', () => {
  const { api, archive, advance } = makeApi();
  const invited = api.create();
  advance(61);
  assert.equal(api.getByCode(invited.code), null);
  const row = archive.listAll()[0];
  assert.equal(row.reason, 'invite-expired');
  assert.equal(row.abandoned, true);
});

test('turning late joining off closes the door once the lobby breaks', () => {
  const { api, advance } = makeApi({ allowLateJoin: false });
  const invited = api.create();
  const luis = api.join({ code: invited.code, name: 'Luis' });
  assert.equal(luis.ok, true);
  assert.equal(luis.session.allowLateJoin, false);

  advance(11);
  assert.equal(api.getByCode(invited.code).phase, 'round');
  const ada = api.join({ code: invited.code, name: 'Ada' });
  assert.equal(ada.ok, false);
  assert.match(ada.error, /already started/);

  // A player who is already in keeps their seat on a page refresh.
  const again = api.join({ code: invited.code, name: 'Luis', playerId: luis.player.id });
  assert.equal(again.ok, true);
});

test('the board carries the round and the code while phones may still join', () => {
  const { api, advance, pushes } = makeApi();
  const invited = api.create();
  api.join({ code: invited.code, name: 'Luis' });
  advance(11);

  const round = pushes.filter((row) => row.payload.card === 'round').pop();
  assert.equal(round.payload.roundIndex, 1);
  assert.equal(round.payload.rounds, 3);
  assert.equal(round.payload.showCode, true);
  assert.equal(round.payload.code, invited.code);

  const shut = makeApi({ allowLateJoin: false });
  const closed = shut.api.create();
  shut.api.join({ code: closed.code, name: 'Luis' });
  shut.advance(11);
  const quiet = shut.pushes.filter((row) => row.payload.card === 'round').pop();
  assert.equal(quiet.payload.showCode, false);
});

test('a stream only ever carries the words that watcher found', () => {
  const { api, advance } = makeApi();
  const invited = api.create();
  const luis = api.join({ code: invited.code, name: 'Luis' });
  const ada = api.join({ code: invited.code, name: 'Ada' });
  const seen = { luis: [], ada: [] };
  const sink = (bucket) => ({ write: (line) => seen[bucket].push(line), end() {} });
  api.subscribe(invited.sessionId, sink('luis'), luis.player.id);
  api.subscribe(invited.sessionId, sink('ada'), ada.player.id);

  advance(11);
  const live = api.getByCode(invited.code);
  api.submit({ sessionId: live.id, playerId: luis.player.id, payload: { word: 'cat' } });

  const last = (bucket) => JSON.parse(seen[bucket].pop().split('data: ')[1]).session;
  assert.deepEqual(last('luis').you.words, [{ word: 'cat', points: 1 }]);
  assert.deepEqual(last('ada').you.words, [], 'nobody sees another phone list mid-round');
  assert.equal(last('ada').you.name, 'Ada');
});

test('the reveal between rounds lists every word and who found it', () => {
  const { api, advance } = makeApi();
  const invited = api.create();
  const luis = api.join({ code: invited.code, name: 'Luis' });
  const ada = api.join({ code: invited.code, name: 'Ada' });
  api.subscribe(invited.sessionId, { write() {}, end() {} }, luis.player.id);
  advance(11);
  const live = api.getByCode(invited.code);
  api.submit({ sessionId: live.id, playerId: luis.player.id, payload: { word: 'cat' } });
  api.submit({ sessionId: live.id, playerId: ada.player.id, payload: { word: 'cat' } });
  const long = api.submit({
    sessionId: live.id,
    playerId: ada.player.id,
    payload: { word: 'scrambled' },
  });
  assert.deepEqual(long.words.map((row) => row.word), ['cat', 'scrambled']);

  advance(21);
  const paused = api.publicSession(api.getByCode(invited.code), ada.player.id);
  assert.equal(paused.phase, 'intermission');
  assert.equal(paused.lastRound.index, 1);
  assert.deepEqual(paused.lastRound.words, [
    { word: 'scrambled', points: 15, names: ['Ada'] },
    { word: 'cat', points: 1, names: ['Luis', 'Ada'] },
  ]);

  // During the next round the reveal is put away again.
  advance(6);
  assert.equal(api.publicSession(api.getByCode(invited.code)).lastRound, null);
});

test('end archives the session as abandoned', () => {
  const { api, archive } = makeApi();
  const invited = api.create();
  api.join({ code: invited.code, name: 'Luis' });
  assert.equal(api.end(invited.sessionId).ok, true);
  assert.equal(api.getById(invited.sessionId), null);
  assert.equal(archive.listAll()[0].reason, 'ended');
});
