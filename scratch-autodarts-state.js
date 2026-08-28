const { matchFromState } = require('./src/autodarts-live');
const { buildMatchPayload } = require('./src/autodarts-payload');

// Shaped from the fields darts-caller reads off the real `<matchId>.state`
// message: m['player'], m['players'], m['gameScores'], m['turns'][0].throws,
// m['winner'], m['gameWinner'], m['leg'], m['set'], m['settings'][baseScore].
function seg(name, bed, multiplier, number) {
  return { name, bed, multiplier, number };
}

function state(throws, { points = 0, gameScores = [121, 121], player = 0, winner = -1, gameWinner = -1 } = {}) {
  return {
    id: '01a045d6-d0b5-7757-8d8e-a617adc03345',
    variant: 'X01',
    player,
    players: [
      { index: 0, name: 'trashpanda', userId: 'bd4aab98', boardId: 'b1', host: true, cpuPPR: null },
      { index: 1, name: 'war d', userId: 'ff01', boardId: null, host: false, cpuPPR: null },
    ],
    gameScores,
    leg: 1,
    set: 1,
    winner,
    gameWinner,
    settings: { baseScore: 121, inMode: 'Straight', outMode: 'Straight', bullMode: '25/50', maxRounds: 50 },
    turns: [{
      id: 'turn-1',
      createdAt: '2026-08-28T00:49:00Z',
      throws,
      points,
      busted: false,
    }],
    scores: [],
  };
}

const throw1 = { id: 't1', createdAt: 'x', segment: seg('T20', 'Triple', 3, 20), coords: { x: 0.1, y: -0.3 } };
const throw2 = { id: 't2', createdAt: 'x', segment: seg('S1', 'SingleOuter', 1, 1), coords: { x: 0.2, y: 0.1 } };
const throw3 = { id: 't3', createdAt: 'x', segment: seg('D20', 'Double', 2, 20), coords: { x: 0.05, y: -0.5 } };

const steps = [
  ['turn start (no darts)', state([], { points: 0 })],
  ['after dart 1 (T20)', state([throw1], { points: 60 })],
  ['after dart 2 (S1)', state([throw1, throw2], { points: 61 })],
  ['after dart 3 (D20)', state([throw1, throw2, throw3], { points: 101 })],
  ['dart 2 corrected to T20', state([throw1, { ...throw2, segment: seg('T20', 'Triple', 3, 20) }, throw3], { points: 160 })],
];

let previous = null;
for (const [label, raw] of steps) {
  const mapped = matchFromState(raw.id, raw, {}, 1);
  const body = buildMatchPayload(mapped, { persistent: true, status: 'live' });
  const m = body.match;
  const line = JSON.stringify({
    scores: m.players.map((p) => `${p.name}:${p.score}`),
    turnPoints: m.turn.points,
    darts: m.turn.darts.map((d) => (d ? d.seg : '-')),
    currentPlayerIndex: m.currentPlayerIndex,
  });
  const changed = previous === null ? 'first' : (line === previous ? 'IDENTICAL' : 'changed');
  console.log(`${label.padEnd(28)} ${changed.padEnd(10)} ${line}`);
  previous = line;
}
