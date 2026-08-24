const test = require('node:test');
const assert = require('node:assert/strict');
const { createRollCreditsService } = require('../src/roll-credits-service');

/** Service wired to in-memory stubs so trimming can be checked without ffmpeg. */
function makeService({ media: mediaRows, renderVideoPreview } = {}) {
  const game = {
    id: 'rc_1',
    title: 'Trim Test',
    media: mediaRows || [{
      id: 'md_video',
      kind: 'video',
      source: 'youtube',
      status: 'ready',
      path: 'rc_1/video/clip.mp4',
      thumbPath: 'rc_1/thumbs/clip.poster.jpg',
      previewPath: 'rc_1/thumbs/clip.preview.webp',
    }],
  };
  const renders = [];
  const removed = [];
  const service = createRollCreditsService({
    config: {},
    log: { warn() {}, info() {}, error() {} },
    dependencies: {
      store: {
        getGame: (id) => (id === game.id ? game : null),
        updateGame: (id, patch) => Object.assign(game, patch),
        loadSystems: () => [],
        getSystemUsage: () => ({}),
        getAllGames: () => [game],
      },
      settings: { get: () => ({ limits: {}, display: {} }) },
      credentials: { resolveCredentials: () => ({}) },
      providers: {},
      jobs: { retry: () => null, enqueueDownload: () => null },
      scraper: {},
      media: {
        routePrefix: '/roll-credits-media/',
        publicUrl: (value) => `/roll-credits-media/${value}`,
        absolutePath: (value) => value,
        removeFile: (value) => removed.push(value),
        renderVideoPreview: renderVideoPreview || (async (path, options) => {
          renders.push([path, options]);
          return {
            posterPath: 'rc_1/thumbs/clip.poster.jpg',
            previewPath: 'rc_1/thumbs/clip.preview.webp',
            durationSeconds: 92,
            error: null,
          };
        }),
      },
    },
  });
  return {
    service, game, renders, removed,
  };
}

test('saving a clip range rebuilds the preview and stores the bounds', async () => {
  const { service, game, renders } = makeService();
  const updated = await service.setMediaTrim('rc_1', 'md_video', { trimStart: 12.5, trimEnd: 20 });

  assert.deepEqual(renders, [['rc_1/video/clip.mp4', { trimStart: 12.5, trimEnd: 20 }]]);
  assert.equal(updated.trimStart, 12.5);
  assert.equal(updated.trimEnd, 20);
  assert.equal(updated.previewPath, 'rc_1/thumbs/clip.preview.webp');
  assert.equal(updated.durationSeconds, 92);
  assert.equal(updated.statusDetail, null);
  // The row is written back in place rather than appended.
  assert.equal(game.media.length, 1);
  assert.equal(game.media[0].trimStart, 12.5);
});

test('clearing the range restores the automatic window', async () => {
  const { service, renders } = makeService();
  await service.setMediaTrim('rc_1', 'md_video', { trimStart: 5, trimEnd: 9 });
  const cleared = await service.setMediaTrim('rc_1', 'md_video', {});

  assert.deepEqual(renders[1], ['rc_1/video/clip.mp4', { trimStart: null, trimEnd: null }]);
  assert.equal(cleared.trimStart, null);
  assert.equal(cleared.trimEnd, null);
});

test('a failed render keeps the row but explains itself in the status line', async () => {
  const { service } = makeService({
    renderVideoPreview: async () => ({
      posterPath: null, previewPath: null, durationSeconds: null, error: 'ffmpeg is missing',
    }),
  });
  const updated = await service.setMediaTrim('rc_1', 'md_video', { trimStart: 1, trimEnd: 4 });

  assert.equal(updated.previewPath, null);
  assert.match(updated.statusDetail, /ffmpeg is missing/);
  // The poster and duration already on the row survive a failed rebuild.
  assert.equal(updated.thumbPath, 'rc_1/thumbs/clip.poster.jpg');
});

test('trimming is refused for images, unknown rows and backwards ranges', async () => {
  const { service } = makeService({
    media: [
      { id: 'md_cover', kind: 'cover', status: 'ready', path: 'rc_1/images/cover.jpg' },
      { id: 'md_pending', kind: 'video', status: 'pending', path: '' },
      { id: 'md_video', kind: 'video', status: 'ready', path: 'rc_1/video/clip.mp4' },
    ],
  });

  await assert.rejects(
    service.setMediaTrim('rc_1', 'md_cover', { trimStart: 1 }),
    /Only video media/,
  );
  await assert.rejects(
    service.setMediaTrim('rc_1', 'md_pending', { trimStart: 1 }),
    /not finished downloading/,
  );
  await assert.rejects(
    service.setMediaTrim('rc_1', 'md_missing', { trimStart: 1 }),
    /media not found/,
  );
  await assert.rejects(
    service.setMediaTrim('rc_nope', 'md_video', { trimStart: 1 }),
    /game not found/,
  );
  await assert.rejects(
    service.setMediaTrim('rc_1', 'md_video', { trimStart: 20, trimEnd: 5 }),
    /end must come after/,
  );
});
