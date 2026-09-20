const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRollCreditsStore } = require('../src/roll-credits-store');
const { createRollCreditsService } = require('../src/roll-credits-service');

const silentLog = {
  info() {}, warn() {}, error() {}, debug() {},
};

function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roll-credits-service-'));
  const store = createRollCreditsStore({ rollCreditsPath: path.join(directory, 'store.json') });
  const service = createRollCreditsService({
    log: silentLog,
    dependencies: {
      store,
      settings: { get: () => ({ limits: {}, youtube: {}, scrape: {} }) },
      credentials: {},
      providers: {},
      media: { mediaRoot: directory, absolutePath: (rel) => path.join(directory, rel) },
      jobs: { onChange: () => () => {}, restartPending: () => 0 },
      scraper: {},
    },
  });
  return { store, service };
}

test('saving the game sheet cannot undo a download that finished while it was open', () => {
  const { store, service } = setup();
  const game = store.createGame({
    title: 'Carmageddon II',
    system: 'pc',
    media: [
      { id: 'clip', kind: 'video', source: 'youtube', status: 'pending', path: null, thumbPath: null },
    ],
  });
  // What the sheet loaded, before the queue got to the clip.
  const stale = store.getGame(game.id).media;

  // The download lands: file recorded, poster and wall preview built.
  store.updateGame(game.id, {
    media: [{
      ...stale[0],
      status: 'ready',
      path: `${game.id}/video-clip.mp4`,
      thumbPath: `${game.id}/thumbs/video-clip.poster.jpg`,
      previewPath: `${game.id}/thumbs/video-clip.preview.webp`,
      durationSeconds: 41,
    }],
  });

  // Now the admin presses Save, PUTting the whole media array it still holds.
  const saved = service.updateGame(game.id, {
    title: 'Carmageddon II: Carpocalypse Now',
    media: stale.map((row, index) => ({ ...row, order: index })),
  });

  assert.equal(saved.title, 'Carmageddon II: Carpocalypse Now');
  const row = saved.media[0];
  assert.equal(row.status, 'ready');
  assert.equal(row.path, `${game.id}/video-clip.mp4`);
  assert.equal(row.previewPath, `${game.id}/thumbs/video-clip.preview.webp`);
  assert.equal(row.durationSeconds, 41);
});

test('a game sheet save still reorders and hides media, and nothing else', () => {
  const { store, service } = setup();
  const game = store.createGame({
    title: 'Blur',
    system: 'pc',
    media: [
      { id: 'a', kind: 'screenshot', status: 'ready', path: 'a.jpg', order: 0, hidden: false },
      { id: 'b', kind: 'screenshot', status: 'ready', path: 'b.jpg', order: 1, hidden: false },
    ],
  });
  const saved = service.updateGame(game.id, {
    media: [
      { id: 'b', order: 0, hidden: true, status: 'failed', path: 'hacked.jpg', kind: 'video' },
      { id: 'a', order: 1, hidden: false },
    ],
  });
  assert.deepEqual(saved.media.map((row) => row.id), ['b', 'a']);
  assert.equal(saved.media[0].hidden, true);
  assert.equal(saved.media[0].status, 'ready');
  assert.equal(saved.media[0].path, 'b.jpg');
  assert.equal(saved.media[0].kind, 'screenshot');
  assert.equal(saved.media[1].hidden, false);
});

test('a stale save neither deletes a clip added after it loaded nor resurrects a deleted one', () => {
  const { store, service } = setup();
  const game = store.createGame({
    title: 'Split/Second',
    system: 'pc',
    media: [{ id: 'old', kind: 'cover', status: 'ready', path: 'cover.jpg' }],
  });
  const stale = store.getGame(game.id).media;
  store.updateGame(game.id, {
    media: [{ id: 'fresh', kind: 'video', status: 'pending', path: null }],
  });
  const saved = service.updateGame(game.id, {
    media: [...stale, { id: 'invented', kind: 'screenshot', status: 'ready' }],
  });
  assert.deepEqual(saved.media.map((row) => row.id), ['fresh']);
});
