const crypto = require('crypto');
const fs = require('fs');

function createJobId() {
  return `job_${crypto.randomBytes(6).toString('hex')}`;
}

function createRollCreditsJobs({ store, media, settings, log = console } = {}) {
  if (!store || !media) throw new Error('Roll Credits jobs need store and media services');
  const jobs = [];
  const listeners = new Set();
  let running = false;
  let idleResolvers = [];

  function snapshot() {
    return jobs.map((job) => ({
      id: job.id,
      gameId: job.gameId,
      mediaId: job.mediaId,
      kind: job.kind,
      state: job.state,
      error: job.error,
    }));
  }

  function notify() {
    const value = snapshot();
    for (const listener of listeners) {
      try {
        listener(value);
      } catch (error) {
        log.warn?.('Roll Credits job listener failed', error?.message || error);
      }
    }
  }

  function onChange(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function patchMedia(gameId, mediaId, patch) {
    const game = store.getGame(gameId);
    if (!game) return null;
    const rows = (game.media || []).map((row) => (
      row.id === mediaId ? { ...row, ...patch } : row
    ));
    return store.updateGame(gameId, { media: rows });
  }

  function inferredPath(item) {
    if (item.path) return item.path;
    const suffix = item.kind === 'video' ? '.mp4' : '.jpg';
    const stem = item.kind === 'cover' ? 'cover' : (
      item.kind === 'screenshot' ? `shot-${item.id}` : `video-${item.resolution || 720}`
    );
    return `${item.gameId}/${stem}${suffix}`;
  }

  async function applyPreview(item, videoPath) {
    const preview = await media.renderVideoPreview(videoPath, {
      trimStart: item.trimStart ?? null,
      trimEnd: item.trimEnd ?? null,
    });
    return {
      thumbPath: preview.posterPath || item.thumbPath || null,
      previewPath: preview.previewPath || null,
      durationSeconds: preview.durationSeconds || item.durationSeconds || null,
      previewRevision: preview.previewRevision || Date.now(),
      frameCount: preview.frameCount || null,
      statusDetail: preview.previewPath
        ? null
        : `Saved, but the wall preview could not be built: ${preview.error || 'unknown reason'}`,
    };
  }

  async function executePreview(job) {
    const game = store.getGame(job.gameId);
    const item = game?.media?.find((row) => row.id === job.mediaId);
    if (!item) throw new Error('Media row no longer exists');
    if (item.kind !== 'video' || !item.path) {
      throw new Error('Preview rebuild needs a ready video file');
    }
    const patch = await applyPreview(item, item.path);
    patchMedia(job.gameId, job.mediaId, patch);
  }

  async function execute(job) {
    if (job.kind === 'preview') {
      await executePreview(job);
      return;
    }
    const game = store.getGame(job.gameId);
    const item = game?.media?.find((row) => row.id === job.mediaId);
    if (!item) throw new Error('Media row no longer exists');
    const outPath = inferredPath({ ...item, gameId: job.gameId });
    const limits = settings?.get?.().limits || {};
    let result;
    if (item.source === 'youtube' || item.youtubeUrl) {
      result = await media.downloadYoutube(
        item.youtubeUrl || item.url,
        item.resolution || settings?.get?.().youtube?.defaultResolution || 720,
        outPath,
      );
    } else {
      const url = item.remoteUrl || item.downloadUrl || item.url;
      if (!url) throw new Error('Media download URL is missing');
      result = await media.downloadUrlToFile(url, outPath, {
        image: item.kind !== 'video',
        maxBytes: item.kind === 'video' ? limits.maxVideoBytes : limits.maxImageBytes,
      });
    }
    const patch = {
      status: 'ready',
      statusDetail: null,
      path: result.path || outPath,
      thumbPath: result.thumbPath || null,
    };
    if (item.path && item.path !== patch.path) {
      try {
        fs.rmSync(media.absolutePath(item.path), { force: true });
      } catch {
        // leftover file at the previous resolution — not fatal
      }
    }
    // The wall cannot decode video, so a downloaded clip is only useful once it
    // has a poster still and a looping preview. Failing that is not fatal — the
    // clip stays playable in the admin and the card falls back to cover art.
    if (item.kind === 'video' && typeof media.renderVideoPreview === 'function') {
      Object.assign(patch, await applyPreview(item, patch.path));
    }
    patchMedia(job.gameId, job.mediaId, patch);
  }

  async function drain() {
    if (running) return;
    running = true;
    try {
      while (true) {
        const job = jobs.find((item) => item.state === 'queued');
        if (!job) break;
        job.state = 'running';
        job.error = null;
        notify();
        try {
          await execute(job);
          job.state = 'done';
        } catch (error) {
          const detail = error?.message || String(error);
          job.state = 'failed';
          job.error = detail;
          if (job.kind !== 'preview') {
            patchMedia(job.gameId, job.mediaId, {
              status: 'failed',
              statusDetail: detail,
            });
          }
        }
        notify();
      }
    } finally {
      running = false;
      const waiting = idleResolvers;
      idleResolvers = [];
      waiting.forEach((resolve) => resolve(snapshot()));
    }
  }

  function normalizeInput(input, mediaItem, extra = {}) {
    if (typeof input === 'object') return { ...input };
    return { gameId: input, ...(mediaItem || {}), ...extra };
  }

  function enqueueDownload(input, mediaItem, extra) {
    const options = normalizeInput(input, mediaItem, extra);
    const gameId = String(options.gameId || '');
    const item = options.media || options.item || options;
    const mediaId = String(options.mediaId || item.id || '');
    if (!gameId || !mediaId) throw new Error('Download job needs gameId and mediaId');
    const existing = jobs.find((job) => (
      job.gameId === gameId && job.mediaId === mediaId
      && (job.state === 'queued' || job.state === 'running')
    ));
    if (existing) return { ...existing };
    const job = {
      id: createJobId(),
      gameId,
      mediaId,
      kind: item.kind || options.kind || 'image',
      state: 'queued',
      error: null,
    };
    jobs.push(job);
    patchMedia(gameId, mediaId, { status: 'pending', statusDetail: null });
    notify();
    queueMicrotask(() => drain());
    return { ...job };
  }

  function enqueuePreviewRebuild(gameId, mediaId) {
    const id = String(gameId || '');
    const itemId = String(mediaId || '');
    if (!id || !itemId) throw new Error('Preview rebuild needs gameId and mediaId');
    const existing = jobs.find((job) => (
      job.gameId === id && job.mediaId === itemId
      && (job.state === 'queued' || job.state === 'running')
    ));
    if (existing) return { ...existing };
    const job = {
      id: createJobId(),
      gameId: id,
      mediaId: itemId,
      kind: 'preview',
      state: 'queued',
      error: null,
    };
    jobs.push(job);
    notify();
    queueMicrotask(() => drain());
    return { ...job };
  }

  function rebuildWallPreviews() {
    let queued = 0;
    for (const game of store.getAllGames()) {
      for (const item of game.media || []) {
        if (item.kind !== 'video' || !item.path) continue;
        if (item.status && item.status !== 'ready') continue;
        enqueuePreviewRebuild(game.id, item.id);
        queued += 1;
      }
    }
    return queued;
  }

  function retry(jobOrId) {
    const id = typeof jobOrId === 'object' ? jobOrId.id : jobOrId;
    const job = jobs.find((item) => item.id === id || item.mediaId === id);
    if (!job) return null;
    if (job.state === 'running' || job.state === 'queued') return { ...job };
    job.state = 'queued';
    job.error = null;
    patchMedia(job.gameId, job.mediaId, { status: 'pending', statusDetail: null });
    notify();
    queueMicrotask(() => drain());
    return { ...job };
  }

  function restartPending() {
    let queued = 0;
    for (const game of store.getAllGames()) {
      for (const item of game.media || []) {
        if (item.status !== 'pending') continue;
        let missing = true;
        if (item.path) {
          try {
            missing = !fs.existsSync(media.absolutePath(item.path));
          } catch {
            missing = true;
          }
        }
        if (missing) {
          enqueueDownload({ gameId: game.id, mediaId: item.id, kind: item.kind });
          queued += 1;
        } else {
          patchMedia(game.id, item.id, { status: 'ready', statusDetail: null });
        }
      }
    }
    return queued;
  }

  function whenIdle() {
    if (!running && !jobs.some((job) => job.state === 'queued')) {
      return Promise.resolve(snapshot());
    }
    return new Promise((resolve) => idleResolvers.push(resolve));
  }

  return {
    enqueueDownload,
    enqueuePreviewRebuild,
    rebuildWallPreviews,
    restartPending,
    retry,
    getJobs: snapshot,
    onChange,
    whenIdle,
  };
}

module.exports = {
  createRollCreditsJobs,
  createJobId,
};
