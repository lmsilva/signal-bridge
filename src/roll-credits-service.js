const fs = require('fs');
const path = require('path');
const { createRollCreditsStore } = require('./roll-credits-store');
const { createRollCreditsSettings } = require('./roll-credits-settings');
const { createRollCreditsCredentials } = require('./roll-credits-credentials');
const { createProviders } = require('./roll-credits-providers');
const { createRollCreditsMedia } = require('./roll-credits-media');
const { createRollCreditsJobs } = require('./roll-credits-jobs');
const { createRollCreditsScraper, createMediaId } = require('./roll-credits-scraper');

function createRollCreditsService({ config = {}, log = console, dependencies = {} } = {}) {
  const store = dependencies.store || createRollCreditsStore(config, log);
  const settings = dependencies.settings || createRollCreditsSettings(config, log);
  const credentials = dependencies.credentials || createRollCreditsCredentials(config);
  const media = dependencies.media || createRollCreditsMedia(config, log, {
    fetch: dependencies.fetch || global.fetch,
    sharpImpl: dependencies.sharp,
    spawnImpl: dependencies.spawn,
  });
  const providers = dependencies.providers || createProviders({
    store,
    credentials,
    settings,
    fetch: dependencies.fetch || global.fetch,
    steamApi: dependencies.steamApi,
  });
  const jobs = dependencies.jobs || createRollCreditsJobs({ store, media, settings, log });
  const scraper = dependencies.scraper || createRollCreditsScraper({
    store,
    providers,
    settings,
    jobs,
  });
  const eventListeners = new Set();
  let started = false;

  function emit(reason, gameId) {
    const event = { reason };
    if (gameId) event.gameId = String(gameId);
    for (const listener of eventListeners) {
      try {
        listener(event);
      } catch (error) {
        log.warn?.('Roll Credits event listener failed', error?.message || error);
      }
    }
  }

  const unsubscribeJobs = jobs.onChange?.((snapshot = []) => {
    const gameIds = [...new Set(snapshot.map((job) => job?.gameId).filter(Boolean))];
    emit('jobs', gameIds.length === 1 ? gameIds[0] : null);
  }) || (() => {});
  const unsubscribeStore = store.onChange?.((event) => {
    emit(event?.reason || 'store', event?.gameId);
  }) || (() => {});

  function start() {
    if (started) return 0;
    started = true;
    return jobs.restartPending();
  }

  function statusSnapshot() {
    return { gameCount: store.getAllGames().length };
  }

  function deleteGame(id) {
    const removed = store.deleteGame(id);
    if (removed) {
      fs.rmSync(path.join(media.mediaRoot, String(id)), { recursive: true, force: true });
    }
    return removed;
  }

  function bulkDelete(ids) {
    const result = store.bulkDelete(ids);
    for (const id of result.deleted) {
      fs.rmSync(path.join(media.mediaRoot, String(id)), { recursive: true, force: true });
    }
    return result;
  }

  async function addUploadedImage(gameId, { dataUrl, kind = 'screenshot' } = {}) {
    const game = store.getGame(gameId);
    if (!game) throw new Error('Roll Credits game not found');
    const saved = await media.saveUploadedImage(gameId, dataUrl, settings.get().limits);
    const row = {
      id: createMediaId(),
      kind: kind === 'cover' ? 'cover' : 'screenshot',
      source: 'upload',
      path: saved.path,
      thumbPath: saved.thumbPath,
      order: (game.media || []).filter((item) => item.kind === kind).length,
      hidden: false,
      status: 'ready',
      statusDetail: null,
    };
    store.updateGame(gameId, { media: [...(game.media || []), row] });
    return row;
  }

  function addYoutube(gameId, { youtubeUrl, resolution } = {}) {
    const game = store.getGame(gameId);
    if (!game) throw new Error('Roll Credits game not found');
    const row = {
      id: createMediaId(),
      kind: 'video',
      source: 'youtube',
      path: null,
      thumbPath: null,
      youtubeUrl: String(youtubeUrl || '').trim(),
      resolution: Number(resolution) || settings.get().youtube.defaultResolution,
      order: (game.media || []).filter((item) => item.kind === 'video').length,
      hidden: false,
      status: settings.get().youtube.downloadEnabled ? 'pending' : 'failed',
      statusDetail: settings.get().youtube.downloadEnabled
        ? null
        : 'YouTube downloads are disabled in Roll Credits settings',
    };
    if (!row.youtubeUrl) throw new Error('YouTube URL is required');
    store.updateGame(gameId, { media: [...(game.media || []), row] });
    if (settings.get().youtube.downloadEnabled) {
      jobs.enqueueDownload({ gameId, mediaId: row.id, kind: 'video' });
    }
    return row;
  }

  function removeMediaFiles(row) {
    for (const relativePath of [row?.path, row?.thumbPath].filter(Boolean)) {
      try {
        fs.rmSync(media.absolutePath(relativePath), { force: true });
      } catch (error) {
        log.warn?.('Could not delete Roll Credits media file', error?.message || error);
      }
    }
  }

  function deleteMedia(gameId, mediaId) {
    const game = store.getGame(gameId);
    if (!game) throw new Error('Roll Credits game not found');
    const row = (game.media || []).find((item) => item.id === mediaId);
    if (!row) throw new Error('Roll Credits media not found');
    removeMediaFiles(row);
    store.updateGame(gameId, {
      media: (game.media || []).filter((item) => item.id !== mediaId),
    });
    return row;
  }

  function retryMedia(gameId, mediaId) {
    const game = store.getGame(gameId);
    if (!game) throw new Error('Roll Credits game not found');
    const row = (game.media || []).find((item) => item.id === mediaId);
    if (!row) throw new Error('Roll Credits media not found');
    const job = jobs.retry(mediaId)
      || jobs.enqueueDownload({ gameId, mediaId, kind: row.kind });
    return job;
  }

  async function saveVideoUpload(gameId, input, { mimeType, contentLength } = {}) {
    const game = store.getGame(gameId);
    if (!game) throw new Error('Roll Credits game not found');
    const limits = settings.get().limits;
    const saved = await media.saveUploadedVideo(gameId, input, {
      mimeType,
      contentLength,
      maxBytes: limits.maxVideoBytes,
    });
    const row = {
      id: createMediaId(),
      kind: 'video',
      source: 'upload',
      path: saved.path,
      thumbPath: saved.thumbPath,
      resolution: null,
      order: (game.media || []).filter((item) => item.kind === 'video').length,
      hidden: false,
      status: 'ready',
      statusDetail: null,
    };
    store.updateGame(gameId, { media: [...(game.media || []), row] });
    return row;
  }

  function onEvents(listener) {
    if (typeof listener !== 'function') return () => {};
    eventListeners.add(listener);
    return () => eventListeners.delete(listener);
  }

  function credentialsStatus() {
    const resolved = credentials.resolveCredentials();
    return {
      hasCredentials: Boolean(resolved.complete),
      configured: Boolean(resolved.complete),
      source: resolved.source || null,
    };
  }

  async function testCredentials() {
    const provider = providers.list?.().find((item) => item?.id === 'igdb');
    const rows = provider?.search
      ? await provider.search('Zelda', { limit: 5 })
      : await providers.search('Zelda', { limit: 5 });
    return {
      ok: true,
      count: rows.length,
      message: `IGDB ok — ${rows.length} candidate${rows.length === 1 ? '' : 's'} for "Zelda"`,
    };
  }

  function saveCredentials(value) {
    const result = credentials.saveCredentials(value);
    if (result.ok) emit('credentials');
    return result;
  }

  function updateSettings(patch) {
    const result = settings.update(patch);
    if (result.ok) emit('settings');
    return result;
  }

  function updateGame(id, patch) {
    return store.updateGame(id, patch);
  }

  function reorderGames(ids) {
    return store.reorderGames(ids);
  }

  function resetInductionOrder() {
    return store.resetInductionOrder();
  }

  function createManual(value) {
    return scraper.createManual(value);
  }

  async function createFromCandidate(value) {
    return scraper.createFromCandidate(value);
  }

  async function rescrape(id, options) {
    return scraper.rescrape(id, options);
  }

  return {
    store,
    settings,
    credentials,
    providers,
    media,
    jobs,
    scraper,
    start,
    statusSnapshot,
    search: scraper.search,
    createFromCandidate,
    createManual,
    rescrape,
    getGame: store.getGame,
    listGames: store.listGames,
    getStats: store.getStats,
    updateGame,
    reorderGames,
    resetInductionOrder,
    deleteGame,
    bulkDelete,
    addUploadedImage,
    addYoutube,
    deleteMedia,
    retryMedia,
    saveVideoUpload,
    onEvents,
    listSystems: store.loadSystems,
    getSystemUsage: store.getSystemUsage,
    testCredentials,
    credentialsStatus,
    saveCredentials,
    pruneOrphans: () => media.pruneOrphans(store.getAllGames().map((game) => game.id)),
    diskUsage: media.diskUsage,
    getSettings: settings.get,
    updateSettings,
    getJobs: jobs.getJobs,
    close: () => {
      unsubscribeJobs();
      unsubscribeStore();
    },
  };
}

module.exports = {
  createRollCreditsService,
};
