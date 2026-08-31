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
  const locks = [];
  // Stands in for the board queue: pages other features are still waiting on.
  const queued = [
    { frame: { source: 'word.riddles' }, priority: 'snapshot' },
    { frame: { source: 'stock.market' }, priority: 'snapshot' },
    { frame: { source: 'ring.doorbell' }, priority: 'alert' },
    { frame: { source: 'word.scramble' }, priority: 'snapshot' },
  ];
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
    dropPendingBoard: (predicate) => {
      let dropped = 0;
      for (let i = queued.length - 1; i >= 0; i -= 1) {
        if (predicate(queued[i].frame, queued[i])) {
          queued.splice(i, 1);
          dropped += 1;
        }
      }
      return dropped;
    },
    setGameLock: (source, active) => locks.push({ source, active }),
  });
  return {
    api,
    archive,
    pushes,
    queued,
    locks,
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
  assert.equal(pushes[0].options.replaceCard, 'invite');
  assert.equal(pushes[0].options.gameSource, 'word.scramble');

  api.join({ code: invited.code, name: 'Luis' });
  const sink = { write() {}, end() {} };
  api.subscribe(invited.sessionId, sink);
  advance(11);
  assert.equal(api.getByCode(invited.code).phase, 'round');
  assert.ok(pushes.some((row) => row.payload.card === 'round' && row.payload.holdSeconds === 20));

  advance(21);
  assert.equal(api.getByCode(invited.code).phase, 'intermission');
  assert.ok(pushes.some((row) => row.payload.card === 'intermission'
    && row.options.replaceCard === 'intermission'
    && row.options.breakHold === false));
  advance(6);
  assert.equal(api.getByCode(invited.code).phase, 'round');
  advance(21);
  assert.equal(api.getByCode(invited.code).phase, 'intermission');
  advance(6);
  assert.equal(api.getByCode(invited.code).phase, 'round');
  advance(21);
  const final = api.getByCode(invited.code);
  assert.equal(final.phase, 'final');
  assert.ok(pushes.some((row) => row.payload.card === 'final'));
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

test('archived games can be forgotten one at a time or in a batch', () => {
  const { api, archive } = makeApi();
  const ids = [];
  for (const name of ['Luis', 'Ada', 'Sam']) {
    const invited = api.create();
    api.join({ code: invited.code, name });
    api.end(invited.sessionId);
    ids.push(invited.sessionId);
  }
  assert.equal(archive.listAll().length, 3);

  assert.deepEqual(api.forget(ids[0]), { ok: true, removed: 1 });
  assert.deepEqual(archive.listAll().map((row) => row.sessionId).sort(), [ids[1], ids[2]].sort());

  assert.deepEqual(api.forget([ids[1], ids[2], 'never-existed']), { ok: true, removed: 2 });
  assert.equal(archive.listAll().length, 0);
  assert.deepEqual(api.forget([]), { ok: true, removed: 0 });
});

test('a second Daddy joins as Daddy (2)', () => {
  const { api } = makeApi();
  const invited = api.create();
  const first = api.join({ code: invited.code, name: 'Daddy' });
  const second = api.join({ code: invited.code, name: 'daddy' });
  const third = api.join({ code: invited.code, name: 'Daddy Long-Legs' });
  assert.equal(first.player.name, 'Daddy');
  assert.equal(second.player.name, 'Daddy (2)');
  assert.equal(third.player.name, 'Daddy (3)');
  // A returning player keeps their seat rather than collecting another suffix.
  const again = api.join({ code: invited.code, name: 'Daddy', playerId: first.player.id });
  assert.equal(again.player.name, 'Daddy');
});

test('the scoreboard carries every player and moves as words land', () => {
  const { api, advance } = makeApi();
  const invited = api.create();
  const luis = api.join({ code: invited.code, name: 'Luis' });
  const ada = api.join({ code: invited.code, name: 'Ada' });

  // Nobody has scored yet, but both are already on the board.
  const waiting = api.publicSession(api.getByCode(invited.code));
  assert.deepEqual(waiting.scores.map((row) => [row.name, row.score]), [['Ada', 0], ['Luis', 0]]);

  advance(11);
  api.submit({
    sessionId: invited.sessionId,
    playerId: luis.player.id,
    payload: { word: 'scrambled' },
  });
  // Mid-round, before any round has been banked.
  const live = api.publicSession(api.getByCode(invited.code));
  assert.equal(live.phase, 'round');
  assert.deepEqual(live.scores.map((row) => [row.name, row.score]), [['Luis', 15], ['Ada', 0]]);
  assert.equal(ada.player.score, 0);
});

test('a starting game drops multi-page runs but keeps other queued pages', () => {
  const { api, queued } = makeApi();
  queued.push(
    { frame: { source: 'word.riddles' }, priority: 'snapshot', sequenceId: 's99' },
    { frame: { source: 'word.riddles' }, priority: 'snapshot', sequenceId: 's99' },
  );
  api.create();
  const sources = queued.map((item) => item.frame.source);
  assert.deepEqual(sources.sort(), [
    'ring.doorbell',
    'stock.market',
    'word.riddles',
    'word.scramble',
  ]);
});

test('the board is locked from the invite and released only when the game ends', () => {
  const { api, advance, locks } = makeApi();
  const invited = api.create();
  assert.deepEqual(locks[0], { source: 'word.scramble', active: true });

  api.join({ code: invited.code, name: 'Luis' });
  api.subscribe(invited.sessionId, { write() {}, end() {} });
  // Every phase card renews the lock; none of them lets it go mid-game.
  const seen = new Set();
  while (api.getByCode(invited.code)) {
    seen.add(api.getByCode(invited.code).phase);
    assert.equal(
      locks.some((row) => row.active === false),
      false,
      'the lock must survive lobby, rounds, intermissions and the final card',
    );
    advance(6);
  }
  assert.deepEqual([...seen].sort(), ['final', 'intermission', 'lobby', 'round']);
  assert.deepEqual(locks[locks.length - 1], { source: 'word.scramble', active: false });
});

test('an admin ending a session hands the board back', () => {
  const { api, locks } = makeApi();
  const invited = api.create();
  api.join({ code: invited.code, name: 'Luis' });
  api.end(invited.sessionId);
  assert.deepEqual(locks[locks.length - 1], { source: 'word.scramble', active: false });
});

test('leaving mid-round posts the live score, not a blank board', () => {
  const { api, advance, pushes } = makeApi();
  const invited = api.create();
  const luis = api.join({ code: invited.code, name: 'Luis' });
  advance(11);
  const live = api.getByCode(invited.code);
  api.submit({ sessionId: live.id, playerId: luis.player.id, payload: { word: 'cat' } });
  pushes.length = 0;
  api.leave({ sessionId: invited.sessionId, playerId: luis.player.id });
  const last = pushes[pushes.length - 1];
  assert.equal(last.payload.card, 'final');
  assert.equal(last.payload.scores[0].name, 'Luis');
  assert.ok(last.payload.scores[0].score > 0, 'open-round points must still show');
});

test('when the last player leaves the session closes on the scores', () => {
  const { api, pushes } = makeApi();
  const invited = api.create();
  const luis = api.join({ code: invited.code, name: 'Luis' });
  pushes.length = 0;
  api.leave({ sessionId: invited.sessionId, playerId: luis.player.id });
  assert.equal(api.getById(invited.sessionId), null);
  const last = pushes[pushes.length - 1];
  assert.equal(last.payload.card, 'final');
  assert.equal(last.payload.final, true);
  assert.equal(last.payload.showCode, false);
  assert.equal(last.payload.scores[0].name, 'Luis');
  assert.equal(last.options.replaceCard, 'final');
});

test('ending a session shows the scores instead of leaving the lobby up', () => {
  const { api, pushes } = makeApi();
  const invited = api.create();
  api.join({ code: invited.code, name: 'Luis' });
  pushes.length = 0;
  api.end(invited.sessionId);
  const last = pushes[pushes.length - 1];
  assert.equal(last.payload.card, 'final');
  assert.equal(last.payload.scores[0].name, 'Luis');
  assert.equal(last.options.replaceSource, 'word.scramble');
});

test('a finished game keeps the final scores instead of blanking the board', () => {
  const { api, advance, pushes } = makeApi();
  const invited = api.create();
  api.join({ code: invited.code, name: 'Luis' });
  api.subscribe(invited.sessionId, { write() {}, end() {} });
  advance(11);
  advance(21);
  advance(6);
  advance(21);
  advance(6);
  advance(21);
  assert.equal(api.getByCode(invited.code).phase, 'final');
  const before = pushes.filter((row) => row.payload.card === 'final').length;
  advance(6);
  assert.equal(api.getByCode(invited.code), null);
  assert.equal(
    pushes.filter((row) => row.payload.card === 'final').length,
    before,
    'closing after the final card must not flip the board again',
  );
  assert.equal(pushes.some((row) => row.payload.card === 'clear'), false);
});
