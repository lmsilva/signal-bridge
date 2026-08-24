const test = require('node:test');
const assert = require('node:assert/strict');

const { createRollCreditsPayload } = require('../src/roll-credits-payload');

function fixture() {
  const games = [
    {
      id: 'rc_new', title: 'Newest', system: 'ps5', beatenAt: '2026-08-20', induction: 3,
      media: [
        { id: 'v1', kind: 'video', path: 'rc_new/hero.mp4', status: 'ready', order: 0 },
        { id: 's1', kind: 'screenshot', path: 'rc_new/shot.jpg', thumbPath: 'rc_new/thumbs/shot.jpg', status: 'ready', order: 0 },
        { id: 'c1', kind: 'cover', path: 'rc_new/cover.jpg', status: 'ready', order: 0 },
      ],
    },
    { id: 'rc_old', title: 'Oldest', system: 'snes', beatenAt: '2025-01-01', induction: 1, media: [] },
    { id: 'rc_mid', title: 'Middle', system: 'pc', beatenAt: '2026-02-01', induction: 2, media: [] },
  ];
  const settings = {
    mediaPriority: ['video', 'screenshot', 'cover'],
    display: { secondsPerGame: 12, dashboardSeconds: 25, order: 'recent', scheduledGameLimit: 2 },
  };
  const service = {
    store: {
      getAllGames: () => JSON.parse(JSON.stringify(games)),
      getSystemById: (id) => ({ id, label: id.toUpperCase() }),
    },
    media: { publicUrl: (path) => `/roll-credits-media/${path}` },
    getSettings: () => JSON.parse(JSON.stringify(settings)),
    getStats: () => ({
      total: 3, thisYear: 2, systemsCount: 3, latest: JSON.parse(JSON.stringify(games[0])),
      months: [], bySystem: [], undatedCount: 0,
    }),
    getGame: (id) => JSON.parse(JSON.stringify(games.find((game) => game.id === id) || null)),
  };
  return { service, settings };
}

test('tour start is small and scheduled limits apply', () => {
  const { service } = fixture();
  const tours = createRollCreditsPayload({
    rollCredits: service,
    config: {},
    now: () => Date.parse('2026-08-23T18:00:00Z'),
  });
  const payload = tours.buildTourStart({ loop: false, baseUrl: 'https://bridge:47810' });
  assert.equal(payload.type, 'roll-credits.tour');
  assert.equal(payload.count, 3);
  assert.equal(payload.walkedCount, 2);
  assert.equal(payload.loop, false);
  assert.equal(payload.displaySeconds, 25 + 2 * 12 + 4);
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) < 16_000);
  const playlist = tours.getPlaylist(payload.tourId);
  assert.deepEqual(playlist.games.map((game) => game.id), ['rc_new', 'rc_mid']);
});

test('explicit game limit wins and manual tours otherwise include all games', () => {
  const { service } = fixture();
  const tours = createRollCreditsPayload({ rollCredits: service });
  assert.equal(tours.buildTourStart({ loop: true }).walkedCount, 3);
  assert.equal(tours.buildTourStart({ loop: true, gameLimit: 1 }).walkedCount, 1);
  assert.equal(tours.buildTourStart({ loop: false, gameLimit: 1 }).walkedCount, 1);
});

test('display cards prefer cover hero when screenshots exist', () => {
  const { service } = fixture();
  const tours = createRollCreditsPayload({ rollCredits: service });
  const card = tours.getCard('rc_new', { baseUrl: 'https://bridge:47810' });
  assert.equal(card.media.selectedKind, 'cover');
  assert.equal(card.media.hero.kind, 'cover');
  assert.equal(card.media.hero.url, 'https://bridge:47810/roll-credits-media/rc_new/cover.jpg');
  assert.equal(card.media.screenshots.length, 1);
  assert.equal(card.media.screenshots[0].kind, 'screenshot');
  assert.ok(!JSON.stringify(card.media).includes('.mp4'));
});

test('playlist sessions expire', () => {
  const { service } = fixture();
  let now = 1000;
  const tours = createRollCreditsPayload({ rollCredits: service, ttlMs: 10, now: () => now });
  const payload = tours.buildTourStart({ loop: true });
  assert.ok(tours.getPlaylist(payload.tourId));
  now = 1011;
  assert.equal(tours.getPlaylist(payload.tourId), null);
});
