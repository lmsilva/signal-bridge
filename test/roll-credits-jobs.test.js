const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRollCreditsStore } = require('../src/roll-credits-store');
const { createRollCreditsJobs } = require('../src/roll-credits-jobs');

function setup(download) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roll-credits-jobs-'));
  const store = createRollCreditsStore({ rollCreditsPath: path.join(directory, 'store.json') });
  const media = {
    absolutePath: (relative) => path.join(directory, relative),
    downloadUrlToFile: download,
    downloadYoutube: download,
  };
  const settings = {
    get: () => ({
      limits: { maxImageBytes: 1000, maxVideoBytes: 1000 },
      youtube: { defaultResolution: 720 },
    }),
  };
  return { store, media, jobs: createRollCreditsJobs({ store, media, settings }) };
}

test('jobs run strictly one at a time and mark media ready', async () => {
  let active = 0;
  let maxActive = 0;
  const { store, jobs } = setup(async (_url, outPath) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return { path: outPath, thumbPath: `${outPath}.thumb` };
  });
  const game = store.createGame({
    title: 'Jobs',
    system: 'pc',
    media: [
      { id: 'one', kind: 'cover', status: 'pending', remoteUrl: 'one.jpg' },
      { id: 'two', kind: 'screenshot', status: 'pending', remoteUrl: 'two.jpg' },
    ],
  });
  jobs.enqueueDownload({ gameId: game.id, mediaId: 'one', kind: 'cover' });
  jobs.enqueueDownload({ gameId: game.id, mediaId: 'two', kind: 'screenshot' });
  await jobs.whenIdle();
  assert.equal(maxActive, 1);
  assert.deepEqual(jobs.getJobs().map((job) => job.state), ['done', 'done']);
  assert.ok(store.getGame(game.id).media.every((row) => row.status === 'ready'));
});

test('failed jobs can retry and restartPending finds missing files', async () => {
  let fail = true;
  const { store, jobs } = setup(async (_url, outPath) => {
    if (fail) throw new Error('network failed');
    return { path: outPath, thumbPath: null };
  });
  const game = store.createGame({
    title: 'Retry',
    system: 'pc',
    media: [{ id: 'media', kind: 'cover', status: 'pending', remoteUrl: 'cover.jpg' }],
  });
  assert.equal(jobs.restartPending(), 1);
  await jobs.whenIdle();
  assert.equal(store.getGame(game.id).media[0].status, 'failed');
  fail = false;
  jobs.retry('media');
  await jobs.whenIdle();
  assert.equal(store.getGame(game.id).media[0].status, 'ready');
});

test('a video download rebuilds the wall preview with the saved trim', async () => {
  const renders = [];
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roll-credits-jobs-'));
  const store = createRollCreditsStore({ rollCreditsPath: path.join(directory, 'store.json') });
  const media = {
    absolutePath: (relative) => path.join(directory, relative),
    downloadYoutube: async (_url, _res, outPath) => ({ path: outPath, thumbPath: null }),
    renderVideoPreview: async (path, options) => {
      renders.push([path, options]);
      return { posterPath: `${path}.poster.jpg`, previewPath: `${path}.preview.webp`, durationSeconds: 40 };
    },
  };
  const settings = {
    get: () => ({
      limits: { maxImageBytes: 1000, maxVideoBytes: 1000 },
      youtube: { defaultResolution: 720 },
    }),
  };
  const jobs = createRollCreditsJobs({ store, media, settings });
  const game = store.createGame({
    title: 'Clip',
    system: 'pc',
    media: [{
      id: 'clip',
      kind: 'video',
      source: 'youtube',
      status: 'pending',
      youtubeUrl: 'https://youtu.be/abc',
      resolution: 1080,
      trimStart: 8,
      trimEnd: 18,
    }],
  });
  jobs.enqueueDownload({ gameId: game.id, mediaId: 'clip', kind: 'video' });
  await jobs.whenIdle();
  assert.equal(renders.length, 1);
  assert.equal(renders[0][1].trimStart, 8);
  assert.equal(renders[0][1].trimEnd, 18);
  assert.equal(store.getGame(game.id).media[0].resolution, 1080);
  assert.match(store.getGame(game.id).media[0].path, /video-1080/);
});
