const { createAutodartsLive } = require('./src/autodarts-live');
const { buildMatchPayload, buildMatchClosePayload } = require('./src/autodarts-payload');

const MATCH_ID = '01a045d6-d0b5-7757-8d8e-a617adc03345';
const BOARD_ID = '1ba2df53-9a04-51bc-9a5f-667b2c5f315f';

function dart(name, bed, mult, num, x, y) {
  return { id: `throw-${name}`, createdAt: 'x', segment: { name, bed, multiplier: mult, number: num }, coords: { x, y } };
}

function state({ turnId = 'turn-a', throws = [], points = 0, gameScores = [121], player = 0, winner = -1, gameWinner = -1 }) {
  return {
    id: MATCH_ID,
    variant: 'X01',
    player,
    players: [{ index: 0, name: 'trashpanda', userId: 'bd4a', boardId: BOARD_ID, host: true, cpuPPR: null }],
    gameScores,
    leg: 1,
    set: 1,
    winner,
    gameWinner,
    settings: { baseScore: 121, inMode: 'Straight', outMode: 'Straight', bullMode: '25/50', maxRounds: 50 },
    turns: [{ id: turnId, createdAt: 'x', throws, points, busted: false }],
  };
}

const sent = [];
const live = createAutodartsLive({
  auth: { getAccessToken: async () => 'token' },
  api: {
    getMatch: async () => ({ ok: true, json: { variant: 'X01', createdAt: '2026-08-28T00:48:35Z' } }),
    getMatchState: async () => ({ ok: true, json: state({}) }),
    getMatchStats: async () => ({ ok: false, status: 404 }),
  },
  credentials: { load: () => ({ boardId: BOARD_ID }) },
  settings: {
    get: () => ({
      live: { autoPush: true, inactivityMinutes: 15, finalHoldSeconds: 60 },
      lastMatch: { displaySeconds: 90 },
    }),
  },
  archive: { has: () => false, append: () => ({}), listAll: () => [] },
  aggregates: { recompute: () => {}, get: () => ({ players: [] }) },
  payload: {
    buildMatch: (m, o) => buildMatchPayload(m, o),
    buildClose: (id, r) => buildMatchClosePayload(id, r),
  },
  sendUdpPayload: (body) => sent.push(body),
  log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
  WebSocketImpl: null,
});

const t20 = dart('T20', 'Triple', 3, 20, 0.10, -0.30);
const s1 = dart('S1', 'SingleOuter', 1, 1, 0.20, 0.10);
const s20 = dart('S20', 'SingleInner', 1, 20, 0.06, -0.35);
const t20b = dart('T20b', 'Triple', 3, 20, 0.11, -0.31);
const d1 = dart('D1', 'Double', 2, 1, 0.30, 0.20);

function report(label, before) {
  const body = sent[sent.length - 1];
  const m = body?.match || {};
  const ghosts = (m.prevTurn?.darts || []).filter(Boolean).map((d) => d.seg).join('/') || 'none';
  console.log(
    `${label.padEnd(30)} push:${sent.length - before}  `
    + `remaining=${(m.players || []).map((p) => p.score).join(',')}  `
    + `turn=${String(m.turn?.points).padStart(3)}  `
    + `darts=${(m.turn?.darts || []).map((d) => (d ? d.seg : '-')).join('/').padEnd(14)} `
    + `ghosts=${ghosts}`,
  );
}

function feed(label, raw) {
  const before = sent.length;
  live.ingestEvent({ channel: 'autodarts.matches', topic: `${MATCH_ID}.state`, data: raw });
  report(label, before);
}

async function main() {
  await live.forceSeed(MATCH_ID);
  console.log(`seed: ${sent.length} push\n--- turn one ---`);

  feed('dart 1  T20', state({ throws: [t20], points: 60 }));
  feed('dart 2  S1', state({ throws: [t20, s1], points: 61 }));
  feed('correct dart 2 -> T20', state({ throws: [t20, t20b], points: 120 }));
  feed('dart 3  S20', state({ throws: [t20, t20b, s20], points: 140 }));
  feed('correct all three', state({ throws: [s20, s20, s20], points: 60 }));

  console.log('--- a throw event with no state in it ---');
  const before = sent.length;
  live.ingestEvent({ channel: 'autodarts.matches', topic: `${MATCH_ID}.events`, data: { id: MATCH_ID, event: 'throw' } });
  report('bare throw event', before);

  console.log('--- next turn ---');
  feed('turn two opens', state({ turnId: 'turn-b', throws: [], points: 0, gameScores: [61] }));
  feed('dart 1  D1', state({ turnId: 'turn-b', throws: [d1], points: 2 }));

  console.log(`\ntotal pushes: ${sent.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
