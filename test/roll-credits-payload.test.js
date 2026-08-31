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
  assert.equal(payload.games[0].title, 'Newest');
  assert.equal(payload.games[0].beatenAt, '2026-08-20');
  assert.equal(payload.games[0].systemLabel, 'PS5');
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

function videoFixture({ previewPath, mediaPriority, thumbPath = 'rc_clip/thumbs/clip.poster.jpg' }) {
  const game = {
    id: 'rc_clip',
    title: 'Clip Test',
    system: 'pc',
    beatenAt: '2026-08-20',
    induction: 1,
    mediaPriorityOverride: mediaPriority,
    media: [
      {
        id: 'v1',
        kind: 'video',
        status: 'ready',
        order: 0,
        path: 'rc_clip/video/clip.mp4',
        thumbPath,
        previewPath,
        previewRevision: 99,
      },
      {
        id: 'c1', kind: 'cover', status: 'ready', order: 1, path: 'rc_clip/cover.jpg',
      },
    ],
  };
  return {
    store: {
      getAllGames: () => [JSON.parse(JSON.stringify(game))],
      getSystemById: (id) => ({ id, label: String(id).toUpperCase() }),
    },
    media: { publicUrl: (value) => `/roll-credits-media/${value}` },
    getSettings: () => ({ mediaPriority: ['video', 'screenshot', 'cover'], display: {} }),
    getGame: (id) => (id === game.id ? JSON.parse(JSON.stringify(game)) : null),
    getStats: () => ({
      total: 1, thisYear: 1, systemsCount: 1, latest: game, months: [], bySystem: [], undatedCount: 0,
    }),
  };
}

test('a top-priority video ships as its looping preview, never the source file', () => {
  const tours = createRollCreditsPayload({
    rollCredits: videoFixture({
      previewPath: 'rc_clip/thumbs/clip.preview.webp',
      mediaPriority: ['video', 'cover', 'screenshot'],
    }),
  });
  const card = tours.getCard('rc_clip', { baseUrl: 'https://bridge:47810' });
  assert.equal(card.media.selectedKind, 'video');
  assert.equal(card.media.hero.animated, true);
  assert.equal(
    card.media.hero.url,
    'https://bridge:47810/roll-credits-media/rc_clip/thumbs/clip.preview.webp?v=99',
  );
  // The poster still is what the wall paints until the loop is on disk.
  assert.equal(
    card.media.hero.thumbUrl,
    'https://bridge:47810/roll-credits-media/rc_clip/thumbs/clip.poster.jpg',
  );
  assert.equal(card.media.still.kind, 'video');
  assert.equal(card.media.still.animated, false);
  assert.equal(
    card.media.still.url,
    'https://bridge:47810/roll-credits-media/rc_clip/thumbs/clip.poster.jpg',
  );
  assert.ok(!JSON.stringify(card.media).includes('.mp4'));
});

test('a video without a poster still falls back to the cover', () => {
  const tours = createRollCreditsPayload({
    rollCredits: videoFixture({
      previewPath: 'rc_clip/thumbs/clip.preview.webp',
      mediaPriority: ['video', 'cover', 'screenshot'],
      thumbPath: null,
    }),
  });
  const card = tours.getCard('rc_clip', { baseUrl: 'https://bridge:47810' });
  assert.equal(card.media.hero.animated, true);
  assert.equal(card.media.still.kind, 'cover');
  assert.equal(card.media.still.animated, false);
  assert.equal(
    card.media.still.url,
    'https://bridge:47810/roll-credits-media/rc_clip/cover.jpg',
  );
});

test('a video without a rendered preview is skipped rather than sent as video', () => {
  const tours = createRollCreditsPayload({
    rollCredits: videoFixture({ previewPath: null, mediaPriority: ['video', 'cover', 'screenshot'] }),
  });
  const card = tours.getCard('rc_clip', { baseUrl: '' });
  assert.equal(card.media.selectedKind, 'cover');
  assert.equal(card.media.hero.animated, false);
  assert.ok(!JSON.stringify(card.media).includes('.mp4'));
});

test('video only wins the hero slot when the priority asks for it first', () => {
  const tours = createRollCreditsPayload({
    rollCredits: videoFixture({
      previewPath: 'rc_clip/thumbs/clip.preview.webp',
      mediaPriority: ['cover', 'video', 'screenshot'],
    }),
  });
  const card = tours.getCard('rc_clip', { baseUrl: '' });
  assert.equal(card.media.selectedKind, 'cover');
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
