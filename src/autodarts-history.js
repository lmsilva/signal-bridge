/**
 * History backfill scaffold.
 * Disabled until the match-history list endpoint is confirmed (§4.4).
 */

function createAutodartsHistory({
  archive,
  aggregates,
  api,
  settings,
  log = console,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  let running = false;
  let lastSyncAt = null;
  let lastError = null;

  function status() {
    const cfg = settings.get();
    return {
      enabled: cfg.sync.historyBackfill === true && cfg.sync.historyEndpointConfirmed === true,
      running,
      lastSyncAt,
      lastError,
      archivedCount: archive.count(),
      note: cfg.sync.historyEndpointConfirmed
        ? null
        : 'Archive builds from live matches until the history list endpoint is confirmed',
    };
  }

  async function sync({ limit = 25 } = {}) {
    const cfg = settings.get();
    if (!cfg.sync.historyEndpointConfirmed) {
      return {
        ok: false,
        skipped: true,
        error: 'History backfill is disabled until the list endpoint is confirmed',
      };
    }
    if (running) {
      return { ok: false, error: 'History sync already running' };
    }
    running = true;
    lastError = null;
    try {
      // Placeholder: once the endpoint path is known, walk newest-first and stop
      // at the first already-archived matchId. Keep sequential + spaced.
      void limit;
      void api;
      void sleep;
      lastSyncAt = new Date().toISOString();
      aggregates.recompute(archive.listAll());
      return { ok: true, imported: 0, note: 'No history endpoint wired yet' };
    } catch (error) {
      lastError = error?.message || String(error);
      log?.warn?.('Autodarts history sync failed', lastError);
      return { ok: false, error: lastError };
    } finally {
      running = false;
    }
  }

  return { status, sync };
}

module.exports = {
  createAutodartsHistory,
};
